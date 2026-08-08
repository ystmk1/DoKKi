import { BookNote, GraphBasis } from "./types";
// three.js를 쓰는 두 뷰(큐브·은하)는 동적 import — 메인 번들에서 three가
// 빠지고, 그래프가 실제로 그려질 때만 로드된다.
import type { GraphHandle } from "./graphView";
import { renderBookStack } from "./bookStack";
import { tagLeafOf } from "./parser-core";
import { searchBooks, NlBookResult } from "./nl-api";
import { getMetadata, setMetadata, clearMetadata, setCoverColor, effectiveTags } from "./note-metadata";
import { kdcTagsFromCallNo } from "./kdc";
import { isCloudEnabled } from "./supabase";
import { signInWith, signInWithEmail, signOut, userLabel, getUser } from "./auth";
import { extractCoverColor } from "./cover-color";
import { getWishlist, addWishlist, removeWishlist, type WishItem } from "./wishlist";
import { getMemo, setMemo, memoBolds } from "./memos";

export interface WebViewOptions {
  books: BookNote[];
  isDemo: boolean;
  mount: HTMLElement;
  /** Persist uploaded files (main re-loads + calls reload afterwards). */
  onUpload: (files: File[]) => Promise<void>;
  /** Delete an uploaded note by filename (main re-loads afterwards). */
  onDelete: (filename: string) => Promise<void>;
  /** Delete several uploaded notes at once (one re-load afterwards). */
  onDeleteMany: (filenames: string[]) => Promise<void>;
  /** Save edited tags for an uploaded note (main rewrites + re-loads). */
  onEditTags: (filename: string, tags: string[]) => Promise<void>;
  /** True for demo/built-in notes (not deletable/editable). */
  isDemoPath: (filePath: string) => boolean;
}

export interface WebViewHandle {
  /** Swap the book set (after auth change or upload) and re-render. */
  reload: (books: BookNote[], isDemo: boolean) => void;
}

export function mountWebView({
  books,
  isDemo,
  mount,
  onUpload,
  onDelete,
  onDeleteMany,
  onEditTags,
  isDemoPath,
}: WebViewOptions): WebViewHandle {
  const state: ControlsState = {
    filterAuthors: new Set<string>(),
    filterTags: new Set<string>(),
    filterStatuses: new Set<string>(),
    filterRatings: new Set<string>(),
    search: "",
    // 연결(저자+태그)이 기본 — 연관성을 보여주는 게 이 뷰의 존재 이유다.
    graphBasis: "both",
  };
  let graph: GraphHandle | null = null;
  let lastOpenedBook: BookNote | null = null;
  // Marquee multi-select over the book stack.
  const selectedPaths = new Set<string>();
  let suppressOpen = false; // a drag just happened — swallow the trailing click

  function applySelectionClasses() {
    const apply = (el: HTMLElement) => {
      el.classList.toggle(
        "is-selected",
        !!el.dataset.path && selectedPaths.has(el.dataset.path),
      );
    };
    stackWrap.querySelectorAll<HTMLElement>(".dokki-spine").forEach(apply);
    nonfictionWrap.querySelectorAll<HTMLElement>(".dokki-nf-row").forEach(apply);
  }
  let controlsEl: HTMLElement | null = null;

  mount.classList.add("dokki-root");
  mount.innerHTML = "";

  const header = document.createElement("header");
  header.className = "dokki-page-header";
  const brand = document.createElement("a");
  brand.className = "dokki-brand";
  brand.href = "/";
  const brandName = document.createElement("span");
  brandName.textContent = "tin";
  brand.appendChild(brandName);
  header.appendChild(brand);
  const headerRight = document.createElement("div");
  headerRight.className = "dokki-header-right";
  // Rough entry point to the OCR scan page (design TBD).
  const scanLink = document.createElement("a");
  scanLink.className = "dokki-repo-link";
  scanLink.href = "/scan.html";
  scanLink.textContent = "스캔";
  headerRight.appendChild(scanLink);
  const authSlot = document.createElement("div");
  authSlot.className = "dokki-auth";
  headerRight.appendChild(authSlot);
  header.appendChild(headerRight);
  mount.appendChild(header);

  const excerptWrap = document.createElement("div");
  excerptWrap.className = "dokki-excerpt";
  mount.appendChild(excerptWrap);

  // 컨트롤·그래프·목록들을 감싸는 래퍼 — 넓은 화면(≥1440px)에서는 큐브가
  // 메인(왼쪽, sticky)이 되고 목록들이 오른쪽 좁은 열로 붙는 2열 그리드가 된다.
  const mainWrap = document.createElement("div");
  mainWrap.className = "dokki-main";
  mount.appendChild(mainWrap);

  const controlsHolder = document.createElement("div");
  controlsHolder.className = "dokki-controls-holder";
  mainWrap.appendChild(controlsHolder);

  const graphSection = document.createElement("div");
  graphSection.className = "dokki-graph-section";
  const graphWrap = document.createElement("div");
  graphWrap.className = "dokki-graph-wrap";
  graphSection.appendChild(graphWrap);
  // 큐브(좌표 지도) ↔ 은하(관계 성단) 전환. 큐브가 기본 — 서비스의 초점.
  const GRAPH_VIEW_KEY = "dokki:graph-view:v1";
  type GraphViewMode = "cube" | "galaxy";
  let graphView: GraphViewMode = (() => {
    try {
      return localStorage.getItem(GRAPH_VIEW_KEY) === "galaxy" ? "galaxy" : "cube";
    } catch {
      return "cube";
    }
  })();
  const graphToggle = document.createElement("div");
  graphToggle.className = "dokki-graph-toggle";
  const viewBtns = new Map<GraphViewMode, HTMLButtonElement>();
  for (const [mode, text] of [["cube", "큐브"], ["galaxy", "은하"]] as Array<[GraphViewMode, string]>) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dokki-graph-toggle-btn";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      if (graphView === mode) return;
      graphView = mode;
      try {
        localStorage.setItem(GRAPH_VIEW_KEY, mode);
      } catch {
        /* storage disabled */
      }
      renderGraphSection();
    });
    viewBtns.set(mode, btn);
    graphToggle.appendChild(btn);
  }
  graphSection.appendChild(graphToggle);
  mainWrap.appendChild(graphSection);

  // Upload button lives in the controls bar (right of the filter); it's a
  // persistent element moved into each freshly-built bar.
  const uploadSlot = document.createElement("div");
  uploadSlot.className = "dokki-upload-slot";

  const stackWrap = document.createElement("div");
  stackWrap.className = "dokki-stack-wrap";
  mainWrap.appendChild(stackWrap);

  // 비문학(non-fiction) excerpts — a collection of short prose pieces, between
  // the book stack and the wishlist. Lower hierarchy than the stack (compact
  // rows, no covers), higher than the wishlist (preview text, opens a panel).
  const nonfictionWrap = document.createElement("section");
  nonfictionWrap.className = "dokki-nonfiction";

  // "읽고 싶은 도서" — sits below the book stack, above the GitHub footer.
  const wishWrap = document.createElement("section");
  wishWrap.className = "dokki-wishlist";

  // Drag a marquee across rows to select several at once (own notes only);
  // right-clicking the selection then offers a bulk delete. Shared by the book
  // stack (.dokki-spine) and the 조각 list (.dokki-nf-row). Desktop-only — on
  // mobile (touch / narrow layout) it fights with scrolling, so leave taps to
  // open notes as usual.
  function attachMarquee(wrap: HTMLElement, rowSelector: string): HTMLElement {
    const marquee = document.createElement("div");
    marquee.className = "dokki-marquee";
    marquee.style.display = "none";
    wrap.appendChild(marquee);

    wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !isCloudEnabled || !getUser()) return;
      if (e.pointerType === "touch" || window.matchMedia("(max-width: 768px)").matches) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const fromRow = (e.target as HTMLElement).closest(rowSelector);
      let moved = false;

      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
        if (!moved) {
          moved = true;
          suppressOpen = true; // the trailing click shouldn't open a note
          marquee.style.display = "block";
        }
        const minX = Math.min(startX, ev.clientX);
        const maxX = Math.max(startX, ev.clientX);
        const minY = Math.min(startY, ev.clientY);
        const maxY = Math.max(startY, ev.clientY);
        const wr = wrap.getBoundingClientRect();
        marquee.style.left = `${minX - wr.left}px`;
        marquee.style.top = `${minY - wr.top}px`;
        marquee.style.width = `${maxX - minX}px`;
        marquee.style.height = `${maxY - minY}px`;
        selectedPaths.clear();
        wrap.querySelectorAll<HTMLElement>(rowSelector).forEach((row) => {
          const r = row.getBoundingClientRect();
          const hit = r.left < maxX && r.right > minX && r.top < maxY && r.bottom > minY;
          const path = row.dataset.path;
          if (hit && path && !isDemoPath(path)) selectedPaths.add(path);
        });
        applySelectionClasses();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        marquee.style.display = "none";
        // A plain click on empty space clears the selection.
        if (!moved && !fromRow && selectedPaths.size) {
          selectedPaths.clear();
          applySelectionClasses();
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    return marquee;
  }

  const marquee = attachMarquee(stackWrap, ".dokki-spine");
  const nfMarquee = attachMarquee(nonfictionWrap, ".dokki-nf-row");

  // Pressing anywhere else clears the selection — except on an already-selected
  // spine / 조각 row (so you can right-click it) or inside the context menu.
  document.addEventListener("pointerdown", (e) => {
    if (!selectedPaths.size) return;
    const t = e.target as HTMLElement;
    if (t.closest(".dokki-ctx-menu")) return;
    const spine = t.closest(".dokki-spine") as HTMLElement | null;
    if (spine && spine.dataset.path && selectedPaths.has(spine.dataset.path)) return;
    const nfRow = t.closest(".dokki-nf-row") as HTMLElement | null;
    if (nfRow && nfRow.dataset.path && selectedPaths.has(nfRow.dataset.path)) return;
    selectedPaths.clear();
    applySelectionClasses();
  });

  // GitHub link lives at the very bottom now (desktop only, via CSS) — you
  // scroll past the book stack to reach it.
  const footer = document.createElement("footer");
  footer.className = "dokki-footer";
  const repoLink = document.createElement("a");
  repoLink.className = "dokki-repo-link";
  repoLink.href = "https://github.com/ystmk1/tin";
  repoLink.target = "_blank";
  repoLink.rel = "noopener";
  repoLink.textContent = "GitHub →";
  footer.appendChild(repoLink);
  mainWrap.appendChild(nonfictionWrap); // 비문학 발췌, between the stack and the wishlist
  mainWrap.appendChild(wishWrap); // want-to-read list, just above the footer
  mount.appendChild(footer);

  const panel = document.createElement("aside");
  panel.className = "dokki-panel";
  panel.innerHTML = `<div class="dokki-panel-inner"></div>`;
  mount.appendChild(panel);
  const panelBackdrop = document.createElement("div");
  panelBackdrop.className = "dokki-panel-backdrop";
  panelBackdrop.addEventListener("click", () => closePanel());
  mount.appendChild(panelBackdrop);

  // Clicking a [[Note]] wikilink in the body opens that note (if it's loaded).
  const decodeEntities = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  panel.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest(".dokki-wikilink") as HTMLElement | null;
    if (!a) return;
    e.preventDefault();
    const name = decodeEntities((a.dataset.target ?? "").trim());
    const hit = books.find(
      (x) => x.title === name || x.filePath === name || x.filePath === `${name}.md`,
    );
    if (hit) openNote(hit);
  });

  // Memo popovers — in bold-only mode, every bold with a saved memo gets its
  // own popover automatically; clicking a bold without one opens an empty
  // popover for new notes. Each popover anchors to its bold and follows it
  // as the panel scrolls; both fade at the top/bottom of the panel viewport.
  interface MemoEntry {
    anchor: HTMLElement;
    filePath: string;
    boldText: string;
    popover: HTMLElement;
    textarea: HTMLTextAreaElement;
  }
  const memoPopovers = new Map<HTMLElement, MemoEntry>();

  function createMemoPopover(anchor: HTMLElement, filePath: string): MemoEntry | null {
    const existing = memoPopovers.get(anchor);
    if (existing) return existing;
    const boldText = (anchor.textContent ?? "").trim();
    if (!boldText) return null;

    const popover = document.createElement("div");
    popover.className = "dokki-memo-popover";
    const ta = document.createElement("textarea");
    ta.className = "dokki-memo-textarea";
    ta.placeholder = "메모…";
    ta.value = getMemo(filePath, boldText);
    popover.appendChild(ta);
    document.body.appendChild(popover);

    const entry: MemoEntry = { anchor, filePath, boldText, popover, textarea: ta };
    const persist = () => {
      const v = ta.value;
      setMemo(filePath, boldText, v);
      anchor.classList.toggle("has-memo", v.trim().length > 0);
    };
    const autosize = () => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
      positionMemoEntry(entry); // size changed → re-anchor (fade depends on it)
    };
    ta.addEventListener("input", () => {
      persist();
      autosize();
    });
    ta.addEventListener("blur", persist);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") removeMemoPopover(anchor);
    });

    memoPopovers.set(anchor, entry);
    positionMemoEntry(entry);
    // After the element is in the DOM we can read scrollHeight for the
    // initial autosize (one line when empty, taller for saved content).
    setTimeout(() => autosize(), 0);
    return entry;
  }

  function removeMemoPopover(anchor: HTMLElement): void {
    const e = memoPopovers.get(anchor);
    if (!e) return;
    setMemo(e.filePath, e.boldText, e.textarea.value);
    e.anchor.classList.toggle("has-memo", e.textarea.value.trim().length > 0);
    e.popover.remove();
    memoPopovers.delete(anchor);
  }

  function removeAllMemoPopovers(): void {
    for (const a of [...memoPopovers.keys()]) removeMemoPopover(a);
  }

  /** Drop only popovers whose textarea is empty — saved ones stay pinned. */
  function removeEmptyMemoPopovers(): void {
    for (const [a, e] of [...memoPopovers]) {
      if (!e.textarea.value.trim()) removeMemoPopover(a);
    }
  }

  /** Auto-open a popover for every bold that already has a saved memo. */
  function showSavedMemoPopovers(): void {
    if (!lastOpenedBook || !panel.classList.contains("is-bold-only")) return;
    panel
      .querySelectorAll<HTMLElement>(".dokki-panel-body strong.has-memo")
      .forEach((el) => {
        createMemoPopover(el, lastOpenedBook!.filePath);
      });
  }

  function positionMemoEntry(e: MemoEntry): void {
    const ar = e.anchor.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const pop = e.popover;
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;

    let top: number;
    let left: number;
    let hasTail = false;
    if (pr.left >= popW + 24) {
      // Sits on the panel's left flank with a tail pointing to the bold.
      // Top aligned with the bold so users can tell which one it belongs to.
      left = pr.left - popW - 16;
      top = ar.top;
      hasTail = true;
    } else {
      // Narrow viewport — float above/below the anchor; no tail in this mode.
      left = Math.max(8, Math.min(window.innerWidth - popW - 8, ar.left));
      top = ar.top - popH - 8;
      if (top < 8) top = ar.bottom + 8;
    }
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
    pop.classList.toggle("has-tail", hasTail);

    const FADE = 80;
    const mid = ar.top + ar.height / 2;
    let opacity = 1;
    if (mid < pr.top) opacity = 0;
    else if (mid < pr.top + FADE) opacity = (mid - pr.top) / FADE;
    else if (mid > pr.bottom) opacity = 0;
    else if (mid > pr.bottom - FADE) opacity = (pr.bottom - mid) / FADE;
    opacity = Math.max(0, Math.min(1, opacity));
    pop.style.opacity = String(opacity);
    // Fully faded popovers shouldn't intercept clicks on the panel behind.
    pop.style.pointerEvents = opacity > 0.05 ? "auto" : "none";
  }

  function positionAllMemoPopovers(): void {
    for (const e of memoPopovers.values()) positionMemoEntry(e);
  }

  // Click a bold in bold-only mode → open / focus its memo popover.
  panel.addEventListener("click", (e) => {
    if (!panel.classList.contains("is-bold-only")) return;
    const t = e.target as HTMLElement;
    const strong = t.closest(".dokki-panel-body strong") as HTMLElement | null;
    if (!strong || !panel.contains(strong)) return;
    if (memoPopovers.has(strong)) {
      memoPopovers.get(strong)!.textarea.focus();
      return;
    }
    if (lastOpenedBook) {
      const entry = createMemoPopover(strong, lastOpenedBook.filePath);
      if (entry) setTimeout(() => entry.textarea.focus(), 20);
    }
  });
  panel.addEventListener("scroll", () => positionAllMemoPopovers());
  window.addEventListener("resize", () => positionAllMemoPopovers());
  // Click outside any popover (and outside a bold) drops the empty ones.
  // Saved popovers stay pinned — they're meant to live alongside their bold.
  document.addEventListener("mousedown", (e) => {
    if (!memoPopovers.size) return;
    const t = e.target as HTMLElement;
    if (t.closest(".dokki-memo-popover")) return;
    if (t.closest(".dokki-panel-body strong")) return;
    removeEmptyMemoPopovers();
  });

  // Movable page-index popover (left side) — a table of contents for the open
  // note. Drag it by the header; its position persists across notes.
  const pageIndex = document.createElement("nav");
  pageIndex.className = "dokki-pageindex";
  pageIndex.style.display = "none";
  mount.appendChild(pageIndex);
  let idxPos: { left: number; top: number } | null = null;
  let idxScrollHandler: (() => void) | null = null;

  function openNote(b: BookNote, focus?: { page: number; text: string }) {
    lastOpenedBook = b;
    const inner = panel.querySelector(".dokki-panel-inner") as HTMLElement;
    inner.innerHTML = "";
    const close = document.createElement("button");
    close.className = "dokki-panel-close";
    close.textContent = "×";
    close.addEventListener("click", () => closePanel());
    inner.appendChild(close);

    // "볼드만" pill — collapses the panel to just the bold-highlighted excerpts
    // (page numbers stay so you can navigate). Lives in the panel head so it's
    // accessible on both desktop and mobile (the TOC popover is desktop-only).
    const boldOnlyBtn = document.createElement("button");
    boldOnlyBtn.type = "button";
    boldOnlyBtn.className = "dokki-bold-only-btn";
    boldOnlyBtn.textContent = "볼드만";
    boldOnlyBtn.title = "볼드체 발췌만 보기";
    boldOnlyBtn.addEventListener("click", () => {
      const on = panel.classList.toggle("is-bold-only");
      boldOnlyBtn.classList.toggle("is-active", on);
      boldOnlyBtn.textContent = on ? "전체" : "볼드만";
      if (on) showSavedMemoPopovers();
      else removeAllMemoPopovers();
    });
    inner.appendChild(boldOnlyBtn);

    // (Delete / edit-tags moved to the book-stack right-click context menu.)

    const head = document.createElement("div");
    head.className = "dokki-panel-head";
    inner.appendChild(head);
    renderHead(head, b);

    // Status chip is suppressed for 비문학 (treat as if not set, per the
    // user's note that author/status are book-specific).
    const status = isNonfiction(b) ? "" : statusChipText(b);
    const noteTags = effectiveTags(b);
    if (status || noteTags.length > 0) {
      const tags = document.createElement("div");
      tags.className = "dokki-panel-tags";
      if (status) {
        const chip = document.createElement("span");
        chip.className = "dokki-tag dokki-status";
        chip.textContent = status;
        tags.appendChild(chip);
      }
      // One chip per tag (no "#"). A single tag may itself be a path like
      // "문학/해외문학" (kept verbatim); separate tags — a 사조/장르 like
      // 포스트모더니즘, a 전집, or a KDC overlay tag — stay as their own chips.
      for (const t of noteTags) {
        const span = document.createElement("span");
        span.className = "dokki-tag";
        span.textContent = tagLabel(t);
        tags.appendChild(span);
      }
      inner.appendChild(tags);
    }
    // Resolve an ![[Note]] embed to that note's text, when it's a loaded note.
    const resolveEmbed = (name: string): string | null => {
      const hit = books.find(
        (x) => x.title === name || x.filePath === name || x.filePath === `${name}.md`,
      );
      if (!hit) return null;
      const parts: string[] = [];
      if (hit.externalQuote) parts.push(hit.externalQuote);
      for (const pg of hit.pages) parts.push(pg.body);
      const text = parts.join("\n\n").trim();
      return text || null;
    };

    if (b.frontmatter.comment) {
      const c = document.createElement("blockquote");
      c.className = "dokki-panel-comment";
      c.textContent = b.frontmatter.comment;
      inner.appendChild(c);
    }
    if (b.externalQuote) {
      // The 서평/외부 인용 block can itself hold ![[embeds]] and **bold** — so
      // render it the same way as page bodies (not plain text).
      const e = document.createElement("blockquote");
      e.className = "dokki-panel-external";
      e.innerHTML = renderBodyHTML(b.externalQuote, resolveEmbed);
      inner.appendChild(e);
    }
    if (b.preamble) {
      // Content before the first page marker (a ### heading and/or a few
      // lines) — shown verbatim, but it's not a page so it stays out of the TOC.
      const pre = document.createElement("pre");
      pre.className = "dokki-panel-body dokki-panel-preamble";
      pre.innerHTML = renderBodyHTML(b.preamble, resolveEmbed);
      inner.appendChild(pre);
    }

    const pagesEl = document.createElement("div");
    pagesEl.className = "dokki-panel-pages";
    for (const p of b.pages) {
      const block = document.createElement("section");
      block.className = "dokki-panel-page";
      block.dataset.page = String(p.page);
      const num = document.createElement("h3");
      num.textContent = `p. ${p.page}`;
      block.appendChild(num);
      const body = document.createElement("pre");
      body.className = "dokki-panel-body";
      body.innerHTML = renderBodyHTML(p.body, resolveEmbed);
      block.appendChild(body);
      pagesEl.appendChild(block);
    }
    inner.appendChild(pagesEl);

    // Mark every bold that already has a saved memo so users can see at a
    // glance which excerpts they've annotated (the dot is only shown by CSS
    // in bold-only mode — clean in normal reading mode).
    const memos = memoBolds(b.filePath);
    if (memos.size) {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      inner.querySelectorAll<HTMLElement>(".dokki-panel-body strong").forEach((el) => {
        if (memos.has(norm(el.textContent ?? ""))) el.classList.add("has-memo");
      });
    }

    // Backlinks — other notes that wikilink (`[[Title]]` / `![[Title]]`) to
    // this one. Especially useful for the 비문학 excerpts, which are usually
    // referenced from related notes.
    const incoming = backlinksFor(b, books);
    if (incoming.length) {
      const bl = document.createElement("section");
      bl.className = "dokki-backlinks";
      const lbl = document.createElement("h4");
      lbl.textContent = "이 노트를 인용한 노트";
      bl.appendChild(lbl);
      const ul = document.createElement("ul");
      for (const other of incoming) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.className = "dokki-wikilink";
        a.dataset.target = other.title;
        a.textContent = other.title;
        li.appendChild(a);
        ul.appendChild(li);
      }
      bl.appendChild(ul);
      inner.appendChild(bl);
    }

    panel.classList.add("is-open");
    panelBackdrop.classList.add("is-open");
    // Lock the background so the wheel scrolls the note, not the main page
    // behind it (and hide the main scrollbar).
    document.documentElement.classList.add("dokki-scroll-lock");
    buildPageIndex(b);
    if (focus) scrollToExcerpt(inner, focus);
  }

  // Open scrolled so the excerpted passage sits ~mid-screen. Finds the matching
  // <strong> in the right page (else the page itself) and centres it.
  function scrollToExcerpt(inner: HTMLElement, focus: { page: number; text: string }) {
    const core = stripWrappingQuotes(focus.text.split("\n")[0]).trim().slice(0, 8);
    setTimeout(() => {
      const section = inner.querySelector(
        `.dokki-panel-page[data-page="${focus.page}"]`,
      ) as HTMLElement | null;
      if (!section) return;
      let target: HTMLElement = section;
      if (core) {
        const hit = Array.from(section.querySelectorAll("strong")).find((s) =>
          (s.textContent ?? "").includes(core),
        ) as HTMLElement | undefined;
        if (hit) target = hit;
      }
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
  }

  function renderHead(head: HTMLElement, b: BookNote) {
    head.innerHTML = "";

    // 비문학 발췌는 책이 아니라서 표지·서지·검색 버튼이 의미 없음.
    // 제목(과 별점)만 보여주고 나머지는 전부 생략.
    if (isNonfiction(b)) {
      const titleWrap = document.createElement("div");
      titleWrap.className = "dokki-panel-title-wrap";
      const titleRow = document.createElement("div");
      titleRow.className = "dokki-panel-title-row";
      const title = document.createElement("h2");
      title.textContent = b.title;
      titleRow.appendChild(title);
      if (b.frontmatter.rating !== undefined && b.frontmatter.rating > 0) {
        titleRow.appendChild(renderRatingEl(b.frontmatter.rating));
      }
      titleWrap.appendChild(titleRow);
      head.appendChild(titleWrap);
      return;
    }

    const meta = getMetadata(b.filePath);

    if (meta) {
      // Cover (or letter placeholder) is the trigger for the actions popup —
      // 다시 검색 / 지우기 live one depth deeper now, not inline.
      const cover = document.createElement("button");
      cover.className = "dokki-panel-cover dokki-panel-cover-btn";
      cover.title = "표지를 눌러 다시 검색 / 지우기";
      cover.setAttribute("aria-label", "도서 정보 옵션 열기");
      if (meta.coverUrl) {
        const img = document.createElement("img");
        img.alt = `${meta.title} 표지`;
        img.loading = "lazy";
        img.src = meta.coverUrl;
        img.addEventListener("error", () => {
          img.remove();
          cover.classList.add("dokki-panel-cover-fallback");
          cover.textContent = (b.title[0] ?? "?").toUpperCase();
        });
        cover.appendChild(img);
      } else {
        cover.classList.add("dokki-panel-cover-fallback");
        cover.textContent = (b.title[0] ?? "?").toUpperCase();
      }
      cover.addEventListener("click", () => openCoverActions(b));
      head.appendChild(cover);
    }

    const titleWrap = document.createElement("div");
    titleWrap.className = "dokki-panel-title-wrap";
    const titleRow = document.createElement("div");
    titleRow.className = "dokki-panel-title-row";
    const title = document.createElement("h2");
    title.textContent = b.title;
    titleRow.appendChild(title);
    if (b.frontmatter.rating !== undefined && b.frontmatter.rating > 0) {
      const stars = renderRatingEl(b.frontmatter.rating);
      titleRow.appendChild(stars);
    }
    titleWrap.appendChild(titleRow);

    if (meta) {
      const sub = document.createElement("div");
      sub.className = "dokki-panel-libinfo";
      const subBits: string[] = [];
      if (meta.author) subBits.push(meta.author);
      if (meta.publisher) subBits.push(meta.publisher);
      if (meta.pubYear) subBits.push(meta.pubYear);
      sub.textContent = subBits.join(" · ");
      titleWrap.appendChild(sub);
    } else {
      // No library metadata selected — surface the user's own frontmatter
      // (author / publisher) in the same libinfo slot. Status is handled
      // separately as a chip in the tags row.
      const fmBits: string[] = [];
      if (b.frontmatter.author) fmBits.push(b.frontmatter.author);
      if (b.frontmatter.publisher) fmBits.push(b.frontmatter.publisher);
      if (fmBits.length) {
        const sub = document.createElement("div");
        sub.className = "dokki-panel-libinfo";
        sub.textContent = fmBits.join(" · ");
        titleWrap.appendChild(sub);
      }
      const search = document.createElement("button");
      search.className = "dokki-libsearch-btn";
      search.textContent = "+ 도서 정보 검색";
      search.title = "국립중앙도서관·알라딘에서 검색해 표지·서지 정보를 연결";
      search.addEventListener("click", () => openSearch(b));
      titleWrap.appendChild(search);
    }

    head.appendChild(titleWrap);
  }

  function openCoverActions(b: BookNote) {
    const meta = getMetadata(b.filePath);
    if (!meta) return;

    const overlay = document.createElement("div");
    overlay.className = "dokki-search-overlay";
    const dialog = document.createElement("div");
    dialog.className = "dokki-cover-dialog";

    const closeBtn = document.createElement("button");
    closeBtn.className = "dokki-panel-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => overlay.remove());
    dialog.appendChild(closeBtn);

    if (meta.coverUrl) {
      const big = document.createElement("img");
      big.className = "dokki-cover-big";
      big.alt = `${meta.title} 표지`;
      big.src = meta.coverUrl;
      big.addEventListener("error", () => big.remove());
      dialog.appendChild(big);
    }

    const info = document.createElement("div");
    info.className = "dokki-cover-info";
    const t = document.createElement("div");
    t.className = "dokki-cover-title";
    t.textContent = meta.title || b.title;
    info.appendChild(t);
    const subBits: string[] = [];
    if (meta.author) subBits.push(meta.author);
    if (meta.publisher) subBits.push(meta.publisher);
    if (meta.pubYear) subBits.push(meta.pubYear);
    if (subBits.length) {
      const s = document.createElement("div");
      s.className = "dokki-cover-sub";
      s.textContent = subBits.join(" · ");
      info.appendChild(s);
    }
    dialog.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "dokki-cover-actions";
    const change = document.createElement("button");
    change.className = "dokki-libaction";
    change.textContent = "다시 검색";
    change.addEventListener("click", () => {
      overlay.remove();
      openSearch(b);
    });
    const remove = document.createElement("button");
    remove.className = "dokki-libaction dokki-libaction-quiet";
    remove.textContent = "지우기";
    remove.addEventListener("click", () => {
      clearMetadata(b.filePath);
      overlay.remove();
      const headEl = panel.querySelector(".dokki-panel-head") as HTMLElement | null;
      if (headEl) renderHead(headEl, b);
    });
    actions.append(change, remove);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  // Shared book-search dialog: overlay + title + search form + result cards.
  // Used by 서지정보 검색 (link metadata to a note) and the wishlist search;
  // only the title, initial query and pick behavior differ.
  function openBookSearchDialog(opts: {
    title: string;
    initialQuery?: string;
    onPick: (r: NlBookResult, card: HTMLButtonElement, closeOverlay: () => void) => void;
  }): void {
    const overlay = document.createElement("div");
    overlay.className = "dokki-search-overlay";
    const dialog = document.createElement("div");
    dialog.className = "dokki-search-dialog";

    const head = document.createElement("div");
    head.className = "dokki-search-head";
    const heading = document.createElement("h3");
    heading.textContent = opts.title;
    head.appendChild(heading);
    const closeBtn = document.createElement("button");
    closeBtn.className = "dokki-panel-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => overlay.remove());
    head.appendChild(closeBtn);
    dialog.appendChild(head);

    const form = document.createElement("form");
    form.className = "dokki-search-form";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "dokki-search-input";
    input.value = opts.initialQuery ?? "";
    input.placeholder = "제목·저자·키워드";
    form.appendChild(input);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "dokki-search-submit";
    submit.textContent = "검색";
    form.appendChild(submit);
    dialog.appendChild(form);

    const status = document.createElement("div");
    status.className = "dokki-search-status";
    dialog.appendChild(status);
    const results = document.createElement("div");
    results.className = "dokki-search-results";
    dialog.appendChild(results);

    overlay.appendChild(dialog);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);

    let currentAbort: AbortController | null = null;
    const run = async () => {
      const q = input.value.trim();
      if (!q) return;
      currentAbort?.abort();
      currentAbort = new AbortController();
      results.innerHTML = "";
      status.textContent = "검색 중…";
      submit.disabled = true;
      try {
        const data = await searchBooks(q, currentAbort.signal);
        submit.disabled = false;
        if (!data.results.length) {
          status.textContent = "검색 결과 없음.";
          return;
        }
        status.textContent = `${data.total}건 중 ${data.results.length}건 표시`;
        for (const r of data.results) results.appendChild(renderCard(r));
      } catch (e) {
        submit.disabled = false;
        if ((e as Error).name === "AbortError") return;
        status.textContent = `오류: ${(e as Error).message}`;
      }
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void run();
    });
    if (input.value.trim()) void run();

    function renderCard(r: NlBookResult): HTMLElement {
      const card = document.createElement("button");
      card.className = "dokki-search-card";
      card.type = "button";

      const coverBox = document.createElement("div");
      coverBox.className = "dokki-search-cover";
      const coverFallback = () => {
        coverBox.textContent = (r.title[0] ?? "?").toUpperCase();
        coverBox.classList.add("dokki-search-cover-fallback");
      };
      if (r.coverUrl) {
        const img = document.createElement("img");
        img.src = r.coverUrl;
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", () => {
          img.remove();
          coverFallback();
        });
        coverBox.appendChild(img);
      } else {
        coverFallback();
      }
      card.appendChild(coverBox);

      const text = document.createElement("div");
      text.className = "dokki-search-text";
      const t = document.createElement("div");
      t.className = "dokki-search-card-title";
      t.textContent = r.title;
      text.appendChild(t);
      const s = document.createElement("div");
      s.className = "dokki-search-card-sub";
      s.textContent = [r.author, r.publisher, r.pubYear].filter(Boolean).join(" · ");
      text.appendChild(s);
      if (r.isbn) {
        const i = document.createElement("div");
        i.className = "dokki-search-card-isbn";
        i.textContent = `ISBN ${r.isbn}`;
        text.appendChild(i);
      }
      card.appendChild(text);

      card.addEventListener("click", () => opts.onPick(r, card, () => overlay.remove()));
      return card;
    }
  }

  function openSearch(b: BookNote) {
    openBookSearchDialog({
      title: "서지정보 검색",
      initialQuery: b.title,
      onPick: (r, _card, closeOverlay) => {
        const meta = setMetadata(b.filePath, r);
        closeOverlay();
        const inner = panel.querySelector(".dokki-panel-inner") as HTMLElement;
        const head = inner.querySelector(".dokki-panel-head") as HTMLElement;
        if (head) renderHead(head, b);
        // Sample a spine tint from the cover once, then cache + re-render stack.
        if (r.coverUrl && !meta.coverColor) {
          void extractCoverColor(r.coverUrl).then((color) => {
            if (!color) return;
            setCoverColor(b.filePath, color);
            renderStack();
            graph?.recolor(); // repaint the matching star with the new cover tint
          });
        }
      },
    });
  }

  function closePanel() {
    removeAllMemoPopovers();
    panel.classList.remove("is-open");
    panel.classList.remove("is-bold-only");
    panelBackdrop.classList.remove("is-open");
    document.documentElement.classList.remove("dokki-scroll-lock");
    pageIndex.style.display = "none";
    if (idxScrollHandler) {
      panel.removeEventListener("scroll", idxScrollHandler);
      idxScrollHandler = null;
    }
  }

  // --- page index (left popover) -----------------------------------------
  const applyIdxPos = () => {
    if (!idxPos) return;
    pageIndex.style.left = `${idxPos.left}px`;
    pageIndex.style.top = `${idxPos.top}px`;
  };
  const makeIndexDraggable = (head: HTMLElement) => {
    head.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startLeft = pageIndex.offsetLeft;
      const startTop = pageIndex.offsetTop;
      const sx = e.clientX;
      const sy = e.clientY;
      const move = (ev: PointerEvent) => {
        idxPos = { left: startLeft + (ev.clientX - sx), top: startTop + (ev.clientY - sy) };
        applyIdxPos();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  };

  function scrollToPage(page: number, sub?: string) {
    const inner = panel.querySelector(".dokki-panel-inner") as HTMLElement | null;
    const section = inner?.querySelector(
      `.dokki-panel-page[data-page="${page}"]`,
    ) as HTMLElement | null;
    if (!section) return;
    let target: HTMLElement = section;
    if (sub) {
      const hit = Array.from(section.querySelectorAll<HTMLElement>(".dokki-subheading")).find(
        (e) => (e.textContent ?? "").trim() === sub,
      );
      if (hit) target = hit;
    }
    // Instant jump — a smooth scroll over a long distance felt laggy.
    target.scrollIntoView({ block: sub ? "center" : "start" });
  }

  // The index is a vertical "roulette": the page you're scrolled to sits in
  // the centre, two smaller/fainter pages above and below, and the whole wheel
  // spins as the reading position crosses page boundaries.
  const PI_ROW = 26; // px per row (keep in sync with CSS)
  function buildPageIndex(b: BookNote) {
    if (idxScrollHandler) {
      panel.removeEventListener("scroll", idxScrollHandler);
      idxScrollHandler = null;
    }
    pageIndex.innerHTML = "";
    if (!b.pages.length) {
      pageIndex.style.display = "none";
      return;
    }
    // Drag bar with a faint "current / total" counter. The drag affordance
    // (the bar) stays the dominant visual; the counter sits centred under it.
    const head = document.createElement("div");
    head.className = "dokki-pageindex-head";
    pageIndex.appendChild(head);
    makeIndexDraggable(head);
    const counter = document.createElement("span");
    counter.className = "dokki-pageindex-count";
    head.appendChild(counter);

    const wheel = document.createElement("div");
    wheel.className = "dokki-pageindex-wheel";
    const track = document.createElement("div");
    track.className = "dokki-pageindex-track";
    const items = b.pages.map((p, i) => {
      const it = document.createElement("button");
      it.type = "button";
      it.className = "dokki-pageindex-item";
      it.textContent = `p.${p.page}`;
      it.addEventListener("click", () => {
        if (dragMoved) {
          dragMoved = false; // this was a spin-drag, not a tap
          return;
        }
        scrollToPage(p.page); // jump the note to this page
        setCurrent(i); // and spin the wheel to it
      });
      track.appendChild(it);
      return it;
    });
    wheel.appendChild(track);
    pageIndex.appendChild(wheel);
    applyIdxPos();
    pageIndex.style.display = "block";

    let current = -1;
    let dragMoved = false; // a wheel drag happened → swallow the trailing click
    let wheelDragging = false; // pause scroll-sync while spinning the wheel
    const setCurrent = (idx: number) => {
      if (idx === current) return;
      current = idx;
      track.style.transform = `translateY(${(2 - idx) * PI_ROW}px)`;
      counter.textContent = `${idx + 1} / ${items.length}`;
      items.forEach((el, i) => {
        const d = Math.abs(i - idx);
        el.style.opacity = d === 0 ? "1" : d === 1 ? "0.78" : d === 2 ? "0.5" : "0";
        el.style.transform = `scale(${d === 0 ? 1 : d === 1 ? 0.9 : 0.8})`;
        el.style.pointerEvents = d > 2 ? "none" : "auto";
        el.classList.toggle("is-current", d === 0);
      });
    };

    // Which page section is nearest the panel's vertical centre.
    const nearestPage = (): number => {
      const sections = panel.querySelectorAll<HTMLElement>(".dokki-panel-page");
      const pr = panel.getBoundingClientRect();
      const cy = pr.top + pr.height / 2;
      let best = 0;
      let bestDist = Infinity;
      sections.forEach((sec, i) => {
        const r = sec.getBoundingClientRect();
        const dist = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    };

    let raf = 0;
    idxScrollHandler = () => {
      if (wheelDragging || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setCurrent(nearestPage());
      });
    };
    panel.addEventListener("scroll", idxScrollHandler);

    // Drag vertically on the wheel to spin through pages (like a picker).
    wheel.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const startY = e.clientY;
      const startIdx = current;
      dragMoved = false;
      wheelDragging = true;
      wheel.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        if (Math.abs(dy) > 4) dragMoved = true;
        const idx = Math.max(0, Math.min(items.length - 1, startIdx + Math.round(-dy / PI_ROW)));
        if (idx !== current) {
          setCurrent(idx);
          scrollToPage(b.pages[idx].page);
        }
      };
      const up = (ev: PointerEvent) => {
        try {
          wheel.releasePointerCapture(ev.pointerId);
        } catch {
          /* already released */
        }
        wheel.removeEventListener("pointermove", move);
        wheel.removeEventListener("pointerup", up);
        setTimeout(() => (wheelDragging = false), 60);
      };
      wheel.addEventListener("pointermove", move);
      wheel.addEventListener("pointerup", up);
    });
    // Scrolling the mouse wheel over the popover spins it one page at a time
    // and jumps the note panel along with it. Throttled so a fast flick still
    // feels like discrete steps, and we pause the panel→wheel sync briefly so
    // the two don't oscillate.
    let wheelLast = 0;
    wheel.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const now = performance.now();
        if (now - wheelLast < 110) return;
        wheelLast = now;
        const dir = e.deltaY > 0 ? 1 : -1;
        const next = Math.max(0, Math.min(items.length - 1, current + dir));
        if (next === current) return;
        wheelDragging = true;
        setCurrent(next);
        scrollToPage(b.pages[next].page);
        setTimeout(() => (wheelDragging = false), 140);
      },
      { passive: false },
    );

    // Start with the first page centred (no spin), then enable the animation —
    // a focus-scroll or the reader scrolling will spin it from there.
    track.style.transition = "none";
    setCurrent(0);
    requestAnimationFrame(() => (track.style.transition = ""));
  }

  // 재렌더 경합 방지 — 로딩이 끝나기 전에 다시 렌더되면 이전 결과는 버린다.
  let graphGen = 0;
  function renderGraphSection() {
    const gen = ++graphGen;
    graph?.cleanup();
    graph = null;
    graphWrap.innerHTML = "";
    // 모바일에선 그래프 섹션이 CSS로 숨겨진다 — WebGL 컨텍스트를 만들 이유가
    // 없으니 렌더 자체를 건너뛴다. (데스크톱 전환 시 리사이즈에서 재렌더.)
    if (window.matchMedia("(max-width: 768px)").matches) return;
    graphWrap.classList.toggle("is-cube", graphView === "cube");
    viewBtns.forEach((btn, mode) => btn.classList.toggle("is-active", mode === graphView));
    const open = (path: string) => {
      const b = books.find((x) => x.filePath === path);
      if (b) openNote(b);
    };
    const load =
      graphView === "cube"
        ? import("./cubeView").then((m) => m.renderCube(graphWrap, books, open, state.graphBasis))
        : import("./graphView").then((m) => m.renderGraph(graphWrap, books, open, state.graphBasis));
    void load.then((handle) => {
      if (gen !== graphGen) {
        handle.cleanup(); // 그 사이 다른 렌더가 시작됨 — 이 결과는 폐기
        return;
      }
      graph = handle;
      updateGraphHighlight();
    });
  }
  // 모바일 ↔ 데스크톱 경계를 넘으면 그래프를 만들거나 정리한다.
  const graphMedia = window.matchMedia("(max-width: 768px)");
  graphMedia.addEventListener("change", () => renderGraphSection());

  function updateGraphHighlight() {
    if (!graph) return;
    if (!hasActiveFilter(state)) {
      graph.setHighlight(null);
      return;
    }
    const ids = new Set(filtered(state, books).map((b) => b.filePath));
    graph.setHighlight(ids);
  }

  function renderStack() {
    selectedPaths.clear();
    stackWrap.innerHTML = "";
    stackWrap.appendChild(marquee);
    renderBookStack(
      stackWrap,
      filtered(state, books).filter((b) => !isNonfiction(b)),
      (path) => {
        if (suppressOpen) {
          suppressOpen = false; // swallow the click that ended a marquee drag
          return;
        }
        const b = books.find((x) => x.filePath === path);
        if (b) openNote(b);
      },
      {
        tintFor: (path) => getMetadata(path)?.coverColor,
        onContextMenu: (path, x, y) => {
          if (selectedPaths.size > 1 && selectedPaths.has(path)) {
            openMultiDeleteMenu([...selectedPaths], x, y);
            return;
          }
          if (selectedPaths.size) {
            selectedPaths.clear();
            applySelectionClasses();
          }
          const b = books.find((x2) => x2.filePath === path);
          if (b) openSpineMenu(b, x, y);
        },
      },
    );
  }

  function renderNonfiction() {
    nonfictionWrap.innerHTML = "";
    nonfictionWrap.appendChild(nfMarquee); // re-attach: innerHTML clobbered it
    const pool = filtered(state, books).filter(isNonfiction);
    if (!pool.length) return;

    // 위시리스트와 같은 급의 섹션 헤더 — 세 목록의 위계를 같은 문법으로.
    const head = document.createElement("div");
    head.className = "dokki-list-head";
    const title = document.createElement("span");
    title.textContent = "짧은 발췌";
    head.appendChild(title);
    nonfictionWrap.appendChild(head);

    const list = document.createElement("div");
    list.className = "dokki-nonfiction-list";
    for (const b of pool) {
      const row = document.createElement("article");
      row.className = "dokki-nf-row";
      row.dataset.path = b.filePath;
      const ttlEl = document.createElement("div");
      ttlEl.className = "dokki-nf-title";
      ttlEl.textContent = b.title;
      row.appendChild(ttlEl);
      const preview = bodyPreview(b);
      if (preview) {
        const pv = document.createElement("div");
        pv.className = "dokki-nf-preview";
        pv.textContent = preview;
        row.appendChild(pv);
      }
      row.addEventListener("click", () => {
        if (suppressOpen) {
          suppressOpen = false; // swallow the click that ended a marquee drag
          return;
        }
        if (selectedPaths.size) {
          selectedPaths.clear();
          applySelectionClasses();
        }
        openNote(b);
      });
      if (!isDemoPath(b.filePath)) {
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          // Multi-select right-click → bulk delete (like the book stack).
          if (selectedPaths.size > 1 && selectedPaths.has(b.filePath)) {
            openMultiDeleteMenu([...selectedPaths], e.clientX, e.clientY);
            return;
          }
          if (selectedPaths.size) {
            selectedPaths.clear();
            applySelectionClasses();
          }
          openSpineMenu(b, e.clientX, e.clientY);
        });
      }
      list.appendChild(row);
    }
    nonfictionWrap.appendChild(list);
    applySelectionClasses();
  }

  // Shared right-click context menu scaffold. Items run after the menu closes;
  // clicking anywhere outside dismisses it.
  interface CtxItem {
    label: string;
    danger?: boolean;
    onClick: () => void;
  }
  function openCtxMenu(x: number, y: number, items: CtxItem[]): void {
    document.querySelector(".dokki-ctx-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "dokki-ctx-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    for (const it of items) {
      const btn = document.createElement("button");
      btn.className = it.danger ? "dokki-ctx-item dokki-ctx-danger" : "dokki-ctx-item";
      btn.textContent = it.label;
      btn.addEventListener("click", () => {
        menu.remove();
        it.onClick();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", close);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", close), 0);
  }

  function openSpineMenu(b: BookNote, x: number, y: number) {
    // Edit/delete only for the user's own uploaded notes.
    if (!isCloudEnabled || !getUser() || isDemoPath(b.filePath)) return;
    openCtxMenu(x, y, [
      { label: "태그 수정하기", onClick: () => openTagEditor(b) },
      {
        label: "삭제하기",
        danger: true,
        onClick: async () => {
          if (!confirm(`"${b.title}" 노트를 삭제할까요? 되돌릴 수 없습니다.`)) return;
          try {
            await onDelete(b.filePath);
          } catch (e) {
            alert(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      },
    ]);
  }

  // Tag editor with autocomplete over the tags already used across your notes.
  // Edits the note's own frontmatter tags only — KDC overlay tags aren't
  // editable here (they're derived from the linked call number).
  function openTagEditor(b: BookNote) {
    const STAR = /^[★☆✦✧⭐]+$/;
    const current = b.frontmatter.tags.filter((t) => !STAR.test(t));
    const known = uniqueSorted(
      books.flatMap((bk) => bk.frontmatter.tags).filter((t) => !STAR.test(t)),
    );

    const overlay = document.createElement("div");
    overlay.className = "dokki-search-overlay";
    const dialog = document.createElement("div");
    dialog.className = "dokki-search-dialog dokki-tagedit";

    const head = document.createElement("div");
    head.className = "dokki-search-head";
    const heading = document.createElement("h3");
    heading.textContent = "태그 수정";
    head.appendChild(heading);
    const closeBtn = document.createElement("button");
    closeBtn.className = "dokki-panel-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => overlay.remove());
    head.appendChild(closeBtn);
    dialog.appendChild(head);

    // Field = current tags as removable chips + an inline text input.
    const field = document.createElement("div");
    field.className = "dokki-tagedit-field";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "dokki-tagedit-input";
    input.placeholder = "태그 입력 후 Enter (경로는 / 예: 문학/해외문학)";
    field.appendChild(input);
    dialog.appendChild(field);

    // Recommended classification tags from the linked book's open-API record
    // (its KDC call number). Seeded from stored metadata, then refreshed by an
    // ISBN lookup so books linked before the call number was captured still get
    // suggestions. Clicking one bakes it into the note's tags (and the .md).
    const rec = document.createElement("div");
    rec.className = "dokki-tagedit-rec";
    dialog.appendChild(rec);

    const sugg = document.createElement("div");
    sugg.className = "dokki-tagedit-sugg";
    dialog.appendChild(sugg);

    const actions = document.createElement("div");
    actions.className = "dokki-tagedit-actions";
    const save = document.createElement("button");
    save.className = "dokki-search-submit";
    save.textContent = "저장";
    actions.appendChild(save);
    dialog.appendChild(actions);

    let dragFrom = -1;
    const renderChips = () => {
      field.querySelectorAll(".dokki-tagedit-chip").forEach((n) => n.remove());
      current.forEach((t, i) => {
        const chip = document.createElement("span");
        chip.className = "dokki-tagedit-chip";
        chip.draggable = true;
        chip.textContent = t;
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "×";
        x.draggable = false; // let the × click through instead of starting a drag
        x.addEventListener("click", () => {
          current.splice(i, 1);
          renderChips();
          renderSugg();
          renderRec();
          input.focus();
        });
        chip.appendChild(x);
        // Drag-to-reorder.
        chip.addEventListener("dragstart", (e) => {
          dragFrom = i;
          chip.classList.add("is-dragging");
          e.dataTransfer?.setData("text/plain", String(i));
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        });
        chip.addEventListener("dragend", () => {
          dragFrom = -1;
          field
            .querySelectorAll(".dokki-tagedit-chip")
            .forEach((n) => n.classList.remove("is-dragging", "is-drop-target"));
        });
        chip.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          if (dragFrom !== i) chip.classList.add("is-drop-target");
        });
        chip.addEventListener("dragleave", () => chip.classList.remove("is-drop-target"));
        chip.addEventListener("drop", (e) => {
          e.preventDefault();
          chip.classList.remove("is-drop-target");
          if (dragFrom < 0 || dragFrom === i) return;
          const [moved] = current.splice(dragFrom, 1);
          current.splice(i, 0, moved);
          dragFrom = -1;
          renderChips();
          renderSugg();
          renderRec();
        });
        field.insertBefore(chip, input);
      });
    };
    const addTag = (raw: string) => {
      const t = raw.trim();
      if (!t || current.includes(t)) {
        input.value = "";
        renderSugg();
        return;
      }
      current.push(t);
      input.value = "";
      renderChips();
      renderSugg();
      renderRec();
    };
    let recTags: string[] = kdcTagsFromCallNo(getMetadata(b.filePath)?.callNo);
    const renderRec = () => {
      const pool = recTags.filter((t) => !current.includes(t));
      rec.innerHTML = "";
      if (!pool.length) return;
      const lbl = document.createElement("span");
      lbl.className = "dokki-tagedit-rec-label";
      lbl.textContent = "추천 분류";
      rec.appendChild(lbl);
      for (const t of pool) {
        const s = document.createElement("button");
        s.type = "button";
        s.className = "dokki-tagedit-sugg-item dokki-tagedit-rec-item";
        s.textContent = tagLabel(t);
        s.addEventListener("click", () => {
          addTag(t);
          input.focus();
        });
        rec.appendChild(s);
      }
    };
    const renderSugg = () => {
      const q = input.value.trim().toLowerCase();
      const pool = known.filter((t) => !current.includes(t) && (!q || t.toLowerCase().includes(q)));
      sugg.innerHTML = "";
      for (const t of pool.slice(0, 24)) {
        const s = document.createElement("button");
        s.type = "button";
        s.className = "dokki-tagedit-sugg-item";
        s.textContent = t;
        s.addEventListener("click", () => {
          addTag(t);
          input.focus();
        });
        sugg.appendChild(s);
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addTag(input.value);
      } else if (e.key === "Backspace" && input.value === "" && current.length) {
        current.pop();
        renderChips();
        renderSugg();
        renderRec();
      }
    });
    input.addEventListener("input", () => renderSugg());

    save.addEventListener("click", async () => {
      if (input.value.trim()) addTag(input.value); // commit a half-typed tag
      const rating = b.frontmatter.rating;
      const tags = [...(rating ? ["☆".repeat(rating)] : []), ...current];
      save.disabled = true;
      try {
        await onEditTags(b.filePath, tags);
        overlay.remove();
      } catch (e) {
        save.disabled = false;
        alert(`태그 수정 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    overlay.appendChild(dialog);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    renderChips();
    renderSugg();
    renderRec();
    setTimeout(() => input.focus(), 50);

    // Refresh recommendations from a live ISBN lookup (covers books linked
    // before the call number was stored, or matched without one).
    const isbn = getMetadata(b.filePath)?.isbn?.replace(/[-\s]/g, "");
    if (isbn) {
      void searchBooks(isbn)
        .then((resp) => {
          const hit =
            resp.results.find((r) => r.isbn?.replace(/[-\s]/g, "") === isbn) ?? resp.results[0];
          let changed = false;
          for (const t of kdcTagsFromCallNo(hit?.callNo)) {
            if (!recTags.includes(t)) {
              recTags.push(t);
              changed = true;
            }
          }
          if (changed) renderRec();
        })
        .catch(() => {});
    }
  }

  function openMultiDeleteMenu(paths: string[], x: number, y: number) {
    const deletable = paths.filter((p) => !isDemoPath(p));
    if (!isCloudEnabled || !getUser() || deletable.length === 0) return;
    openCtxMenu(x, y, [
      {
        label: `삭제하기 (${deletable.length}개)`,
        danger: true,
        onClick: async () => {
          if (!confirm(`선택한 ${deletable.length}개 노트를 삭제할까요? 되돌릴 수 없습니다.`)) return;
          try {
            await onDeleteMany(deletable);
          } catch (e) {
            alert(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      },
    ]);
  }

  function renderControlsBar() {
    const next = renderControls(state, books, {
      onSearchOrFilter: () => {
        renderStack();
        renderNonfiction();
        updateGraphHighlight();
      },
      onGraphBasisChange: () => {
        renderGraphSection();
      },
    });
    next.appendChild(uploadSlot); // upload button to the right of the filter
    if (controlsEl) controlsEl.replaceWith(next);
    else controlsHolder.appendChild(next);
    controlsEl = next;
  }

  function renderAuthSlot() {
    authSlot.innerHTML = "";
    if (!isCloudEnabled) return; // localStorage-only mode: no auth UI
    const user = getUser();
    if (user) {
      const name = document.createElement("span");
      name.className = "dokki-auth-name";
      name.textContent = userLabel(user);
      const out = document.createElement("button");
      out.className = "dokki-auth-btn";
      out.textContent = "로그아웃";
      out.addEventListener("click", () => void signOut());
      authSlot.append(name, out);
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "dokki-auth-login";
    const trigger = document.createElement("button");
    trigger.className = "dokki-auth-btn";
    trigger.textContent = "로그인";
    const menu = document.createElement("div");
    menu.className = "dokki-auth-menu";
    const g = document.createElement("button");
    g.className = "dokki-auth-provider";
    g.textContent = "Google로 로그인";
    g.addEventListener("click", () => void signInWith("google"));
    const k = document.createElement("button");
    k.className = "dokki-auth-provider";
    k.textContent = "Kakao로 로그인";
    k.addEventListener("click", () => void signInWith("kakao"));
    menu.append(g, k);

    // Email magic-link: type an address → receive a styled login link.
    const divider = document.createElement("div");
    divider.className = "dokki-auth-divider";
    divider.textContent = "또는 이메일로";
    const emailForm = document.createElement("form");
    emailForm.className = "dokki-auth-email";
    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.required = true;
    emailInput.placeholder = "you@example.com";
    emailInput.autocomplete = "email";
    emailInput.className = "dokki-auth-email-input";
    // The menu closes on outside *click*; typing shouldn't close it.
    emailInput.addEventListener("click", (e) => e.stopPropagation());
    const emailSend = document.createElement("button");
    emailSend.type = "submit";
    emailSend.className = "dokki-auth-email-send";
    emailSend.textContent = "로그인 링크 보내기";
    const emailMsg = document.createElement("div");
    emailMsg.className = "dokki-auth-email-msg";
    emailForm.append(emailInput, emailSend);
    emailForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const email = emailInput.value.trim();
      if (!email) return;
      emailSend.disabled = true;
      emailMsg.classList.remove("is-error");
      emailMsg.textContent = "전송 중…";
      try {
        await signInWithEmail(email);
        emailMsg.textContent = "메일함을 확인하세요 — 로그인 링크를 보냈습니다.";
        emailInput.value = "";
      } catch (err) {
        emailMsg.classList.add("is-error");
        emailMsg.textContent = `전송 실패: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        emailSend.disabled = false;
      }
    });
    menu.append(divider, emailForm, emailMsg);

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("is-open");
    });
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target as Node)) menu.classList.remove("is-open");
    });
    wrap.append(trigger, menu);
    authSlot.appendChild(wrap);
  }

  function renderUploadSlot() {
    uploadSlot.innerHTML = "";
    // Uploads need an account. Only show when signed in.
    if (!isCloudEnabled || !getUser()) return;
    // Same pill as the filter button, with a leading "+" icon.
    const btn = document.createElement("button");
    btn.className = "dokki-filter-btn";
    const icon = document.createElement("span");
    icon.className = "dokki-filter-icon";
    icon.textContent = "＋";
    const lbl = document.createElement("span");
    lbl.textContent = "노트 올리기";
    btn.append(icon, lbl);
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".md,text/markdown";
    picker.multiple = true;
    picker.style.display = "none";
    picker.addEventListener("change", () => {
      if (picker.files && picker.files.length) void doUpload(Array.from(picker.files));
      picker.value = "";
    });
    btn.addEventListener("click", () => picker.click());
    uploadSlot.append(btn, picker);
  }

  async function doUpload(files: File[]) {
    try {
      await onUpload(files);
    } catch (e) {
      alert(`업로드 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Whole-app drag & drop (signed-in only).
  const dropOverlay = document.createElement("div");
  dropOverlay.className = "dokki-drop-overlay";
  dropOverlay.textContent = "여기에 .md 파일을 놓으세요";
  mount.appendChild(dropOverlay);
  let dragDepth = 0;
  const canUpload = () => isCloudEnabled && !!getUser();
  mount.addEventListener("dragenter", (e) => {
    if (!canUpload()) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.classList.add("is-active");
  });
  mount.addEventListener("dragover", (e) => {
    if (canUpload()) e.preventDefault();
  });
  mount.addEventListener("dragleave", () => {
    if (!canUpload()) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.remove("is-active");
  });
  mount.addEventListener("drop", (e) => {
    if (!canUpload()) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove("is-active");
    const files = e.dataTransfer?.files;
    if (files && files.length) void doUpload(Array.from(files));
  });

  function renderWishlist() {
    wishWrap.innerHTML = "";
    const head = document.createElement("div");
    head.className = "dokki-list-head dokki-wishlist-head";
    const title = document.createElement("span");
    title.textContent = "읽고 싶은 도서";
    const add = document.createElement("button");
    add.className = "dokki-wishlist-add";
    add.textContent = "+";
    add.title = "도서 검색해서 추가";
    add.addEventListener("click", () => openWishlistSearch());
    head.append(title, add);
    wishWrap.appendChild(head);

    const list = document.createElement("div");
    list.className = "dokki-wishlist-list";
    // Once a note exists for a wished title, drop it from the list automatically.
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");
    const owned = new Set(books.map((b) => norm(b.title)));
    let items = getWishlist();
    const matched = items.filter((it) => owned.has(norm(it.title)));
    if (matched.length) {
      for (const m of matched) removeWishlist(m.id);
      items = getWishlist();
    }
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "dokki-wishlist-empty";
      empty.textContent = "+ 로 검색해서 추가";
      list.appendChild(empty);
    } else {
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "dokki-wish-row";
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          openCtxMenu(e.clientX, e.clientY, [
            {
              label: "삭제하기",
              danger: true,
              onClick: () => {
                removeWishlist(it.id);
                renderWishlist();
              },
            },
          ]);
        });
        const t = document.createElement("div");
        t.className = "dokki-wish-title";
        t.textContent = it.title;
        row.appendChild(t);
        if (it.author) {
          const a = document.createElement("div");
          a.className = "dokki-wish-author";
          a.textContent = it.author;
          row.appendChild(a);
        }
        const del = document.createElement("button");
        del.className = "dokki-wish-del";
        del.textContent = "×";
        del.title = "삭제";
        del.addEventListener("click", () => {
          removeWishlist(it.id);
          renderWishlist();
        });
        row.appendChild(del);
        list.appendChild(row);
      }
    }
    wishWrap.appendChild(list);
  }

  function openWishlistSearch() {
    openBookSearchDialog({
      title: "읽고 싶은 도서 검색",
      onPick: (r, card) => {
        addWishlist({
          id: r.isbn || r.controlNo || `${r.title}|${r.author ?? ""}`,
          title: r.title,
          author: r.author,
        });
        renderWishlist();
        card.classList.add("is-added");
        card.disabled = true;
      },
    });
  }

  function renderAll() {
    mount.classList.toggle("dokki-demo", isDemo);
    renderExcerpt(excerptWrap, books, (b, focus) => openNote(b, focus));
    renderControlsBar();
    renderGraphSection();
    renderStack();
    renderNonfiction();
    renderAuthSlot();
    renderUploadSlot();
    renderWishlist();
  }

  renderAll();

  return {
    reload(nextBooks: BookNote[], nextIsDemo: boolean) {
      books = nextBooks;
      isDemo = nextIsDemo;
      closePanel();
      renderAll();
    },
  };
}

function hasActiveFilter(state: ControlsState): boolean {
  return (
    state.search.trim().length > 0 ||
    state.filterAuthors.size > 0 ||
    state.filterTags.size > 0 ||
    state.filterStatuses.size > 0 ||
    state.filterRatings.size > 0
  );
}

function renderExcerpt(
  wrap: HTMLElement,
  books: BookNote[],
  onOpen: (b: BookNote, focus?: { page: number; text: string }) => void,
): void {
  wrap.innerHTML = "";
  const bolds = books.flatMap((b) => b.allBolds);
  if (!bolds.length) {
    const empty = document.createElement("div");
    empty.className = "dokki-excerpt-empty";
    empty.textContent = "발췌가 아직 없습니다.";
    wrap.appendChild(empty);
    return;
  }
  const draw = () => {
    wrap.innerHTML = "";
    const pick = bolds[Math.floor(Math.random() * bolds.length)];
    const b = books.find((x) => x.filePath === pick.filePath);
    const quote = document.createElement("blockquote");
    quote.className = "dokki-quote";
    // Strip quotes per line so a merged multi-line dialogue reads as one quote
    // (the outer “ ” come from CSS); line breaks are preserved.
    quote.textContent = pick.text.split("\n").map(stripWrappingQuotes).join("\n");
    wrap.appendChild(quote);
    const meta = document.createElement("div");
    meta.className = "dokki-quote-meta";
    const title = document.createElement("span");
    title.className = "dokki-quote-title";
    title.textContent = pick.bookTitle;
    title.addEventListener("click", () => b && onOpen(b, { page: pick.page, text: pick.text }));
    meta.appendChild(title);
    if (pick.author) {
      meta.append(sep(), spanOf(pick.author));
    }
    meta.append(sep(), spanOf(`p.${pick.page}`));
    wrap.appendChild(meta);
    const reroll = document.createElement("button");
    reroll.className = "dokki-reroll";
    reroll.textContent = "↻";
    reroll.title = "다른 발췌 보기";
    reroll.addEventListener("click", draw);
    wrap.appendChild(reroll);
  };
  draw();
}

interface ControlsState {
  filterAuthors: Set<string>;
  filterTags: Set<string>;
  filterStatuses: Set<string>;
  filterRatings: Set<string>;
  search: string;
  graphBasis: GraphBasis;
}

interface ControlsHooks {
  onSearchOrFilter: () => void;
  /** Graph connection basis changed → rebuild the graph. */
  onGraphBasisChange: () => void;
}

// Single-select chips for the graph connection basis.
const GRAPH_BASIS_OPTIONS: Array<[GraphBasis, string]> = [
  ["off", "연결 끄기"],
  ["author", "저자"],
  ["tag", "태그"],
  ["both", "저자+태그"],
];

const STATUS_OPTIONS: Array<[string, string]> = [
  ["reading", "읽는 중"],
  ["stopped", "중단"],
  ["finished", "완독"],
  ["unknown", "기타"],
];

function renderControls(
  state: ControlsState,
  books: BookNote[],
  hooks: ControlsHooks,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "dokki-controls";

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "검색 (제목·저자·태그·본문)";
  search.className = "dokki-search";
  search.addEventListener("input", () => {
    state.search = search.value;
    hooks.onSearchOrFilter();
  });
  bar.appendChild(search);

  bar.appendChild(renderFilterButton(state, books, hooks));
  return bar;
}

function renderFilterButton(
  state: ControlsState,
  books: BookNote[],
  hooks: ControlsHooks,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "dokki-filter-root";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dokki-filter-btn";
  const icon = document.createElement("span");
  icon.className = "dokki-filter-icon";
  icon.textContent = "≡";
  const label = document.createElement("span");
  label.textContent = "필터";
  const badge = document.createElement("span");
  badge.className = "dokki-filter-badge";
  btn.append(icon, label, badge);
  root.appendChild(btn);

  const popover = document.createElement("div");
  popover.className = "dokki-filter-popover";
  root.appendChild(popover);

  const activeCount = () =>
    state.filterStatuses.size +
    state.filterAuthors.size +
    state.filterTags.size +
    state.filterRatings.size;

  const refreshBadge = () => {
    const n = activeCount();
    badge.textContent = String(n);
    btn.classList.toggle("is-active", n > 0);
  };

  const onChipChange = () => {
    refreshBadge();
    hooks.onSearchOrFilter();
  };

  // Drag-to-move: grab the popover by its header. Position (relative to the
  // filter root) persists across rebuilds and reopens.
  let popPos: { left: number; top: number } | null = null;
  const applyPopPos = () => {
    if (!popPos) return;
    popover.style.left = `${popPos.left}px`;
    popover.style.top = `${popPos.top}px`;
    popover.style.right = "auto";
  };
  const makeHeadDraggable = (head: HTMLElement) => {
    head.style.cursor = "move";
    head.style.userSelect = "none";
    head.style.touchAction = "none";
    head.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".dokki-filter-clear")) return;
      e.preventDefault();
      const startLeft = popover.offsetLeft;
      const startTop = popover.offsetTop;
      const sx = e.clientX;
      const sy = e.clientY;
      popover.style.left = `${startLeft}px`;
      popover.style.top = `${startTop}px`;
      popover.style.right = "auto";
      // Track on window so the drag keeps up even if the cursor outruns the
      // small header.
      const move = (ev: PointerEvent) => {
        popPos = { left: startLeft + (ev.clientX - sx), top: startTop + (ev.clientY - sy) };
        applyPopPos();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  };

  const buildPopover = () => {
    popover.innerHTML = "";
    const head = document.createElement("div");
    head.className = "dokki-filter-popover-head";
    const title = document.createElement("span");
    title.textContent = "필터";
    head.appendChild(title);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "dokki-filter-clear";
    clear.textContent = "초기화";
    clear.addEventListener("click", () => {
      state.filterStatuses.clear();
      state.filterAuthors.clear();
      state.filterTags.clear();
      state.filterRatings.clear();
      buildPopover();
      refreshBadge();
      hooks.onSearchOrFilter();
    });
    head.appendChild(clear);
    popover.appendChild(head);
    makeHeadDraggable(head);

    // Graph connection basis (single-select; a view preference, not a filter —
    // so it sits apart from the badge/초기화).
    popover.appendChild(
      buildModeSection("연결", GRAPH_BASIS_OPTIONS, state.graphBasis, (next) => {
        state.graphBasis = next;
        buildPopover();
        hooks.onGraphBasisChange();
      }),
    );

    const authors = uniqueSorted(books.map((b) => b.frontmatter.author ?? "").filter(Boolean));
    // Tag filter chips ordered by hierarchy (broad → narrow, via the deepest
    // full tag path each leaf appears in) instead of 가나다, with 전집 tags
    // pushed to the very end. Matching still uses the leaf value.
    const STAR = /^[★☆✦✧⭐]+$/;
    const leafPath = new Map<string, string>();
    for (const b of books) {
      for (const t of effectiveTags(b)) {
        if (STAR.test(t)) continue;
        const leaf = tagLeafOf(t);
        const prev = leafPath.get(leaf);
        if (!prev || t.split("/").length > prev.split("/").length) leafPath.set(leaf, t);
      }
    }
    const isJip = (leaf: string) => /전집/.test(leaf) || /전집/.test(leafPath.get(leaf) ?? "");
    const tagLeaves = [...leafPath.keys()].sort((a, b) => {
      const aj = isJip(a);
      const bj = isJip(b);
      if (aj !== bj) return aj ? 1 : -1; // 전집 last
      return (leafPath.get(a) ?? a).localeCompare(leafPath.get(b) ?? b, "ko");
    });
    // Distinct ratings present in the data, high → low, labeled as filled stars.
    const ratings = Array.from(
      new Set(
        books
          .map((b) => b.frontmatter.rating)
          .filter((r): r is number => typeof r === "number" && r > 0),
      ),
    ).sort((a, b) => b - a);

    popover.appendChild(buildFilterSection("상태", STATUS_OPTIONS, state.filterStatuses, onChipChange));
    if (ratings.length) {
      popover.appendChild(
        buildFilterSection(
          "별점",
          ratings.map((r) => [String(r), "★".repeat(r)] as [string, string]),
          state.filterRatings,
          onChipChange,
        ),
      );
    }
    popover.appendChild(
      buildFilterSection(
        "저자",
        authors.map((a) => [a, a] as [string, string]),
        state.filterAuthors,
        onChipChange,
      ),
    );
    popover.appendChild(
      buildFilterSection(
        "태그",
        tagLeaves.map((t) => [t, tagLabel(t)] as [string, string]),
        state.filterTags,
        onChipChange,
      ),
    );
    applyPopPos(); // keep a dragged position across rebuilds
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = popover.classList.toggle("is-open");
    if (open) buildPopover();
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target as Node)) popover.classList.remove("is-open");
  });

  refreshBadge();
  return root;
}

// Single-select variant of a filter section: exactly one chip is active.
function buildModeSection<T extends string>(
  label: string,
  options: Array<[T, string]>,
  active: T,
  onSelect: (value: T) => void,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "dokki-filter-section";
  const heading = document.createElement("div");
  heading.className = "dokki-filter-section-label";
  heading.textContent = label;
  section.appendChild(heading);
  const list = document.createElement("div");
  list.className = "dokki-filter-section-list";
  for (const [val, text] of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dokki-filter-chip";
    if (val === active) chip.classList.add("is-active");
    chip.textContent = text;
    chip.addEventListener("click", () => {
      if (val !== active) onSelect(val);
    });
    list.appendChild(chip);
  }
  section.appendChild(list);
  return section;
}

function buildFilterSection(
  label: string,
  options: Array<[string, string]>,
  set: Set<string>,
  onChange: () => void,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "dokki-filter-section";
  const heading = document.createElement("div");
  heading.className = "dokki-filter-section-label";
  heading.textContent = label;
  section.appendChild(heading);
  const list = document.createElement("div");
  list.className = "dokki-filter-section-list";
  if (options.length === 0) {
    const empty = document.createElement("span");
    empty.className = "dokki-filter-empty";
    empty.textContent = "없음";
    list.appendChild(empty);
  } else {
    for (const [val, text] of options) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "dokki-filter-chip";
      if (set.has(val)) chip.classList.add("is-active");
      chip.textContent = text;
      chip.addEventListener("click", () => {
        if (set.has(val)) set.delete(val);
        else set.add(val);
        chip.classList.toggle("is-active");
        onChange();
      });
      list.appendChild(chip);
    }
  }
  section.appendChild(list);
  return section;
}

function filtered(state: ControlsState, books: BookNote[]): BookNote[] {
  const q = state.search.trim().toLowerCase();
  return books.filter((b) => {
    if (state.filterStatuses.size > 0 && !state.filterStatuses.has(b.status)) return false;
    if (state.filterAuthors.size > 0 && !state.filterAuthors.has(b.frontmatter.author ?? "")) return false;
    if (
      state.filterTags.size > 0 &&
      !effectiveTags(b).some((t) => state.filterTags.has(tagLeafOf(t)))
    ) {
      return false;
    }
    if (state.filterRatings.size > 0) {
      const r = b.frontmatter.rating;
      if (r === undefined || !state.filterRatings.has(String(r))) return false;
    }
    if (!q) return true;
    if (b.title.toLowerCase().includes(q)) return true;
    if ((b.frontmatter.author ?? "").toLowerCase().includes(q)) return true;
    if (effectiveTags(b).some((t) => t.toLowerCase().includes(q))) return true;
    if ((b.frontmatter.comment ?? "").toLowerCase().includes(q)) return true;
    if (b.pages.some((p) => p.body.toLowerCase().includes(q))) return true;
    return false;
  });
}

function uniqueSorted(arr: string[]): string[] {
  return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b, "ko"));
}

function sep(): HTMLElement {
  const s = document.createElement("span");
  s.className = "dokki-quote-sep";
  s.textContent = " · ";
  return s;
}

function spanOf(text: string): HTMLElement {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}

function statusChipText(b: BookNote): string | undefined {
  const fm = b.frontmatter;
  switch (b.status) {
    case "finished":
      return fm.endDate ? `완독 · ${fm.endDate}` : "완독";
    case "reading":
      return "읽는 중";
    case "stopped":
      return fm.stoppedAtPage ? `p.${fm.stoppedAtPage} 중단` : "중단";
    default:
      return fm.rawStatus || undefined;
  }
}

// When the bold excerpt is a dialogue wrapped in matching quotes,
// strip the outer pair at render time only — CSS already adds visual
// curly quotes (“ ”) via ::before/::after, so the typed quotes would
// double up. The source .md is never touched.
//
// Lenient: any character considered an "opener" + any "closer" at the
// ends counts as a wrapped pair, so we cover ASCII straight, curly,
// CJK 「」『』, French «», low-9 „, etc. — and also ASCII " on both
// ends (same char as opener and closer).
const QUOTE_OPENERS = new Set([
  '"', "'", "“", "‘", "「", "『", "«", "‹", "„", "‚", "＂", "＇",
]);
const QUOTE_CLOSERS = new Set([
  '"', "'", "”", "’", "」", "』", "»", "›", "‟", "‛", "＂", "＇",
]);
function stripWrappingQuotes(s: string): string {
  let t = s.trim();
  // Strip ends independently. If the user only bolded part of a dialogue
  // (so only the leading quote is in the bold, or only the trailing one),
  // we still want that single quote gone to avoid the doubled-quote look.
  // Up to two passes covers the rare nested-quote case.
  for (let i = 0; i < 2; i++) {
    if (t.length === 0) break;
    let changed = false;
    if (QUOTE_OPENERS.has(t[0])) {
      t = t.slice(1).trimStart();
      changed = true;
    }
    if (t.length > 0 && QUOTE_CLOSERS.has(t[t.length - 1])) {
      t = t.slice(0, -1).trimEnd();
      changed = true;
    }
    if (!changed) break;
  }
  return t;
}

// Rounded star SVG path (chunky body, soft tips).
const STAR_PATH =
  "M12 3.4l2.62 5.31 5.86.85-4.24 4.13 1 5.84L12 16.78l-5.24 2.75 1-5.84L3.52 9.56l5.86-.85L12 3.4z";
const SVG_NS = "http://www.w3.org/2000/svg";

function renderRatingEl(rating: number): HTMLElement {
  const r = Math.max(0, Math.min(5, Math.round(rating)));
  const wrap = document.createElement("span");
  wrap.className = "dokki-rating";
  wrap.title = `${r} / 5`;
  wrap.setAttribute("aria-label", `별점 ${r}점 만점 5점`);
  for (let i = 0; i < 5; i++) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", i < r ? "dokki-star is-filled" : "dokki-star");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", STAR_PATH);
    svg.appendChild(path);
    wrap.appendChild(svg);
  }
  return wrap;
}

// Bold span: may run across lines and contain an inner single-* italic
// (rendered as nested <strong><em>). Only `**` closes it.
const BOLD_HTML = /\*\*((?:[^*]|\*(?!\*))+?)\*\*/g;
// Italic: a single *…* span. Applied AFTER bold so the ** are already gone.
const ITALIC_HTML = /\*([^*\n]+?)\*/g;
// Subheadings (## / ### / #### Title) — used inside page bodies of short-story
// collections etc. We accept 1–4 hashes with a required trailing space so a
// mistyped level (## or ####) or a heading that hugs the previous line still
// reads as a subheading instead of leaking raw `#`s into the prose. `#####` is
// the page marker (5 hashes), parsed away earlier and never reaches here.
// Display label for a tag: underscores read as spaces (e.g. 민음사_세계문학전집
// → "민음사 세계문학전집"). The underscore stays in the stored/matched value.
function tagLabel(t: string): string {
  return t.replace(/_/g, " ");
}

// 조각글(fragment) notes are collected into their own section between the
// book stack and the wishlist. Classification is owned by the Obsidian plugin
// — files in its configured fragment folder land in the cloud with
// `is_fragment = true`. The frontmatter `비문학` tag no longer affects
// placement (it's just an ordinary tag now — books can carry it freely).
function isNonfiction(b: BookNote): boolean {
  return b.isFragment === true;
}

// A short, plain-text preview of a note's body for the non-fiction card —
// strips wikilink/embed/bold/italic markup and collapses whitespace.
function bodyPreview(b: BookNote, max = 140): string {
  const raw =
    b.preamble ||
    b.externalQuote ||
    b.pages.map((p) => p.body).find((s) => s.trim()) ||
    "";
  const text = raw
    .replace(/!?\[\[([^\][|#]+)(?:[|#][^\][]*)?\]\]/g, "$1") // [[Note]] / ![[..]]
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // ![alt](url) images
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/\*([^*\n]+)\*/g, "$1") // *italic*
    .replace(/^#{1,4}[ \t]+/gm, "") // # … #### heading prefix
    .replace(/^>\s?/gm, "") // > quote prefix
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

// Notes that wikilink (`[[Title]]` / `![[Title]]`) to this one — shown as a
// backlinks section at the bottom of the panel. These collected excerpts are
// usually referenced from related notes, so the connection should be visible.
const WIKILINK_ANY = /!?\[\[([^\][]+)\]\]/g;
function backlinksFor(book: BookNote, all: BookNote[]): BookNote[] {
  const out: BookNote[] = [];
  for (const other of all) {
    if (other.filePath === book.filePath) continue;
    const text = [
      other.externalQuote ?? "",
      other.preamble ?? "",
      ...other.pages.map((p) => p.body),
    ].join("\n");
    WIKILINK_ANY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_ANY.exec(text)) !== null) {
      const name = m[1].split("|")[0].split("#")[0].trim();
      if (name === book.title) {
        out.push(other);
        break;
      }
    }
  }
  return out;
}

const SUBHEADING_HTML = /^#{1,4}[ \t]+(.+?)[ \t]*$/gm;
const EMBED = /!\[\[([^\]]+)\]\]/g; // ![[Note]] / ![[Note#sec|alias]] / ![[img.png]]
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g; // ![alt](url)
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/**
 * Render a page body to HTML.
 * - `![[Note]]` transclusions show like a `>` quote (the referenced note's
 *   text pulled in when `resolveEmbed` finds it, else just the name).
 * - Images (`![alt](url)` and `![[img.png]]`) are stripped out — not shown.
 * - `### Title` → subheading, `**bold**` → highlight, big gaps → skip.
 */
function renderBodyHTML(
  body: string,
  resolveEmbed?: (name: string) => string | null,
  depth = 0,
): string {
  let html = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // --- Line-anchored block conversions first, while line starts are still
  // intact. Both rely on `^`, so they must run before any newline-stripping
  // below (otherwise a heading sitting directly on top of a quote would be
  // glued to it and the `^&gt;` quote pass would no longer match). ---
  // # … #### Title → block subheading (before bold so its text can hold **bold**).
  html = html.replace(SUBHEADING_HTML, '<span class="dokki-subheading">$1</span>');
  // `> quote` lines → a quote box. `>` was escaped to `&gt;` above. Consecutive
  // `>` lines (incl. empty `>` lines used as line breaks) form one box; a line
  // without `>` ends it, so blank-line-separated groups become separate boxes.
  html = html.replace(/(?:^&gt;[^\n]*(?:\n|$))+/gm, (block: string) => {
    const inner = block
      .replace(/\n+$/, "")
      .split("\n")
      .map((l) => l.replace(/^&gt;[ \t]?/, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, ""); // trim blank edges inside the box
    return `<span class="dokki-panel-external dokki-blockquote">${inner}</span>`;
  });
  // --- Now strip the blank lines the user happened to type around each block
  // piece, on BOTH sides, so its vertical spacing is owned solely by CSS
  // margins (consistent regardless of authoring) rather than by stray newlines
  // stacking on top of the margins. A heading gets a wide top / tight bottom
  // gap from .dokki-subheading; a quote box an even gap from .dokki-blockquote. ---
  html = html
    .replace(/(<span class="dokki-subheading">[^<]*<\/span>)\n+/g, "$1")
    .replace(/\n+(<span class="dokki-subheading">)/g, "$1")
    .replace(/(<span class="dokki-panel-external dokki-blockquote">[\s\S]*?<\/span>)\n+/g, "$1")
    .replace(/\n+(<span class="dokki-panel-external dokki-blockquote">)/g, "$1");
  // ![[…]] embeds → quote-styled block (display:block span, valid inside <pre>).
  html = html.replace(EMBED, (_m, inner: string) => {
    const name = inner.split("|")[0].split("#")[0].trim();
    if (IMG_EXT.test(name)) return ""; // images are not shown
    const resolved = depth < 1 && resolveEmbed ? resolveEmbed(name) : null;
    const innerHtml = resolved != null ? renderBodyHTML(resolved, undefined, depth + 1) : name;
    return `<span class="dokki-panel-external dokki-embed">${innerHtml}</span>`;
  });
  // Embed spacing is owned by .dokki-embed margins too — drop a blank line
  // typed right before it. (The closing side is left alone: an embed body is
  // recursively rendered and may itself contain `</span>`, which a greedy
  // match would mis-pair — the bottom margin handles that gap on its own.)
  html = html.replace(/\n+(<span class="dokki-panel-external dokki-embed">)/g, "$1");
  // [[Note]] / [[Note#sec|alias]] → a clickable link to that note (the [[ ]]
  // markup is hidden). The panel resolves the target on click and opens it;
  // links to notes not in the library simply do nothing. Runs after EMBED so
  // the `![[…]]` form is already consumed and only plain wikilinks remain.
  html = html.replace(/\[\[([^\][]+)\]\]/g, (_m, inner: string) => {
    const target = inner.split("|")[0].split("#")[0].trim();
    const alias = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1).trim() : "";
    const label = alias || target;
    return `<a class="dokki-wikilink" data-target="${target.replace(/"/g, "&quot;")}">${label}</a>`;
  });
  // ![alt](url) → images are not shown; strip them out entirely.
  html = html.replace(MD_IMAGE, "");
  // 3+ newlines = intentional skip; a single blank line is a paragraph break.
  html = html.replace(/\n{3,}/g, '<span class="dokki-skip" aria-hidden="true"></span>');
  // Bold first (rendering any nested *italic* inside it), then standalone italics.
  html = html.replace(BOLD_HTML, (_m, inner: string) => `<strong>${inner.replace(ITALIC_HTML, "<em>$1</em>")}</strong>`);
  return html.replace(ITALIC_HTML, "<em>$1</em>");
}

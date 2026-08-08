// 페이지 본문 → HTML 렌더 정규화 (순수 함수 — DOM 무관, 테스트 대상).
//
// 노트 원문은 사용자의 소스라 절대 고쳐 쓰지 않는다. 대신 이 층이 흔한 양식
// 미스(부제목 공백 누락, 블록 주변 잉여 빈 줄, 볼드 한쪽 누락은 파서가)를
// 렌더 시점에 흡수한다 — docs/FORMAT.md의 "렌더 관용" 층.

// Bold span: may run across lines and contain an inner single-* italic
// (rendered as nested <strong><em>). Only `**` closes it.
const BOLD_HTML = /\*\*((?:[^*]|\*(?!\*))+?)\*\*/g;
// Italic: a single *…* span. Applied AFTER bold so the ** are already gone.
const ITALIC_HTML = /\*([^*\n]+?)\*/g;
// Subheadings — `#`~`####` + 제목. FORMAT.md R5의 관용 규칙대로 `##제목`처럼
// 공백이 빠진 실수도 부제목으로 읽는다. `#####`(5개)는 페이지 마커라서
// (?!#)로 제외 — 파서가 먼저 소비하므로 여기 오지도 않지만, 방어적으로.
const SUBHEADING_HTML = /^#{1,4}(?!#)[ \t]*(\S[^\n]*?)[ \t]*$/gm;
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
export function renderBodyHTML(
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

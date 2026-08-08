import "./dom-polyfill";
import "./styles.css";
import { mountWebView, type WebViewHandle } from "./view-web";
import { initAuth, onAuthChange } from "./auth";
import { initMetadata } from "./note-metadata";
import { initWishlist } from "./wishlist";
import { initMemos } from "./memos";
import {
  loadBooks,
  uploadNotes,
  deleteNote,
  deleteNotes,
  isDemoPath,
  getNoteRaw,
  saveNoteContent,
  rewriteTags,
} from "./notes-store";

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

let view: WebViewHandle | null = null;

void bootstrap();

async function bootstrap() {
  // 1) Metadata cache (localStorage first → instant), then initial notes
  //    (demo when logged out). Mount immediately.
  await Promise.all([initMetadata(), initWishlist(), initMemos()]);
  const initial = await loadBooks();
  view = mountWebView({
    books: initial.books,
    isDemo: initial.isDemo,
    mount: app!,
    onUpload: handleUpload,
    onDelete: handleDelete,
    onDeleteMany: handleDeleteMany,
    onEditTags: handleEditTags,
    isDemoPath,
  });
  dismissSplash();

  // 2) Resolve the session. On any auth change, re-pull metadata + notes
  //    for the new identity and swap them into the mounted view.
  onAuthChange(() => void refresh());
  await initAuth();
}

async function refresh() {
  await Promise.all([initMetadata(), initWishlist(), initMemos()]);
  const { books, isDemo } = await loadBooks();
  view?.reload(books, isDemo);
}

async function handleUpload(files: File[]) {
  await uploadNotes(files);
  await refresh();
}

async function handleDelete(filename: string) {
  await deleteNote(filename);
  await refresh();
}

async function handleDeleteMany(filenames: string[]) {
  await deleteNotes(filenames);
  await refresh();
}

async function handleEditTags(filename: string, tags: string[]) {
  const raw = await getNoteRaw(filename);
  if (raw == null) throw new Error("노트 원문을 찾을 수 없습니다.");
  await saveNoteContent(filename, rewriteTags(raw, tags));
  await refresh();
}

function dismissSplash(): void {
  const splash = document.getElementById("dokki-splash");
  if (!splash) return;
  if (document.documentElement.classList.contains("dokki-no-splash")) {
    splash.remove();
    return;
  }
  const MIN_DWELL_MS = 1200; // 로고만 보여주는 스플래시 — 짧게

  setTimeout(() => {
    splash.classList.add("is-leaving");
    const onEnd = () => splash.remove();
    splash.addEventListener("transitionend", onEnd, { once: true });
    setTimeout(onEnd, 1500);
    try {
      localStorage.setItem("dokki:seen-splash:v1", "1");
    } catch {
      /* storage disabled */
    }
  }, MIN_DWELL_MS);
}

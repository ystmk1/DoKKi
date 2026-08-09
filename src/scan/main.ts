// Scan page wiring: intake files, run OCR + reflow, optional Gemini AI clean,
// copy/download. Keys are routed through the serverless proxy when configured,
// otherwise entered by the user and kept in localStorage.

import "./scan.css";
import { intake, type ScanItem } from "./files";
import { probeConfig, type ServerConfig } from "./api";
import { runExtract } from "./ocr";
import { processBookText, type ReflowMode } from "./reflow";
import { cleanText } from "./clean";
import { normalizeNoteFormat } from "../../lib/note-format";
import type { VisionMode } from "../../lib/vision-ocr";

// 스캔 출력의 마지막 층 — AI/규칙이 뭘 내놓든 docs/FORMAT.md 양식을 강제한다.
// (스캔 텍스트에 의도적 스킵은 없으므로 빈 줄은 1개로 축약)
const enforceFormat = (t: string) => normalizeNoteFormat(t, { preserveSkips: false });

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  drop: $("drop"),
  fileInput: $<HTMLInputElement>("fileInput"),
  fileList: $<HTMLUListElement>("fileList"),
  mode: $<HTMLSelectElement>("mode"),
  lang: $<HTMLSelectElement>("lang"),
  reflow: $<HTMLSelectElement>("reflow"),
  visionKeyField: $("visionKeyField"),
  geminiKeyField: $("geminiKeyField"),
  visionKey: $<HTMLInputElement>("visionKey"),
  geminiKeys: $<HTMLTextAreaElement>("geminiKeys"),
  model: $<HTMLInputElement>("model"),
  customPrompt: $<HTMLTextAreaElement>("customPrompt"),
  advNote: $("advNote"),
  extractBtn: $<HTMLButtonElement>("extractBtn"),
  resetBtn: $<HTMLButtonElement>("resetBtn"),
  autoAi: $<HTMLInputElement>("autoAi"),
  progress: $("progress"),
  bar: $("bar"),
  progressText: $("progressText"),
  badge: $("badge"),
  result: $<HTMLTextAreaElement>("result"),
  fixBtn: $<HTMLButtonElement>("fixBtn"),
  aiBtn: $<HTMLButtonElement>("aiBtn"),
  revertBtn: $<HTMLButtonElement>("revertBtn"),
  copyBtn: $<HTMLButtonElement>("copyBtn"),
  dlBtn: $<HTMLButtonElement>("dlBtn"),
};

let items: ScanItem[] = [];
let config: ServerConfig = { vision: false, gemini: false };
let beforeClean: string | null = null;

// ── localStorage-backed key fields ──────────────────────────────────────────
const LS = {
  vision: "tin_scan_vision_key",
  gemini: "tin_scan_gemini_keys",
  model: "tin_scan_model",
  prompt: "tin_scan_prompt",
};
function restoreField(input: HTMLInputElement | HTMLTextAreaElement, key: string) {
  const v = localStorage.getItem(key);
  if (v) input.value = v;
  input.addEventListener("change", () => {
    const val = input.value.trim();
    if (val) localStorage.setItem(key, val);
    else localStorage.removeItem(key);
  });
}

// ── config → which key fields to show ───────────────────────────────────────
async function initConfig() {
  config = await probeConfig();
  els.visionKeyField.hidden = config.vision;
  els.geminiKeyField.hidden = config.gemini;
  const parts: string[] = [];
  parts.push(config.vision ? "Vision: 서버 키 사용" : "Vision: 브라우저 키 입력");
  parts.push(config.gemini ? "Gemini: 서버 키 사용" : "Gemini: 브라우저 키 입력");
  els.advNote.textContent = parts.join(" · ") + ". 입력한 키는 이 브라우저에만 저장됩니다.";
}

// ── file list (reorderable) ─────────────────────────────────────────────────
let dragFrom: number | null = null;
function renderFileList() {
  els.fileList.innerHTML = "";
  els.extractBtn.disabled = items.length === 0;
  if (items.length === 0) {
    els.fileList.hidden = true;
    return;
  }
  els.fileList.hidden = false;
  items.forEach((it, i) => {
    const li = document.createElement("li");
    li.className = "file-item";
    li.draggable = true;
    const kind = it.extractedText != null ? "PDF" : "IMG";
    li.innerHTML = `<span class="fi-handle">⠿</span><span class="fi-kind">${kind}</span><span class="fi-name">${i + 1}. ${it.name}</span>`;
    const ord = document.createElement("span");
    ord.className = "fi-ord";
    const up = document.createElement("button");
    up.textContent = "↑";
    up.disabled = i === 0;
    up.onclick = () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; renderFileList(); };
    const down = document.createElement("button");
    down.textContent = "↓";
    down.disabled = i === items.length - 1;
    down.onclick = () => { [items[i], items[i + 1]] = [items[i + 1], items[i]]; renderFileList(); };
    const del = document.createElement("button");
    del.textContent = "×";
    del.onclick = () => { items.splice(i, 1); renderFileList(); };
    ord.append(up, down, del);
    li.append(ord);

    li.addEventListener("dragstart", () => { dragFrom = i; li.classList.add("dragging"); });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("drag-over"); });
    li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      li.classList.remove("drag-over");
      if (dragFrom !== null && dragFrom !== i) {
        const moved = items.splice(dragFrom, 1)[0];
        items.splice(i, 0, moved);
        renderFileList();
      }
      dragFrom = null;
    });
    els.fileList.appendChild(li);
  });
}

async function addFiles(files: FileList | File[]) {
  try {
    const incoming = await intake(files);
    items = items.concat(incoming);
    renderFileList();
  } catch (e) {
    alert(e instanceof Error ? e.message : "파일 분석 실패");
  }
}

// ── extract ─────────────────────────────────────────────────────────────────
async function extract() {
  if (items.length === 0) return;
  els.extractBtn.disabled = true;
  els.progress.hidden = false;
  const setProg = (pct: number, label: string) => {
    els.bar.style.width = pct + "%";
    els.progressText.textContent = label;
  };
  try {
    const { text, badge } = await runExtract(items, {
      mode: els.mode.value as VisionMode,
      lang: els.lang.value,
      reflow: els.reflow.value as ReflowMode,
      useProxy: config.vision,
      userKey: els.visionKey.value.trim(),
      onProgress: setProg,
    });
    els.result.value = enforceFormat(text);
    els.badge.textContent = badge;
    beforeClean = null;
    els.revertBtn.hidden = true;
    els.progress.hidden = true;
    // Chain straight into Gemini cleanup when it's available, so one click
    // yields the fully-refined text (like the original two-step workflow).
    const geminiReady = config.gemini || els.geminiKeys.value.trim() !== "";
    if (els.autoAi.checked && geminiReady) await aiClean();
  } catch (e) {
    alert(e instanceof Error ? e.message : "오류가 발생했습니다.");
  } finally {
    els.progress.hidden = true;
    els.extractBtn.disabled = false;
  }
}

// ── AI clean ────────────────────────────────────────────────────────────────
async function aiClean() {
  const text = els.result.value;
  if (!text.trim()) return;
  els.aiBtn.disabled = true;
  beforeClean = text;
  const keys = els.geminiKeys.value.split(/\n/).map((k) => k.trim()).filter(Boolean);
  try {
    const refined = await cleanText(text, {
      useProxy: config.gemini,
      userKeys: keys,
      model: els.model.value.trim() || undefined,
      customPrompt: els.customPrompt.value.trim() || undefined,
      onChunk: (joined, done, total) => {
        els.result.value = joined;
        els.result.scrollTop = els.result.scrollHeight;
        els.aiBtn.textContent = total > 1 ? `AI 정리 중… (${done}/${total})` : "AI 정리 중…";
      },
    });
    els.result.value = enforceFormat(refined);
    els.aiBtn.textContent = "AI 정리 완료 ✓";
    els.revertBtn.hidden = false;
    setTimeout(() => { els.aiBtn.textContent = "AI 재정리"; }, 2000);
  } catch (e) {
    alert(e instanceof Error ? e.message : "AI 정리 실패");
    els.aiBtn.textContent = "AI 정리";
  } finally {
    els.aiBtn.disabled = false;
  }
}

// ── events ──────────────────────────────────────────────────────────────────
els.drop.addEventListener("click", () => els.fileInput.click());
els.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files;
  if (f) addFiles(f);
  els.fileInput.value = "";
});
["dragover", "dragenter"].forEach((ev) =>
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add("over"); }),
);
["dragleave", "drop"].forEach((ev) =>
  els.drop.addEventListener(ev, () => els.drop.classList.remove("over")),
);
els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  if ((e as DragEvent).dataTransfer?.files?.length) addFiles((e as DragEvent).dataTransfer!.files);
});

els.extractBtn.addEventListener("click", extract);
els.resetBtn.addEventListener("click", () => {
  items = [];
  renderFileList();
  els.result.value = "";
  els.badge.textContent = "대기";
  beforeClean = null;
  els.revertBtn.hidden = true;
});

els.fixBtn.addEventListener("click", () => {
  const t = els.result.value;
  if (!t) return;
  els.result.value = enforceFormat(processBookText(t, els.reflow.value as ReflowMode));
  els.fixBtn.textContent = "정리됨 ✓";
  setTimeout(() => (els.fixBtn.textContent = "규칙 정리"), 1500);
});
els.aiBtn.addEventListener("click", aiClean);
els.revertBtn.addEventListener("click", () => {
  if (beforeClean !== null) {
    els.result.value = beforeClean;
    els.revertBtn.hidden = true;
  }
});
els.copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(els.result.value).then(() => {
    els.copyBtn.textContent = "복사됨 ✓";
    setTimeout(() => (els.copyBtn.textContent = "복사"), 1500);
  });
});
els.dlBtn.addEventListener("click", () => {
  const text = els.result.value;
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tin-scan-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

restoreField(els.visionKey, LS.vision);
restoreField(els.geminiKeys, LS.gemini);
restoreField(els.model, LS.model);
restoreField(els.customPrompt, LS.prompt);
renderFileList();
initConfig();

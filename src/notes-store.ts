import { load as yamlLoad } from "js-yaml";
import { BookNote } from "./types";
import { parseBookContent } from "./parser-core";
import { supabase } from "./supabase";
import { getUser } from "./auth";
import { demoBooks } from "./demo-notes";

// Notes are per-account now (not bundled from git). Signed-in users see the
// notes they uploaded; logged-out users — or signed-in users with zero
// notes — see the format-tutorial demo set.

const yaml = (s: string) => yamlLoad(s) as Record<string, unknown>;

export interface LoadedNotes {
  books: BookNote[];
  isDemo: boolean;
}

export async function loadBooks(): Promise<LoadedNotes> {
  const user = getUser();
  if (supabase && user) {
    const { data, error } = await supabase
      .from("notes")
      .select("filename, content, updated_at, is_fragment")
      .eq("user_id", user.id);
    if (error) {
      console.warn("[notes] cloud load failed, showing demo:", error.message);
      return { books: demoBooks(), isDemo: true };
    }
    const rows = data ?? [];
    if (rows.length === 0) return { books: demoBooks(), isDemo: true };
    const books = rows
      .map((r) => {
        const b = safeParse(r.filename as string, r.content as string);
        if (b) b.isFragment = (r as { is_fragment?: boolean }).is_fragment === true;
        return b;
      })
      .filter((b): b is BookNote => b !== null);
    return { books, isDemo: false };
  }
  return { books: demoBooks(), isDemo: true };
}

/** Upload .md files to the signed-in user's account. Returns count saved. */
export async function uploadNotes(files: File[]): Promise<{ saved: number; skipped: number }> {
  const user = getUser();
  if (!supabase || !user) throw new Error("로그인이 필요합니다.");

  const mds = files.filter((f) => /\.md$/i.test(f.name));
  let saved = 0;
  const rows: Array<{ user_id: string; filename: string; content: string }> = [];
  for (const f of mds) {
    const content = await f.text();
    rows.push({ user_id: user.id, filename: f.name, content });
  }
  if (rows.length === 0) return { saved: 0, skipped: files.length };

  const { error } = await supabase
    .from("notes")
    .upsert(rows, { onConflict: "user_id,filename" });
  if (error) throw new Error(error.message);
  saved = rows.length;
  return { saved, skipped: files.length - mds.length };
}

/** Delete one uploaded note (by its filename) from the signed-in account. */
export async function deleteNote(filename: string): Promise<void> {
  return deleteNotes([filename]);
}

/** Delete several uploaded notes in one round trip. */
export async function deleteNotes(filenames: string[]): Promise<void> {
  if (filenames.length === 0) return;
  const user = getUser();
  if (!supabase || !user) throw new Error("로그인이 필요합니다.");
  const { error } = await supabase
    .from("notes")
    .delete()
    .eq("user_id", user.id)
    .in("filename", filenames);
  if (error) throw new Error(error.message);
}

/** A note is deletable only if it's a real uploaded note (not a demo one). */
export function isDemoPath(filePath: string): boolean {
  return filePath.startsWith("demo/");
}

/** Fetch the raw .md content of one uploaded note. */
export async function getNoteRaw(filename: string): Promise<string | null> {
  const user = getUser();
  if (!supabase || !user) return null;
  const { data, error } = await supabase
    .from("notes")
    .select("content")
    .eq("user_id", user.id)
    .eq("filename", filename)
    .maybeSingle();
  if (error || !data) return null;
  return (data.content as string) ?? null;
}

/** Overwrite one uploaded note's content. */
export async function saveNoteContent(filename: string, content: string): Promise<void> {
  const user = getUser();
  if (!supabase || !user) throw new Error("로그인이 필요합니다.");
  const { error } = await supabase
    .from("notes")
    .upsert({ user_id: user.id, filename, content }, { onConflict: "user_id,filename" });
  if (error) throw new Error(error.message);
}

/**
 * Replace just the `tags:` block of a note's YAML frontmatter, leaving every
 * other field byte-identical (avoids js-yaml reformatting dates etc.).
 */
export function rewriteTags(content: string, tags: string[]): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return content;
  const fm = content.slice(3, end); // starts with "\n", ends before closing ---
  const rest = content.slice(end); // "\n---" + body

  const block = "tags:\n" + tags.map((t) => `  - ${t}`).join("\n") + "\n";
  const TAGS_BLOCK = /(^|\n)tags:[^\n]*\n(?:[ \t]+-[^\n]*\n?)*/;
  let newFm: string;
  if (TAGS_BLOCK.test(fm)) {
    newFm = fm.replace(TAGS_BLOCK, (_m, p1: string) => `${p1}${block}`);
  } else {
    newFm = fm.replace(/\n*$/, "\n") + block;
  }
  return "---" + newFm + rest;
}

function safeParse(filename: string, content: string): BookNote | null {
  try {
    const title = filename.replace(/\.md$/i, "");
    return parseBookContent(content, filename, title, yaml);
  } catch (e) {
    console.warn("[notes] parse failed:", filename, e);
    return null;
  }
}

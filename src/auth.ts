import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type AuthProvider = "google" | "kakao";
type AuthListener = (user: User | null) => void;

const listeners = new Set<AuthListener>();
let currentUser: User | null = null;
let initialized = false;

export function getUser(): User | null {
  return currentUser;
}

export function isLoggedIn(): boolean {
  return currentUser !== null;
}

/** Subscribe to auth changes. Fires immediately with the current value. */
export function onAuthChange(fn: AuthListener): () => void {
  listeners.add(fn);
  fn(currentUser);
  return () => {
    listeners.delete(fn);
  };
}

/** Resolve the existing session (if any) and start listening for changes. */
export async function initAuth(): Promise<void> {
  if (initialized || !supabase) return;
  initialized = true;
  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user ?? null;
  notify();
  supabase.auth.onAuthStateChange((_event, session) => {
    const next = session?.user ?? null;
    const changed = next?.id !== currentUser?.id;
    currentUser = next;
    if (changed) notify();
  });
}

export async function signInWith(provider: AuthProvider): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.origin },
  });
}

/**
 * Email magic-link sign-in: sends an invite/login link to `email`.
 * The HTML the user receives is the "Magic Link" template configured in
 * Supabase (see supabase/templates/magic-link.html); clicking the link
 * returns here and `detectSessionInUrl` completes the session.
 * Throws with a readable message on failure (rate limit, invalid email …).
 */
export async function signInWithEmail(email: string): Promise<void> {
  if (!supabase) throw new Error("클라우드 동기화가 설정되지 않았습니다.");
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin,
      shouldCreateUser: true, // first-time emails create an account (invite flow)
    },
  });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
}

/** Best-effort display label for the signed-in user. */
export function userLabel(user: User): string {
  const m = user.user_metadata ?? {};
  return (
    (m.name as string) ||
    (m.full_name as string) ||
    (m.nickname as string) ||
    (m.preferred_username as string) ||
    user.email ||
    "사용자"
  );
}

function notify(): void {
  for (const fn of listeners) fn(currentUser);
}

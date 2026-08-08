-- 읽고 싶은 도서(위시리스트) 계정 저장 테이블.
-- Supabase Dashboard → SQL Editor에 통째로 붙여넣고 Run 하면 끝.
-- 클라이언트(src/wishlist.ts)는 이미 이 테이블로 동기화하도록 짜여 있어서
-- 테이블만 생기면 로그인 시 자동으로 클라우드 저장 + 기존 로컬 항목 이관됨.

create table if not exists public.wishlist (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  wish_id    text        not null,          -- ISBN·제어번호·제목|저자 조합 키
  title      text,
  author     text,
  created_at timestamptz not null default now(),
  primary key (user_id, wish_id)
);

alter table public.wishlist enable row level security;

-- 본인 행만 읽고/쓰고/지울 수 있게 (다른 테이블들과 동일한 패턴).
drop policy if exists "wishlist_select_own" on public.wishlist;
create policy "wishlist_select_own" on public.wishlist
  for select using (auth.uid() = user_id);

drop policy if exists "wishlist_insert_own" on public.wishlist;
create policy "wishlist_insert_own" on public.wishlist
  for insert with check (auth.uid() = user_id);

drop policy if exists "wishlist_update_own" on public.wishlist;
create policy "wishlist_update_own" on public.wishlist
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "wishlist_delete_own" on public.wishlist;
create policy "wishlist_delete_own" on public.wishlist
  for delete using (auth.uid() = user_id);

-- OpenRefine saved project storage schema
-- Apply this in Supabase SQL editor before using /api/openrefine/projects/*

create table if not exists public.openrefine_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  archive_path text not null,
  thumbnail_path text,
  openrefine_version text,
  source_filename text,
  size_bytes bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists openrefine_projects_user_updated_idx
  on public.openrefine_projects (user_id, updated_at desc);

alter table public.openrefine_projects enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'openrefine_projects'
      and policyname = 'openrefine_projects_select_own'
  ) then
    create policy openrefine_projects_select_own
      on public.openrefine_projects
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'openrefine_projects'
      and policyname = 'openrefine_projects_insert_own'
  ) then
    create policy openrefine_projects_insert_own
      on public.openrefine_projects
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'openrefine_projects'
      and policyname = 'openrefine_projects_update_own'
  ) then
    create policy openrefine_projects_update_own
      on public.openrefine_projects
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'openrefine_projects'
      and policyname = 'openrefine_projects_delete_own'
  ) then
    create policy openrefine_projects_delete_own
      on public.openrefine_projects
      for delete
      using (auth.uid() = user_id);
  end if;
end$$;

-- Storage bucket (run once)
insert into storage.buckets (id, name, public)
values ('openrefine-projects', 'openrefine-projects', false)
on conflict (id) do nothing;

-- Storage policies for per-user folder ownership: {user_id}/{project_id}/...
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'openrefine_storage_select_own'
  ) then
    create policy openrefine_storage_select_own
      on storage.objects
      for select
      using (
        bucket_id = 'openrefine-projects'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'openrefine_storage_insert_own'
  ) then
    create policy openrefine_storage_insert_own
      on storage.objects
      for insert
      with check (
        bucket_id = 'openrefine-projects'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'openrefine_storage_update_own'
  ) then
    create policy openrefine_storage_update_own
      on storage.objects
      for update
      using (
        bucket_id = 'openrefine-projects'
        and split_part(name, '/', 1) = auth.uid()::text
      )
      with check (
        bucket_id = 'openrefine-projects'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'openrefine_storage_delete_own'
  ) then
    create policy openrefine_storage_delete_own
      on storage.objects
      for delete
      using (
        bucket_id = 'openrefine-projects'
        and split_part(name, '/', 1) = auth.uid()::text
      );
  end if;
end$$;


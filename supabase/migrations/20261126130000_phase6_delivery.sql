-- ============================================================================
-- NOVA OS — Phase 6: production and delivery
--
-- The roadmap rule this file enforces: work exists only for an accepted quote,
-- and a delivery counts only when there is an artifact to point at. Nothing here
-- invents a deliverable, a delivery date or a revision.
--
--   accepted quote → delivery opened → work started → delivered (artifact URL)
--                  → accepted, or one bounded revision at a time
--
-- When payments are live for the owner, delivery cannot start until a succeeded
-- payment record exists for that quote. With payments off (the default) the
-- delivery is tracked without claiming anyone paid.
-- ============================================================================

create table if not exists public.deliverables (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  quote_id uuid not null unique references public.quotes (id) on delete cascade,
  deal_id uuid references public.deals (id) on delete set null,
  lead_id uuid references public.leads (id) on delete set null,
  title text not null check (length(btrim(title)) > 0),
  scope text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'delivered', 'accepted', 'revision_requested', 'cancelled')),
  due_at timestamptz,
  started_at timestamptz,
  delivered_at timestamptz,
  accepted_at timestamptz,
  revisions_included integer not null default 1 check (revisions_included between 0 and 10),
  revisions_used integer not null default 0 check (revisions_used >= 0),
  artifact_url text,
  revision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A delivery is a link to real work, not a status someone typed.
  constraint deliverables_delivered_needs_artifact check (
    status not in ('delivered', 'accepted')
    or (artifact_url is not null and length(btrim(artifact_url)) > 8)
  ),
  constraint deliverables_accepted_needs_delivery check (
    status <> 'accepted' or delivered_at is not null
  ),
  constraint deliverables_revisions_within_allowance check (
    revisions_used <= revisions_included
  )
);

create index if not exists deliverables_owner_status_idx
  on public.deliverables (owner_id, status, due_at);

drop trigger if exists deliverables_touch on public.deliverables;
create trigger deliverables_touch before update on public.deliverables
  for each row execute function public.set_updated_at();

-- ============================================================================
-- NOVA OS — Phase 5c: page the ready-to-draft set, and report its size
--
-- Phase 5b fixed the capped contact window, but the query still returned at
-- most one page (200) and the app had no idea anything was left. A lower-scored
-- lead with a usable address could therefore still be invisible.
--
-- The function now takes an offset, returns `total_count` for the whole matching
-- set, and is joined only to leads that have a usable address. A companion
-- `ready_to_draft_stats` reports how many leads are ready and how many are
-- waiting on a usable address, without loading either list.
-- ============================================================================

-- The return type changes (total_count is added), so the old signature goes.
drop function if exists public.ready_to_draft_leads(integer);

create or replace function public.ready_to_draft_leads(
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  id uuid,
  business_name text,
  website text,
  domain text,
  industry text,
  location text,
  status text,
  score integer,
  research_confidence numeric,
  recommended_service text,
  recommended_service_key text,
  discovered_at timestamptz,
  qualified_at timestamptz,
  contact_id uuid,
  contact_email text,
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.business_name,
    l.website,
    l.domain,
    l.industry,
    l.location,
    l.status,
    l.score,
    l.research_confidence,
    l.recommended_service,
    l.recommended_service_key,
    l.discovered_at,
    l.qualified_at,
    c.id,
    lower(btrim(coalesce(c.email_normalized, c.email))),
    count(*) over () as total_count
  from public.leads l
  join lateral (
    select ct.id, ct.email, ct.email_normalized
    from public.contacts ct
    where ct.lead_id = l.id
      and ct.owner_id = l.owner_id
      and not ct.opted_out
      and position('@' in lower(btrim(coalesce(ct.email_normalized, ct.email)))) > 1
      and not exists (
        select 1
        from public.suppression_list s
        where s.owner_id = ct.owner_id
          and s.email_normalized = lower(btrim(coalesce(ct.email_normalized, ct.email)))
      )
    order by ct.created_at asc
    limit 1
  ) c on true
  where l.owner_id = auth.uid()
    and l.status in ('qualified', 'researched')
    and not exists (
      select 1
      from public.outreach_messages m
      where m.owner_id = l.owner_id
        and m.lead_id = l.id
        and m.status in ('draft', 'approved', 'sending')
    )
  order by l.score desc nulls last, l.discovered_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 200))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- ---------------------------------------------------------------------------
-- ready_to_draft_stats — the two counts the screen needs, without the rows.
-- ---------------------------------------------------------------------------
create or replace function public.ready_to_draft_stats()
returns table (ready bigint, without_contact bigint)
language sql
stable
security definer
set search_path = public
as $$
  with eligible as (
    select
      l.id,
      exists (
        select 1
        from public.contacts ct
        where ct.lead_id = l.id
          and ct.owner_id = l.owner_id
          and not ct.opted_out
          and position('@' in lower(btrim(coalesce(ct.email_normalized, ct.email)))) > 1
          and not exists (
            select 1
            from public.suppression_list s
            where s.owner_id = ct.owner_id
              and s.email_normalized = lower(btrim(coalesce(ct.email_normalized, ct.email)))
          )
      ) as has_contact
    from public.leads l
    where l.owner_id = auth.uid()
      and l.status in ('qualified', 'researched')
      and not exists (
        select 1
        from public.outreach_messages m
        where m.owner_id = l.owner_id
          and m.lead_id = l.id
          and m.status in ('draft', 'approved', 'sending')
      )
  )
  select
    count(*) filter (where has_contact) as ready,
    count(*) filter (where not has_contact) as without_contact
  from eligible;
$$;

revoke all on function public.ready_to_draft_leads(integer, integer) from public, anon;
grant execute on function public.ready_to_draft_leads(integer, integer) to authenticated;

revoke all on function public.ready_to_draft_stats() from public, anon;
grant execute on function public.ready_to_draft_stats() to authenticated;

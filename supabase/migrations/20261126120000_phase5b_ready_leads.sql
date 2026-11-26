-- ============================================================================
-- NOVA OS — Phase 5b: which leads can actually be drafted
--
-- The app used to decide this from a 300-row slice of contacts ordered
-- oldest-first, so an address created after that window was invisible and its
-- lead never appeared under Ready to draft. The decision now happens in one
-- query that sees every contact the owner has.
--
-- The rule itself is unchanged: a lead is draftable when it is qualified or
-- researched, at least one stored contact has a real address that has not opted
-- out and is not suppressed, and no draft/approved/sending message already
-- exists for it. Leads with no usable address are still returned, with a null
-- contact, so the app can say how many are waiting on one.
-- ============================================================================

create or replace function public.ready_to_draft_leads(p_limit integer default 200)
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
  contact_email text
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
    lower(btrim(coalesce(c.email_normalized, c.email)))
  from public.leads l
  left join lateral (
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
  limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

revoke all on function public.ready_to_draft_leads(integer) from public, anon;
grant execute on function public.ready_to_draft_leads(integer) to authenticated;

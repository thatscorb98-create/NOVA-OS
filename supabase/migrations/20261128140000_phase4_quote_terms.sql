-- ============================================================================
-- NOVA OS — Phase 4 completion: quote terms and deliverables
--
-- The roadmap requires a quote record to carry the scope, the price, the terms
-- and the deliverables the customer is accepting. The original Phase 4 table
-- carried title/scope/amount/delivery days; this adds the missing fields so an
-- acceptance is acceptance of a complete offer, not just a number.
-- ============================================================================

alter table public.quotes
  add column if not exists deliverables text not null default '';

alter table public.quotes
  add column if not exists terms text not null default '';

alter table public.quotes
  add column if not exists requirements text[] not null default '{}';

alter table public.quotes
  add column if not exists discount_cents integer not null default 0
    check (discount_cents >= 0);

comment on column public.quotes.deliverables is
  'What the customer receives, in the owner''s own words.';
comment on column public.quotes.terms is
  'The terms the customer accepts with the quote: payment, revisions, timing.';
comment on column public.quotes.discount_cents is
  'A discount the owner applied when writing the quote. The charged amount stays amount_cents.';

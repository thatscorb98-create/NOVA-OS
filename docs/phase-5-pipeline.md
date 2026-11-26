# Phase 5 — replies and the deal pipeline

Phase 5 reads what the inbox already reported. It composes nothing and infers no
outcome beyond a keyword hint.

## The write path

`POST /functions/v1/webhook` (cron secret or service role) →
`public.record_email_event(...)`:

- resolves the message from our own `outreach_messages` row, so ownership is never
  taken from the request body
- appends the provider event to `email_events` verbatim, with a deterministic
  `intent` label: `interested`, `question`, `not_interested`, `unsubscribe` or
  `other`
- an opt-out, bounce or complaint suppresses the address through
  `suppress_email`, which also cancels that address's open drafts
- a reply moves the message to `replied` and the deal to `replied`, `lost`
  (they said no) or `do_not_contact` (they asked to be left alone)

The intent is a hint for the owner, not a claim about what the customer meant, and
the app labels it that way. No model call is made and no reply is drafted.

## The app

`src/app/pipeline.tsx` reads deals and recent replies. The only manual actions are
the owner's own **Mark won** and **Mark lost**. Nothing advances because time
passed, and no deal is created by hand.

## What the SQL suite asserts

- only the service role can record a provider event
- an unknown message id is refused
- a reply marks the message `replied` and the deal `replied`
- "not interested" closes the deal as `lost`
- "please remove me" suppresses the address, cancels other open drafts to it and
  moves the deal to `do_not_contact`
- an owner cannot read another owner's replies

## Ready to draft is a database decision

The outreach screen used to decide which leads could be drafted from a page of
300 contacts ordered oldest-first. A usable address created after that window was
invisible, so its lead never appeared. `public.ready_to_draft_leads(p_limit)`
now does the work in one query over every contact the owner has:

- the lead is `qualified` or `researched`
- at least one contact has an address containing `@`, is not opted out and is not
  on the suppression list (the oldest usable contact wins)
- no `draft`, `approved` or `sending` message already exists for that lead

The function returns only leads that have a usable address, ordered by score,
with `p_limit`/`p_offset` paging and a `total_count` over the whole matching set.
A companion `ready_to_draft_stats()` returns two counts — ready, and waiting on a
usable address — so the screen can say how many exist without loading them.

The app calls it through `loadReadyLeads`, keeps the first 100, shows "_n_ of
_total_" and loads the next page on demand. The capped contact list is no longer
involved in the decision, and no lower-scored lead is hidden once the set grows
past one page.

## What is not built

- No inbox sync. The provider must POST to the webhook; the app does not poll a
  mailbox, and AgentMail's inbound payload has not been verified against a live
  key.
- No automatic replies, follow-up sequencing or reply drafting.
- No production automation. Delivery tracking is Phase 6
  ([`phase-6-production.md`](phase-6-production.md)).

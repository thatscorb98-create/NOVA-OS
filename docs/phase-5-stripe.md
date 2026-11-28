# Phase 5 — Stripe

The roadmap rule: **checkout exists only for a validated ready-to-buy deal, and
a payment counts only when Stripe's signed webhook says so.** Both are enforced
in the database and in the edge functions, not in the screen.

## The chain

`accepted quote → checkout session → Stripe webhook → paid record → order`

Nothing earlier can skip a step:

- A draft or unaccepted quote cannot produce a payment record
  (`create_checkout_intent` refuses anything but `accepted`).
- A checkout cannot be created while the owner has payments switched off.
- A live Stripe key cannot charge while `stripe_live_mode` is off.
- A paid row needs a provider reference, and an order is inserted only inside
  `record_stripe_event` after the amount and currency match our own record.
- A refund arrives from Stripe as `charge.refunded`; it adjusts the same payment
  and order rather than inventing a new one.

## What is enforced

| Rule | Where |
| --- | --- |
| Checkout only from an accepted, unexpired quote | `create_checkout_intent` |
| Owner's live-payments switch re-checked at checkout time | `create_checkout_intent`, payments function |
| One live checkout per quote; paid/refunded quotes cannot be charged again | partial unique index + `create_checkout_intent` |
| Only an `https` checkout URL is stored | `attach_checkout_session` |
| A second open session cannot replace a live one | `attach_checkout_session` |
| Every webhook verified before the body is trusted | `stripe-webhook` (HMAC-SHA256, 5-minute tolerance, constant-time compare) |
| Duplicate Stripe events apply once | `stripe_events.id` primary key + `record_stripe_event` |
| Amount and currency must match the quote | `record_stripe_event` |
| A failed or cancelled event cannot downgrade a paid record | `record_stripe_event` |
| Exactly one order per payment | unique `orders.payment_intent_id` |
| Refunds cannot exceed the charge | table check + `record_stripe_event` |
| Live mode is off by default | `business_settings.stripe_live_mode = false` |
| A user cannot create a checkout, attach a session or record an event | execute revoked to `service_role` only |
| Orders are readable by their owner only | RLS `orders_select` |
| Finance totals come from stored rows | `finance_summary()` |

The app never sees `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET`. They are
Supabase function secrets, read only inside `payments` and `stripe-webhook`.

## What the app does

- **Quotes** (`src/app/quotes.tsx`): an accepted quote with payments on shows
  **Create checkout**. The returned Checkout URL can be shared with the customer
  or opened in a browser. The payment status (`AWAITING CHECKOUT`, `CHECKOUT
  OPEN`, `PAID`, `REFUNDED`, `PART REFUNDED`) and the paid time come from the
  stored record.
- **Finance** (`src/app/finance.tsx`): gross and net revenue, pending money,
  refunds, recorded expenses, AI spend and profit, plus payment records, paid
  orders and an expense form. Payments and live mode are separate switches; live
  mode is disabled while payments are off.

Nothing on either screen creates a charge directly. The only write path for a
paid status is the signed webhook.

## Setup

1. Put the Stripe keys in Supabase secrets (never in the app or the repo):

   ```bash
   npx supabase secrets set \
     STRIPE_SECRET_KEY=sk_test_... \
     STRIPE_WEBHOOK_SECRET=whsec_...
   ```

2. Deploy the functions. `.github/workflows/supabase-deploy.yml` discovers every
   directory under `supabase/functions`, so `payments` and `stripe-webhook` are
   included automatically.

3. In the Stripe dashboard → **Developers → Webhooks**, add
   `https://<project-ref>.supabase.co/functions/v1/stripe-webhook` and subscribe
   to:

   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `payment_intent.payment_failed`
   - `charge.refunded`

   Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`.

4. In the app: **Company → Finance**, switch **Payments** on and leave **Live
   mode** off. Accept a test quote, create a checkout and pay with Stripe's test
   card `4242 4242 4242 4242`. The payment record becomes `PAID`, an order
   appears, and `open_delivery` is unlocked for that quote.

5. Only after an end-to-end test passes: replace the key with the live key and
   turn live mode on. A live key with live mode off is refused, and so is a
   non-secret key.

## What the SQL suite asserts

The local Postgres suite applies every migration, including this one, and runs
48 assertions. The Phase 5 ones:

- live mode and payments are off by default
- a signed-in user cannot create a checkout intent
- checkout is refused while payments are off, and for a draft quote
- an accepted quote yields one Stripe record with the quoted amount
- a second call reuses that record instead of creating a second
- a user cannot attach a session; a service request stores only an `https` URL
- a second open session for the same payment is refused
- a user cannot record a Stripe event
- an amount mismatch is recorded as unmatched and creates no order
- a verified paid event creates exactly one order with a paid timestamp
- a duplicate event id is idempotent; a second paid event does not duplicate
- a late failure event does not downgrade a paid record
- partial and full refunds update both the payment and the order
- a refunded quote cannot open another checkout
- an unknown session is recorded but matches nothing
- another owner sees no orders, payments or expenses
- `finance_summary` computes gross, net, refunds, expenses and profit
- delivery stays blocked while the recorded payment is refunded, and unlocks
  with a succeeded payment

## What is not built, and why

- **No Stripe account is connected here.** `STRIPE_SECRET_KEY` is not set in this
  environment, so no Checkout Session has been created by this code and no
  webhook has been received. The SQL, the signature check and the app wiring
  were tested; the live Stripe API call was not.
- **No refund UI.** Refunds are created in Stripe; the `charge.refunded` event is
  what updates our record. The app shows the result.
- **No invoices, tax, subscriptions, saved cards, Stripe Connect or payout
  reporting.** Receipts are Stripe's own.
- **No automatic fulfilment.** A paid order is the trigger Phase 6 needs; this
  phase stops at creating that order.
- **No customer-facing payment page of our own.** The customer pays on Stripe
  Checkout; our return page only displays the status Stripe already reported.

import { resolveCaller } from '../_shared/auth.ts';
import { fail, json, preflight } from '../_shared/http.ts';
import { adminClient, env, SERVICE_VERSION } from '../_shared/supabase.ts';

/**
 * Customer delivery page.
 *
 *   GET  ?token=<64 hex>   the customer opens their private delivery link
 *   POST (form)            action=revision, token, note — the customer asks for
 *                          a change without an account
 *   POST { action: 'mint', deliverableId, days }
 *                          the signed-in owner creates a new link
 *
 * The link token is random, stored only as a SHA-256 hash, expires, and can be
 * revoked. The page signs each file for 15 minutes; the bucket stays private.
 * An unknown, expired or revoked token gets the same generic page, so the
 * response cannot be used to probe which deliveries exist.
 *
 * The revision form is a plain HTML form: no script runs on this page, and the
 * CSP allows form submission back to this same origin only.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;

const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

interface DeliverableRow {
  id: string;
  owner_id: string;
  quote_id: string;
  lead_id: string | null;
  title: string;
  scope: string;
  status: string;
  revisions_included: number;
  revisions_used: number;
  artifact_url: string | null;
}

interface ResolvedRow {
  link_id: string;
  deliverable_id: string;
  owner_id: string;
  expires_at: string;
  status: string;
  title: string;
  scope: string;
  quote_id: string;
  lead_id: string | null;
  revisions_included: number;
  revisions_used: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #04050a; color: #e8ecf8; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 640px; border: 1px solid #1d2438; border-radius: 18px;
    background: #0a0e1c; padding: 28px; }
  .eyebrow { font-size: 11px; letter-spacing: 2px; color: #7c89a8; text-transform: uppercase; }
  h1 { font-size: 22px; line-height: 1.3; margin: 10px 0 6px; }
  h2 { font-size: 13px; letter-spacing: 1px; text-transform: uppercase; color: #7c89a8; margin: 26px 0 10px; }
  p { font-size: 14px; line-height: 1.65; color: #c7d0e6; margin: 8px 0; }
  .muted { color: #9aa6c4; font-size: 13px; }
  .bad { color: #fca5a5; }
  .file { display: flex; align-items: center; justify-content: space-between; gap: 14px;
    border: 1px solid #1d2438; border-radius: 12px; padding: 12px 14px; margin: 8px 0; }
  .name { font-size: 14px; font-weight: 600; }
  .meta { font-size: 12px; color: #7c89a8; margin-top: 3px; word-break: break-all; }
  a.button { flex: none; text-decoration: none; font-size: 13px; font-weight: 600; color: #04050a;
    background: #22d3ee; border-radius: 9px; padding: 9px 14px; }
  form.revision { margin-top: 10px; display: grid; gap: 10px; }
  textarea { width: 100%; min-height: 96px; resize: vertical; color: #e8ecf8; background: #04050a;
    border: 1px solid #1d2438; border-radius: 10px; padding: 12px; font: inherit; font-size: 14px; }
  button { justify-self: start; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600;
    color: #04050a; background: #fbbf24; border: 0; border-radius: 9px; padding: 10px 16px; }
  .note { margin-top: 24px; padding-top: 16px; border-top: 1px solid #1d2438;
    font-size: 12px; line-height: 1.6; color: #7c89a8; }
</style>
</head>
<body><main>${body}</main></body>
</html>`,
    { status, headers: PAGE_HEADERS },
  );
}

function unavailable(): Response {
  return page(
    'Delivery link unavailable',
    `<div class="eyebrow">NOVA OS · delivery</div>
     <h1>This link is no longer available</h1>
     <p>It may have expired or been withdrawn. Reply to the email that brought you here and we will send a fresh link.</p>`,
    404,
  );
}

async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function publicDeliveryUrl(token: string): string {
  const base = (env('SUPABASE_URL') ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('SUPABASE_URL is not configured for this function.');
  return `${base}/functions/v1/delivery?token=${token}`;
}

function requestIsSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;

  try {
    const base = (env('SUPABASE_URL') ?? '').replace(/\/+$/, '');
    return Boolean(base) && new URL(origin).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function revisionSection(token: string, row: ResolvedRow): string {
  const remaining = Math.max(0, row.revisions_included - row.revisions_used);

  if (row.status === 'revision_requested') {
    return `<h2>Revision in progress</h2>
      <p>Your change request is with the studio. A new version will arrive at this same link.</p>`;
  }

  if (row.status === 'accepted') {
    return `<h2>Accepted</h2>
      <p>This delivery was accepted, so it can no longer be changed here.</p>`;
  }

  if (row.status !== 'delivered') {
    return `<h2>Revisions</h2>
      <p>The files are being prepared, so there is nothing to revise yet.</p>`;
  }

  if (remaining <= 0) {
    return `<h2>Revisions</h2>
      <p>This order has used all ${row.revisions_included} included revision${
        row.revisions_included === 1 ? '' : 's'
      }. Reply to the delivery email if something is wrong and we will help.</p>`;
  }

  return `<h2>Request a revision</h2>
    <p>Your quote includes ${row.revisions_included} revision${
      row.revisions_included === 1 ? '' : 's'
    }; ${remaining} remaining. Tell us what should change and the studio will prepare a new version.</p>
    <form class="revision" method="post" action="?token=${token}">
      <input type="hidden" name="action" value="revision">
      <input type="hidden" name="token" value="${token}">
      <textarea name="note" required minlength="3" maxlength="1000"
        placeholder="What should change? Please be specific about the text, colours or files."></textarea>
      <button type="submit">Request this revision</button>
    </form>`;
}

async function renderDelivery(token: string): Promise<Response> {
  if (!TOKEN.test(token)) return unavailable();

  const admin = adminClient();
  const tokenHash = await hashToken(token);

  const { data: resolved, error: resolveError } = await admin.rpc('resolve_delivery_token', {
    p_token_hash: tokenHash,
  });
  if (resolveError) return unavailable();

  const row = (Array.isArray(resolved) ? resolved[0] : resolved) as ResolvedRow | null;
  if (!row || row.status === 'cancelled') return unavailable();

  const { data: job } = await admin
    .from('production_jobs')
    .select('id, version, status, qa_notes')
    .eq('owner_id', row.owner_id)
    .eq('quote_id', row.quote_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job || !['ready', 'delivered'].includes(String(job.status))) {
    return page(
      'Files not ready',
      `<div class="eyebrow">NOVA OS · delivery</div>
       <h1>The files are being prepared</h1>
       <p>This link is valid, but the delivery is not ready yet. Please try again shortly or reply to the delivery email.</p>`,
      409,
    );
  }

  const { data: files } = await admin
    .from('production_files')
    .select('name, path, bytes, sha256, content_type')
    .eq('job_id', job.id)
    .eq('version', job.version)
    .order('name');

  if (!files || files.length === 0) {
    return page(
      'Files not ready',
      `<div class="eyebrow">NOVA OS · delivery</div>
       <h1>The files are being prepared</h1>
       <p>This link is valid, but there are no stored files for this version yet.</p>`,
      409,
    );
  }

  const { data: lead } = row.lead_id
    ? await admin.from('leads').select('business_name').eq('id', row.lead_id).maybeSingle()
    : { data: null };

  const links: string[] = [];
  for (const file of files as Array<{ path: string; name: string; bytes: number; sha256: string }>) {
    const { data: signed } = await admin.storage.from('deliverables').createSignedUrl(file.path, 900);
    const signedUrl = signed?.signedUrl ?? '';
    links.push(`<div class="file">
      <div>
        <div class="name">${escapeHtml(file.name)}</div>
        <div class="meta">${formatBytes(Number(file.bytes) || 0)} · sha256 ${escapeHtml(file.sha256.slice(0, 16))}…</div>
      </div>
      ${signedUrl ? `<a class="button" href="${escapeHtml(signedUrl)}">Download</a>` : '<div class="bad">Unavailable</div>'}
    </div>`);
  }

  const business = lead?.business_name ? escapeHtml(String(lead.business_name)) : '';

  return page(
    row.title,
    `<div class="eyebrow">NOVA OS · delivery</div>
     <h1>${escapeHtml(row.title)}</h1>
     ${business ? `<p class="muted">Prepared for ${business}</p>` : ''}
     ${row.scope ? `<p>${escapeHtml(row.scope)}</p>` : ''}
     <h2>Your files</h2>
     ${links.join('')}
     ${revisionSection(token, row)}
     <div class="note">
       <p>Download links expire 15 minutes after this page loads. This link expires on ${formatDate(row.expires_at)}.</p>
       <p>This link is unique to you. Please do not forward it.</p>
     </div>`,
  );
}

async function handleRevisionForm(req: Request): Promise<Response> {
  if (!requestIsSameOrigin(req)) return fail('This request did not come from the delivery page.', 403);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return unavailable();
  }

  if (String(form.get('action') ?? '') !== 'revision') return fail('Unknown action.');

  const token = String(form.get('token') ?? new URL(req.url).searchParams.get('token') ?? '');
  if (!TOKEN.test(token)) return unavailable();

  const note = String(form.get('note') ?? '');
  const admin = adminClient();

  const { data, error } = await admin.rpc('request_delivery_revision', {
    p_token_hash: await hashToken(token),
    p_note: note,
  });

  if (error) {
    return page(
      'Revision not recorded',
      `<div class="eyebrow">NOVA OS · delivery</div>
       <h1>We could not record that request</h1>
       <p class="bad">${escapeHtml(error.message)}</p>
       <p>Reply to the delivery email and we will help directly.</p>`,
      409,
    );
  }

  const result = (Array.isArray(data) ? data[0] : data) as { revisionsRemaining?: number } | null;
  const remaining = Number(result?.revisionsRemaining ?? 0);

  return page(
    'Revision requested',
    `<div class="eyebrow">NOVA OS · delivery</div>
     <h1>Thank you — the revision is with the studio</h1>
     <p>We recorded your request. A new version will be prepared and checked, and we will email you when it is ready.</p>
     <p class="muted">${remaining} revision${remaining === 1 ? '' : 's'} left on this order after this request.</p>`,
  );
}

async function mintLink(req: Request): Promise<Response> {
  const caller = await resolveCaller(req);
  if (!caller || caller.mode !== 'user' || !caller.ownerId) {
    return fail('Sign in to create a delivery link.', 401);
  }

  let body: { action?: string; deliverableId?: string; days?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail('A JSON body is required.');
  }

  if (body.action !== 'mint') return fail('Unknown action.');
  const deliverableId = typeof body.deliverableId === 'string' ? body.deliverableId : '';
  if (!UUID.test(deliverableId)) return fail('A valid deliverableId is required.');

  const days = Math.min(30, Math.max(1, Math.round(Number(body.days) || 14)));
  const expiresAt = new Date(Date.now() + days * 86_400_000);

  const admin = adminClient();
  const { data: deliverable, error } = await admin
    .from('deliverables')
    .select('id, owner_id, status')
    .eq('id', deliverableId)
    .eq('owner_id', caller.ownerId)
    .maybeSingle();

  if (error) return fail(error.message, 500);
  if (!deliverable) return fail('That delivery does not exist for this owner.', 404);
  if (deliverable.status === 'cancelled') return fail('A cancelled delivery cannot be linked.', 409);

  const token = randomToken();
  const { data: link, error: linkError } = await admin.rpc('create_delivery_link', {
    p_deliverable_id: deliverableId,
    p_token_hash: await hashToken(token),
    p_expires_at: expiresAt.toISOString(),
  });

  const created = (Array.isArray(link) ? link[0] : link) as { id?: string; expires_at?: string } | null;
  if (linkError || !created?.id) return fail(linkError?.message ?? 'Could not create the link.', 500);

  return json({
    ok: true,
    linkId: created.id,
    url: publicDeliveryUrl(token),
    expiresAt: created.expires_at ?? expiresAt.toISOString(),
  });
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    return await renderDelivery(token);
  }

  if (req.method === 'POST') {
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return await handleRevisionForm(req);
    }
    return await mintLink(req);
  }

  return json({ ok: false, error: 'Use GET with a token or POST to mint.', version: SERVICE_VERSION }, 405);
});

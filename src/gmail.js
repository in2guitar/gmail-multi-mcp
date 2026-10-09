// Thin Gmail REST client.
//
// Deliberately uses fetch against the REST API rather than the `googleapis` package:
// the surface we need is ten endpoints, and this keeps the dependency tree small
// enough to actually audit.

import { getAccessToken } from './oauth.js';
import {
  b64url,
  buildMime,
  extractBodies,
  headerValue,
  splitAddresses,
} from './mime.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** send-as list cache: accountKey -> { at, entries }. */
const sendAsCache = new Map();
const SEND_AS_TTL_MS = 10 * 60 * 1000;

/**
 * Apply query parameters to a URL.
 *
 * Array values are repeated rather than joined. Gmail expects
 * `?metadataHeaders=From&metadataHeaders=Subject`; collapsing them into one
 * comma-separated value matches no header at all, and the request still returns 200 —
 * it just comes back with no headers, so subject and date silently read as null.
 * Exported so that behaviour stays pinned by a test.
 */
export function applyQuery(url, query) {
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

async function gapi(ctx, path, { method = 'GET', query, body } = {}) {
  const token = await getAccessToken(ctx.accounts, ctx.key);
  const url = applyQuery(new URL(BASE + path), query);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return null;
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = payload?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gmail API ${method} ${path} failed for "${ctx.key}": ${msg}`);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Send-as aliases
// ---------------------------------------------------------------------------

/**
 * List send-as identities usable on this account.
 *
 * The primary address comes back with an empty verificationStatus rather than
 * "accepted", so it has to be admitted via isPrimary or we would reject the one
 * address that always works.
 */
export async function listSendAs(ctx, { force = false } = {}) {
  const cached = sendAsCache.get(ctx.key);
  if (!force && cached && Date.now() - cached.at < SEND_AS_TTL_MS) return cached.entries;

  const res = await gapi(ctx, '/settings/sendAs');
  const entries = (res.sendAs ?? []).map((s) => ({
    email: s.sendAsEmail,
    name: s.displayName || null,
    isPrimary: Boolean(s.isPrimary),
    isDefault: Boolean(s.isDefault),
    verificationStatus: s.verificationStatus || (s.isPrimary ? 'accepted' : ''),
    usable: Boolean(s.isPrimary) || s.verificationStatus === 'accepted',
    treatAsAlias: Boolean(s.treatAsAlias),
  }));

  sendAsCache.set(ctx.key, { at: Date.now(), entries });
  return entries;
}

/**
 * Resolve a requested From address to a usable send-as identity, or throw.
 *
 * This check is the whole reason the server exists. Gmail does NOT reliably error
 * on an unverified From — it silently substitutes the account's primary address,
 * so a draft meant to go out as one business quietly goes out as another. Refusing
 * up front is the only way to make that failure visible.
 */
export async function resolveFrom(ctx, requested) {
  const entries = await listSendAs(ctx);
  if (!requested) {
    const def = entries.find((e) => e.isDefault) ?? entries.find((e) => e.isPrimary);
    return def ? { email: def.email, name: def.name } : null;
  }

  // Tolerate "Name <addr@host>" by extracting the address for matching.
  const bare = String(requested).match(/<([^>]+)>/)?.[1] ?? String(requested);
  const wanted = bare.trim().toLowerCase();
  const match = entries.find((e) => e.email.toLowerCase() === wanted);

  if (!match) {
    const usable = entries.filter((e) => e.usable).map((e) => e.email);
    throw new Error(
      `"${bare}" is not a send-as address on ${ctx.accounts[ctx.key].email}. ` +
        `Usable addresses: ${usable.join(', ') || '(none)'}. ` +
        `Add it in Gmail → Settings → Accounts → "Send mail as", then verify it.`
    );
  }
  if (!match.usable) {
    throw new Error(
      `Send-as address "${match.email}" on ${ctx.accounts[ctx.key].email} is not verified ` +
        `(status: ${match.verificationStatus || 'pending'}). Complete verification in Gmail first — ` +
        `sending now would silently go out as the primary address instead.`
    );
  }
  return { email: match.email, name: match.name };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function searchMessages(ctx, { query, maxResults = 20, includeSpamTrash = false }) {
  const list = await gapi(ctx, '/messages', {
    query: { q: query, maxResults, includeSpamTrash },
  });
  const ids = (list.messages ?? []).map((m) => m.id);
  const messages = await Promise.all(ids.map((id) => getMessage(ctx, { id, format: 'metadata' })));
  return { resultSizeEstimate: list.resultSizeEstimate ?? messages.length, messages };
}

export async function getMessage(ctx, { id, format = 'full' }) {
  const query =
    format === 'metadata'
      ? { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] }
      : { format };
  const msg = await gapi(ctx, `/messages/${encodeURIComponent(id)}`, { query });
  return shapeMessage(msg, format);
}

export async function getThread(ctx, { id, format = 'full' }) {
  const thread = await gapi(ctx, `/threads/${encodeURIComponent(id)}`, { query: { format } });
  return {
    id: thread.id,
    historyId: thread.historyId,
    messages: (thread.messages ?? []).map((m) => shapeMessage(m, format)),
  };
}

function shapeMessage(msg, format) {
  const p = msg.payload;
  const base = {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    snippet: msg.snippet,
    date: headerValue(p, 'Date'),
    from: headerValue(p, 'From'),
    to: headerValue(p, 'To'),
    cc: headerValue(p, 'Cc'),
    subject: headerValue(p, 'Subject'),
  };
  if (format === 'metadata') return base;
  const bodies = extractBodies(p);
  return {
    ...base,
    messageId: headerValue(p, 'Message-ID'),
    references: headerValue(p, 'References'),
    inReplyTo: headerValue(p, 'In-Reply-To'),
    text: bodies.text,
    html: bodies.html,
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export async function listDrafts(ctx, { query, maxResults = 20 }) {
  const list = await gapi(ctx, '/drafts', { query: { q: query, maxResults } });
  const drafts = await Promise.all(
    (list.drafts ?? []).map(async (d) => {
      const full = await gapi(ctx, `/drafts/${encodeURIComponent(d.id)}`, {
        query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] },
      });
      return { draftId: full.id, ...shapeMessage(full.message, 'metadata') };
    })
  );
  return { drafts };
}

/**
 * Derive the threading headers for a reply from the message being replied to.
 * Setting threadId alone lets Gmail fork a new thread, so we always carry
 * In-Reply-To and References across.
 */
async function replyContext(ctx, replyToMessageId) {
  const src = await getMessage(ctx, { id: replyToMessageId, format: 'full' });
  const refs = [src.references, src.messageId].filter(Boolean).join(' ').trim();
  const subject = /^re:/i.test(src.subject ?? '') ? src.subject : `Re: ${src.subject ?? ''}`.trim();
  return {
    threadId: src.threadId,
    inReplyTo: src.messageId,
    references: refs || null,
    subject,
    to: src.from ? splitAddresses(src.from) : [],
  };
}

export async function createDraft(ctx, opts) {
  const from = await resolveFrom(ctx, opts.from);

  let threading = {};
  if (opts.replyToMessageId) {
    const rc = await replyContext(ctx, opts.replyToMessageId);
    threading = {
      threadId: rc.threadId,
      inReplyTo: rc.inReplyTo,
      references: rc.references,
      subject: opts.subject ?? rc.subject,
      to: opts.to?.length ? opts.to : rc.to,
    };
  }

  const raw = buildMime({
    from,
    to: threading.to ?? opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: threading.subject ?? opts.subject,
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments ?? [],
    inReplyTo: threading.inReplyTo,
    references: threading.references,
  });

  const body = { message: { raw: b64url(raw) } };
  if (threading.threadId) body.message.threadId = threading.threadId;

  const created = await gapi(ctx, '/drafts', { method: 'POST', body });
  return {
    draftId: created.id,
    messageId: created.message?.id,
    threadId: created.message?.threadId,
    from: from?.email ?? null,
  };
}

/**
 * Update an existing draft.
 *
 * drafts.update is a full PUT replace, not a patch: whatever we send becomes the
 * entire message. So we read the current draft, merge the requested changes over
 * it, and rebuild. Two things bite here — the draft id is stable but the underlying
 * message id changes on every update (so state must key off draftId), and dropping
 * threadId or the In-Reply-To/References headers during the rebuild silently
 * detaches the draft from its thread.
 */
export async function updateDraft(ctx, { draftId, ...changes }) {
  const existing = await gapi(ctx, `/drafts/${encodeURIComponent(draftId)}`, {
    query: { format: 'full' },
  });
  const msg = existing.message;
  const p = msg.payload;
  const bodies = extractBodies(p);

  const currentFrom = headerValue(p, 'From');
  const from = await resolveFrom(ctx, changes.from ?? currentFrom);

  const merged = {
    from,
    to: changes.to ?? splitAddresses(headerValue(p, 'To')),
    cc: changes.cc ?? splitAddresses(headerValue(p, 'Cc')),
    bcc: changes.bcc ?? splitAddresses(headerValue(p, 'Bcc')),
    subject: changes.subject ?? headerValue(p, 'Subject') ?? '',
    text: changes.text ?? bodies.text,
    // New text with no new html: drop the old html so buildMime regenerates it from
    // the new text. Keeping it would leave the two parts saying different things.
    html: changes.html ?? (changes.text != null ? null : bodies.html),
    attachments: changes.attachments ?? [],
    // Preserved verbatim — regenerating these would break the thread linkage.
    inReplyTo: headerValue(p, 'In-Reply-To'),
    references: headerValue(p, 'References'),
  };

  const body = { message: { raw: b64url(buildMime(merged)) } };
  if (msg.threadId) body.message.threadId = msg.threadId;

  const updated = await gapi(ctx, `/drafts/${encodeURIComponent(draftId)}`, {
    method: 'PUT',
    body,
  });
  return {
    draftId: updated.id,
    messageId: updated.message?.id,
    threadId: updated.message?.threadId,
    from: from?.email ?? null,
  };
}

export async function sendDraft(ctx, { draftId }) {
  const sent = await gapi(ctx, '/drafts/send', { method: 'POST', body: { id: draftId } });
  return { messageId: sent.id, threadId: sent.threadId, labelIds: sent.labelIds ?? [] };
}

export async function sendMessage(ctx, opts) {
  const from = await resolveFrom(ctx, opts.from);

  let threading = {};
  if (opts.replyToMessageId) {
    const rc = await replyContext(ctx, opts.replyToMessageId);
    threading = {
      threadId: rc.threadId,
      inReplyTo: rc.inReplyTo,
      references: rc.references,
      subject: opts.subject ?? rc.subject,
      to: opts.to?.length ? opts.to : rc.to,
    };
  }

  const raw = buildMime({
    from,
    to: threading.to ?? opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: threading.subject ?? opts.subject,
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments ?? [],
    inReplyTo: threading.inReplyTo,
    references: threading.references,
  });

  const body = { raw: b64url(raw) };
  if (threading.threadId) body.threadId = threading.threadId;

  const sent = await gapi(ctx, '/messages/send', { method: 'POST', body });
  return { messageId: sent.id, threadId: sent.threadId, from: from?.email ?? null };
}

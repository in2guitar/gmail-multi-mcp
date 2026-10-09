// MIME construction for Gmail.
//
// We build MIME but never parse it: drafts are read back with format=full, which
// hands us a decoded payload tree, so a parser would be dead weight.

import { randomBytes } from 'node:crypto';

/** base64url per RFC 4648 §5 — this is what Gmail's `raw` field expects, NOT plain base64. */
export function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Wrap base64 at 76 chars, as required for a well-formed body. */
function wrap76(b64) {
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

/** RFC 2047 encode a header value when it contains anything outside ASCII. */
function encodeHeaderValue(value) {
  const str = String(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

/**
 * Format an address for a header. Accepts "user@host" or {name, email}, and also
 * tolerates a pre-formatted "Name <user@host>" string.
 */
export function formatAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  const { name, email } = addr;
  if (!name) return email;
  return `${encodeHeaderValue(name)} <${email}>`;
}

function addressList(addrs) {
  if (!addrs) return '';
  const arr = Array.isArray(addrs) ? addrs : [addrs];
  return arr.filter(Boolean).map(formatAddress).join(', ');
}

function boundary() {
  return `----=_Part_${randomBytes(12).toString('hex')}`;
}

function bodyPart(contentType, content) {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(content, 'utf8').toString('base64')),
  ].join('\r\n');
}

function attachmentPart(att) {
  const mimeType = att.mimeType || 'application/octet-stream';
  const filename = att.filename || 'attachment';
  const disposition = att.inline ? 'inline' : 'attachment';
  const lines = [
    `Content-Type: ${mimeType}; name="${filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${disposition}; filename="${filename}"`,
  ];
  if (att.inline) lines.push(`Content-ID: <${filename}>`);
  lines.push('', wrap76(String(att.content).replace(/\s+/g, '')));
  return lines.join('\r\n');
}

function multipart(subtype, parts) {
  const b = boundary();
  const body = parts.map((p) => `--${b}\r\n${p}`).join('\r\n') + `\r\n--${b}--`;
  return { contentType: `multipart/${subtype}; boundary="${b}"`, body };
}

/**
 * Build an RFC 5322 message.
 *
 * Threading note: setting threadId on the API call is NOT sufficient for Gmail to
 * keep a reply in its thread — In-Reply-To and References must be present and the
 * subject must stay consistent, or Gmail forks a new thread.
 */
/**
 * Turn a plain-text body into the HTML alternative Gmail needs.
 *
 * A message with ONLY a text/plain part opens in Gmail's plain-text compose mode, and
 * Gmail hard-wraps every line at ~70 characters when it is sent from there. The draft
 * looks fine in the compose window; the recipient gets a chopped, short-line email
 * that reads as automated. That happened to every cold email sent on 2026-10-09.
 * So buildMime never emits a text-only body: when the caller gives no html, this
 * builds one. Blank lines separate paragraphs; a single newline is kept as <br>
 * (sign-offs, addresses). URLs become links.
 */
export function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const link = (s) => s.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}">${u}</a>`);
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((para) => para.replace(/^\n+|\n+$/g, ''))
    .filter((para) => para !== '')
    .map((para) => `<div>${para.split('\n').map((line) => link(esc(line))).join('<br>')}</div>`)
    .join('<div><br></div>');
}

export function buildMime({
  from,
  to,
  cc,
  bcc,
  subject,
  text,
  html,
  attachments = [],
  inReplyTo,
  references,
}) {
  const headers = [];
  if (from) headers.push(`From: ${formatAddress(from)}`);
  if (to) headers.push(`To: ${addressList(to)}`);
  if (cc) headers.push(`Cc: ${addressList(cc)}`);
  if (bcc) headers.push(`Bcc: ${addressList(bcc)}`);
  headers.push(`Subject: ${encodeHeaderValue(subject ?? '')}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) {
    headers.push(`References: ${Array.isArray(references) ? references.join(' ') : references}`);
  }
  headers.push('MIME-Version: 1.0');

  // An empty body is legal; default to empty text so we always emit a valid part.
  const hasText = text != null && text !== '';
  // Never text-only: see textToHtml for why a missing html part is a defect.
  if (hasText && (html == null || html === '')) html = textToHtml(text);
  const hasHtml = html != null && html !== '';

  let contentType;
  let body;

  const bodyParts = [];
  if (hasText) bodyParts.push(bodyPart('text/plain', text));
  if (hasHtml) bodyParts.push(bodyPart('text/html', html));

  if (bodyParts.length === 0) {
    bodyParts.push(bodyPart('text/plain', ''));
  }

  let bodySection;
  if (bodyParts.length > 1) {
    bodySection = multipart('alternative', bodyParts);
  } else {
    // Single part: splice its headers into the top level rather than nesting.
    const [head, ...rest] = bodyParts[0].split('\r\n\r\n');
    const partHeaders = head.split('\r\n');
    bodySection = {
      contentType: partHeaders[0].replace(/^Content-Type:\s*/i, ''),
      body: rest.join('\r\n\r\n'),
      extraHeaders: partHeaders.slice(1),
    };
  }

  if (attachments.length > 0) {
    const inner =
      bodyParts.length > 1
        ? `Content-Type: ${bodySection.contentType}\r\n\r\n${bodySection.body}`
        : bodyParts[0];
    const mixed = multipart('mixed', [inner, ...attachments.map(attachmentPart)]);
    contentType = mixed.contentType;
    body = mixed.body;
  } else {
    contentType = bodySection.contentType;
    body = bodySection.body;
    if (bodySection.extraHeaders) headers.push(...bodySection.extraHeaders);
  }

  headers.push(`Content-Type: ${contentType}`);
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/** Pull a header value out of a Gmail payload's headers array (case-insensitive). */
export function headerValue(payload, name) {
  const target = name.toLowerCase();
  return payload?.headers?.find((h) => h.name.toLowerCase() === target)?.value ?? null;
}

/**
 * Walk a Gmail `format=full` payload tree and pull out the plain-text and HTML bodies.
 * Used when merging an update into an existing draft.
 */
export function extractBodies(payload) {
  const out = { text: null, html: null };
  (function walk(node) {
    if (!node) return;
    const mime = node.mimeType || '';
    const data = node.body?.data;
    if (data && mime === 'text/plain' && out.text == null) {
      out.text = b64urlDecode(data).toString('utf8');
    } else if (data && mime === 'text/html' && out.html == null) {
      out.html = b64urlDecode(data).toString('utf8');
    }
    for (const part of node.parts ?? []) walk(part);
  })(payload);
  return out;
}

/** Split a comma-separated address header into plain address strings. */
export function splitAddresses(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

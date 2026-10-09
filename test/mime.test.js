import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  b64url,
  b64urlDecode,
  buildMime,
  extractBodies,
  formatAddress,
  headerValue,
  splitAddresses,
  textToHtml,
} from '../src/mime.js';

/** Pull a header out of a built MIME string. */
function header(raw, name) {
  const line = raw
    .split('\r\n\r\n')[0]
    .split('\r\n')
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : null;
}

function bodyOf(raw) {
  return raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
}

test('b64url uses RFC 4648 §5 alphabet and strips padding', () => {
  // 0xFB 0xFF encodes to "+/8=" in standard base64 -> "-_8" in base64url.
  const encoded = b64url(Buffer.from([0xfb, 0xff]));
  assert.equal(encoded, '-_8');
  assert.ok(!encoded.includes('+'));
  assert.ok(!encoded.includes('/'));
  assert.ok(!encoded.includes('='));
});

test('b64url round-trips non-ASCII content', () => {
  const original = 'Ann — café ☕ 日本語';
  assert.equal(b64urlDecode(b64url(original)).toString('utf8'), original);
});

test('text-only input still gets an html alternative, so Gmail never hard-wraps it on send', () => {
  const raw = buildMime({
    from: 'sender@example.com',
    to: ['someone@example.com'],
    subject: 'Hello',
    text: 'Body text here',
  });
  assert.match(header(raw, 'Content-Type'), /^multipart\/alternative/);
  assert.equal(header(raw, 'From'), 'sender@example.com');
  assert.equal(header(raw, 'To'), 'someone@example.com');
  assert.equal(header(raw, 'Subject'), 'Hello');
  assert.match(raw, /Content-Type: text\/plain/);
  assert.match(raw, /Content-Type: text\/html/);
});

test('textToHtml: paragraphs, line breaks, escaping and links', () => {
  const html = textToHtml(
    'Owen,\r\n\r\nA long paragraph on one line, with <angle> & ampersand.\n\nBook: https://abax.fund/book-consultation.\n\nKevin\nkevin@abax.fund',
  );
  assert.equal(
    html,
    '<div>Owen,</div><div><br></div>' +
      '<div>A long paragraph on one line, with &lt;angle&gt; &amp; ampersand.</div><div><br></div>' +
      '<div>Book: <a href="https://abax.fund/book-consultation">https://abax.fund/book-consultation</a>.</div><div><br></div>' +
      '<div>Kevin<br>kevin@abax.fund</div>',
  );
});

test('an explicit html body is used as given, not regenerated', () => {
  const raw = buildMime({ to: ['a@b.c'], subject: 's', text: 'plain', html: '<p><b>rich</b></p>' });
  assert.match(raw, /Content-Type: text\/html/);
  const htmlPart = raw.split(/--[^\r\n]+\r\n/).find((x) => /^Content-Type: text\/html/.test(x));
  const b64 = htmlPart.split('\r\n\r\n')[1].replace(/\r\n(--.*)?$/s, '');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '<p><b>rich</b></p>');
});

test('text + html becomes multipart/alternative containing both', () => {
  const raw = buildMime({
    from: 'sender@example.com',
    to: ['a@example.com'],
    subject: 'Both',
    text: 'plain version',
    html: '<p>rich version</p>',
  });
  const ct = header(raw, 'Content-Type');
  assert.match(ct, /^multipart\/alternative; boundary="(.+)"$/);

  const boundary = ct.match(/boundary="(.+)"/)[1];
  const parts = bodyOf(raw)
    .split(`--${boundary}`)
    .filter((p) => p.trim() && !p.startsWith('--'));
  assert.equal(parts.length, 2);

  const decoded = parts.map((p) => {
    const [head, ...rest] = p.trim().split('\r\n\r\n');
    return { head, body: Buffer.from(rest.join('\r\n\r\n'), 'base64').toString('utf8') };
  });
  assert.match(decoded[0].head, /text\/plain/);
  assert.equal(decoded[0].body, 'plain version');
  assert.match(decoded[1].head, /text\/html/);
  assert.equal(decoded[1].body, '<p>rich version</p>');
});

test('attachments wrap the body in multipart/mixed', () => {
  const raw = buildMime({
    from: 'sender@example.com',
    to: ['a@example.com'],
    subject: 'With file',
    text: 'see attached',
    attachments: [
      { filename: 'note.txt', mimeType: 'text/plain', content: Buffer.from('hi').toString('base64') },
    ],
  });
  assert.match(header(raw, 'Content-Type'), /^multipart\/mixed/);
  assert.match(raw, /Content-Disposition: attachment; filename="note\.txt"/);
});

test('non-ASCII subject is RFC 2047 encoded rather than emitted raw', () => {
  const raw = buildMime({ from: 'k@x.com', subject: 'Café ☕', text: 'x' });
  const subject = header(raw, 'Subject');
  assert.match(subject, /^=\?UTF-8\?B\?/);
  const decoded = Buffer.from(subject.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64');
  assert.equal(decoded.toString('utf8'), 'Café ☕');
});

test('ASCII subject is left alone', () => {
  const raw = buildMime({ from: 'k@x.com', subject: 'Plain subject', text: 'x' });
  assert.equal(header(raw, 'Subject'), 'Plain subject');
});

test('threading headers survive into the built message', () => {
  const raw = buildMime({
    from: 'k@x.com',
    to: ['a@example.com'],
    subject: 'Re: Original',
    text: 'reply',
    inReplyTo: '<msg-1@mail.example.com>',
    references: ['<msg-0@mail.example.com>', '<msg-1@mail.example.com>'],
  });
  assert.equal(header(raw, 'In-Reply-To'), '<msg-1@mail.example.com>');
  assert.equal(
    header(raw, 'References'),
    '<msg-0@mail.example.com> <msg-1@mail.example.com>'
  );
});

test('display names are quoted and encoded correctly', () => {
  assert.equal(formatAddress({ name: 'Ann', email: 'a@x.com' }), 'Ann <a@x.com>');
  assert.equal(formatAddress('k@x.com'), 'k@x.com');
  assert.match(formatAddress({ name: 'Café', email: 'k@x.com' }), /^=\?UTF-8\?B\?.+\?= <k@x\.com>$/);
});

test('multiple recipients are comma-joined', () => {
  const raw = buildMime({
    from: 'k@x.com',
    to: ['a@example.com', 'b@example.com'],
    cc: ['c@example.com'],
    text: 'x',
  });
  assert.equal(header(raw, 'To'), 'a@example.com, b@example.com');
  assert.equal(header(raw, 'Cc'), 'c@example.com');
});

test('empty body still produces a valid single part', () => {
  const raw = buildMime({ from: 'k@x.com', to: ['a@x.com'], subject: 'Empty' });
  assert.match(header(raw, 'Content-Type'), /^text\/plain/);
  assert.equal(Buffer.from(bodyOf(raw), 'base64').toString('utf8'), '');
});

test('base64 bodies are wrapped at 76 characters', () => {
  const raw = buildMime({ from: 'k@x.com', text: 'x'.repeat(500) });
  const lines = bodyOf(raw).split('\r\n');
  assert.ok(lines.length > 1, 'long body should wrap onto several lines');
  for (const line of lines) assert.ok(line.length <= 76, `line too long: ${line.length}`);
});

test('extractBodies walks a nested Gmail payload tree', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('the plain body') } },
          { mimeType: 'text/html', body: { data: b64url('<p>the html body</p>') } },
        ],
      },
      { mimeType: 'application/pdf', body: { attachmentId: 'abc' } },
    ],
  };
  assert.deepEqual(extractBodies(payload), {
    text: 'the plain body',
    html: '<p>the html body</p>',
  });
});

test('headerValue matches case-insensitively', () => {
  const payload = { headers: [{ name: 'Message-ID', value: '<a@b>' }] };
  assert.equal(headerValue(payload, 'message-id'), '<a@b>');
  assert.equal(headerValue(payload, 'Missing'), null);
});

test('splitAddresses handles empty and multi-value headers', () => {
  assert.deepEqual(splitAddresses(null), []);
  assert.deepEqual(splitAddresses('a@x.com, b@y.com'), ['a@x.com', 'b@y.com']);
});

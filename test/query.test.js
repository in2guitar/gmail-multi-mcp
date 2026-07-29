import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyQuery } from '../src/gmail.js';

const base = () => new URL('https://example.com/v1/messages');

test('array values repeat the key instead of being comma-joined', () => {
  // The bug this pins: String(['From','Subject']) yields "From,Subject", which Gmail
  // treats as one header name matching nothing. The call still returns 200, so the
  // failure is silent — subject and date just come back null.
  const url = applyQuery(base(), {
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
  });
  assert.deepEqual(url.searchParams.getAll('metadataHeaders'), [
    'From',
    'To',
    'Cc',
    'Subject',
    'Date',
  ]);
  assert.equal(url.searchParams.get('format'), 'metadata');
  assert.ok(!url.search.includes('From%2CTo'), 'must not comma-join the header names');
});

test('scalar values are set normally', () => {
  const url = applyQuery(base(), { q: 'is:unread', maxResults: 20 });
  assert.equal(url.searchParams.get('q'), 'is:unread');
  assert.equal(url.searchParams.get('maxResults'), '20');
});

test('empty, null and undefined values are omitted', () => {
  const url = applyQuery(base(), { a: '', b: null, c: undefined, d: 'kept' });
  assert.equal(url.searchParams.has('a'), false);
  assert.equal(url.searchParams.has('b'), false);
  assert.equal(url.searchParams.has('c'), false);
  assert.equal(url.searchParams.get('d'), 'kept');
});

test('false is preserved rather than dropped as falsy', () => {
  const url = applyQuery(base(), { includeSpamTrash: false });
  assert.equal(url.searchParams.get('includeSpamTrash'), 'false');
});

test('a missing query object is harmless', () => {
  assert.equal(applyQuery(base(), undefined).search, '');
});

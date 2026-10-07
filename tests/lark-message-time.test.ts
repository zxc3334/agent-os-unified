import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMessageReceivedAt } from '../src/im/lark.js';

test('Feishu message timestamp is preserved as ISO time and missing time uses receipt fallback', () => {
  assert.equal(
    normalizeMessageReceivedAt('1791374400000'),
    '2026-10-07T12:00:00.000Z',
  );
  assert.equal(
    normalizeMessageReceivedAt('not-a-time', new Date('2026-10-07T12:34:00.000Z')),
    '2026-10-07T12:34:00.000Z',
  );
});

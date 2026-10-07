import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAppToolName } from '../../src/cli/app-tool-names.js';

test('daily record and reminder MCP tool aliases normalize through engine adapters', () => {
  assert.equal(normalizeAppToolName('capture_daily_record'), 'capture_daily_record');
  assert.equal(normalizeAppToolName('mcp__agent_os__search_daily_records'), 'search_daily_records');
  assert.equal(normalizeAppToolName('agent_os_create_personal_reminder'), 'create_personal_reminder');
  assert.equal(normalizeAppToolName('untrusted_send_message'), undefined);
});

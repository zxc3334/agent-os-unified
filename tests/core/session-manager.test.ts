import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '../../src/core/session-manager.js';
import { JsonSessionStore } from '../../src/core/session-store.js';

const address = { messageId: 'm1', chatId: 'chat', threadId: 'thread', rootId: '' };

test('switching engines preserves the Agent OS matter but clears engine-native history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-session-'));
  try {
    const store = new JsonSessionStore(join(directory, 'sessions.json'));
    const sessions = await SessionManager.open({ store });
    let { session } = await sessions.resolve(address, 'agy', 'assistant', '/workspace');
    session = await sessions.transition(session.id, 'idle');
    await sessions.setCliSessionId(session.id, 'agy-native-1');

    const switched = await sessions.resolve(address, 'codex', 'assistant', '/workspace');
    assert.equal(switched.isNew, false);
    assert.equal(switched.session.id, session.id);
    assert.equal(switched.session.cliId, 'codex');
    assert.equal(switched.session.cliSessionId, undefined);

    const restored = await SessionManager.open({ store });
    const continued = await restored.resolve(address, 'codex', 'assistant', '/workspace');
    assert.equal(continued.session.id, session.id);
    assert.equal(continued.session.cliSessionId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('engine changes are rejected while the matter is actively executing', async () => {
  const sessions = new SessionManager();
  const { session } = await sessions.resolve(address, 'agy', 'assistant', '/workspace');
  await sessions.transition(session.id, 'active');
  await assert.rejects(
    sessions.resolve(address, 'codex', 'assistant', '/workspace'),
    /不能切换执行引擎/,
  );
});

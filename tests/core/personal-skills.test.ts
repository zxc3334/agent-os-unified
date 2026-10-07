import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonPersonalSkillRegistry } from '../../src/core/personal-skills.js';

test('personal skill packs require explicit enablement and only add scoped guidance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-skills-'));
  const file = join(directory, 'personal-skills.json');
  try {
    const registry = new JsonPersonalSkillRegistry(file);
    assert.equal(await registry.promptFor('帮我做模拟面试'), '');
    assert.equal(await registry.enable('career-interview'), true);
    const guidance = await registry.promptFor('请根据简历做模拟面试');
    assert.match(guidance, /求职与项目面试/);
    assert.match(guidance, /不增加工具、权限或记忆空间访问范围/);
    assert.doesNotMatch(guidance, /阅读与读书记录/);

    const reopened = new JsonPersonalSkillRegistry(file);
    assert.equal((await reopened.list()).find((skill) => skill.id === 'career-interview')?.enabled, true);
    assert.equal(await reopened.disable('career-interview'), true);
    assert.equal(await reopened.promptFor('简历项目模拟面试'), '');
    assert.equal(await reopened.enable('not-a-skill'), false);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { enabled: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

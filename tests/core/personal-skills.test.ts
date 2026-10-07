import { explicitlyRequestsCareerFeedbackSave } from '../../src/core/career-feedback-tool.js';
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
    assert.match(guidance, /一次一问/);
    assert.match(guidance, /缺乏证据时追问/);
    assert.match(guidance, /薄弱点和建议复习问题/);
    assert.match(guidance, /明确要求保存或明确同意后调用 save_career_interview_feedback/);
    assert.equal(await registry.isSelectedFor('career-interview', '请根据简历做模拟面试'), true);
    assert.equal(await registry.isSelectedFor('career-interview', '帮我记录午饭'), false);
    assert.doesNotMatch(guidance, /阅读与读书记录/);

    const reopened = new JsonPersonalSkillRegistry(file);
    assert.equal((await reopened.list()).find((skill) => skill.id === 'career-interview')?.enabled, true);
    assert.equal(await reopened.disable('career-interview'), true);
    assert.equal(await reopened.promptFor('简历项目模拟面试'), '');
    assert.equal(await reopened.isSelectedFor('career-interview', '做模拟面试'), false);
    assert.equal(await reopened.enable('not-a-skill'), false);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { enabled: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('career feedback persistence requires explicit owner-language opt-in and rejects negation', () => {
  assert.equal(explicitlyRequestsCareerFeedbackSave('帮我把这次模拟面试反馈记录为复习记录'), true);
  assert.equal(explicitlyRequestsCareerFeedbackSave('请保存刚才的薄弱点'), true);
  assert.equal(explicitlyRequestsCareerFeedbackSave('Save this mock interview feedback'), true);
  assert.equal(explicitlyRequestsCareerFeedbackSave('我们先做一次模拟面试'), false);
  assert.equal(explicitlyRequestsCareerFeedbackSave('不要保存这次面试反馈'), false);
  assert.equal(explicitlyRequestsCareerFeedbackSave('不用保存面试反馈'), false);
});


test('daily-record skill uses bounded sourced recaps without converting them into long-term memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-os-daily-skill-'));
  try {
    const registry = new JsonPersonalSkillRegistry(join(directory, 'personal-skills.json'));
    await registry.enable('daily-records');
    const guidance = await registry.promptFor('帮我做本周回顾');
    assert.match(guidance, /search_daily_records/);
    assert.match(guidance, /指定日期范围/);
    assert.match(guidance, /来源 ID/);
    assert.match(guidance, /不写入长期记忆/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

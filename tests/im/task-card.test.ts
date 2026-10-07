import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTaskCard } from '../../src/im/card.js';

test('partial task cards distinguish incomplete work from full success', () => {
  const card = buildTaskCard({
    title: '个人任务', status: 'partial',
    detail: '部分完成：1 个工具调用失败，请核对结果并重试未完成部分。',
    answer: '已完成部分结果',
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /部分完成/);
  assert.doesNotMatch(serialized, /个人任务 · 已完成/);
  assert.match(serialized, /请核对结果并重试未完成部分/);
});

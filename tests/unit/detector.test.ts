import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLimitMessage } from '../../apps/server/src/modules/limit/detector.ts';

const SAMPLE =
  'Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-10-18 11:37:19 重置。][req_01abc]';

test('429+1308+重置时刻 → 强匹配（high）并提取墙钟', () => {
  const r = parseLimitMessage(SAMPLE);
  assert.ok(r);
  assert.equal(r.httpStatus, 429);
  assert.equal(r.providerCode, '1308');
  assert.equal(r.resetAtRaw, '2026-10-18 11:37:19');
  assert.equal(r.confidence, 'high');
});

test('只有 1308（无 HTTP 状态）→ 中置信匹配', () => {
  const r = parseLimitMessage('[1308][已达到 5 小时的使用上限。您的限额将在 2026-10-18 11:37:19 重置。]');
  assert.ok(r);
  assert.equal(r.httpStatus, null);
  assert.equal(r.providerCode, '1308');
  assert.equal(r.confidence, 'medium');
});

test('只有 429 → 不能断定 5 小时限额，返回 null（§6.2）', () => {
  assert.equal(parseLimitMessage('Request rejected (429) too many requests'), null);
});

test('普通错误文本 → null', () => {
  assert.equal(parseLimitMessage('ECONNRESET socket hang up'), null);
});

test('429+1308 但缺重置时刻 → 匹配但 resetAtRaw=null（上层转 paused）', () => {
  const r = parseLimitMessage('Request rejected (429) · [1308][已达到 5 小时的使用上限。]');
  assert.ok(r);
  assert.equal(r.resetAtRaw, null);
  assert.equal(r.confidence, 'high');
});

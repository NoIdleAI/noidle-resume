import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay } from '../../apps/server/src/modules/scheduler/backoff.ts';
import { classifyResult } from '../../apps/server/src/modules/resume/runner.ts';

test('指数退避 1x/2x/4x，封顶 cap', () => {
  assert.equal(backoffDelay(1, 60_000, 600_000), 60_000);
  assert.equal(backoffDelay(2, 60_000, 600_000), 120_000);
  assert.equal(backoffDelay(3, 60_000, 600_000), 240_000);
  assert.equal(backoffDelay(10, 60_000, 600_000), 600_000);
  assert.equal(backoffDelay(0, 60_000, 600_000), 60_000); // 下界修正
});

const SID = 'sid-1234';

test('classifyResult：成功结果', () => {
  const out = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '好的，继续。',
    session_id: SID,
  });
  const r = classifyResult(out, SID);
  assert.equal(r.kind, 'ok');
  assert.equal(r.resultSessionId, SID);
});

test('classifyResult：is_error 且 429/1308 → still-limited', () => {
  const out = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result:
      'API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-10-24 00:00:00 重置。]',
  });
  assert.equal(classifyResult(out, SID).kind, 'still-limited');
});

test('classifyResult：is_error 其他错误 → error', () => {
  const out = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'network unreachable',
  });
  assert.equal(classifyResult(out, SID).kind, 'error');
});

test('classifyResult：session_id 不符 → error（分叉防护）', () => {
  const out = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: 'other-session',
  });
  const r = classifyResult(out, SID);
  assert.equal(r.kind, 'error');
  assert.match(r.message ?? '', /session_id 不符/);
});

test('classifyResult：无结果 JSON → error', () => {
  assert.equal(classifyResult('some random output', SID).kind, 'error');
});

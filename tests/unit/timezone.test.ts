import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSupportedTimezone,
  utcToZonedWall,
  zonedTimeToUtc,
} from '../../apps/server/src/modules/limit/timezone.ts';

test('Asia/Shanghai 墙钟 → UTC（+8）', () => {
  const d = zonedTimeToUtc('2026-10-18 11:37:19', 'Asia/Shanghai');
  assert.equal(d.toISOString(), '2026-10-18T03:37:19.000Z');
});

test('跨夏令时时区：纽约夏令时 -4', () => {
  const d = zonedTimeToUtc('2026-07-10 12:00:00', 'America/New_York');
  assert.equal(d.toISOString(), '2026-07-10T16:00:00.000Z');
});

test('跨夏令时时区：纽约标准时 -5', () => {
  const d = zonedTimeToUtc('2026-01-10 12:00:00', 'America/New_York');
  assert.equal(d.toISOString(), '2026-01-10T17:00:00.000Z');
});

test('UTC 时区恒等', () => {
  const d = zonedTimeToUtc('2026-10-18 11:37:19', 'UTC');
  assert.equal(d.toISOString(), '2026-10-18T11:37:19.000Z');
});

test('roundtrip：UTC → 上海墙钟 → UTC', () => {
  const orig = zonedTimeToUtc('2026-10-18 11:37:19', 'Asia/Shanghai');
  const wall = utcToZonedWall(orig, 'Asia/Shanghai');
  assert.equal(wall, '2026-10-18 11:37:19');
  assert.equal(zonedTimeToUtc(wall, 'Asia/Shanghai').getTime(), orig.getTime());
});

test('非法墙钟抛错', () => {
  assert.throws(() => zonedTimeToUtc('not-a-date', 'Asia/Shanghai'));
});

test('时区支持判断', () => {
  assert.equal(isSupportedTimezone('Asia/Shanghai'), true);
  assert.equal(isSupportedTimezone('Mars/Phobos'), false);
});

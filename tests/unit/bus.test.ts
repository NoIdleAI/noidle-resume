import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../apps/server/src/shared/bus.ts';

test('EventBus：seq 全局单调递增，事件帧携带', () => {
  const bus = new EventBus();
  assert.equal(bus.seq, 0);
  const seen: number[] = [];
  bus.onEvent((e) => seen.push(e.seq!));
  bus.emit('task.changed', {});
  bus.emit('session.changed', {});
  bus.emit('heartbeat', {});
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(bus.seq, 3);
});

test('EventBus：off 之后不再收，seq 仍前进', () => {
  const bus = new EventBus();
  let hits = 0;
  const off = bus.onEvent(() => hits++);
  bus.emit('service.note', {});
  off();
  bus.emit('service.note', {});
  assert.equal(hits, 1);
  assert.equal(bus.seq, 2);
});

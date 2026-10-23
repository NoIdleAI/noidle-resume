import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findUserEntryByContent,
  hasLineage,
  latestLeafUuid,
  newestDescendantLeaf,
  readTranscriptEntries,
  type TranscriptEntry,
} from '../../apps/server/src/modules/resume/transcript.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const e = (
  type: string,
  uuid: string,
  parentUuid: string | null,
  content?: string,
): TranscriptEntry => ({
  type,
  uuid,
  parentUuid,
  message: content
    ? { role: type, content }
    : { role: type, content: [{ type: 'text', text: '回复' }] },
});

function chain(): TranscriptEntry[] {
  // u1 ← a1 ← u2(工具轮) ← a2
  return [
    e('user', 'u1', null, '初始问题'),
    e('assistant', 'a1', 'u1'),
    e('user', 'u2', 'a1', '继续 [car:auto t1]'),
    e('assistant', 'a2', 'u2'),
  ];
}

test('latestLeafUuid：链尾为叶', () => {
  assert.equal(latestLeafUuid(chain()), 'a2');
});

test('hasLineage：血统上溯穿过祖先', () => {
  const es = chain();
  assert.equal(hasLineage(es, 'a2', 'u1'), true);
  assert.equal(hasLineage(es, 'a2', 'a1'), true);
  assert.equal(hasLineage(es, 'a2', 'u2'), true);
  assert.equal(hasLineage(es, 'a2', '不存在'), false);
});

test('hasLineage：分叉枝不认别的枝祖先（72f4a5ce 教训）', () => {
  // u1 ← a1（侧边栏枝）；u1 ← uX ← aX（外部枝）
  const es = [
    e('user', 'u1', null, 'q'),
    e('assistant', 'a1', 'u1'),
    e('user', 'uX', 'u1', '外部'),
    e('assistant', 'aX', 'uX'),
  ];
  assert.equal(hasLineage(es, 'aX', 'u1'), true);
  assert.equal(hasLineage(es, 'a1', 'aX'), false);
  assert.equal(hasLineage(es, 'aX', 'a1'), false);
});

test('findUserEntryByContent：全等匹配本工具帧', () => {
  const es = chain();
  assert.equal(findUserEntryByContent(es, '继续 [car:auto t1]')?.uuid, 'u2');
  assert.equal(findUserEntryByContent(es, '继续 [car:auto t2]'), null);
  // 部分匹配不算
  assert.equal(findUserEntryByContent(es, '继续'), null);
});

test('newestDescendantLeaf：工具轮的后代叶', () => {
  const es = chain();
  assert.equal(newestDescendantLeaf(es, 'u2'), 'a2');
  assert.equal(newestDescendantLeaf(es, 'u1'), 'a2');
  // 空树/无后代 → null
  assert.equal(newestDescendantLeaf([e('user', 'u9', null, '孤')], 'u9'), null);
});

test('多轮子树收拢：孙代也算后代', () => {
  const es = [
    e('user', 'r', null, 'root'),
    e('assistant', 'c1', 'r'),
    e('user', 'c2', 'c1'),
    e('assistant', 'c3', 'c2'),
  ];
  assert.equal(newestDescendantLeaf(es, 'r'), 'c3');
});

test('readTranscriptEntries：坏行跳过、字段归一', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-lineage-'));
  try {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'q' } }),
        '{broken json',
        '',
        JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1' }),
      ].join('\n'),
    );
    const es = readTranscriptEntries(file);
    assert.equal(es.length, 2);
    assert.equal(es[1]?.uuid, 'a1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

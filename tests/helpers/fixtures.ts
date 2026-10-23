import fs from 'node:fs';
import path from 'node:path';

/** 构造一个「真实形状」的工作区转写夹具（帧内 cwd 供身份核验）。 */
export interface WorkspaceFixture {
  projectPath: string;
  transcriptFile: string;
  sessionId: string;
  /** 初始叶（assistant 回答帧的 uuid）。 */
  baseLeafUuid: string;
}

export function makeWorkspaceFixture(
  projectsRoot: string,
  name: string,
  opts?: { sessionId?: string; initialTurns?: boolean },
): WorkspaceFixture {
  const sessionId = opts?.sessionId ?? `sid-${Math.random().toString(36).slice(2, 10)}`;
  const projectPath = path.join(projectsRoot, 'workspaces', name);
  fs.mkdirSync(projectPath, { recursive: true });
  const encoded = projectPath.replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(projectsRoot, encoded);
  fs.mkdirSync(dir, { recursive: true });
  const transcriptFile = path.join(dir, `${sessionId}.jsonl`);

  const baseLeafUuid = `${name}-a1`;
  if (opts?.initialTurns !== false) {
    const frames = [
      {
        type: 'user',
        uuid: `${name}-u1`,
        parentUuid: null,
        message: { role: 'user', content: `${name} 的初始问题` },
        sessionId,
        cwd: projectPath,
        timestamp: new Date().toISOString(),
      },
      {
        type: 'assistant',
        uuid: baseLeafUuid,
        parentUuid: `${name}-u1`,
        message: { role: 'assistant', content: [{ type: 'text', text: '初始回答' }] },
        sessionId,
        cwd: projectPath,
        timestamp: new Date().toISOString(),
      },
    ];
    fs.writeFileSync(
      transcriptFile,
      frames.map((f) => JSON.stringify(f)).join('\n') + '\n',
    );
  }
  return { projectPath, transcriptFile, sessionId, baseLeafUuid };
}

/** 429+1308 限额 api_error 帧（探针实录形状）。 */
export function limitFrame(
  fixture: WorkspaceFixture,
  resetWall: string,
  reqid = 'req_unknown',
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'api_error',
    sessionId: fixture.sessionId,
    cwd: fixture.projectPath,
    timestamp: new Date().toISOString(),
    error: `Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 ${resetWall} 重置。][${reqid}]`,
    retryInMs: 45000,
    maxRetries: 10,
  };
}

/** 模拟「本工具续跑轮已落盘」：追加 user(含精确 prompt) + assistant 帧。 */
export function appendResumeTurn(
  fixture: WorkspaceFixture,
  prompt: string,
  fromLeaf: string,
): { userUuid: string; assistantUuid: string } {
  const userUuid = `our-${Math.random().toString(36).slice(2, 10)}`;
  const assistantUuid = `our-a-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const frames = [
    {
      type: 'user',
      uuid: userUuid,
      parentUuid: fromLeaf,
      message: { role: 'user', content: prompt },
      sessionId: fixture.sessionId,
      cwd: fixture.projectPath,
      timestamp: now,
    },
    {
      type: 'assistant',
      uuid: assistantUuid,
      parentUuid: userUuid,
      message: { role: 'assistant', content: [{ type: 'text', text: '好的，继续。' }] },
      sessionId: fixture.sessionId,
      cwd: fixture.projectPath,
      timestamp: now,
    },
  ];
  fs.appendFileSync(
    fixture.transcriptFile,
    frames.map((f) => JSON.stringify(f)).join('\n') + '\n',
  );
  return { userUuid, assistantUuid };
}

/** 未来某墙钟时刻（Asia/Shanghai）的「YYYY-MM-DD HH:mm:ss」。 */
export function wallClockAhead(msAhead: number): string {
  // 直接以本地墙钟近似（测试机即 Asia/Shanghai），够测试用
  const d = new Date(Date.now() + msAhead);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

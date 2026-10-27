import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { assertCold } from './coldGuard.ts';

const execFileAsync = promisify(execFile);

/**
 * 热会话接管（2026-10-25 真机实验定案，C 方案）：
 * VS Code 侧边栏持有的会话（--resume=<sid> 签名进程）在到期时挡住续跑。
 * 实验证明：杀掉专属持有进程后扩展不会自动重启、血统不分叉、
 * vscode:// URI 可复活会话界面。安全边界（事故教训）：
 * ① 只杀命令行「精确带 --resume=<sid>」的进程；无 sid 的共享 daemon 一个不碰；
 * ② 杀前必须确认转写静默（用户没在聊）；
 * ③ 杀后复查冷持有，仍热（竞态复活）则本轮放弃。
 */

/** 转写静默判定：最近写入早于 quietMs（用户大概率没在聊）。 */
export function transcriptQuiet(file: string, quietMs: number, now = Date.now()): boolean {
  try {
    return now - fs.statSync(file).mtimeMs >= quietMs;
  } catch {
    return false; // 文件不可读（异常态）：按不静默处理，不动手
  }
}

/** 结束热持有者：复用 assertCold 的探针枚举（unix pgrep / windows CIM，均带 sid 精确匹配）。 */
export async function killHotHolders(sessionId: string): Promise<number[]> {
  const check = await assertCold(sessionId);
  const pids = (check.pids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/PID', String(pid), '/F', '/T'], { timeout: 5000 });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      killed.push(pid);
    } catch {
      /* 进程可能已自行退出：忽略，最终以复查为准 */
    }
  }
  return killed;
}

/** 复活命令构造（纯函数，单测覆盖）：macOS open / Windows cmd start。 */
export function makeReviveCommand(
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): { bin: string; args: string[] } {
  const uri = `vscode://anthropic.claude-code/open?session=${sessionId}`;
  if (platform === 'win32') {
    return { bin: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', uri] };
  }
  return { bin: 'open', args: [uri] };
}

/** 续跑成功后：复活 VS Code 里的会话界面 +（macOS）系统通知。失败静默——不影响结算。 */
export function reviveSession(sessionId: string, displayName?: string): void {
  const { bin, args } = makeReviveCommand(sessionId);
  try {
    spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* 打不开 VS Code 协议就算了 */
  }
  if (process.platform === 'darwin') {
    try {
      const title = 'NoIdle Resume';
      const msg = `已续跑「${displayName ?? sessionId.slice(0, 8)}」，VS Code 会话界面已刷新`;
      const esc = msg.replace(/"/g, '\\"');
      spawn(
        'osascript',
        ['-e', `display notification "${esc}" with title "${title}"`],
        { stdio: 'ignore', detached: true },
      ).unref();
    } catch {
      /* 通知失败无碍 */
    }
  }
}

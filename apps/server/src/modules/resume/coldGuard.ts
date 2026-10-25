import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ColdCheckResult {
  cold: boolean;
  /** 命中的进程号（热持有时）。 */
  pids?: string[];
  /** 检测失败时的原因（按热持有处理，保守拒跑）。 */
  error?: string;
}

/** 平台策略点：扩展侧以 `--resume=<sessionId>` 签名 spawn 自带 CLI，命中即热持有。 */
export interface ResumeProbe {
  bin: string;
  args: string[];
  /** stdout 有进程号行 = 热持有；空 stdout = 冷。 */
  hasMatch(stdout: string): string[];
}

/** unix 探针：pgrep -f 全量命令行 ERE 匹配（macOS/Linux）。 */
export function unixResumeProbe(sessionId: string): ResumeProbe {
  return {
    bin: 'pgrep',
    args: ['-f', '--', `--resume[= ]${sessionId}`],
    hasMatch(stdout) {
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    },
  };
}

/**
 * Windows 探针：pgrep 不存在，经 PowerShell CIM 枚举进程命令行匹配。
 * 只放行 [0-9a-zA-Z_-] 进过滤串（sessionId 本是 UUID，防御外部输入），杜绝 WQL 注入。
 * 探测参数构造为纯函数，单测覆盖（tests/unit/platform.test.ts）。
 */
export function windowsResumeProbeArgs(sessionId: string): string[] {
  const safe = sessionId.replace(/[^0-9a-zA-Z_-]/g, '');
  const filter = `CommandLine LIKE '%--resume=${safe}%' OR CommandLine LIKE '%--resume ${safe}%'`;
  const script = `(Get-CimInstance Win32_Process -Filter "${filter}").ProcessId`;
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

export function windowsResumeProbe(sessionId: string): ResumeProbe {
  return {
    bin: 'powershell.exe',
    args: windowsResumeProbeArgs(sessionId),
    hasMatch(stdout) {
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    },
  };
}

/**
 * 探针超时：Windows CIM 首查要初始化 WMI，繁忙机器上可达 10s+（GitHub runner
 * 实测踩过：5s 超时 → 误判热持有 → 全部续跑测试退避），放宽到 30s；
 * unix pgrep 本地毫秒级，5s 足够。
 */
export function probeTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 30_000 : 5_000;
}

/**
 * 冷会话守卫（设计书 §5.1 规则 11 / §13 assertCold）。
 *
 * 命中 `--resume=<sessionId>` 签名进程即视为热持有，拒绝恢复，避免 silent 分叉。
 * 检测本身失败也按热持有处理（宁可转待确认，不可冒险分叉）。
 * 平台差异收口在本文件（策略点 2），业务侧只见 assertCold 一个入口。
 */
export async function assertCold(sessionId: string): Promise<ColdCheckResult> {
  const probe =
    process.platform === 'win32' ? windowsResumeProbe(sessionId) : unixResumeProbe(sessionId);
  try {
    const { stdout } = await execFileAsync(probe.bin, probe.args, {
      timeout: probeTimeoutMs(),
      windowsHide: true,
    });
    const pids = probe.hasMatch(stdout);
    if (pids.length > 0) return { cold: false, pids };
    return { cold: true };
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === 1) return { cold: true }; // pgrep 无匹配退出码 1
    return { cold: false, error: e.message ?? String(err) };
  }
}

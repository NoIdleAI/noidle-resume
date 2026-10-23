/**
 * 墙钟 → UTC 换算（设计书 §6.3）。
 * 智谱重置时刻是「2026-10-18 11:37:19」这种不带时区的墙钟文本，
 * 按配置时区（默认 Asia/Shanghai）解释，落库一律 UTC ISO。
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(tz, fmt);
  }
  return fmt;
}

/** 某一 UTC 时刻在目标时区的墙钟，换回毫秒后与 UTC 的偏差。 */
function tzOffsetMs(utc: Date, tz: string): number {
  const parts = formatter(tz).formatToParts(utc);
  const get = (type: string): number => {
    const v = parts.find((p) => p.type === type)?.value ?? '0';
    return Number(v === '24' ? '0' : v); // hour12:false 下午夜可能给出 24
  };
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - utc.getTime();
}

export function isSupportedTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 「YYYY-MM-DD HH:mm:ss」按指定时区解释成 UTC 时刻。 */
export function zonedTimeToUtc(wall: string, tz: string): Date {
  const normalized = wall.trim().replace(' ', 'T');
  const naiveMs = Date.parse(`${normalized}Z`);
  if (Number.isNaN(naiveMs)) {
    throw new Error(`无法解析的墙钟时间: ${wall}`);
  }
  const firstGuess = new Date(naiveMs);
  const offset1 = tzOffsetMs(firstGuess, tz);
  const secondGuess = new Date(naiveMs - offset1);
  const offset2 = tzOffsetMs(secondGuess, tz);
  return new Date(naiveMs - offset2);
}

/** UTC 时刻 → 目标时区墙钟文本（展示用）。 */
export function utcToZonedWall(utc: Date, tz: string): string {
  const fmt = formatter(tz);
  const parts = fmt.formatToParts(utc);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const pad = (n: string) => n.padStart(2, '0');
  return `${get('year')}-${pad(get('month'))}-${pad(get('day'))} ${pad(
    get('hour') === '24' ? '0' : get('hour'),
  )}:${pad(get('minute'))}:${pad(get('second'))}`;
}

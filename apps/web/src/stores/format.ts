/** 时间展示工具：全部按配置时区渲染（重置时刻按绝对时间锚定，设计书 §6.3）。 */

function partsIn(tz: string, iso: string): Intl.DateTimeFormatPart[] | null {
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return fmt.formatToParts(new Date(iso));
  } catch {
    return null;
  }
}

function pick(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '--';
}

/** HH:mm（时区墙上钟）。iso 非法返回 '—'。 */
export function fmtHM(iso: string | null, tz: string): string {
  if (!iso) return '—';
  const parts = partsIn(tz, iso);
  if (!parts) return '—';
  return `${pick(parts, 'hour')}:${pick(parts, 'minute')}`;
}

/** HH:mm:ss（时区墙上钟）。 */
export function fmtHMS(iso: string | null, tz: string): string {
  if (!iso) return '—';
  const parts = partsIn(tz, iso);
  if (!parts) return '—';
  return `${pick(parts, 'hour')}:${pick(parts, 'minute')}:${pick(parts, 'second')}`;
}

/** MM-DD HH:mm（时区墙上钟），跨天事件用。 */
export function fmtMDHM(iso: string | null, tz: string): string {
  if (!iso) return '—';
  const parts = partsIn(tz, iso);
  if (!parts) return '—';
  return `${pick(parts, 'month')}-${pick(parts, 'day')} ${pick(parts, 'hour')}:${pick(parts, 'minute')}`;
}

/** 浏览器本地 HH:mm:ss（日志行用）。 */
export function fmtLocalHMS(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface RemainParts {
  main: string;
  sec: string;
  total: string;
}

/** 剩余时间 → 大数字分段（mm:ss 或 h:mm:ss + 独立秒）。负数/非法返回 null。 */
export function remainParts(targetIso: string, nowMs: number): RemainParts | null {
  const t = new Date(targetIso).getTime();
  if (Number.isNaN(t)) return null;
  const diff = Math.max(0, Math.floor((t - nowMs) / 1000));
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  const mm = h > 0 ? `${h}:${p(m)}` : p(m);
  return {
    main: h > 0 ? `${h}:${p(m)}` : p(m),
    sec: `:${p(s)}`,
    total: `${mm}:${p(s)}`,
  };
}

/** 「now」在指定时区的墙上钟（datetime-local 预填用）：YYYY-MM-DDTHH:mm。 */
export function nowWallInTz(tz: string, atMs = Date.now()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(atMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  } catch {
    const d = new Date(atMs);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}

/** 相对时刻短语（最近会话下拉用）：N 分钟前 / N 小时前 / 昨日 / MM-DD。 */
export function agoShort(iso: string, nowMs = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const min = Math.floor((nowMs - t) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  if (h < 48) return '昨日';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

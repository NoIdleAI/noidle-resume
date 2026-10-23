/** 可注入时钟：调度器与状态机不直接读系统时间（设计书 §6.3 绝对时间重算）。 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** 测试用固定时钟。 */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(d: Date): void {
    this.current = new Date(d.getTime());
  }
}

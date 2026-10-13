/**
 * 单帧 dt 上限（秒，文档 4.6：防止卡顿后瞬移）。
 * 移动类逻辑统一用 min(dt, MAX_DT_SEC) 计算步长。
 */
export const MAX_DT_SEC = 0.05;

/**
 * 帧率无关计时器（项目宪法 6.6：时间逻辑走 dt，不依赖固定帧率）。
 *
 * 由根系统每帧调用 update(dt) 驱动（dt 单位：秒）。
 * delay/interval 由调用方传入，本类不持有任何游戏数值。
 */
interface TimerTask {
  id: number;
  remaining: number;
  interval: number; // 0 表示一次性
  repeat: boolean;
  callback: () => void;
  alive: boolean;
}

class Timer {
  private tasks: TimerTask[] = [];
  private nextId = 1;

  /** 一次性延时（秒），返回任务 id 便于取消。 */
  after(delaySec: number, callback: () => void): number {
    const id = this.nextId++;
    this.tasks.push({ id, remaining: delaySec, interval: 0, repeat: false, callback, alive: true });
    return id;
  }

  /** 周期任务（秒），返回任务 id 便于取消。 */
  every(intervalSec: number, callback: () => void): number {
    const id = this.nextId++;
    this.tasks.push({ id, remaining: intervalSec, interval: intervalSec, repeat: true, callback, alive: true });
    return id;
  }

  /** 取消任务。 */
  cancel(id: number): void {
    const t = this.tasks.find(x => x.id === id);
    if (t) t.alive = false;
  }

  /** 每帧驱动（dt 单位：秒）。 */
  update(dt: number): void {
    if (dt <= 0) return;
    for (const t of this.tasks) {
      if (!t.alive) continue;
      t.remaining -= dt;
      if (t.remaining > 0) continue;
      t.callback();
      if (t.repeat) {
        t.remaining += t.interval;
        if (t.remaining < 0) t.remaining = 0;
      } else {
        t.alive = false;
      }
    }
    if (this.tasks.some(t => !t.alive)) {
      this.tasks = this.tasks.filter(t => t.alive);
    }
  }
}

export const timer = new Timer();

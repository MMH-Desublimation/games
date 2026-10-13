/**
 * 帧驱动注册表（core：引擎封装）。
 *
 * 背景：本项目的系统多为「模块级单例」（RunFlow / BuffSystem / 地宫系统等），没有场景节点可挂 update；
 * 统一在此登记每帧回调，由 Boot.update 驱动，避免各模块互相直接引用实例（宪法 6.13）。
 *
 * 约定：回调需自行绑定 this（用箭头函数属性或 bind），本类不做绑定。
 */
export type TickFn = (dtSec: number) => void;

class Ticker {
  private fns: TickFn[] = [];
  /** 已上报过异常的回调（同一个回调只报错一次，避免每帧刷屏）。 */
  private reported: TickFn[] = [];

  /** 注册每帧回调（重复注册忽略）。 */
  add(fn: TickFn): void {
    if (this.fns.indexOf(fn) < 0) {
      this.fns.push(fn);
    }
  }

  /** 取消注册。 */
  remove(fn: TickFn): void {
    const i = this.fns.indexOf(fn);
    if (i >= 0) {
      this.fns.splice(i, 1);
    }
  }

  /**
   * 每帧驱动（按下标遍历，不产生临时数组；回调内不要增删注册）。
   *
   * **错误隔离**：单个系统的回调抛异常时，其余系统必须继续被驱动。
   * 否则会出现「某个系统坏掉 → 它后面的系统整片静默失效」的连锁故障
   * （实测过：技能系统异常导致技能栏永远不显示，且没有任何报错线索）。
   */
  update(dtSec: number): void {
    for (let i = 0; i < this.fns.length; i++) {
      const fn = this.fns[i];
      try {
        fn(dtSec);
      } catch (err) {
        if (this.reported.indexOf(fn) < 0) {
          this.reported.push(fn);
          console.error('[Ticker] 每帧回调抛出异常（已隔离，仅报一次）：', err);
        }
      }
    }
  }
}

export const ticker = new Ticker();

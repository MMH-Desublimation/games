/**
 * 可复现随机数（纯函数，无引擎依赖）。
 * 用于掉落/Buff 抽取等需要可控随机的场景；调用方自行用种子构造实例。
 * 算法：mulberry32。
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    // 保证非零状态
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** [0, 1) 浮点。 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) 浮点。 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** [min, max] 闭区间整数。 */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** 以概率 p（0~1）命中。 */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 从数组随机取一个元素。 */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** 按权重抽取（keys 与 weights 等长）。 */
  weightedPick<T>(keys: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this.next() * total;
    for (let i = 0; i < keys.length; i++) {
      r -= weights[i];
      if (r < 0) return keys[i];
    }
    return keys[keys.length - 1];
  }
}

/** 便捷工厂。 */
export function createRandom(seed: number): Random {
  return new Random(seed);
}

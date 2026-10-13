import { Node, Prefab, instantiate } from 'cc';

interface Pool {
  /** 节点生产方式：Prefab 实例化或程序化灰盒节点（仅在池空/预分配时调用）。 */
  factory: () => Node;
  free: Node[];
  active: Set<Node>;
  /** 活跃对象硬上限（文档 4.9：超限回收最旧）。 */
  cap: number;
}

/**
 * 通用节点对象池（项目宪法 6.5 / 文档 4.5）。
 *
 * 用法：先 register / registerFactory（含预分配数量与上限），
 * 再 get(key) 取节点、release(key, node) 回收；运行时不再直接创建/销毁节点。
 * 上限语义（文档 4.9）：子弹/飘字等超出硬上限时，自动回收「最旧」的活跃对象。
 */
class PoolManager {
  private static pools = new Map<string, Pool>();

  /**
   * 以 Prefab 注册对象池（敌人等有形资源的首选方式）。
   * @param preload 预分配数量（启动期一次性创建，避免运行期抖动）
   * @param cap 活跃对象硬上限
   */
  static register(poolKey: string, prefab: Prefab, preload = 0, cap = Infinity): void {
    this.registerFactory(poolKey, () => instantiate(prefab), preload, cap);
  }

  /** 以工厂函数注册对象池（子弹/飘字/特效等灰盒程序化节点）。 */
  static registerFactory(poolKey: string, factory: () => Node, preload = 0, cap = Infinity): void {
    if (this.pools.has(poolKey)) {
      return;
    }
    const pool: Pool = { factory, free: [], active: new Set(), cap };
    this.pools.set(poolKey, pool);
    for (let i = 0; i < preload; i++) {
      const node = factory();
      node.active = false;
      pool.free.push(node);
    }
  }

  /** 池是否已注册。 */
  static has(poolKey: string): boolean {
    return this.pools.has(poolKey);
  }

  /**
   * 取一个节点（自动激活）。调用方负责挂到目标层级/父节点并设置位置。
   * @returns 未注册对象池或创建失败时返回 null
   */
  static get(poolKey: string): Node | null {
    const pool = this.pools.get(poolKey);
    if (!pool) {
      console.error(`[PoolManager] 未注册对象池: ${poolKey}`);
      return null;
    }
    if (pool.active.size >= pool.cap) {
      const oldest = pool.active.values().next().value as Node | undefined;
      if (oldest) {
        this.release(poolKey, oldest);
      }
    }
    let node = pool.free.pop();
    if (!node || !node.isValid) {
      node = pool.factory();
    }
    node.active = true;
    pool.active.add(node);
    return node;
  }

  /** 回收节点：移出父节点并停用，留作复用。 */
  static release(poolKey: string, node: Node): void {
    const pool = this.pools.get(poolKey);
    if (!pool || !pool.active.has(node)) {
      return;
    }
    pool.active.delete(node);
    node.removeFromParent();
    node.active = false;
    pool.free.push(node);
  }

  /**
   * 回收该池的**全部活跃节点**（退回空闲队列，不销毁）。
   *
   * 用途：开局 / 结算时清理"上一局仍在播放的"表现层节点。
   * 若不清理，上一局的长时长节点（技能引导特效可达数秒）会跨局继续播放 ——
   * 表现为「退出 / 重进 / 换职业后，开局一瞬看到上一局的技能动画残留」。
   */
  static releaseAll(poolKey: string): void {
    const pool = this.pools.get(poolKey);
    if (!pool) {
      return;
    }
    for (const node of Array.from(pool.active)) {
      this.release(poolKey, node);
    }
  }

  /** 清空（可选指定 key）。会销毁所有节点，仅在场景切换/退出时调用。 */
  static clear(poolKey?: string): void {
    if (poolKey) {
      const pool = this.pools.get(poolKey);
      if (!pool) {
        return;
      }
      for (const n of pool.active) {
        n.destroy();
      }
      for (const n of pool.free) {
        n.destroy();
      }
      this.pools.delete(poolKey);
    } else {
      for (const key of this.pools.keys()) {
        this.clear(key);
      }
    }
  }
}

export { PoolManager };

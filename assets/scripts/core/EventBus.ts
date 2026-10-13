import { EventName } from './EventNames';

/** 事件回调签名。参数为动态负载，由各事件自行约定结构。 */
export type EventHandler = (...args: any[]) => void;

/** 取消订阅函数：由 on 返回，推荐持有并在组件 onDestroy 中调用。 */
export type OffFn = () => void;

/** 内部订阅记录：保存原回调与绑定 target 后的回调，保证 off 能精确匹配。 */
interface Subscription {
  handler: EventHandler;
  bound: EventHandler;
  target?: unknown;
}

/**
 * 全局事件总线单例。
 *
 * 规则（项目宪法 6.6）：
 *  - 事件名必须是 EventNames 成员（类型已约束，禁止字符串字面量）。
 *  - 订阅方必须在销毁时取消订阅（on 返回 OffFn，推荐在 onDestroy 调用）。
 *  - 回调内禁止做耗时操作（如同步 IO / 存档读写）。
 *
 * 支持三参数订阅 on(name, handler, target)：target 会被绑定为回调的 this，
 * 与 Node/Component 事件监听习惯一致。派发时单个回调抛错不影响其他订阅者。
 *
 * 本类不依赖引擎，纯 TypeScript 实现，便于单元测试与复用。
 */
class EventBus {
  private handlers: Map<string, Subscription[]> = new Map();

  /**
   * 订阅事件。
   * @param target 可选，作为回调执行时的 this（传 this 即组件实例）。
   * @returns 取消订阅函数，调用即退订。
   */
  on(name: EventName, handler: EventHandler, target?: unknown): OffFn {
    const bound: EventHandler = target !== undefined ? handler.bind(target) : handler;
    let list = this.handlers.get(name);
    if (!list) {
      list = [];
      this.handlers.set(name, list);
    }
    list.push({ handler, bound, target });
    return () => this.off(name, handler, target);
  }

  /** 订阅一次，触发后自动退订。 */
  once(name: EventName, handler: EventHandler, target?: unknown): OffFn {
    const wrapper: EventHandler = (...args: any[]) => {
      this.off(name, wrapper);
      handler.apply(target, args);
    };
    return this.on(name, wrapper);
  }

  /** 取消订阅。须与订阅时传入相同的 name/handler/target。 */
  off(name: EventName, handler: EventHandler, target?: unknown): void {
    const list = this.handlers.get(name);
    if (!list) {
      return;
    }
    const idx = list.findIndex((s) => s.handler === handler && s.target === target);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
    if (list.length === 0) {
      this.handlers.delete(name);
    }
  }

  /** 发布事件。快照迭代；单回调抛错仅记录，不中断后续订阅者。 */
  emit(name: EventName, ...args: any[]): void {
    const list = this.handlers.get(name);
    if (!list || list.length === 0) {
      return;
    }
    const snapshot = [...list];
    for (let i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i].bound(...args);
      } catch (err) {
        console.error(`[EventBus] 事件 ${String(name)} 的某个订阅者抛出异常:`, err);
      }
    }
  }

  /** 移除某事件的全部订阅（场景重置等场景使用）。 */
  clearEvent(name: EventName): void {
    this.handlers.delete(name);
  }

  /** 清空所有订阅（仅调试或整体重置使用）。 */
  clearAll(): void {
    this.handlers.clear();
  }
}

export const eventBus = new EventBus();

import { Vec2 } from 'cc';

/**
 * 虚拟摇杆的**输入状态**（core 层：只有状态，没有渲染、没有触摸）。
 *
 * 为什么单独放在 core：
 *  - `entities/Player` 需要读摇杆方向，而摇杆的**渲染与触摸采集**在 `ui/VirtualStick`；
 *  - 若让 `entities` 直接 import `ui`，就会与既有的 `ui → entities`（`Minimap` 读 `playerRef`）
 *    形成**双向依赖**；
 *  - 把状态提到 core 后，`ui` 与 `entities` **都只依赖 core** ⇒ 分层干净（宪法 6.2）。
 *
 * 数据流向：`ui/VirtualStick`（触摸 → 写） → `core/VirtualInput`（状态） → `entities/Player`（读）。
 */
class VirtualInput {
  /** 归一化方向（长度 0~1；松手为 0）。 */
  private readonly axis = new Vec2(0, 0);

  /** 由摇杆视图层写入（触摸移动 / 触摸结束）。 */
  setAxis(x: number, y: number): void {
    this.axis.set(x, y);
  }

  /** 归零（松手 / 退出本局）。 */
  clear(): void {
    this.axis.set(0, 0);
  }

  /** 当前方向（长度 0~1）。注意：返回的是**内部实例**，只读使用。 */
  getAxis(): Vec2 {
    return this.axis;
  }

  /** 是否有有效输入。 */
  isActive(): boolean {
    return this.axis.x !== 0 || this.axis.y !== 0;
  }
}

export const virtualInput = new VirtualInput();

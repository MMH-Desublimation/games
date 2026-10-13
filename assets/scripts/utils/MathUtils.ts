/**
 * 纯数学工具（无引擎依赖）。
 * 单位约定（项目宪法 6.3）：距离用像素(px)，角度用弧度。
 * 规则：仅放纯函数/类型，禁止在此写入任何游戏数值（数值一律外置配置）。
 */
export class MathUtils {
  /** 将 value 限制在 [min, max]。 */
  static clamp(value: number, min: number, max: number): number {
    return value < min ? min : (value > max ? max : value);
  }

  /** 线性插值：a + (b - a) * t。 */
  static lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  /** 两点欧氏距离（像素）。 */
  static dist(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 两点距离平方（避免开方，用于比较）。 */
  static distSq(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    return dx * dx + dy * dy;
  }

  /** 由 a 指向 b 的角度（弧度）。 */
  static angleTo(ax: number, ay: number, bx: number, by: number): number {
    return Math.atan2(by - ay, bx - ax);
  }

  /** 向 target 逼近，单步最多移动 maxDelta。 */
  static approach(current: number, target: number, maxDelta: number): number {
    if (current < target) return Math.min(current + maxDelta, target);
    if (current > target) return Math.max(current - maxDelta, target);
    return target;
  }

  /** 将角度归一化到 [0, 2π)。 */
  static wrapAngle(rad: number): number {
    const twoPi = Math.PI * 2;
    let a = rad % twoPi;
    if (a < 0) a += twoPi;
    return a;
  }

  static degToRad(deg: number): number {
    return deg * Math.PI / 180;
  }

  static radToDeg(rad: number): number {
    return rad * 180 / Math.PI;
  }
}

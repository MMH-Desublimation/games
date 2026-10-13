import { _decorator, Color, Component, Graphics, Node, UIOpacity } from 'cc';
import { PoolManager } from '../core/PoolManager';
import { attachToViewLayer } from '../core/ViewRoot';
import { MAX_DT_SEC } from '../core/Timer';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { dataManager } from '../data/DataManager';

const { ccclass } = _decorator;

/** 危险范围对象池 key。 */
export const DANGER_ZONE_POOL = 'danger_zone';

/** 表现常量（非游戏数值）。 */
const FILL_COLOR = new Color(255, 64, 64, 88);
const RING_COLOR = new Color(255, 96, 96, 255);
const RING_WIDTH_PX = 6;
/** 闪烁透明度上下限（0~255）。 */
const PULSE_MIN = 80;
const PULSE_MAX = 255;

/**
 * 危险范围预警（视图层，文档 4.7：特效层）。
 *
 * 用途：Boss「跳砸」等范围技在蓄力期间标出落点与范围，给玩家规避窗口（文档 2.6 / 用户裁决）。
 * 纯表现：只订阅 on_boss_telegraph(x, y, 半径px, 持续ms)，结束时归还对象池（宪法 6.5）；
 * 半径由事件携带（数值来自 enemies.json，本文件不持有游戏数值）。
 */
@ccclass('DangerZone')
export class DangerZone extends Component {
  private g: Graphics | null = null;
  private opacity: UIOpacity | null = null;
  private totalSec = 0;
  private elapsedSec = 0;

  onLoad(): void {
    this.g = this.node.getComponent(Graphics);
    this.opacity = this.node.getComponent(UIOpacity);
  }

  play(xPx: number, yPx: number, radiusPx: number, totalSec: number): void {
    this.reset(xPx, yPx, totalSec);
    const g = this.g;
    if (!g) {
      return;
    }
    g.clear();
    g.fillColor = FILL_COLOR;
    g.circle(0, 0, radiusPx);
    g.fill();
    g.lineWidth = RING_WIDTH_PX;
    g.strokeColor = RING_COLOR;
    g.circle(0, 0, radiusPx);
    g.stroke();
  }

  /**
   * 矩形危险范围（`on_danger_rect` 的表现）：长边沿**局部 x 轴**，用节点旋转对齐方向。
   * `angleRad` = `atan2(dy, dx)`（与 Cocos 的 `node.angle` 同为逆时针为正，可直接换算成度）。
   */
  playRect(
    xPx: number, yPx: number, lengthPx: number, widthPx: number, angleRad: number, totalSec: number,
  ): void {
    this.reset(xPx, yPx, totalSec);
    this.node.angle = (angleRad * 180) / Math.PI;
    const g = this.g;
    if (!g) {
      return;
    }
    const halfLen = lengthPx / 2;
    const halfWid = widthPx / 2;
    g.clear();
    g.fillColor = FILL_COLOR;
    g.rect(-halfLen, -halfWid, lengthPx, widthPx);
    g.fill();
    g.lineWidth = RING_WIDTH_PX;
    g.strokeColor = RING_COLOR;
    g.rect(-halfLen, -halfWid, lengthPx, widthPx);
    g.stroke();
  }

  /** 公共重置：位置 / 计时 / 不透明度，（**并清掉上一次可能残留的旋转**）。 */
  private reset(xPx: number, yPx: number, totalSec: number): void {
    this.node.setPosition(xPx, yPx, 0);
    this.node.angle = 0; // 池复用：圆形预警必须清掉矩形留下的角度
    this.totalSec = totalSec;
    this.elapsedSec = 0;
    if (this.opacity) {
      this.opacity.opacity = PULSE_MAX;
    }
  }

  update(dt: number): void {
    if (gameState.isPaused()) return; // 暂停时整体冻结，画面静止
    const step = Math.min(dt, MAX_DT_SEC);
    this.elapsedSec += step;
    const t = this.totalSec > 0 ? this.elapsedSec / this.totalSec : 1;
    if (t >= 1) {
      this.despawn();
      return;
    }
    if (this.opacity) {
      // 越接近落点闪得越快，强化"要来了"的可读性
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsedSec * (8 + 20 * t));
      this.opacity.opacity = Math.floor(PULSE_MIN + (PULSE_MAX - PULSE_MIN) * pulse);
    }
  }

  private despawn(): void {
    PoolManager.release(DANGER_ZONE_POOL, this.node);
  }
}

function createDangerZoneNode(): Node {
  const node = new Node('danger_zone');
  node.addComponent(Graphics);
  node.addComponent(UIOpacity);
  node.addComponent(DangerZone);
  return node;
}

/** 订阅 Boss 预警事件，标出危险范围。 */
class DangerZoneSystem {
  constructor() {
    eventBus.on(EventNames.on_boss_telegraph, this.onTelegraph, this);
    // 通用危险范围（技能型 Buff「雷电」等复用同一表现，含预警闪烁）
    eventBus.on(EventNames.on_danger_zone, this.onTelegraph, this);
    // 矩形危险范围（冲锋路径 / 水柱 / 火焰）
    eventBus.on(EventNames.on_danger_rect, this.onRect, this);
  }

  private onTelegraph(xPx: number, yPx: number, radiusPx: number, durationMs: number): void {
    const node = PoolManager.get(DANGER_ZONE_POOL);
    if (!node) {
      return;
    }
    attachToViewLayer(node, 'effect');
    node.getComponent(DangerZone)?.play(xPx, yPx, radiusPx, durationMs / 1000);
  }

  private onRect(
    xPx: number, yPx: number, lengthPx: number, widthPx: number, angleRad: number, durationMs: number,
  ): void {
    const node = PoolManager.get(DANGER_ZONE_POOL);
    if (!node) {
      return;
    }
    attachToViewLayer(node, 'effect');
    node.getComponent(DangerZone)?.playRect(xPx, yPx, lengthPx, widthPx, angleRad, durationMs / 1000);
  }
}

export const dangerZoneSystem = new DangerZoneSystem();

/** 注册危险范围池（由 Boot 在配置就绪后调用）。 */
export function registerDangerZonePool(): void {
  const perf = dataManager.get<any>('balance', 'performance');
  PoolManager.registerFactory(
    DANGER_ZONE_POOL, createDangerZoneNode, perf.preload_danger_zone, perf.max_danger_zone_count,
  );
}

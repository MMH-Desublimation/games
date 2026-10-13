import { _decorator, Color, Component, Node, Sprite, UITransform } from 'cc';
import { PoolManager } from '../core/PoolManager';
import { attachToViewLayer } from '../core/ViewRoot';
import { getWhiteFrame } from '../core/WhiteFrame';
import { MAX_DT_SEC } from '../core/Timer';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { dataManager } from '../data/DataManager';
import { playerRef } from '../entities/Player';

const { ccclass } = _decorator;

/** 特效应池 key（灰盒用纯色方块扩散表示受击与死亡）。 */
export const EFFECT_POOL = 'hit_effect';

/** 表现常量（非游戏数值） */
const HIT_COLOR = new Color(255, 255, 255, 210);
const PLAYER_HURT_COLOR = new Color(255, 80, 80, 230);
const DEATH_COLOR = new Color(255, 120, 120, 220);
const HIT_FROM_PX = 10;
const HIT_TO_PX = 26;
const DEATH_FROM_PX = 16;
const DEATH_TO_PX = 46;

/**
 * 受击 / 死亡特效（视图层，文档 4.7：特效层）。
 * 纯表现：只订阅事件、驱动自身动画，结束时归还对象池（宪法 6.5）。
 */
@ccclass('HitEffect')
export class HitEffect extends Component {
  private ut: UITransform | null = null;
  private sp: Sprite | null = null;
  private totalSec = 0;
  private elapsedSec = 0;
  private fromPx = 0;
  private toPx = 0;
  private readonly baseColor = new Color();
  private readonly fadeColor = new Color();

  onLoad(): void {
    this.ut = this.node.getComponent(UITransform);
    this.sp = this.node.getComponent(Sprite);
  }

  /** 坐标用世界根坐标（与玩法统一口径）。 */
  play(xPx: number, yPx: number, fromPx: number, toPx: number, color: Color, totalSec: number): void {
    this.node.setPosition(xPx, yPx, 0);
    this.fromPx = fromPx;
    this.toPx = toPx;
    this.totalSec = totalSec;
    this.elapsedSec = 0;
    this.baseColor.set(color);
    this.applySize(fromPx);
    if (this.sp) {
      this.sp.color = color;
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
    this.applySize(this.fromPx + (this.toPx - this.fromPx) * t);
    if (this.sp) {
      this.fadeColor.set(
        this.baseColor.r, this.baseColor.g, this.baseColor.b,
        Math.floor(this.baseColor.a * (1 - t)),
      );
      this.sp.color = this.fadeColor;
    }
  }

  private applySize(px: number): void {
    if (this.ut) {
      this.ut.setContentSize(px, px);
    }
  }

  private despawn(): void {
    PoolManager.release(EFFECT_POOL, this.node);
  }
}

function createEffectNode(): Node {
  const node = new Node('hit_effect');
  const sp = node.addComponent(Sprite);
  sp.spriteFrame = getWhiteFrame();
  sp.sizeMode = Sprite.SizeMode.CUSTOM;
  sp.color = HIT_COLOR;
  const ut = node.getComponent(UITransform);
  if (ut) {
    ut.setContentSize(HIT_FROM_PX, HIT_FROM_PX);
  }
  node.addComponent(HitEffect);
  return node;
}

/** 受击 / 死亡特效表现：订阅 on_damage_dealt 与 on_enemy_died。 */
class HitEffectSystem {
  constructor() {
    eventBus.on(EventNames.on_damage_dealt, this.onDamageDealt, this);
    eventBus.on(EventNames.on_enemy_died, this.onEnemyDied, this);
    eventBus.on(EventNames.on_player_hurt, this.onPlayerHurt, this);
  }

  /** 玩家受击：在角色位置播放红色脉冲，直观提示"正在被围攻"。 */
  private onPlayerHurt(): void {
    if (!playerRef) {
      return;
    }
    const wp = playerRef.position;
    this.play(wp.x, wp.y, PLAYER_HURT_COLOR, 'hit_effect_ms', HIT_FROM_PX, HIT_TO_PX);
  }

  private onDamageDealt(xPx: number, yPx: number): void {
    this.play(xPx, yPx, HIT_COLOR, 'hit_effect_ms', HIT_FROM_PX, HIT_TO_PX);
  }

  /** 死亡爆点：优先用事件携带的世界根坐标（敌人节点此时可能已被回收）。 */
  private onEnemyDied(node: Node, xPx?: number, yPx?: number): void {
    if (xPx !== undefined && yPx !== undefined) {
      this.play(xPx, yPx, DEATH_COLOR, 'death_effect_ms', DEATH_FROM_PX, DEATH_TO_PX);
      return;
    }
    const wp = node.position;
    this.play(wp.x, wp.y, DEATH_COLOR, 'death_effect_ms', DEATH_FROM_PX, DEATH_TO_PX);
  }

  private play(xPx: number, yPx: number, color: Color, msKey: string, fromPx: number, toPx: number): void {
    const node = PoolManager.get(EFFECT_POOL);
    if (!node) {
      return;
    }
    attachToViewLayer(node, 'effect');
    const ms = dataManager.get<any>('balance', 'combat')[msKey];
    node.getComponent(HitEffect)?.play(xPx, yPx, fromPx, toPx, color, ms / 1000);
  }
}

export const hitEffectSystem = new HitEffectSystem();

/** 注册特效应池（由 Boot 在配置就绪后调用）。 */
export function registerHitEffectPool(): void {
  const perf = dataManager.get<any>('balance', 'performance');
  PoolManager.registerFactory(EFFECT_POOL, createEffectNode, perf.preload_effect, perf.max_effect_count);
}

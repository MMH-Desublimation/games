import { _decorator, Color, Component, Label, Node } from 'cc';
import { PoolManager } from '../core/PoolManager';
import { attachToViewLayer } from '../core/ViewRoot';
import { MAX_DT_SEC } from '../core/Timer';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { dataManager } from '../data/DataManager';
import { playerRef } from '../entities/Player';

const { ccclass } = _decorator;

/** 飘字对象池 key（文档 4.9：硬上限 max_float_text，超限回收最旧）。 */
export const DAMAGE_TEXT_POOL = 'damage_text';

/** 表现常量（非游戏数值，灰盒阶段调整） */
const FONT_SIZE = 24;
const RISE_PX = 44;
const START_OFFSET_PX = 14;
const DAMAGE_COLOR = new Color(255, 235, 200, 255);
const PLAYER_HURT_COLOR = new Color(255, 110, 110, 255);

/**
 * 伤害飘字（视图层，文档 4.7：独立飘字层，便于限流与合并）。
 * 只听事件、只做表现，不修改任何游戏状态（文档 4.2）。
 */
@ccclass('DamageText')
export class DamageText extends Component {
  private label: Label | null = null;
  private totalSec = 0;
  private elapsedSec = 0;
  /** 起始位置（世界根坐标，与玩法统一口径）。 */
  private wx = 0;
  private wy = 0;
  private readonly baseColor = new Color();
  private readonly fadeColor = new Color();

  onLoad(): void {
    this.label = this.node.getComponent(Label);
  }

  play(xPx: number, yPx: number, text: string, color: Color, totalSec: number): void {
    this.totalSec = totalSec;
    this.elapsedSec = 0;
    this.wx = xPx;
    this.wy = yPx + START_OFFSET_PX;
    this.node.setPosition(this.wx, this.wy, 0);
    this.baseColor.set(color);
    if (this.label) {
      this.label.string = text;
      this.label.color = color;
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
    this.node.setPosition(this.wx, this.wy + RISE_PX * t, 0);
    if (this.label) {
      // 复用临时颜色对象，避免逐帧分配（宪法 6.10）
      this.fadeColor.set(this.baseColor.r, this.baseColor.g, this.baseColor.b, Math.floor(255 * (1 - t)));
      this.label.color = this.fadeColor;
    }
  }

  private despawn(): void {
    PoolManager.release(DAMAGE_TEXT_POOL, this.node);
  }
}

function createDamageTextNode(): Node {
  const node = new Node('damage_text');
  const label = node.addComponent(Label);
  label.fontSize = FONT_SIZE;
  label.lineHeight = FONT_SIZE + 4;
  label.color = DAMAGE_COLOR;
  label.string = '';
  node.addComponent(DamageText);
  return node;
}

/**
 * 伤害飘字表现。
 * 订阅 on_damage_dealt(x, y, 伤害值) 显示对敌伤害；
 * 订阅 on_player_hurt(伤害值) 在玩家位置显示受击伤害（红字），便于察觉被围攻。
 */
class DamageTextSystem {
  constructor() {
    eventBus.on(EventNames.on_damage_dealt, this.onDamageDealt, this);
    eventBus.on(EventNames.on_player_hurt, this.onPlayerHurt, this);
  }

  private onDamageDealt(xPx: number, yPx: number, amount: number): void {
    this.spawn(xPx, yPx, amount, DAMAGE_COLOR);
  }

  private onPlayerHurt(amount: number): void {
    if (!playerRef) {
      return;
    }
    const wp = playerRef.position;
    this.spawn(wp.x, wp.y, amount, PLAYER_HURT_COLOR);
  }

  private spawn(xPx: number, yPx: number, amount: number, color: Color): void {
    const node = PoolManager.get(DAMAGE_TEXT_POOL);
    if (!node) {
      return;
    }
    attachToViewLayer(node, 'floatText');
    const ms = dataManager.get<any>('balance', 'combat').damage_text_ms;
    node.getComponent(DamageText)?.play(xPx, yPx, String(Math.round(amount)), color, ms / 1000);
  }
}

export const damageTextSystem = new DamageTextSystem();

/** 注册飘字池（由 Boot 在配置就绪后调用）。 */
export function registerDamageTextPool(): void {
  const perf = dataManager.get<any>('balance', 'performance');
  PoolManager.registerFactory(DAMAGE_TEXT_POOL, createDamageTextNode, perf.preload_float_text, perf.max_float_text);
}

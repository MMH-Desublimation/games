import { _decorator, Color, Component, Node, Sprite, UITransform } from 'cc';
import { PoolManager } from '../core/PoolManager';
import { attachToViewLayer } from '../core/ViewRoot';
import { getWhiteFrame } from '../core/WhiteFrame';
import { MAX_DT_SEC } from '../core/Timer';
import { gameState } from '../core/GameState';
import { dataManager } from '../data/DataManager';
import { playerRef } from '../entities/Player';

const { ccclass } = _decorator;

/** 敌方子弹对象池 key（文档 4.9：独立硬上限 max_enemy_bullet_count）。 */
export const ENEMY_BULLET_POOL = 'enemy_bullet';

/** 灰盒敌方弹颜色（表现常量，非游戏数值）。 */
const ENEMY_BULLET_COLOR = new Color(255, 118, 190, 255);

/**
 * 敌方子弹（combat：Boss 等远程攻击的伤害载体）。
 *
 * 特点（用户裁决：慢弹速可规避）：飞行速度 / 半径 / 存活时间 / 伤害倍率**全部由发射方从配置读入**，
 * 本类只负责飞行与命中玩家，不持有任何游戏数值（宪法 6.7）。
 *
 * 规则（项目宪法 6.5）：节点全程经 PoolManager 复用，禁止运行期 new Node；
 * 规则（文档 4.6）：位移使用 min(dt, MAX_DT_SEC) 固定上限步长。
 */
@ccclass('EnemyBullet')
export class EnemyBullet extends Component {
  private wx = 0;
  private wy = 0;
  private vx = 0;
  private vy = 0;
  private damage = 0;
  private radiusPx = 0;
  private lifeSec = 0;

  launch(
    xPx: number, yPx: number, dirX: number, dirY: number,
    speedPxPerSec: number, radiusPx: number, lifeSec: number, damage: number,
  ): void {
    this.wx = xPx;
    this.wy = yPx;
    this.node.setPosition(xPx, yPx, 0);
    this.vx = dirX * speedPxPerSec;
    this.vy = dirY * speedPxPerSec;
    this.damage = damage;
    this.radiusPx = radiusPx;
    this.lifeSec = lifeSec;
    const ut = this.node.getComponent(UITransform);
    if (ut) {
      ut.setContentSize(radiusPx * 2, radiusPx * 2);
    }
    const sp = this.node.getComponent(Sprite);
    if (sp) {
      sp.color = ENEMY_BULLET_COLOR;
    }
  }

  update(dt: number): void {
    if (gameState.isPaused()) return; // 暂停（升级选卡）时冻结飞行
    if (!gameState.isRunActive()) {
      this.despawn();
      return;
    }
    const step = Math.min(dt, MAX_DT_SEC);
    this.lifeSec -= step;
    if (this.lifeSec <= 0) {
      this.despawn();
      return;
    }
    this.wx += this.vx * step;
    this.wy += this.vy * step;
    this.node.setPosition(this.wx, this.wy, 0);
    if (this.hitCheck()) {
      this.despawn();
    }
  }

  /** 命中判定：与玩家体积求交（容差取 balance.combat.contact_dist_px，与接触伤害同一口径）。 */
  private hitCheck(): boolean {
    const player = playerRef;
    if (!player) {
      return false;
    }
    const tolerancePx = dataManager.get<any>('balance', 'combat').contact_dist_px;
    const reach = this.radiusPx + tolerancePx;
    const dx = player.position.x - this.wx;
    const dy = player.position.y - this.wy;
    if (dx * dx + dy * dy > reach * reach) {
      return false;
    }
    if (gameState.isImmuneRanged()) {
      return true; // 免疫远程（技能效果）：弹丸失效但不结算伤害
    }
    if (this.damage > 0) {
      gameState.takeDamage(this.damage); // 内部广播 on_player_hurt（飘字 / 受击特效由表现层消费）
    }
    return true;
  }

  private despawn(): void {
    PoolManager.release(ENEMY_BULLET_POOL, this.node);
  }
}

/** 池内节点工厂：1x1 白图，尺寸在 launch 时按弹半径设置。 */
function createEnemyBulletNode(): Node {
  const node = new Node('enemy_bullet');
  const sp = node.addComponent(Sprite);
  sp.spriteFrame = getWhiteFrame();
  sp.sizeMode = Sprite.SizeMode.CUSTOM;
  sp.color = ENEMY_BULLET_COLOR;
  const ut = node.getComponent(UITransform);
  if (ut) {
    ut.setContentSize(1, 1);
  }
  node.addComponent(EnemyBullet);
  return node;
}

/** 注册敌方子弹池（由 Boot 在配置就绪后调用；预分配与上限取自 balance.performance）。 */
export function registerEnemyBulletPool(): void {
  const perf = dataManager.get<any>('balance', 'performance');
  PoolManager.registerFactory(
    ENEMY_BULLET_POOL, createEnemyBulletNode, perf.preload_enemy_bullet, perf.max_enemy_bullet_count,
  );
}

/** 发射一发敌方子弹（数值由调用方按配置算好后传入）。 */
export function fireEnemyBullet(
  xPx: number, yPx: number, dirX: number, dirY: number,
  speedPxPerSec: number, radiusPx: number, lifeSec: number, damage: number,
): void {
  const node = PoolManager.get(ENEMY_BULLET_POOL);
  if (!node) {
    return;
  }
  attachToViewLayer(node, 'bullet');
  node.getComponent(EnemyBullet)?.launch(xPx, yPx, dirX, dirY, speedPxPerSec, radiusPx, lifeSec, damage);
}

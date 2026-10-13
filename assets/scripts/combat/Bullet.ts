import { _decorator, Color, Component, Node, Sprite, UITransform } from 'cc';
import { PoolManager } from '../core/PoolManager';
import { attachToViewLayer } from '../core/ViewRoot';
import { getWhiteFrame } from '../core/WhiteFrame';
import { MAX_DT_SEC } from '../core/Timer';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { dataManager } from '../data/DataManager';
import { entityManagerRef } from '../entities/EntityManager';
import { Enemy } from '../entities/Enemy';
import { MathUtils } from '../utils/MathUtils';
import { Random } from '../utils/Random';
import { applyOnHitEffects } from './OnHitEffects';

const { ccclass } = _decorator;

/** 子弹对象池 key（文档 4.9：硬上限 max_bullet_count）。 */
export const BULLET_POOL = 'bullet';

/** 灰盒子弹颜色（表现常量，非游戏数值）。 */
const BULLET_COLOR = new Color(255, 240, 120, 255);

/** 池内子弹的随机源播种计数（让每发子弹的冰缓/连锁掷点互不相同）。 */
let rngSeed = 1;

/**
 * 子弹行为参数（由 combat 依职业配置构造；子弹本身不持有任何游戏数值，宪法 6.7）。
 *
 * 职业普攻差异（文档 2.7）：
 *  - 法师：`explodeRadiusPx > 0` → 命中首个敌人后爆开，对范围内其余敌人造成溅射伤害；
 *  - 射手：`pierceCount` → 命中后不消失，可继续穿透该数量的敌人（有限穿透）；
 *  - 战士：近战 AOE，不发射子弹（走 CombatSystem 近战分支）。
 */
export interface BulletSpec {
  damage: number;
  lifestealRatio: number;
  /** 可继续穿透的敌人数（0 = 命中即消失）。 */
  pierceCount: number;
  /** 命中后爆开半径（px；0 = 不爆开）。 */
  explodeRadiusPx: number;
  /** 爆开溅射伤害 = damage × 该系数（1 = 全额）。 */
  explodeDamageRatio: number;
  /**
   * 体积倍率（可选，1 = 默认）。技能型 Buff 的「飞斧 / 飞剑」用它做出弹体差异，
   * 避免为了视觉差异新增一套投射物池（宪法 6.5：复用对象池）。
   */
  radiusScale?: number;
  /** 弹射次数（可选，> 0 时命中后转向下一个敌人继续飞，而不是消失）。 */
  bounceCount?: number;
  /** 射程尽头自动爆开（可选；技能型 Buff「爆弹」用：没打到敌人也要在尽头炸开）。 */
  explodeOnExpire?: boolean;
  /** 命中 / 爆开时播放的特效 key（可选，见 `fx.json`）。 */
  fxOnHit?: string;
  /** 命中 / 爆开特效的**目标世界尺寸**（最长边 px；0 = 用 fx.json 的 scale）。 */
  fxTargetPx?: number;
  /**
   * 存活时长（毫秒，可选）：射程 = 弹速 × 时长。
   * 技能型 Buff 的「爆弹」用它做远程射程（比普攻远得多），0 = 用职业默认寿命。
   */
  lifeMs?: number;
}

/**
 * 子弹（combat：伤害载体，自身负责飞行与命中）。
 *
 * 规则（项目宪法 6.5）：节点全程经 PoolManager 复用，禁止运行期 new Node；
 * 规则（文档 4.6）：位移使用 min(dt, MAX_DT_SEC) 固定上限步长，避免卡顿瞬移；
 * 规则（文档 4.2）：本类不创建 UI，只发 on_damage_dealt 由表现层消费。
 */
@ccclass('Bullet')
export class Bullet extends Component {
  /** 世界根坐标（玩法统一坐标口径；各层容器与世界根均在原点）。 */
  private wx = 0;
  private wy = 0;
  private vx = 0;
  private vy = 0;
  private damage = 0;
  private radiusPx = 0;
  private lifeSec = 0;
  private lifestealRatio = 0;
  private pierceLeft = 0;
  /** 剩余弹射次数（Buff「弹射」）。 */
  private bounceLeft = 0;
  /** 射程尽头自动爆开（技能型 Buff「爆弹」）。 */
  private explodeOnExpire = false;
  /** 命中 / 爆开时播放的特效 key（空 = 不播）。 */
  private fxOnHit = '';
  /** 命中 / 爆开特效的目标世界尺寸（0 = 用 fx.json 默认缩放）。 */
  private fxTargetPx = 0;
  /** 命中附加效果（冰缓 / 灼烧 / 连锁）的概率掷点（池内每发子弹独立序列，避免逐发分配）。 */
  private rng = new Random((rngSeed++ * 0x9e3779b1) >>> 0 || 1);
  private explodeRadiusPx = 0;
  private explodeDamageRatio = 1;
  /** 本次飞行已命中的敌人（穿透时避免同一目标重复受伤；复用同一数组，不逐发分配）。 */
  private readonly hitNodes: Node[] = [];

  /** 发射（坐标与方向均为世界根坐标；方向向量需已归一化；数值全部来自配置/调用方）。 */
  launch(xPx: number, yPx: number, dirX: number, dirY: number, spec: BulletSpec): void {
    const c = dataManager.get<any>('balance', 'combat');
    // 投射物体积 / 速度增幅 = 局外养成 + 技能临时增幅 + 局内 Buff
    // （局外 kind 为 projectile_*，局内 Buff「巨矢 / 弹速」的 kind 为 bullet_*，两者都要计）
    const speedScale = 1 + gameState.getBonus('projectile_speed_up') + gameState.getBonus('bullet_speed_up');
    const sizeScale = 1 + gameState.getBonus('projectile_size_up')
      + gameState.getBonus('width_up') + gameState.getBonus('bullet_size_up');
    this.wx = xPx;
    this.wy = yPx;
    this.node.setPosition(xPx, yPx, 0);
    this.vx = dirX * c.bullet_speed_px_per_sec * speedScale;
    this.vy = dirY * c.bullet_speed_px_per_sec * speedScale;
    this.damage = spec.damage;
    this.radiusPx = c.bullet_radius_px * sizeScale * (spec.radiusScale ?? 1);
    // 节点尺寸按本次半径重设（池内节点会被复用，不能沿用工厂期的基础尺寸）
    const ut = this.node.getComponent(UITransform);
    if (ut) {
      ut.setContentSize(this.radiusPx * 2, this.radiusPx * 2);
    }
    // 射程 = 弹速 × 存活时长；技能型爆弹用 lifeMs 覆盖（远程射程），其余沿用职业默认寿命
    this.lifeSec = spec.lifeMs && spec.lifeMs > 0 ? spec.lifeMs / 1000 : c.bullet_life_ms / 1000;
    this.lifestealRatio = spec.lifestealRatio;
    this.pierceLeft = Math.max(0, Math.floor(spec.pierceCount));
    this.bounceLeft = Math.max(0, Math.floor(spec.bounceCount ?? 0));
    this.explodeRadiusPx = spec.explodeRadiusPx;
    this.explodeDamageRatio = spec.explodeDamageRatio;
    this.explodeOnExpire = spec.explodeOnExpire === true;
    this.fxOnHit = spec.fxOnHit ?? '';
    this.fxTargetPx = spec.fxTargetPx ?? 0;
    this.hitNodes.length = 0;
  }

  update(dt: number): void {
    if (gameState.isPaused()) return; // 暂停（升级选卡）时冻结飞行，避免暂停期间继续结算伤害
    const step = Math.min(dt, MAX_DT_SEC);
    this.lifeSec -= step;
    if (this.lifeSec <= 0) {
      // 射程尽头爆开（技能型 Buff「爆弹」）：没打到敌人也要在尽头炸开
      if (this.explodeOnExpire && this.explodeRadiusPx > 0) {
        this.explode(this.wx, this.wy, null);
      }
      this.despawn();
      return;
    }
    this.wx += this.vx * step;
    this.wy += this.vy * step;
    this.node.setPosition(this.wx, this.wy, 0);
    if (this.hitCheck() && this.node.isValid) {
      this.despawn();
    }
  }

  /**
   * 命中检测（双方都用世界根坐标；同屏敌人 ≤ 80，直接遍历，文档 4.8）。
   * @returns true 表示本发子弹结束（爆开 / 穿透用尽 / 无穿透）
   */
  private hitCheck(): boolean {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    if (enemies.length === 0) {
      return false;
    }
    for (const e of enemies) {
      if (this.hitNodes.indexOf(e) >= 0) {
        continue; // 穿透飞行中：同一目标只结算一次
      }
      const enemy = e.getComponent(Enemy);
      if (!enemy) {
        continue;
      }
      const ep = e.position;
      const ex = ep.x;
      const ey = ep.y;
      const reach = this.radiusPx + enemy.getHitRadiusPx();
      const dx = ex - this.wx;
      const dy = ey - this.wy;
      if (dx * dx + dy * dy > reach * reach) {
        continue;
      }
      this.hitNodes.push(e);
      this.applyDamage(enemy, ex, ey, this.damage);
      if (this.explodeRadiusPx > 0) {
        this.explode(ex, ey, e);
        return true; // 爆开后子弹消失
      }
      if (this.pierceLeft > 0) {
        this.pierceLeft -= 1;
        return false; // 继续飞行，命中下一个
      }
      if (this.bounceLeft > 0 && this.retarget()) {
        return false; // 弹射：转向下一个敌人继续飞
      }
      this.playFx(ex, ey);
      return true;
    }
    return false;
  }

  /** 命中后爆开：对半径内其余敌人造成溅射伤害（每个目标单独飘字由表现层消费）。 */
  private explode(xPx: number, yPx: number, primary: Node | null): void {
    this.playFx(xPx, yPx);
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    if (enemies.length === 0) {
      return;
    }
    const damage = Math.max(1, Math.floor(this.damage * this.explodeDamageRatio));
    for (const e of enemies) {
      if (e === primary) {
        continue; // 首个目标已按全额结算，不重复
      }
      const enemy = e.getComponent(Enemy);
      if (!enemy) {
        continue;
      }
      const ep = e.position;
      const ex = ep.x;
      const ey = ep.y;
      const reach = this.explodeRadiusPx + enemy.getHitRadiusPx();
      const dx = ex - xPx;
      const dy = ey - yPx;
      if (dx * dx + dy * dy > reach * reach) {
        continue;
      }
      this.applyDamage(enemy, ex, ey, damage);
    }
  }

  private applyDamage(enemy: Enemy, xPx: number, yPx: number, amount: number): void {
    enemy.takeDamage(amount);
    if (this.lifestealRatio > 0) {
      gameState.heal(amount * this.lifestealRatio);
    }
    eventBus.emit(EventNames.on_damage_dealt, xPx, yPx, amount);
    // 命中附加效果（冰缓 / 灼烧 / 连锁），与近战共用同一实现
    applyOnHitEffects(enemy, enemy.node, xPx, yPx, amount, this.rng);
  }

  /**
   * 弹射（Buff「弹射」）：把飞行方向转向范围内「本次尚未命中过」的最近敌人。
   * @returns 是否找到目标（无目标则子弹按正常命中消失）
   */
  private retarget(): boolean {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    if (enemies.length === 0) {
      return false;
    }
    const rangePx = dataManager.get<any>('balance', 'combat').bounce_retarget_range_px;
    let best: Node | null = null;
    let bestSq = rangePx * rangePx;
    for (const e of enemies) {
      if (this.hitNodes.indexOf(e) >= 0) {
        continue;
      }
      const sq = MathUtils.distSq(this.wx, this.wy, e.position.x, e.position.y);
      if (sq <= bestSq) {
        bestSq = sq;
        best = e;
      }
    }
    if (!best) {
      return false;
    }
    const dx = best.position.x - this.wx;
    const dy = best.position.y - this.wy;
    const len = Math.hypot(dx, dy) || 1;
    const speed = Math.hypot(this.vx, this.vy);
    this.vx = (dx / len) * speed;
    this.vy = (dy / len) * speed;
    this.bounceLeft -= 1;
    this.lifeSec = Math.max(this.lifeSec, 0.3); // 转向后补一点飞行时间，避免刚转就寿终
    return true;
  }

  /** 播放命中 / 爆开特效（fx 为空则跳过；资源缺失由表现层静默降级）。 */
  private playFx(xPx: number, yPx: number): void {
    if (!this.fxOnHit) {
      return;
    }
    eventBus.emit(EventNames.on_fx, this.fxOnHit, xPx, yPx, 0, false, undefined, this.fxTargetPx);
  }

  private despawn(): void {
    PoolManager.release(BULLET_POOL, this.node);
  }
}

/** 池内节点工厂：1x1 白图 + 大小由配置半径决定。 */
function createBulletNode(): Node {
  const node = new Node('bullet');
  const sp = node.addComponent(Sprite);
  sp.spriteFrame = getWhiteFrame();
  sp.sizeMode = Sprite.SizeMode.CUSTOM;
  sp.color = BULLET_COLOR;
  const ut = node.getComponent(UITransform);
  if (ut) {
    const r = dataManager.get<any>('balance', 'combat').bullet_radius_px;
    ut.setContentSize(r * 2, r * 2);
  }
  node.addComponent(Bullet);
  return node;
}

/**
 * 注册子弹池（由 Boot 在配置就绪后调用；预分配与上限取自 balance.performance）。
 */
export function registerBulletPool(): void {
  const perf = dataManager.get<any>('balance', 'performance');
  PoolManager.registerFactory(BULLET_POOL, createBulletNode, perf.preload_bullet, perf.max_bullet_count);
}

/** 发射一发子弹（数值由调用方按伤害公式与职业配置算好后传入）。 */
export function fireBullet(xPx: number, yPx: number, dirX: number, dirY: number, spec: BulletSpec): void {
  const node = PoolManager.get(BULLET_POOL);
  if (!node) {
    return;
  }
  attachToViewLayer(node, 'bullet');
  node.getComponent(Bullet)?.launch(xPx, yPx, dirX, dirY, spec);
}

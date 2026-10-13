import { _decorator, Component, Node, CCFloat, UITransform } from 'cc';
import { gameState } from '../core/GameState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { entityManagerRef } from '../entities/EntityManager';
import { Enemy } from '../entities/Enemy';
import { playerRef } from '../entities/Player';
import { damageFormula } from './DamageFormula';
import { fireBullet, BulletSpec } from './Bullet';
import { applyOnHitEffects } from './OnHitEffects';
import { dataManager } from '../data/DataManager';
import { Random } from '../utils/Random';
import { MathUtils } from '../utils/MathUtils';

const { ccclass, property } = _decorator;

/**
 * 战斗系统（系统层）。把伤害公式真正作用到实体上：
 *  - 玩家按 atk_speed 自动攻击最近敌人（DamageFormula.playerDamage）；
 *  - 敌人与玩家接触时周期结算伤害；
 *  - 敌人死亡发放经验/金币（文档 3.5/3.6）。
 * 规则：本类只编排，数值全部读配置（balance.combat）；状态变更走 gameState。
 */
@ccclass('CombatSystem')
export class CombatSystem extends Component {
  @property(Node) playerNode: Node = null!;
  /** 接触判定距离（px，balance.combat.contact_dist_px 在配置就绪后覆盖）。 */
  @property(CCFloat) contactDistPx = 0;

  private rng = new Random(1);
  private attackTimer = 0;
  private contactTimer = 0;
  private contactIntervalSec = 0;
  /** 本局攻击类型与射程（开局按 characters.json 缓存，近战/远程共用同一套判定）。 */
  private attackType = 'melee';
  private attackRangePx = 0;
  /** 普攻爆开半径倍数（× 角色显示尺寸；characters.attack_explode_radius_scale，0 = 不爆开）。 */
  private explodeRadiusScale = 0;
  /** 爆开溅射伤害系数（characters.attack_explode_damage_ratio，1 = 全额）。 */
  private explodeDamageRatio = 1;
  /** 普攻特效 key（characters.attack_fx；空 = 不播，远程职业由子弹自身承担表现）。 */
  private attackFx = '';

  onLoad(): void {
    this.rng = new Random((Date.now() >>> 0) || 1);
    eventBus.on(EventNames.on_enemy_died, this.onEnemyDied, this);
    eventBus.on(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
  }

  onDestroy(): void {
    eventBus.off(EventNames.on_enemy_died, this.onEnemyDied, this);
    eventBus.off(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.off(EventNames.on_run_start, this.onRunStart, this);
  }

  /** 开局：缓存本职业的攻击类型与射程（换职业重开时重新读取）。 */
  private onRunStart(): void {
    const c = dataManager.get<any>('characters', gameState.getClassId());
    this.attackType = c.attack_type;
    this.attackRangePx = c.attack_range_px;
    // 普攻特性（文档 2.7 职业差异）：法师命中爆开、射手有限穿透；未配置 = 无特性
    this.explodeRadiusScale = c.attack_explode_radius_scale ?? 0;
    this.explodeDamageRatio = c.attack_explode_damage_ratio ?? 1;
    this.attackFx = c.attack_fx ?? '';
    this.attackTimer = 0;
    this.contactTimer = 0;
  }

  /** 配置就绪后读取接触判定参数（单位换算：配置 ms -> 代码 s）。 */
  private onConfigLoaded(): void {
    const cb = dataManager.get<any>('balance', 'combat');
    this.contactIntervalSec = cb.contact_interval_ms / 1000;
    this.contactDistPx = cb.contact_dist_px;
  }

  update(dt: number): void {
    if (!gameState.isRunActive() || !gameState.isAlive()) return;
    if (gameState.isPaused()) return; // 升级选卡等待中冻结玩法层
    const stats = gameState.getStats();

    // 玩家自动攻击
    const atkInterval = stats.atkSpeed > 0 ? 1 / stats.atkSpeed : 1;
    this.attackTimer += dt;
    if (this.attackTimer >= atkInterval) {
      this.attackTimer = 0;
      this.autoAttack();
    }

    // 敌人接触伤害（周期取自 balance.combat.contact_interval_ms）
    this.contactTimer += dt;
    if (this.contactTimer >= this.contactIntervalSec) {
      this.contactTimer = 0;
      this.contactDamage();
    }
  }

  /** 玩家节点：优先取运行期注册表（真正会移动的节点），回退到 Inspector 指定。 */
  private getPlayerNode(): Node | null {
    return playerRef ?? this.playerNode;
  }

  /**
   * 普攻爆开半径（px）= 角色实际显示尺寸 × 配置倍数。
   * 用真实显示尺寸而非硬编码像素：换职业 / 调 render_scale 时无需重新配半径（宪法 6.7）。
   */
  private explodeRadiusPxOf(playerNode: Node): number {
    if (this.explodeRadiusScale <= 0) {
      return 0;
    }
    const ut = playerNode.getComponent(UITransform);
    if (!ut) {
      return 0;
    }
    const size = Math.max(ut.contentSize.width, ut.contentSize.height) * playerNode.scale.x;
    // 叠加爆开范围增幅（局外养成 + 技能临时增幅）
    return size * this.explodeRadiusScale * (1 + gameState.getBonus('explode_radius_up'));
  }

  private autoAttack(): void {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    if (enemies.length === 0) return;
    const pn = this.getPlayerNode();
    if (!pn) return;
    const pp = pn.position;
    let nearest: Node | null = null;
    let best = Infinity;
    for (const e of enemies) {
      const d = MathUtils.distSq(pp.x, pp.y, e.position.x, e.position.y);
      if (d < best) { best = d; nearest = e; }
    }
    if (!nearest) return;
    // 射程判定（characters.attack_range_px）：超出射程不攻击，近战/远程共用
    if (best > this.attackRangePx * this.attackRangePx) return;
    const stats = gameState.getStats();
    const dmg = damageFormula.playerDamage(stats, gameState.getClassId(), this.rng);
    const ls = stats.lifestealRatio;
    if (this.attackType === 'ranged') {
      // 远程：发射子弹，命中时结算伤害（Bullet 负责发 on_damage_dealt）
      const ep = nearest.position;
      const dx = ep.x - pp.x;
      const dy = ep.y - pp.y;
      const baseAngle = Math.atan2(dy, dx);
      const spec: BulletSpec = {
        damage: dmg,
        lifestealRatio: ls,
        // 穿透数 = 职业基础（characters.attack_pierce_count）+ 局内行为型 Buff + 局外养成
        pierceCount: stats.bulletPierce + Math.round(gameState.getBonus('bullet_pierce')),
        explodeRadiusPx: this.explodeRadiusPxOf(pn),
        explodeDamageRatio: this.explodeDamageRatio,
        // 弹射（局内行为型 Buff）：命中后转向下一个敌人继续飞
        bounceCount: Math.round(gameState.getBonus('bullet_bounce')),
      };
      // 多重投射物（局外 amp_proj_count）：以目标方向为中心扇形展开
      const count = Math.max(1, 1 + Math.round(gameState.getBonus('extra_projectile')));
      const spreadRad = dataManager.get<any>('balance', 'combat').extra_projectile_spread_deg * Math.PI / 180;
      for (let i = 0; i < count; i++) {
        const angle = baseAngle + (i - (count - 1) / 2) * spreadRad;
        fireBullet(pp.x, pp.y, Math.cos(angle), Math.sin(angle), spec);
      }
      return;
    }
    // 近战：一次挥砍命中射程内全部敌人（AOE），逐个发伤害事件由表现层消费
    // 表现：播放职业普攻特效（characters.attack_fx，战士 = 双重切割；远程职业由子弹承担表现）
    // 尺寸按攻击射程给出（动画覆盖范围 = 实际命中范围），朝向最近敌人
    if (this.attackFx) {
      const ep0 = nearest.position;
      const angle = (Math.atan2(ep0.y - pp.y, ep0.x - pp.x) * 180) / Math.PI;
      eventBus.emit(EventNames.on_fx, this.attackFx, pp.x, pp.y, angle, false, undefined,
        this.attackRangePx * 2);
    }
    const reachSq = this.attackRangePx * this.attackRangePx;
    let total = 0;
    for (const e of enemies) {
      const ep = e.position;
      if (MathUtils.distSq(pp.x, pp.y, ep.x, ep.y) > reachSq) continue;
      const enemy = e.getComponent(Enemy);
      if (!enemy) continue;
      enemy.takeDamage(dmg);
      eventBus.emit(EventNames.on_damage_dealt, ep.x, ep.y, dmg);
      applyOnHitEffects(enemy, e, ep.x, ep.y, dmg, this.rng);
      total += dmg;
    }
    if (ls > 0 && total > 0) gameState.heal(total * ls);
  }

  private contactDamage(): void {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    const pn = this.getPlayerNode();
    if (!pn) return;
    const pp = pn.position;
    for (const e of enemies) {
      const enemy = e.getComponent(Enemy);
      if (!enemy) continue;
      // 接触判定按「体积边缘」计：中心距 - 敌人命中半径 <= contact_dist_px
      const gap = MathUtils.dist(pp.x, pp.y, e.position.x, e.position.y) - enemy.getHitRadiusPx();
      const atk = enemy.getAtk();
      if (gap <= this.contactDistPx && atk > 0) {
        const hpBefore = gameState.getHp();
        gameState.takeDamage(damageFormula.enemyDamage(atk));
        // 荆棘（行为型 Buff）：仅在「确实受到伤害」时按玩家攻击力反射（无敌帧 / 免疫期间不反射）
        const thorns = gameState.getBonus('thorns');
        if (thorns > 0 && gameState.getHp() < hpBefore) {
          const reflect = Math.max(1, Math.floor(gameState.getStats().atk * thorns));
          enemy.takeDamage(reflect);
          eventBus.emit(EventNames.on_damage_dealt, e.position.x, e.position.y, reflect);
        }
      }
    }
  }

  /**
   * 敌人死亡：按**种类**发放经验/金币（文档 3.5/3.6）。
   *  - 普通怪：经验 = floor(enemy_base_exp × layer_exp_factor^(layer-1))，金币同法；
   *  - 猎杀者（精英）/ Boss：直接取 enemies.hunter / enemies.boss 的 exp、gold。
   * 掉落发放的唯一位置即此处（宪法 6.13：掉落不由其他模块代发）。
   */
  private onEnemyDied(node: Node): void {
    gameState.addKill(); // 结算界面统计（本局击杀数）
    const layer = gameState.getLayer();
    const kind = ((node as any).__kind as string) ?? ((node as any).__isBoss ? 'boss' : 'normal');
    const baseExp = dataManager.get<any>('exp_curve', 'enemy_base_exp');
    const layerExpFactor = dataManager.get<any>('exp_curve', 'layer_exp_factor');
    const scale = Math.pow(layerExpFactor, layer - 1);
    let expAmt: number;
    let goldAmt: number;
    if (kind === 'boss') {
      const boss = dataManager.get<any>('enemies', 'boss');
      expAmt = boss.exp;
      goldAmt = boss.gold;
    } else if (kind === 'hunter') {
      const hunter = dataManager.get<any>('enemies', 'hunter');
      expAmt = hunter.exp;
      goldAmt = hunter.gold;
    } else {
      expAmt = Math.floor(baseExp * scale);
      goldAmt = Math.floor(dataManager.get<any>('enemies', 'normal').gold * scale);
    }
    gameState.addExp(expAmt);
    gameState.addGold(goldAmt);
  }
}

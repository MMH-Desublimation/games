import { _decorator, Color, Component, Sprite } from 'cc';
import { dataManager } from '../data/DataManager';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { MAX_DT_SEC, timer } from '../core/Timer';
import { damageFormula } from '../combat/DamageFormula';
import { fireEnemyBullet } from '../combat/EnemyBullet';
import { resolveWalkableMove } from '../dungeon/DungeonCollision';
import { Random } from '../utils/Random';
import { Enemy } from './Enemy';
import { Player, playerRef } from './Player';

const { ccclass } = _decorator;

/** 预警染色 / 加速染色（表现常量，非游戏数值）。 */
const WINDUP_COLOR = new Color(255, 208, 96, 255);
const HASTE_COLOR = new Color(150, 220, 255, 255);

/** 当前动作（同一时刻只做一个）。 */
type BossAction = 'none' | 'charge' | 'slam' | 'haste' | 'ultimate';

/**
 * 专属大招类型（`boss_ultimates.json` 的 `kind`，用户口径逐个 Boss 一种）：
 *  - `water_line`：锁定玩家那一刻的位置 → 长矩形水柱，持续攻击、每 tick 判定一次（龙）；
 *  - `shockwave`：自身为中心的大范围圆形气浪，**无伤害**，只把玩家强制推出（天狗）；
 *  - `delayed_bombs`：场地内随机 3~6 个**不重叠**的延迟爆炸（巨竹，可走位躲避）；
 *  - `flame_line`：超长矩形火焰，每 tick 直伤 + 触碰附加**不叠加**的小额烧伤 DOT（红武士）。
 */
type UltimateKind = 'water_line' | 'shockwave' | 'delayed_bombs' | 'flame_line' | 'ring_burst';
/** 动作阶段：预警 → 生效 → 收招。 */
type BossPhase = 'windup' | 'active' | 'recover';

/**
 * Boss 独立行为（文档 2.5「Boss 有独立行为模式，不做小怪放大」）。
 *
 * 四种行为（全部参数来自 enemies.json.boss，宪法 6.7 禁止硬编码；用户裁决的行为清单）：
 *  1) **冲锋** charge_*：预警期锁定玩家「那一刻」的位置与朝向 → 沿锁定轴冲锋至多 charge_distance_px；
 *     玩家处于「锁定起点 + 锁定方向 × 长度 × 宽度」矩形内才受伤（倍率 charge_damage_multiplier），
 *     横向移出即可完全规避（朝向已锁定，Boss 不修正）。
 *  2) **跳砸** slam_*：预警期在**落点**标出危险范围（on_boss_telegraph → 表现层画圈），
 *     预警结束后 Boss 跃至落点并对半径内玩家造成 slam_damage_multiplier 倍伤害。
 *  3) **慢速远程弹** bolt_*：向玩家方向发射扇形慢弹（速度低 → 可走位规避）；
 *     越难的 Boss 释放越密集、弹数越多（冷却按 bolt_cooldown_decay_ratio 逐轮递减，弹数按 bolt_count_per_index 递增）。
 *  4) **短时加速** haste_*：短时间提升移速（haste_speed_multiplier），用于贴近玩家。
 *
 * 行为选择（每帧在「无动作」时决策）：近身且跳砸就绪 → 跳砸；否则远程就绪 → 发弹；
 * 否则冲锋就绪 → 冲锋；否则加速就绪 → 加速；都未就绪则继续常规追击（Enemy.update）。
 *
 * 规则：暂停（升级选卡）/ 结算 / 死亡时整体冻结；位移复用 dungeon 的可行走区域求解；
 * 技能期间关闭常规追击（Enemy.setChaseEnabled），避免两套位移互相拉扯。
 */
@ccclass('BossBehavior')
export class BossBehavior extends Component {
  private action: BossAction = 'none';
  private phase: BossPhase = 'recover';
  private timerSec = 0;
  private enemy: Enemy | null = null;
  private bossIndex = 1;

  /** 锁定方向（单位向量）与冲锋起点。 */
  private dirX = 0;
  private dirY = 0;
  private originX = 0;
  private originY = 0;
  private traveledPx = 0;
  private hitDone = false;
  /** 跳砸落点（预警期锁定）。 */
  private slamTargetX = 0;
  private slamTargetY = 0;

  // —— 冷却（秒）——
  private chargeCd = 0;
  private slamCd = 0;
  private hasteCd = 0;
  private boltCd = 0;

  // —— 配置（enemies.json.boss，禁止硬编码）——
  private chargeCooldownSec = 0;
  private chargeWindupSec = 0;
  private chargeSpeedPx = 0;
  private chargeDistancePx = 0;
  private chargeWidthPx = 0;
  private chargeDamageMult = 1;
  private chargeRecoverSec = 0;
  private hasteSpeedMult = 1;
  private hasteDurationSec = 0;
  private hasteCooldownSec = 0;
  private slamCooldownSec = 0;
  private slamWindupSec = 0;
  private slamRangePx = 0;
  private slamRadiusMaxPx = 0;
  private slamRadiusBossMult = 0;
  /** 跳砸实际半径：min(硬上限, Boss 命中半径 × 体积倍率)，越大的 Boss 范围越大（用户裁决）。 */
  private slamRadiusPx = 0;
  private slamDamageMult = 1;
  private slamRecoverSec = 0;
  private boltCooldownSec = 0;
  private boltSpeedPx = 0;
  private boltRadiusPx = 0;
  private boltLifeSec = 0;
  private boltDamageMult = 1;
  private boltCount = 1;
  private boltSpreadRad = 0;

  // —— 专属大招（boss_ultimates.json；空 = 该 Boss 只用统一基座）——
  private ultKind: UltimateKind | '' = '';
  private ultCd = 0;
  private ultCooldownSec = 0;
  private ultWindupSec = 0;
  private ultRecoverSec = 0;
  private ultRangePx = 0;
  private ultWidthPx = 0;
  private ultRadiusPx = 0;
  private ultTickSec = 0.35;
  private ultDurationSec = 0;
  private ultDamageMult = 1;
  private ultKnockbackPx = 0;
  private ultCount = 1;
  private ultDelaySec = 1.5;
  private ultMinGapPx = 0;
  private ultSpreadPx = 400;
  private ultBurnDpsRatio = 0;
  private ultBurnSec = 0;
  private ultFx = '';
  private ultFxSizePx = 0;
  /** `ring_burst`（环形弹幕）专用：弹速 / 弹半径 / 弹寿命。 */
  private ultBoltSpeedPx = 0;
  private ultBoltRadiusPx = 0;
  private ultBoltLifeSec = 0;
  /** 生效期累计（按 `ultTickSec` 判定节奏）。 */
  private ultAccumSec = 0;
  /** 长蓄力时锁定的站位（水柱 / 火焰以它为起点沿方向铺开）。 */
  private lockX = 0;
  private lockY = 0;
  /** 随机爆炸点（巨竹）。 */
  private bombPoints: { x: number; y: number }[] = [];
  private rng = new Random(1);

  /** 由 EntityManager 在 Boss 建怪后调用（layer 决定本轮 Boss 序号 → 远程强度）。 */
  setup(layer: number): void {
    const boss = dataManager.get<any>('enemies', 'boss');
    const dungeon = dataManager.getTable<any>('dungeon');
    this.bossIndex = Math.max(1, Math.floor(layer / dungeon.boss_every_layers));

    this.chargeCooldownSec = boss.charge_cooldown_ms / 1000;
    this.chargeWindupSec = boss.charge_windup_ms / 1000;
    this.chargeSpeedPx = boss.charge_speed_px_per_sec;
    this.chargeDistancePx = boss.charge_distance_px;
    this.chargeWidthPx = boss.charge_width_px;
    this.chargeDamageMult = boss.charge_damage_multiplier;
    this.chargeRecoverSec = boss.charge_recover_ms / 1000;

    this.hasteSpeedMult = boss.haste_speed_multiplier;
    this.hasteDurationSec = boss.haste_duration_ms / 1000;
    this.hasteCooldownSec = boss.haste_cooldown_ms / 1000;

    this.slamCooldownSec = boss.slam_cooldown_ms / 1000;
    this.slamWindupSec = boss.slam_windup_ms / 1000;
    this.slamRangePx = boss.slam_range_px;
    this.slamRadiusMaxPx = boss.slam_radius_max_px;
    this.slamRadiusBossMult = boss.slam_radius_boss_multiplier;
    this.slamDamageMult = boss.slam_damage_multiplier;
    this.slamRecoverSec = boss.slam_recover_ms / 1000;

    // 越难的 Boss：远程冷却逐轮递减（有下限）、弹数逐轮递增
    const decay = Math.pow(1 - boss.bolt_cooldown_decay_ratio, this.bossIndex - 1);
    this.boltCooldownSec = Math.max(boss.bolt_cooldown_min_ms / 1000, (boss.bolt_cooldown_ms / 1000) * decay);
    this.boltSpeedPx = boss.bolt_speed_px_per_sec;
    this.boltRadiusPx = boss.bolt_radius_px;
    this.boltLifeSec = boss.bolt_life_ms / 1000;
    this.boltDamageMult = boss.bolt_damage_multiplier;
    this.boltCount = boss.bolt_count_base + boss.bolt_count_per_index * (this.bossIndex - 1);
    this.boltSpreadRad = boss.bolt_spread_deg * Math.PI / 180;

    this.enemy = this.node.getComponent(Enemy);
    // 跳砸范围自适应体积：越大的 Boss 范围越大，但不超过硬上限
    // （硬上限由校验脚本保证「玩家在预警期内朝一个方向持续移动必定能走出范围」）
    this.slamRadiusPx = Math.min(this.slamRadiusMaxPx, this.radiusPx() * this.slamRadiusBossMult);
    this.action = 'none';
    this.phase = 'recover';
    this.hitDone = false;
    this.traveledPx = 0;
    // 各冷却按配置初始化（进入战斗后按节奏依次起手）
    this.chargeCd = this.chargeCooldownSec;
    this.slamCd = this.slamCooldownSec;
    this.hasteCd = this.hasteCooldownSec;
    this.boltCd = this.boltCooldownSec;
    this.restoreColor();
    this.setChase(true);
    // 专属大招：按 Boss 素材 id（EntityManager 写入 node.__actorId）查配置
    this.rng = new Random((Date.now() >>> 0) || 1);
    this.bombPoints.length = 0;
    this.ultAccumSec = 0;
    const actorId = typeof (this.node as any).__actorId === 'string' ? (this.node as any).__actorId : '';
    // 用 getTable + 直接索引：条目值可能是 null（该 Boss 只用统一基座），
    // 不能走 dataManager.get（它对假值会抛"缺少 key"）
    const ultTable = actorId && dataManager.isLoaded('boss_ultimates')
      ? dataManager.getTable<any>('boss_ultimates')
      : null;
    const u = ultTable ? (ultTable[actorId] ?? null) : null;
    if (u && u.kind) {
      this.ultKind = u.kind;
      this.ultCooldownSec = (u.cooldown_ms ?? 0) / 1000;
      this.ultWindupSec = (u.windup_ms ?? 0) / 1000;
      this.ultRecoverSec = (u.recover_ms ?? 0) / 1000;
      this.ultRangePx = u.range_px ?? 0;
      this.ultWidthPx = u.width_px ?? 0;
      this.ultRadiusPx = u.radius_px ?? 0;
      this.ultTickSec = Math.max(0.05, (u.tick_ms ?? 350) / 1000);
      this.ultDurationSec = (u.duration_ms ?? 0) / 1000;
      this.ultDamageMult = u.damage_ratio ?? 1;
      this.ultKnockbackPx = u.knockback_px ?? 0;
      this.ultCount = Math.max(1, Math.round(u.count ?? 1));
      this.ultDelaySec = Math.max(0.2, (u.delay_ms ?? 1500) / 1000);
      this.ultMinGapPx = u.min_gap_px ?? 0;
      this.ultSpreadPx = u.spread_px ?? 400;
      this.ultBurnDpsRatio = u.burn_dps_ratio ?? 0;
      this.ultBurnSec = (u.burn_ms ?? 0) / 1000;
      this.ultFx = u.fx ?? '';
      this.ultFxSizePx = u.fx_size_px ?? 0;
      this.ultBoltSpeedPx = u.speed_px ?? 0;
      this.ultBoltRadiusPx = u.bullet_radius_px ?? 0;
      this.ultBoltLifeSec = (u.life_ms ?? 0) / 1000;
      this.ultCd = this.ultCooldownSec; // 进入战斗后按节奏起手
    } else {
      this.ultKind = '';
      this.ultCd = 0;
    }
  }

  update(dt: number): void {
    if (!gameState.isRunActive() || gameState.isPaused() || !gameState.isAlive()) {
      return; // 暂停（升级选卡）/ 结算 / 死亡：行为整体冻结
    }
    const step = Math.min(dt, MAX_DT_SEC);
    if (this.action === 'none') {
      this.tickCooldowns(step);
      this.decide();
      return;
    }
    this.timerSec -= step;
    switch (this.action) {
      case 'charge':
        if (this.phase === 'windup') {
          if (this.timerSec <= 0) this.startChargeDash();
        } else if (this.phase === 'active') {
          this.tickChargeDash(step);
        } else if (this.timerSec <= 0) {
          this.finishAction();
        }
        break;
      case 'slam':
        if (this.phase === 'windup') {
          if (this.timerSec <= 0) this.impactSlam();
        } else if (this.timerSec <= 0) {
          this.finishAction();
        }
        break;
      case 'haste':
        if (this.timerSec <= 0) this.endHaste();
        break;
      case 'ultimate':
        if (this.phase === 'windup') {
          if (this.timerSec <= 0) this.startUltimateEffect();
        } else if (this.phase === 'active') {
          this.tickUltimateEffect(step);
          // ⚠️ 持续期必须有**到期出口**：水柱 / 火焰的 `active` 原先没有任何人检查倒计时，
          // 一旦进入就**永远停在喷发状态**（用户实测：水柱喷了十几秒不停）。
          // 这里到期转收招并**重置大招冷却**，否则收招后又会立刻再次触发。
          if (this.timerSec <= 0) {
            this.phase = 'recover';
            this.timerSec = this.ultRecoverSec;
            this.ultCd = this.ultCooldownSec;
            console.log(`[Boss] 大招「${this.ultKind}」持续结束，进入收招`);
          }
        } else if (this.timerSec <= 0) {
          this.finishAction();
        }
        break;
      default:
        break;
    }
  }

  private tickCooldowns(step: number): void {
    this.chargeCd -= step;
    this.slamCd -= step;
    this.hasteCd -= step;
    this.boltCd -= step;
    this.ultCd -= step;
  }

  /** 行为选择：近身跳砸 > 远程弹 > 冲锋 > 加速；都未就绪则交给常规追击。 */
  private decide(): void {
    const player = playerRef;
    if (!player) {
      return;
    }
    const p = this.node.position;
    const pp = player.position;
    const dx = pp.x - p.x;
    const dy = pp.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 1) {
      return;
    }
    this.dirX = dx / dist;
    this.dirY = dy / dist;
    this.enemy?.setFacingDir(this.dirX); // 朝向跟随玩家（素材只有朝右，朝左时水平镜像）

    // 专属大招优先级最高（长蓄力 → 生效 → 收招；用户口径：这是 Boss 的主要威胁）
    if (this.ultKind && this.ultCd <= 0) {
      this.beginUltimate();
      return;
    }
    if (this.slamCd <= 0 && dist <= this.slamRangePx) {
      this.beginSlam(pp.x, pp.y);
      return;
    }
    if (this.boltCd <= 0) {
      this.fireBoltVolley();
      return;
    }
    if (this.chargeCd <= 0) {
      this.beginChargeWindup();
      return;
    }
    if (this.hasteCd <= 0) {
      this.beginHaste();
    }
  }

  // —— 1) 冲锋 ——

  /** 预警：锁定玩家当前位置与朝向（此后不再修正，玩家可侧移规避）。 */
  private beginChargeWindup(): void {
    this.action = 'charge';
    this.phase = 'windup';
    this.timerSec = this.chargeWindupSec;
    this.setChase(false);
    this.tint(WINDUP_COLOR);
    this.enemy?.playBossAction('attack'); // 蓄力挥击动作（配了 attack 帧才生效）
    // 冲锋路径预警（用户口径：所见即判定区）：方向已锁定，标出一条与判定矩形**完全一致**的长条，
    // 玩家只要横移离开这条带子就能规避 —— 此前冲锋没有任何预告，只能靠观感躲。
    const p = this.node.position;
    eventBus.emit(
      EventNames.on_danger_rect,
      p.x + (this.dirX * this.chargeDistancePx) / 2,
      p.y + (this.dirY * this.chargeDistancePx) / 2,
      this.chargeDistancePx,
      this.chargeWidthPx,
      Math.atan2(this.dirY, this.dirX),
      this.chargeWindupSec * 1000,
    );
    console.log(`[Boss] 冲锋预警：已锁定方向（${this.chargeWindupSec.toFixed(2)}s 后冲锋）`);
  }

  private startChargeDash(): void {
    const p = this.node.position;
    this.originX = p.x;
    this.originY = p.y;
    this.traveledPx = 0;
    this.hitDone = false;
    this.phase = 'active';
    this.restoreColor();
  }

  private tickChargeDash(step: number): void {
    const p = this.node.position;
    const speedPx = this.chargeSpeedPx * step;
    const moved = resolveWalkableMove(
      p.x, p.y, p.x + this.dirX * speedPx, p.y + this.dirY * speedPx, this.radiusPx(),
    );
    const advanced = Math.hypot(moved.x - p.x, moved.y - p.y);
    this.node.setPosition(moved.x, moved.y, p.z);
    this.traveledPx += advanced;
    this.checkChargeHit();
    // 走满长度或被墙挡住（位移明显衰减）即收招
    if (this.traveledPx >= this.chargeDistancePx || advanced < speedPx * 0.5) {
      this.phase = 'recover';
      this.timerSec = this.chargeRecoverSec;
      this.chargeCd = this.chargeCooldownSec;
    }
  }

  /** 冲锋命中判定（每轮至多一次）：玩家在锁定矩形内才受伤，横向移出即可规避。 */
  private checkChargeHit(): void {
    if (this.hitDone || !playerRef) {
      return;
    }
    const vx = playerRef.position.x - this.originX;
    const vy = playerRef.position.y - this.originY;
    const along = vx * this.dirX + vy * this.dirY;
    if (along < 0 || along > this.chargeDistancePx) {
      return;
    }
    const perp = Math.abs(-vx * this.dirY + vy * this.dirX);
    if (perp > this.chargeWidthPx / 2) {
      return; // 已移出冲锋宽度 → 规避成功
    }
    this.hitDone = true;
    this.dealDamage(this.chargeDamageMult, '冲锋');
  }

  // —— 2) 跳砸 ——

  /** 预警：标注落点危险范围（表现层据此画圈），预警结束后跃至落点。 */
  private beginSlam(targetX: number, targetY: number): void {
    this.action = 'slam';
    this.phase = 'windup';
    this.timerSec = this.slamWindupSec;
    this.slamTargetX = targetX;
    this.slamTargetY = targetY;
    this.setChase(false);
    this.tint(WINDUP_COLOR);
    eventBus.emit(
      EventNames.on_boss_telegraph, targetX, targetY, this.slamRadiusPx, this.slamWindupSec * 1000,
    );
    console.log(`[Boss] 跳砸预警：落点已标出危险范围（半径 ${this.slamRadiusPx}px）`);
  }

  private impactSlam(): void {
    const p = this.node.position;
    const moved = resolveWalkableMove(p.x, p.y, this.slamTargetX, this.slamTargetY, this.radiusPx());
    this.node.setPosition(moved.x, moved.y, p.z);
    this.restoreColor();
    this.phase = 'recover';
    this.timerSec = this.slamRecoverSec;
    this.slamCd = this.slamCooldownSec;
    const player = playerRef;
    if (!player) {
      return;
    }
    const d = Math.hypot(player.position.x - moved.x, player.position.y - moved.y);
    if (d <= this.slamRadiusPx) {
      this.dealDamage(this.slamDamageMult, '跳砸');
    }
  }

  // —— 3) 慢速远程弹 ——

  /** 向玩家方向发射扇形慢弹（弹数与冷却随 Boss 序号增强，玩家可走位规避）。 */
  private fireBoltVolley(): void {
    this.boltCd = this.boltCooldownSec;
    const baseAngle = Math.atan2(this.dirY, this.dirX);
    const damage = damageFormula.enemyDamage(this.atk() * this.boltDamageMult);
    const p = this.node.position;
    const r = this.radiusPx();
    const count = Math.max(1, Math.round(this.boltCount));
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * this.boltSpreadRad;
      const a = baseAngle + offset;
      fireEnemyBullet(
        p.x + Math.cos(a) * r, p.y + Math.sin(a) * r,
        Math.cos(a), Math.sin(a),
        this.boltSpeedPx, this.boltRadiusPx, this.boltLifeSec, damage,
      );
    }
    console.log(`[Boss] 远程攻击：发射 ${count} 发慢弹（第 ${this.bossIndex} 轮，伤害 ${damage}）`);
  }

  // —— 4) 短时加速 ——

  private beginHaste(): void {
    this.action = 'haste';
    this.phase = 'active';
    this.timerSec = this.hasteDurationSec;
    this.tint(HASTE_COLOR);
    this.enemy?.setSpeedMultiplier(this.hasteSpeedMult);
    this.hasteCd = this.hasteCooldownSec;
    console.log(`[Boss] 加速：移速 ×${this.hasteSpeedMult}，持续 ${this.hasteDurationSec.toFixed(2)}s`);
  }

  private endHaste(): void {
    this.enemy?.setSpeedMultiplier(1);
    this.finishAction();
  }

  // —— 公共收尾 ——

  private finishAction(): void {
    this.action = 'none';
    this.phase = 'recover';
    this.ultAccumSec = 0;
    this.bombPoints.length = 0;
    this.restoreColor();
    this.setChase(true);
  }

  // —— 5) 专属大招（长蓄力 → 生效 → 收招；参数全在 boss_ultimates.json）——

  /**
   * 长蓄力：**锁定玩家那一刻的位置 / 方向**（用户口径：龙锁定当时的位置），
   * 并在此期间把即将生效的范围预告给玩家（表现层据此画危险圈）。
   */
  private beginUltimate(): void {
    this.action = 'ultimate';
    this.phase = 'windup';
    this.timerSec = this.ultWindupSec;
    this.setChase(false);
    this.tint(WINDUP_COLOR);
    this.enemy?.playBossAction('attack'); // 长蓄力 = 攻击动作（配了 attack 帧才生效）
    const p = this.node.position;
    const player = playerRef;
    const pp = player ? player.position : p;
    this.lockX = p.x;
    this.lockY = p.y;
    const dx = pp.x - p.x;
    const dy = pp.y - p.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    this.dirX = dx / len;
    this.dirY = dy / len;
    this.enemy?.setFacingDir(this.dirX); // 长蓄力按锁定方向面向玩家

    if (this.ultKind === 'shockwave') {
      eventBus.emit(EventNames.on_boss_telegraph, p.x, p.y, this.ultRadiusPx, this.ultWindupSec * 1000);
    } else if (this.ultKind === 'delayed_bombs') {
      this.bombPoints.length = 0;
      // 危险提示必须**从技能开始一直挂到爆炸判定前**（用户口径）：
      // 时长 = 蓄力 + 引爆延迟；原先只给了 `ultDelaySec`，蓄力一结束提示就没了，延迟期"裸奔"。
      const telegraphMs = (this.ultWindupSec + this.ultDelaySec) * 1000;
      for (let i = 0; i < this.ultCount; i++) {
        const pt = this.pickBombPoint(pp.x, pp.y, this.bombPoints);
        if (!pt) {
          break; // 找不到满足间距的点就不再补（保证"不重叠、留出走位空隙"）
        }
        this.bombPoints.push(pt);
        eventBus.emit(EventNames.on_boss_telegraph, pt.x, pt.y, this.ultRadiusPx, telegraphMs);
      }
    } else if (this.ultKind === 'ring_burst') {
      // 环形弹幕：以自身为中心标一圈预警（提示"要放大招了"）。
      // 它**没有固定安全区**（弹是向四周散开的），所以只做"以我为圆心"的范围提示，
      // 玩家要靠观察弹道找缝隙 —— 这是与"水柱/火焰长矩形"完全不同的应对方式。
      eventBus.emit(
        EventNames.on_boss_telegraph, p.x, p.y, this.radiusPx() * 3, this.ultWindupSec * 1000,
      );
    } else {
      // 水柱 / 火焰：沿锁定方向标出一条**长矩形**（与生效期的判定矩形完全一致）。
      // 旧实现是"沿方向铺一串小圆"去近似，圆之间必然有缝、边缘也不齐 —— 与"所见即判定区"不符。
      eventBus.emit(
        EventNames.on_danger_rect,
        p.x + (this.dirX * this.ultRangePx) / 2,
        p.y + (this.dirY * this.ultRangePx) / 2,
        this.ultRangePx,
        this.ultWidthPx,
        Math.atan2(this.dirY, this.dirX),
        this.ultWindupSec * 1000,
      );
    }
    console.log(`[Boss] 大招预警（${this.ultKind}）：${this.ultWindupSec.toFixed(1)}s 后生效`);
  }

  /** 长蓄力结束：按类型生效（水柱 / 火焰进入持续判定；气浪 / 爆炸立即结算后转收招）。 */
  private startUltimateEffect(): void {
    this.restoreColor();
    this.ultAccumSec = this.ultTickSec; // 立即结算第一下（玩家已获得完整预警时间）
    switch (this.ultKind) {
      case 'ring_burst':
        this.fireRingBurst();
        this.phase = 'recover';
        this.timerSec = this.ultRecoverSec;
        this.ultCd = this.ultCooldownSec;
        break;
      case 'shockwave':
        this.fireShockwave();
        this.phase = 'recover';
        this.timerSec = this.ultRecoverSec;
        this.ultCd = this.ultCooldownSec;
        break;
      case 'delayed_bombs':
        this.armBombs();
        this.phase = 'recover';
        this.timerSec = this.ultDelaySec + this.ultRecoverSec; // 等爆炸全部引爆后再收招
        this.ultCd = this.ultCooldownSec;
        break;
      default:
        this.phase = 'active';
        this.timerSec = this.ultDurationSec; // 水柱 / 火焰：持续 1~2s，每 tick 判定
        break;
    }
    console.log(`[Boss] 大招生效：${this.ultKind}`);
  }

  /** 水柱 / 火焰：生效期内每 `ultTickSec`（0.3~0.5s）判定一次，持续 `ultDurationSec`（1~2s）。 */
  private tickUltimateEffect(step: number): void {
    if (this.ultKind !== 'water_line' && this.ultKind !== 'flame_line') {
      return;
    }
    this.ultAccumSec += step;
    if (this.ultAccumSec < this.ultTickSec) {
      return;
    }
    this.ultAccumSec = 0;
    const ox = this.lockX;
    const oy = this.lockY;
    // 表现：沿矩形铺一串特效（水柱保持竖直不旋转；火焰沿方向铺开）
    const segs = Math.max(2, Math.round(this.ultRangePx / Math.max(60, this.ultFxSizePx)));
    const ang = this.ultKind === 'water_line' ? 0 : this.dirAngleDeg();
    for (let i = 0; i < segs; i++) {
      const t = (i + 0.5) / segs;
      this.playFx(this.ultFx, ox + this.dirX * this.ultRangePx * t, oy + this.dirY * this.ultRangePx * t,
        ang, false, 0.45, this.ultFxSizePx);
    }
    // 判定：矩形内的玩家（每 tick 一次，不因"一直站在里面"额外叠加）
    const player = playerRef;
    if (!player) {
      return;
    }
    const vx = player.position.x - ox;
    const vy = player.position.y - oy;
    const along = vx * this.dirX + vy * this.dirY;
    if (along < 0 || along > this.ultRangePx) {
      return;
    }
    const perp = Math.abs(-vx * this.dirY + vy * this.dirX);
    if (perp > this.ultWidthPx / 2) {
      return;
    }
    this.dealDamage(this.ultDamageMult, this.ultKind === 'flame_line' ? '火焰' : '水柱');
    if (this.ultKind === 'flame_line' && this.ultBurnDpsRatio > 0 && this.ultBurnSec > 0) {
      // 烧伤 DOT：不叠加（GameState.applyDot 内部只取更强 / 更长者）
      gameState.applyDot(this.atk() * this.ultBurnDpsRatio, this.ultBurnSec);
    }
    if (this.ultKnockbackPx > 0) {
      player.getComponent(Player)?.applyPush(this.dirX, this.dirY, this.ultKnockbackPx);
    }
  }

  /**
   * 环形弹幕（`ring_burst`，DemonCyclop2 专属）：以自身为中心向四周**均匀**打出 `count` 发慢速弹。
   *
   * 设计口径（与统一基座的「扇形慢速远程」区分）：
   *  - **全方向**覆盖，但弹与弹之间留**固定角度缺口** ⇒ 站进缺口即可规避，是"看懂规律就能躲"的技巧型大招；
   *  - 弹速刻意**慢**（可走位），伤害单发不高但数量多 ⇒ 逼玩家短时间做出位移决策。
   */
  private fireRingBurst(): void {
    const p = this.node.position;
    const r = this.radiusPx();
    const count = Math.max(3, Math.round(this.ultCount));
    const damage = damageFormula.enemyDamage(this.atk() * this.ultDamageMult);
    for (let i = 0; i < count; i++) {
      const a = (i * 2 * Math.PI) / count;
      fireEnemyBullet(
        p.x + Math.cos(a) * r, p.y + Math.sin(a) * r,
        Math.cos(a), Math.sin(a),
        this.ultBoltSpeedPx, this.ultBoltRadiusPx, this.ultBoltLifeSec, damage,
      );
    }
    this.playFx(this.ultFx, p.x, p.y, 0, false, 0.6, this.ultFxSizePx);
    console.log(`[Boss] 环形弹幕：${count} 发（弹速 ${this.ultBoltSpeedPx}px/s，走位找缺口）`);
  }

  /** 圆形气浪（用户口径：**没有伤害**，但会短暂击退玩家、造成强制位移）。 */
  private fireShockwave(): void {
    const p = this.node.position;
    this.playFx(this.ultFx, p.x, p.y, 0, false, 0.6, this.ultFxSizePx);
    const player = playerRef;
    if (!player) {
      return;
    }
    const dx = player.position.x - p.x;
    const dy = player.position.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > this.ultRadiusPx) {
      return; // 范围外不受影响
    }
    const len = Math.max(1, d);
    player.getComponent(Player)?.applyPush(dx / len, dy / len, this.ultKnockbackPx);
    console.log(`[Boss] 气浪：玩家被强制推开 ${this.ultKnockbackPx}px（无伤害）`);
  }

  /** 延迟爆炸：预警期已标出每个点位，到点引爆（范围内玩家受伤）。 */
  private armBombs(): void {
    for (const pt of this.bombPoints) {
      timer.after(this.ultDelaySec, () => {
        if (!this.node.isValid || !gameState.isRunActive() || !gameState.isAlive()) {
          return;
        }
        this.playFx(this.ultFx, pt.x, pt.y, 0, false, 0.5, this.ultFxSizePx);
        const player = playerRef;
        if (!player) {
          return;
        }
        if (Math.hypot(player.position.x - pt.x, player.position.y - pt.y) <= this.ultRadiusPx) {
          this.dealDamage(this.ultDamageMult, '延迟爆炸');
        }
      });
    }
  }

  /** 取一个满足最小间距的随机爆炸点（在玩家附近散布；取不到返回 null）。 */
  private pickBombPoint(
    cx: number, cy: number, used: { x: number; y: number }[],
  ): { x: number; y: number } | null {
    for (let attempt = 0; attempt < 24; attempt++) {
      const ang = this.rng.next() * Math.PI * 2;
      const dist = this.ultSpreadPx * (0.35 + this.rng.next() * 0.65);
      const x = cx + Math.cos(ang) * dist;
      const y = cy + Math.sin(ang) * dist;
      let ok = true;
      for (const u of used) {
        if (Math.hypot(u.x - x, u.y - y) < this.ultMinGapPx) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return { x, y };
      }
    }
    return null;
  }

  /** 方向角（度），用于"沿方向铺开"的特效朝向。 */
  private dirAngleDeg(): number {
    return (Math.atan2(this.dirY, this.dirX) * 180) / Math.PI;
  }

  /** 播放特效（表现层负责资源缺失时的降级）。 */
  private playFx(
    key: string, xPx: number, yPx: number, angleDeg: number, follow: boolean,
    totalSec: number, targetPx: number,
  ): void {
    if (!key) {
      return;
    }
    eventBus.emit(EventNames.on_fx, key, xPx, yPx, angleDeg, follow, totalSec, targetPx);
  }

  /** 按倍率对玩家造成伤害（数值口径与 combat 一致：floor(atk × 倍率)）。 */
  private dealDamage(multiplier: number, tag: string): void {
    const damage = damageFormula.enemyDamage(this.atk() * multiplier);
    if (damage <= 0) {
      return;
    }
    gameState.takeDamage(damage);
    console.log(`[Boss] ${tag}命中：${damage} 点伤害（ATK ${this.atk()} × ${multiplier}）`);
  }

  private atk(): number {
    return this.enemy ? this.enemy.getAtk() : 0;
  }

  private radiusPx(): number {
    return this.enemy ? this.enemy.getHitRadiusPx() : 0;
  }

  private setChase(enabled: boolean): void {
    this.enemy?.setChaseEnabled(enabled);
  }

  private tint(color: Color | null): void {
    const sp = this.node.getComponent(Sprite);
    if (!sp) {
      return;
    }
    sp.color = color ?? (this.enemy ? this.enemy.getBaseColor() : new Color(255, 255, 255, 255));
  }

  private restoreColor(): void {
    this.tint(null);
  }

  onDisable(): void {
    // 被回收 / 切回普通怪时，恢复常规追击、移速与常态色
    this.enemy?.setSpeedMultiplier(1);
    this.setChase(true);
    this.action = 'none';
    this.restoreColor();
  }
}

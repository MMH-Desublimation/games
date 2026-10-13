import { Input, input, EventKeyboard, KeyCode, Node, UITransform } from 'cc';
import { dataManager } from '../data/DataManager';
import { gameState } from '../core/GameState';
import { metaState } from '../core/MetaState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { MAX_DT_SEC, timer } from '../core/Timer';
import { ticker } from '../core/Ticker';
import { Random } from '../utils/Random';
import { resolveWalkableMove } from '../dungeon/DungeonCollision';
import { entityManagerRef } from '../entities/EntityManager';
import { Enemy } from '../entities/Enemy';
import { Player, playerRef } from '../entities/Player';
import { damageFormula } from './DamageFormula';
import { BulletSpec, fireBullet } from './Bullet';

/**
 * 技能系统（插入项：技能系统 + 行为型 Buff 的第一步）。
 *
 * 数据源：`skills.json`（3 职业 × 2 槽，`cast_type` 共 4 种）。
 * 规则（宪法 6.7 / 6.10 / 6.13、文档 4.6）：
 *  - 全部数值（冷却 / 时长 / 伤害倍率 / 范围 / 冲刺距离）来自配置，本文件零硬编码数值；
 *  - 逐帧逻辑走 `core/Ticker`，位移用 `min(dt, MAX_DT_SEC)`；暂停（升级选卡）与结算时冻结；
 *  - 释放伤害统一走 `damageFormula.playerDamage`（含暴击与总伤害倍率上限）；
 *  - 局外「功能类」养成（技能冷却 / 时长 / 效果 / 范围）在开局解析技能时折算进运行时参数。
 *
 * 4 种 cast_type：
 *  - `dash`    ：向最近敌人方向冲刺，沿途对接触到的敌人结算一次伤害（期间 invuln 无敌）；
 *  - `instant` ：立即对范围内敌人结算伤害并施加控制（如 root 定身，可配置 Boss 免疫）；
 *  - `channel` ：持续施放，每 `tick_ms` 对范围内敌人结算一次伤害并刷新减速，期间可移动（可配置降速/无敌/免疫远程）；
 *  - `buff`    ：给自身施加限时增幅（属性效果 + 技能增幅系数），到期整批移除。
 *
 * 操作：键盘 `J` = 技能1、`K` = 技能2；也可由技能栏按钮点击触发（为手机端预留）。
 */
type CastState = 'idle' | 'dash' | 'channel';

/** 技能栏反馈提示的持续时长（秒，表现常量）。 */
const RESET_FLASH_SEC = 1.2;
const DENIED_FLASH_SEC = 0.6;

/**
 * 散布特效参数（`skills.json` 的 `fx_scatter`）。
 * 用途：引导类必杀技的**氛围**表现（如「雷霆审判」全屏雷电乱闪）——
 * 在玩家四周随机位置反复播若干个**小**特效，不承担命中判定（判定仍走 `tick_ms` 的范围伤害）。
 */
interface FxScatter {
  fx: string;
  count: number;
  /** 单个特效的目标世界尺寸（px，最长边）——与角色体型相当，避免"一整片糊住屏幕"。 */
  sizePx: number;
  /** 补排节奏（秒）。 */
  intervalSec: number;
  /** 随机散布半径（px）。 */
  spreadPx: number;
  /** 单个特效的在场时长（秒）——足够长，避免一闪而过。 */
  durationSec: number;
}

/** 技能运行时实例（开局按职业从 skills.json 解析 + 局外功能类加成折算）。 */
interface SkillRuntime {
  id: string;
  name: string;
  castType: string;
  /** 释放特效 key（`fx.json`）；空 = 不播特效。 */
  fx: string;
  /** 散布特效（可选；引导类必杀技的"乱闪"氛围）。 */
  fxScatter: FxScatter | null;
  cooldownSec: number;
  remainSec: number;
  damageRatio: number;
  /** 作用半径（px）；0 = 全场（mage_s2 雷霆审判）。 */
  rangePx: number;
  durationSec: number;
  tickSec: number;
  dashDistancePx: number;
  dashSpeedPx: number;
  effects: any[];
  /** 引导期间是否禁止移动（站桩施法；skills.json 的 `lock_move`）。 */
  lockMove: boolean;
  /**
   * 「增幅光环」特效 key（可选，`skills.json` 的 `aura_fx`）。
   *
   * 用户口径：**boost 光环是覆盖在角色本体的一层，技能特效是技能特效**，两者必须共存、不互相遮挡或抵消。
   * 因此光环作为**独立的一层**播放（小尺寸、跟随玩家、持续整个技能时长），与技能范围特效分开。
   */
  auraFx: string;
  /** 增幅光环的目标显示尺寸（px；0 = 用 fx.json 的 scale）。 */
  auraSizePx: number;
}

/** 键位 → 技能槽（桌面端；手机端走技能栏按钮）。 */
const SLOT_BY_KEY: Record<number, number> = {
  [KeyCode.KEY_J]: 1,
  [KeyCode.KEY_K]: 2,
};

class SkillSystem {
  /** 两个技能槽的运行时（索引 0 = 槽 1）。 */
  private skills: (SkillRuntime | null)[] = [null, null];
  private state: CastState = 'idle';
  private activeSkill: SkillRuntime | null = null;
  /** 当前动作剩余时间（秒）：冲刺剩余 / 引导剩余。 */
  private stateTimerSec = 0;
  private tickAccumSec = 0;
  private dashDirX = 0;
  private dashDirY = 0;
  private dashTraveledPx = 0;
  /** 本次冲刺已命中节点（同一敌人只结算一次）。 */
  private readonly dashHitNodes: Node[] = [];
  private rng = new Random((Date.now() >>> 0) || 1);
  /** 已按哪个职业解析过技能（避免每帧重复解析；换职业 / 重开局时刷新）。 */
  private resolvedClassId = '';
  /** 冲刺「卡住」判定：单帧位移低于 距离×ratio 视为推不动，连续累计超过 sec 才收招。 */
  private dashStuckRatio = 0.3;
  private dashStuckSec = 0.15;
  private stuckAccumSec = 0;
  private commonLoaded = false;
  /**
   * 技能栏反馈计时（秒，纯表现）：
   *  - `resetFlashSec`：冷却被「疾影」等效果**凭空清零**后短暂提示，避免玩家误以为"技能没冷却"；
   *  - `deniedFlashSec`：冷却中按键/点击后短暂提示，避免玩家误以为"按键没反应"。
   */
  private resetFlashSec: number[] = [0, 0];
  private deniedFlashSec: number[] = [0, 0];
  /** 散布特效的补排计时（秒，仅引导期间使用）。 */
  private scatterAccumSec = 0;

  constructor() {
    eventBus.on(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);
    // 局内选了新 Buff：技能类 Buff 会改变冷却 / 伤害 / 时长 → 需要重算技能运行时
    eventBus.on(EventNames.on_buff_selected, this.onBuffSelected, this);
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    ticker.add(this.tick);
  }

  private onConfigLoaded(): void {
    this.rng = new Random((Date.now() >>> 0) || 1);
    this.ensureCommonConfig();
  }

  /** 冲刺「卡住」判定参数（只在配置就绪后读取一次；判定阈值全部来自 balance.skill_common）。 */
  private ensureCommonConfig(): void {
    if (this.commonLoaded || !dataManager.isLoaded('balance')) {
      return;
    }
    const common = (dataManager.getTable<any>('balance') as any).skill_common;
    if (common) {
      this.dashStuckRatio = common.dash_stuck_ratio;
      this.dashStuckSec = common.dash_stuck_sec;
    }
    this.commonLoaded = true;
  }

  private onKeyDown(e: EventKeyboard): void {
    const slot = SLOT_BY_KEY[e.keyCode];
    if (slot) {
      this.cast(slot);
    }
  }

  /** 开局：按职业解析技能并复位状态（含局外「功能类」加成折算）。 */
  private onRunStart(): void {
    this.resetFlashSec = [0, 0];
    this.deniedFlashSec = [0, 0];
    this.abortCast();
    this.skills = [null, null];
    this.resolvedClassId = '';
    this.ensureSkills();
  }

  /**
   * 解析当前职业的技能（**幂等**，可重复调用）。
   *
   * 为什么除开局事件外还允许惰性调用：`on_run_start` 的订阅者顺序由模块加载顺序决定，
   * 若本系统比流程层（RunFlow）先收到开局事件，那一刻 `classId` 仍为空 → 解析不到技能，
   * 表现为「技能栏空白、J/K 无反应」。改为「先到先解析、后到者补齐」后，
   * 技能解析不再依赖订阅顺序；稳态下每帧只做一次字符串比较，零分配。
   */
  private ensureSkills(): void {
    // 门槛：**只在「本局已开局」时解析**。开局事件可能早于流程层（RunFlow）把职业写进 GameState，
    // 此时读到的 classId 还是上一局的残留 —— 实测表现为「玩射手却显示/放出战士的技能」。
    // 以 runActive 为界后，解析只会在职业已确定之后发生，彻底消除这一竞态。
    if (!gameState.isRunActive()) {
      return;
    }
    const classId = gameState.getClassId();
    if (!classId || classId === this.resolvedClassId) {
      return;
    }
    if (!dataManager.isLoaded('skills')) {
      console.warn('[Skill] skills 配置表未加载，技能不可用');
      return;
    }
    const all = dataManager.getTable<any[]>('skills');
    const resolved: (SkillRuntime | null)[] = [null, null];
    for (const def of all) {
      if (def.class_id !== classId || (def.slot !== 1 && def.slot !== 2)) {
        continue;
      }
      resolved[def.slot - 1] = this.buildRuntime(def);
    }
    // 保留冷却中技能的剩余时间（按新上限收敛）：选了减 CD 的 Buff 时不应白送一次冷却
    for (let i = 0; i < resolved.length; i++) {
      const next = resolved[i];
      const prev = this.skills[i];
      if (next && prev && prev.remainSec > 0) {
        next.remainSec = Math.min(prev.remainSec, next.cooldownSec);
      }
    }
    this.resolvedClassId = classId;
    this.skills = resolved;
    const names = resolved.filter((s) => !!s).map((s) => s!.name).join(' / ');
    if (names) {
      console.log(`[Skill] ${classId} 技能就绪：${names}`);
    } else {
      const available = Array.from(new Set(all.map((d) => d.class_id))).join(', ');
      console.error(`[Skill] skills.json 中没有 class_id=${classId} 的技能（现有：${available}）`);
    }
  }

  /** 结算（死亡 / 通关）：中断动作并解除临时状态。 */
  private onRunEnd(): void {
    this.abortCast();
  }

  /**
   * 局内选了新 Buff：把「已解析职业」作废，让下一帧 `tick` 用最新加成重算运行时。
   * 之所以延迟到下一帧：`on_buff_selected` 在 Buff 效果登记**之前**广播，
   * 立即重算会读到未更新的系数。
   */
  private onBuffSelected(): void {
    this.resolvedClassId = '';
  }

  /** 技能运行时参数（配置 + 局外功能类加成；加成按 meta.json 的 effect.slot 区分技能槽）。 */
  private buildRuntime(def: any): SkillRuntime {
    const slot = def.slot;
    // 加成来源 = 局外「功能类」养成（按 effect.slot 区分技能槽）+ 局内技能类 Buff
    const cdDown = this.metaSlotBonus('skill_cd_down', slot)
      + gameState.getBuffBonus('skill_cd_down', slot);
    const durationUp = this.metaSlotBonus('skill_duration_up', slot)
      + gameState.getBuffBonus('skill_duration_up', slot);
    const effectUp = this.metaSlotBonus('skill_effect_up', 0)
      + gameState.getBuffBonus('skill_dmg_up', slot)
      + gameState.getBuffBonus('all_skill_dmg_up', 0);
    const rangeUp = this.metaSlotBonus('skill_range_up', 0)
      + gameState.getBuffBonus('skill_range_up', 0);
    // 冷却：先按缩减比例算，再夹到**按槽位的最低冷却**。
    // 用户口径：技能2（大招）满配也不能短到几秒 —— 原先缩减上限硬编码 0.9，55s 会被压到 5.5s。
    // 现在上限与下限都进 `balance.skill_common`（宪法 6.7：数值不硬编码）。
    const common = dataManager.get<any>('balance', 'skill_common') ?? {};
    const cdCap = common.cd_down_cap ?? 0.75;
    const minCdSec = Math.max(0, ((slot === 2 ? common.slot2_min_cd_ms : common.slot1_min_cd_ms) ?? 0) / 1000);
    const cdSec = Math.max(minCdSec, (def.cooldown_ms / 1000) * (1 - Math.min(cdCap, cdDown)));
    return {
      id: def.id,
      name: def.name,
      castType: def.cast_type,
      fx: def.fx ?? '',
      fxScatter: def.fx_scatter
        ? {
          fx: def.fx ?? '',
          count: def.fx_scatter.count ?? 6,
          sizePx: def.fx_scatter.size_px ?? 96,
          intervalSec: Math.max(0.05, (def.fx_scatter.interval_ms ?? 240) / 1000),
          spreadPx: def.fx_scatter.spread_px ?? 600,
          durationSec: Math.max(0.2, (def.fx_scatter.duration_ms ?? 800) / 1000),
        }
        : null,
      cooldownSec: Math.max(0.1, cdSec),
      remainSec: 0,
      damageRatio: (def.damage_ratio ?? 0) * (1 + effectUp),
      // range_px = 0 约定为「全场」，乘加成后仍为 0
      rangePx: (def.range_px ?? 0) * (1 + rangeUp),
      durationSec: ((def.duration_ms ?? 0) / 1000) * (1 + durationUp),
      tickSec: (def.tick_ms ?? 0) / 1000,
      dashDistancePx: (def.dash_distance_px ?? 0) * (1 + rangeUp),
      dashSpeedPx: def.dash_speed_px ?? 0,
      effects: Array.isArray(def.effects) ? def.effects : [],
      lockMove: def.lock_move === true,
      auraFx: def.aura_fx ?? '',
      auraSizePx: def.aura_size_px > 0 ? def.aura_size_px : 0,
    };
  }

  /**
   * 局外「功能类」加成：按 `effect.kind`（+ 可选 `effect.slot`）汇总 `per_level × 等级`。
   * `slot = 0` 表示不区分技能槽（如 skill_effect_up / skill_range_up）。
   */
  private metaSlotBonus(kind: string, slot: number): number {
    if (!dataManager.isLoaded('meta')) {
      return 0;
    }
    let total = 0;
    for (const item of dataManager.getTable<any[]>('meta')) {
      if (item.enabled === false) {
        continue;
      }
      const e = item.effect;
      if (!e || e.kind !== kind || typeof e.per_level !== 'number') {
        continue;
      }
      if (slot > 0 && e.slot !== undefined && e.slot !== slot) {
        continue;
      }
      total += e.per_level * metaState.getLevel(item.id);
    }
    return total;
  }

  // —— 释放 ——

  /** 释放技能（键盘或技能栏按钮）。@returns 是否成功释放 */
  cast(slot: number): boolean {
    if (!gameState.isRunActive() || gameState.isPaused() || !gameState.isAlive()) {
      return false;
    }
    this.ensureSkills(); // 惰性补齐：任何释放入口都保证技能已解析
    if (this.state !== 'idle') {
      return false; // 同一时刻只进行一个技能
    }
    const skill = this.skills[slot - 1];
    if (!skill) {
      return false;
    }
    if (skill.remainSec > 0) {
      // 冷却中按键/点击：给出反馈（否则玩家会以为"按键没反应"，反复猛按）
      this.deniedFlashSec[slot - 1] = DENIED_FLASH_SEC;
      console.log(`[Skill] 技能${slot}「${skill.name}」冷却中，剩余 ${skill.remainSec.toFixed(1)}s`);
      return false;
    }
    skill.remainSec = skill.cooldownSec;
    const source = `skill:${skill.id}`;
    switch (skill.castType) {
      case 'dash':
        this.startDash(skill, source);
        break;
      case 'instant':
        this.castInstant(skill);
        break;
      case 'channel':
        this.startChannel(skill, source);
        break;
      case 'buff':
        this.castBuff(skill, source);
        break;
      default:
        console.warn(`[Skill] 未知 cast_type: ${skill.castType}`);
        break;
    }
    // 增幅光环：与技能范围特效**分层**播放（跟随角色、小尺寸、持续整段技能），
    // 保证"角色身上的光环"和"技能的斩击 / 雷击"同时可见、互不遮挡（用户口径）
    if (skill.auraFx) {
      const ap = playerRef?.position;
      this.playFx(skill.auraFx, ap ? ap.x : 0, ap ? ap.y : 0, 0, true,
        Math.max(0.6, skill.durationSec), skill.auraSizePx);
    }
    eventBus.emit(EventNames.on_skill_cast, slot, skill.name);
    console.log(`[Skill] 释放「${skill.name}」（槽 ${slot}，冷却 ${skill.cooldownSec.toFixed(1)}s）`);
    return true;
  }

  /**
   * 播放技能特效（表现层负责资源缺失时的降级）。
   * @param totalSec 在场时长（秒）
   * @param targetPx 目标世界尺寸（最长边 px）—— 让"看起来多大"与"实际作用范围"一致
   */
  private playFx(
    key: string, xPx: number, yPx: number, angleDeg: number, follow: boolean,
    totalSec?: number, targetPx?: number,
  ): void {
    if (!key) {
      return;
    }
    eventBus.emit(EventNames.on_fx, key, xPx, yPx, angleDeg, follow, totalSec, targetPx);
  }

  /** 引导 / 冲刺类技能的特效覆盖尺寸：range = 0（全场）时用一个足够大的值。 */
  private fxSizeOf(skill: SkillRuntime): number {
    const span = skill.rangePx > 0 ? skill.rangePx : 900;
    return span * 2;
  }

  /** 方向 → 角度（度），供特效朝向使用。 */
  private dirAngleDeg(x: number, y: number): number {
    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  /**
   * 散布特效（如「雷霆审判」）：在玩家四周随机位置播若干个**小**特效，
   * 只营造"全屏雷电乱闪"的氛围，**不承担命中判定**（判定仍由 `tick_ms` 的范围伤害完成）。
   * 每个特效的在场时长由配置给出，避免"一闪而过看不清"。
   */
  private playFxScatter(s: FxScatter): void {
    const p = playerRef?.position;
    if (!p) {
      return;
    }
    const n = Math.max(1, Math.round(s.count));
    for (let i = 0; i < n; i++) {
      const ang = this.rng.next() * Math.PI * 2;
      const rad = Math.sqrt(this.rng.next()) * s.spreadPx; // 面积均匀采样
      this.playFx(s.fx, p.x + Math.cos(ang) * rad, p.y + Math.sin(ang) * rad,
        this.rng.next() * 360, false, s.durationSec, s.sizePx);
    }
  }

  /** dash：朝最近敌人方向冲刺，期间无敌，沿途对接触到的敌人结算一次伤害。 */
  private startDash(skill: SkillRuntime, source: string): void {
    const dir = this.aimDir();
    this.dashDirX = dir.x;
    this.dashDirY = dir.y;
    this.dashTraveledPx = 0;
    this.dashHitNodes.length = 0;
    this.stuckAccumSec = 0;
    this.ensureCommonConfig();
    this.state = 'dash';
    this.activeSkill = skill;
    this.stateTimerSec = skill.dashDistancePx / Math.max(1, skill.dashSpeedPx);
    if (this.findEffect(skill, 'invuln')) {
      gameState.setInvulnerable(true);
    }
    playerRef?.getComponent(Player)?.setControlEnabled(false);
    // 表现：冲刺全程跟随玩家的斩击特效（此前玩家技能完全没有特效，导致"按了看不出释放"）
    const p = playerRef?.position;
    const dashDur = skill.dashDistancePx / Math.max(1, skill.dashSpeedPx);
    this.playFx(skill.fx, p ? p.x : 0, p ? p.y : 0, this.dirAngleDeg(this.dashDirX, this.dashDirY),
      true, Math.max(0.4, dashDur * 1.3), 150);
    console.log(`[Skill] 冲刺开始：距离 ${skill.dashDistancePx.toFixed(0)}px，方向 (${this.dashDirX.toFixed(2)}, ${this.dashDirY.toFixed(2)})`);
  }

  /** instant：立即对范围内敌人结算伤害并施加控制（root）。 */
  private castInstant(skill: SkillRuntime): void {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    const damage = this.skillDamage(skill);
    // 表现：以自身为中心的范围特效（尺寸 = 实际作用直径），此前完全没有特效
    const pp = playerRef?.position;
    this.playFx(skill.fx, pp ? pp.x : 0, pp ? pp.y : 0, 0, true, 0.9, this.fxSizeOf(skill));
    const root = this.findEffect(skill, 'root');
    let hits = 0;
    for (const node of enemies) {
      const enemy = node.getComponent(Enemy);
      if (!enemy || !this.inRange(node, skill.rangePx)) {
        continue;
      }
      enemy.takeDamage(damage);
      eventBus.emit(EventNames.on_damage_dealt, node.position.x, node.position.y, damage);
      hits++;
      if (root) {
        const isBoss = enemy.getKind() === 'boss';
        if (!(root.exclude_boss && isBoss)) {
          enemy.applyStatus(0, (root.duration_ms ?? 0) / 1000); // speedScale 0 = 定身
        }
      }
    }
    console.log(`[Skill] 「${skill.name}」命中 ${hits} 个敌人（伤害 ${damage}）`);
  }

  /** channel：持续施放，每 tick 结算一次伤害并刷新减速。 */
  private startChannel(skill: SkillRuntime, source: string): void {
    this.state = 'channel';
    this.activeSkill = skill;
    this.stateTimerSec = skill.durationSec;
    this.tickAccumSec = 0;
    if (this.findEffect(skill, 'invuln')) {
      gameState.setInvulnerable(true);
    }
    // 站桩引导（用户反馈：雷霆审判引导期间还能自由移动，与「持续施法」不符）：
    // 由 skills.json 的 `lock_move` 控制，位移在引导期间完全锁定，收招时统一恢复。
    if (skill.lockMove) {
      playerRef?.getComponent(Player)?.setControlEnabled(false);
    }
    const moveSlow = this.findEffect(skill, 'move_slow');
    if (moveSlow) {
      playerRef?.getComponent(Player)?.setMoveSpeedScale(moveSlow.ratio);
    }
    const immune = this.findEffect(skill, 'immune_ranged');
    if (immune) {
      gameState.setImmuneRanged(true);
      // immune_ranged 自带独立时长（短于引导时间时提前解除）
      const ms = immune.duration_ms ?? skill.durationSec * 1000;
      timer.after(ms / 1000, () => gameState.setImmuneRanged(false));
    }
    // 表现：默认播"跟随自身"的引导特效；配置了 fx_scatter 的技能改走散布特效（见 tickChannel），
    // 避免整片大特效糊住屏幕（用户反馈：雷霆审判的雷电太大）
    this.scatterAccumSec = skill.fxScatter ? skill.fxScatter.intervalSec : 0;
    if (!skill.fxScatter) {
      const pp = playerRef?.position;
      this.playFx(skill.fx, pp ? pp.x : 0, pp ? pp.y : 0, 0, true,
        Math.max(0.5, skill.durationSec), this.fxSizeOf(skill));
    }
    console.log(`[Skill] 引导开始：「${skill.name}」持续 ${skill.durationSec.toFixed(1)}s，每 ${skill.tickSec.toFixed(2)}s 结算一次`);
  }

  /** buff：给自身施加限时增幅（属性效果 + 技能增幅系数），到期整批移除。 */
  private castBuff(skill: SkillRuntime, source: string): void {
    // 表现：增幅类必杀技给自己套一个持续整个增益时长的光环（跟随自身）
    const bp = playerRef?.position;
    // 尺寸交给 fx.json（boost 已按"与角色图标相近"重新标定），不再硬编码 96px
    this.playFx(skill.fx, bp ? bp.x : 0, bp ? bp.y : 0, 0, true,
      Math.max(0.8, skill.durationSec), skill.auraSizePx);
    for (const e of skill.effects) {
      switch (e.kind) {
        case 'atk_speed_up':
          gameState.applyEffect({ kind: 'atk_speed', op: 'add_percent', value: e.ratio }, source);
          break;
        case 'damage_up':
          gameState.addSkillBonus('damage_up', e.ratio, source);
          break;
        case 'width_up':
          gameState.addSkillBonus('width_up', e.ratio, source);
          break;
        case 'extra_projectile':
          // 额外投射物数量（计数类）：让「猎手专注」这类必杀技有弹幕倾泻的观感
          gameState.addSkillBonus('extra_projectile', e.count ?? 0, source);
          break;
        default:
          break;
      }
    }
    timer.after(skill.durationSec, () => {
      gameState.removeEffectsOf(source);
      gameState.removeSkillBonusesOf(source);
      console.log(`[Skill] 「${skill.name}」增幅结束`);
    });
    console.log(`[Skill] 「${skill.name}」增幅生效 ${skill.durationSec.toFixed(1)}s`);
  }

  /** 疾风步：起手向四周散射箭矢（effects.arrow_burst）。 */
  private fireArrowBurst(skill: SkillRuntime, burst: any): void {
    const player = playerRef;
    if (!player) {
      return;
    }
    const count = Math.max(1, Math.round(burst.count ?? 1));
    const damage = this.skillDamage(skill);
    const spec: BulletSpec = {
      damage,
      lifestealRatio: gameState.getStats().lifestealRatio,
      pierceCount: 0,
      explodeRadiusPx: 0,
      explodeDamageRatio: 1,
    };
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count;
      fireBullet(player.position.x, player.position.y, Math.cos(angle), Math.sin(angle), spec);
    }
    console.log(`[Skill] 散射 ${count} 支箭矢（每支 ${damage}）`);
  }

  // —— 逐帧 ——

  private tick = (dt: number): void => {
    if (!gameState.isRunActive()) {
      return;
    }
    this.ensureSkills(); // 自愈：不依赖开局事件的订阅顺序
    if (gameState.isPaused()) {
      return; // 暂停（升级选卡 / 手动暂停）时冻结冷却与动作
    }
    const step = Math.min(dt, MAX_DT_SEC);
    for (const skill of this.skills) {
      if (skill && skill.remainSec > 0) {
        skill.remainSec = Math.max(0, skill.remainSec - step);
      }
    }
    for (let i = 0; i < this.resetFlashSec.length; i++) {
      if (this.resetFlashSec[i] > 0) {
        this.resetFlashSec[i] = Math.max(0, this.resetFlashSec[i] - step);
      }
      if (this.deniedFlashSec[i] > 0) {
        this.deniedFlashSec[i] = Math.max(0, this.deniedFlashSec[i] - step);
      }
    }
    if (this.state === 'dash') {
      this.tickDash(step);
    } else if (this.state === 'channel') {
      this.tickChannel(step);
    }
  };

  private tickDash(step: number): void {
    const skill = this.activeSkill;
    const player = playerRef;
    if (!skill || !player) {
      this.abortCast();
      return;
    }
    const distance = skill.dashSpeedPx * step;
    const p = player.position;
    const moved = resolveWalkableMove(
      p.x, p.y, p.x + this.dashDirX * distance, p.y + this.dashDirY * distance, this.bodyRadiusPx(),
    );
    const advanced = Math.hypot(moved.x - p.x, moved.y - p.y);
    player.setPosition(moved.x, moved.y, p.z);
    this.dashTraveledPx += advanced;
    this.damageAlongDash(skill);
    this.stateTimerSec -= step;
    // 卡住判定：贴墙 / 被挤压时单帧位移会大幅衰减，但**必须连续一小段时间都推不动**才收招。
    // 若按单帧判定，起手撞墙时会在第一帧就"落地"（表现为「箭矢在起点射出、冲刺没动」）。
    if (advanced < distance * this.dashStuckRatio) {
      this.stuckAccumSec += step;
    } else {
      this.stuckAccumSec = 0;
    }
    // 走满距离 / 确认卡住 / 超时 → 收招
    if (this.dashTraveledPx >= skill.dashDistancePx
      || this.stuckAccumSec >= this.dashStuckSec
      || this.stateTimerSec <= 0) {
      // 射手「疾风步」：位移结束**落地那一刻**向四周散射（用户口径）
      const burst = this.findEffect(skill, 'arrow_burst');
      if (burst) {
        this.fireArrowBurst(skill, burst);
      }
      this.abortCast();
    }
  }

  /** 冲刺沿途伤害（每个敌人只结算一次）。 */
  private damageAlongDash(skill: SkillRuntime): void {
    const player = playerRef;
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    if (!player) {
      return;
    }
    const damage = this.skillDamage(skill);
    for (const node of enemies) {
      if (this.dashHitNodes.indexOf(node) >= 0) {
        continue;
      }
      const enemy = node.getComponent(Enemy);
      if (!enemy || !this.inRange(node, skill.rangePx)) {
        continue;
      }
      this.dashHitNodes.push(node);
      enemy.takeDamage(damage);
      eventBus.emit(EventNames.on_damage_dealt, node.position.x, node.position.y, damage);
    }
  }

  private tickChannel(step: number): void {
    const skill = this.activeSkill;
    if (!skill) {
      this.abortCast();
      return;
    }
    this.tickAccumSec += step;
    if (skill.tickSec > 0 && this.tickAccumSec >= skill.tickSec) {
      this.tickAccumSec = 0;
      this.damageChannelTick(skill);
    }
    // 散布特效（如「雷霆审判」的全屏雷电乱闪）：按节奏在玩家四周随机播若干个**小**特效
    if (skill.fxScatter) {
      this.scatterAccumSec += step;
      if (this.scatterAccumSec >= skill.fxScatter.intervalSec) {
        this.scatterAccumSec = 0;
        this.playFxScatter(skill.fxScatter);
      }
    }
    this.stateTimerSec -= step;
    if (this.stateTimerSec <= 0) {
      this.abortCast();
    }
  }

  /** 引导每段伤害（并按 slow 效果刷新敌人减速）。 */
  private damageChannelTick(skill: SkillRuntime): void {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    const damage = this.skillDamage(skill);
    const slow = this.findEffect(skill, 'slow');
    let hits = 0;
    for (const node of enemies) {
      const enemy = node.getComponent(Enemy);
      if (!enemy || !this.inRange(node, skill.rangePx)) {
        continue;
      }
      enemy.takeDamage(damage);
      eventBus.emit(EventNames.on_damage_dealt, node.position.x, node.position.y, damage);
      hits++;
      if (slow && typeof slow.ratio === 'number') {
        // 持续 2 个 tick，使减速在引导期间持续生效
        enemy.applyStatus(Math.max(0, 1 - slow.ratio), skill.tickSec * 2);
      }
    }
    if (hits > 0) {
      console.log(`[Skill] 「${skill.name}」结算 ${hits} 个敌人（每段伤害 ${damage}）`);
    }
  }

  /** 收招：解除无敌 / 免疫远程不需要在此处理（自带时长）/ 恢复玩家操控与移速。 */
  private abortCast(): void {
    gameState.setInvulnerable(false);
    const player = playerRef?.getComponent(Player);
    player?.setControlEnabled(true);
    player?.setMoveSpeedScale(1);
    this.activeSkill = null;
    this.state = 'idle';
    this.stateTimerSec = 0;
    this.tickAccumSec = 0;
    this.stuckAccumSec = 0;
    this.dashHitNodes.length = 0;
  }

  // —— 工具 ——

  private findEffect(skill: SkillRuntime, kind: string): any | null {
    for (const e of skill.effects) {
      if (e && e.kind === kind) {
        return e;
      }
    }
    return null;
  }

  private skillDamage(skill: SkillRuntime): number {
    return damageFormula.playerDamage(gameState.getStats(), gameState.getClassId(), this.rng, skill.damageRatio);
  }

  /** 是否在技能作用范围内（rangePx ≤ 0 视为全场）。 */
  private inRange(node: Node, rangePx: number): boolean {
    const player = playerRef;
    if (!player) {
      return false;
    }
    if (rangePx <= 0) {
      return true;
    }
    const dx = node.position.x - player.position.x;
    const dy = node.position.y - player.position.y;
    return dx * dx + dy * dy <= rangePx * rangePx;
  }

  /**
   * 冲刺方向（用户口径）：正在移动时按**当前移动方向**，静止时按**面朝方向**（= 最近一次移动方向）。
   * 因此冲刺既能当位移/闪避，也能当输出手段；不做自动瞄准最近敌人。
   */
  private aimDir(): { x: number; y: number } {
    const facing = playerRef?.getComponent(Player)?.getFacingDir();
    if (facing) {
      const len = Math.hypot(facing.x, facing.y);
      if (len > 0) {
        return { x: facing.x / len, y: facing.y / len };
      }
    }
    return { x: 0, y: -1 }; // 兜底：与 Player.facing 初值一致（朝下）
  }

  /** 玩家身体半径（冲刺贴墙用），由精灵尺寸 × 缩放推导。 */
  private bodyRadiusPx(): number {
    const player = playerRef;
    if (!player) {
      return 0;
    }
    const ut = player.getComponent(UITransform);
    if (!ut) {
      return 0;
    }
    return Math.max(ut.contentSize.width, ut.contentSize.height) * player.scale.x * 0.5;
  }

  /**
   * 技能栏只读快照（名称 / 剩余冷却 / 冷却总量）。
   * 表现层读取用于绘制冷却进度（与 Minimap 同模式：连续表现由表现层按帧读取只读状态）。
   */
  getSlotInfo(
    slot: number,
  ): {
    name: string; remainSec: number; totalSec: number;
    durationSec: number; resetFlashSec: number; deniedFlashSec: number;
  } | null {
    this.ensureSkills(); // 自愈：技能栏在开局事件顺序异常时也能拿到数据
    const skill = this.skills[slot - 1];
    if (!skill) {
      return null;
    }
    return {
      name: skill.name,
      remainSec: skill.remainSec,
      totalSec: skill.cooldownSec,
      durationSec: skill.durationSec,
      resetFlashSec: this.resetFlashSec[slot - 1] ?? 0,
      deniedFlashSec: this.deniedFlashSec[slot - 1] ?? 0,
    };
  }

  /** 当前是否正在施放（表现层可用于高亮）。 */
  isCasting(): boolean {
    return this.state !== 'idle';
  }

  /**
   * 立即结束某技能槽的冷却（供「疾影」等击杀重置类效果使用）。
   * @returns 是否确实重置了（原本不在冷却中则返回 false）
   */
  resetCooldown(slot: number): boolean {
    const skill = this.skills[slot - 1];
    if (!skill || skill.remainSec <= 0) {
      return false;
    }
    skill.remainSec = 0;
    // 冷却被"凭空清零"必须有可见反馈，否则玩家会误判为"技能没有冷却"（用户实测疑问）
    this.resetFlashSec[slot - 1] = RESET_FLASH_SEC;
    return true;
  }
}

export const skillSystem = new SkillSystem();

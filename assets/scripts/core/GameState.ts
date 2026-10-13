import { dataManager } from '../data/DataManager';
import { eventBus } from './EventBus';
import { EventNames } from './EventNames';
import { metaState, RunSnapshot } from './MetaState';
import { MathUtils } from '../utils/MathUtils';
import { timer } from './Timer';

/**
 * 配置/养成项的 `effect.kind` → GameState 属性 kind 映射（局内 Buff 与局外养成共用同一套翻译）。
 * 未列入的 kind 属「非属性」效果（技能类 / 行为类 / 解锁类），由各自模块消费。
 */
export const STAT_KIND_MAP: Record<string, string> = {
  atk_up: 'atk',
  atk_speed_up: 'atk_speed',
  max_hp_up: 'max_hp',
  crit_rate_up: 'crit_rate',
  crit_dmg_up: 'crit_dmg',
  move_speed_up: 'move_speed',
  pickup_range_up: 'pickup_range',
  hp_regen_up: 'hp_regen_per_sec',
  exp_gain_up: 'exp_gain',
  gold_gain_up: 'gold_gain',
  lifesteal_up: 'lifesteal',
};

/** 玩家局内属性快照（比例类用小数，距离用像素）。 */
export interface PlayerStats {
  maxHp: number;
  atk: number;
  atkSpeed: number;
  critRate: number;
  critDmg: number;
  moveSpeedPx: number;
  pickupRangePx: number;
  hpRegenPerSecRatio: number;
  expGain: number;
  goldGain: number;
  lifestealRatio: number;
  /** 普攻子弹额外穿透数（职业基础值 + 行为型 Buff 增益；0 = 命中即消失，文档 2.7 射手特性）。 */
  bulletPierce: number;
}

/**
 * 本局模式（文档 2.6 / 7.6 阶段 4）：
 * `base` 本体（有层数上限，通关解锁终局）、`normal` 终局·普通地图、`challenge` 终局·挑战地图。
 */
export type RunMode = 'base' | 'normal' | 'challenge';

/** 生成本局随机种子（时间 ^ 随机数；非 0）。 */
function newRunSeed(): number {
  return ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0) || 1;
}

/** 属性增益效果（与 buffs.json 的 effect 结构一致）。 */
export interface StatEffect {
  kind: string;
  op: 'add_flat' | 'add_percent';
  value: number;
  /** 效果来源（Buff id / `meta` 表示局外养成）：卸下或替换 Buff 时按来源整批移除。 */
  source?: string;
}

/**
 * 局内运行状态源（唯一可变状态容器）。
 *
 * 规则（项目宪法 6.5）：状态只能通过本类方法变更；变更后按需发布事件。
 * 规则（项目宪法 6.7）：初始值来自 characters.json / balance.json，禁止硬编码游戏数值。
 * Buff 叠加由 recompute() 统一结算，受 balance 上限约束（文档 3.3/3.4）。
 */
class GameState {
  private classId = '';
  private baseStats: PlayerStats = {
    maxHp: 0, atk: 0, atkSpeed: 0, critRate: 0, critDmg: 0,
    moveSpeedPx: 0, pickupRangePx: 0, hpRegenPerSecRatio: 0,
    expGain: 0, goldGain: 0, lifestealRatio: 0, bulletPierce: 0,
  };
  private stats: PlayerStats = {
    maxHp: 0, atk: 0, atkSpeed: 0, critRate: 0, critDmg: 0,
    moveSpeedPx: 0, pickupRangePx: 0, hpRegenPerSecRatio: 0,
    expGain: 0, goldGain: 0, lifestealRatio: 0, bulletPierce: 0,
  };
  private activeEffects: StatEffect[] = [];
  // 以下为「默认上限」，init 时会从 balance.json 覆盖（防止硬编码生效）
  private attrCaps = {
    atk_speed: 5, crit_rate: 0.75, move_speed_px: 400,
    pickup_range_px: 300, hp_regen_per_sec_ratio: 0.02, exp_gain: 3, gold_gain: 3,
  };
  private pctCap = 3.0;
  /**
   * 局外养成提供的「增幅系数」缓存（effect.kind → 系数）。
   * 属性类在 init 时折算进 activeEffects；增幅/成长类（流派伤害、投射物、局内 Buff 数值等）
   * 由消费方按需读取（伤害公式 / 子弹 / Buff 系统），避免 PlayerStats 字段无限膨胀。
   */
  private metaBonuses: Map<string, number> = new Map();

  /**
   * 技能临时增幅系数（effect.kind → 系数，如 damage_up / width_up）。
   * 与局外增幅分开存放：技能增幅随技能结束按来源整批移除（`removeSkillBonusesOf`），
   * 读取方统一走 `getBonus()`，因此「局外加成 + 技能加成」对伤害 / 子弹 / 爆开同时生效。
   */
  private skillBonuses: { kind: string; value: number; source: string }[] = [];

  /**
   * 局内 Buff 的增幅系数（技能类 / 行为类效果）。
   * `slot > 0` 表示按技能槽区分（如 `skill_cd_down` / `skill_dmg_up`）；
   * `source` = buff id，Buff 被替换或卸下时按来源整批移除。
   * 复杂效果（灼烧 / 冰缓 / 光环…）的附加参数以 `${kind}.参数名` 形式一并登记，供机制实现读取。
   */
  private buffBonuses: { kind: string; slot: number; value: number; source: string }[] = [];
  /** 无敌标记（技能效果 invuln）：为真时 `takeDamage` 直接忽略，所有伤害源统一生效。 */
  private invuln = false;
  /** 免疫远程标记（技能效果 immune_ranged）：远程弹丸命中前自行查询。 */
  private immuneRanged = false;

  private hp = 0;
  private exp = 0;
  private level = 1;
  private gold = 0;
  private layer = 0;
  /** 本局击杀数（运行时统计，结算界面展示用）。 */
  private kills = 0;
  private runActive = false;
  private alive = true;
  /** 玩家烧伤 DOT（Boss 火焰大招）：每秒伤害 / 剩余秒数 / 是否已在结算循环中。 */
  private dotDps = 0;
  private dotLeftSec = 0;
  private dotRunning = false;

  /** 本局随机种子（地宫生成用；每局不同 → 同一层布局不再雷同，用户反馈）。 */
  private runSeed = 0;
  /** 「不屈」等复活类效果是否已用掉（每局一次）。 */
  private reviveUsed = false;
  /** 护盾减伤比例（0 = 无护盾；由技能型 Buff「护盾」设置，硬上限取 balance.attr_cap）。 */
  private shieldRatio = 0;
  /** 暂停标记（升级选卡等待中）：只冻结玩法层，UI 与事件总线不受影响。 */
  private paused = false;
  /**
   * 手动暂停标记（局内暂停面板）。
   * 与 `paused`（升级选卡等待）分开存放：`isPaused()` 取两者并集，
   * 因此玩法层（玩家/敌人/子弹/计时/技能冷却）会一并冻结，退出暂停后自动恢复。
   */
  private manualPaused = false;
  /** 本局结束原因：死亡 / 通关 / 玩家主动退出（主动退出不弹结算面板）。 */
  private endReason: 'death' | 'clear' | 'suspend' = 'death';
  private buffs: string[] = [];
  /** 层内收益软上限倍率（由 dungeon/LayerRisk 按停留时间写入，文档 3.7；1 = 无衰减）。 */
  private layerRewardMultiplier = 1;
  /**
   * 本局模式（文档 2.6 / 7.6 阶段 4）：
   *  - `base`：本体（有层数上限，通关后解锁终局）；
   *  - `normal`：终局·普通地图（层数无上限、收益稳定、无软上限）；
   *  - `challenge`：终局·挑战地图（层数无上限、敌方按递进公式、收益按 1.12^层数、失败保留部分收益）。
   */
  private mode: RunMode = 'base';
  /**
   * 本局「模式收益系数」（由 dungeon/RunFlow 在每层开始时按模式 × 层数写入，文档 3.8）。
   * 与层内软上限分开：软上限只降不升（0~1），模式系数可 > 1（挑战地图收益递增）。
   */
  private modeRewardFactor = 1;

  /** 以职业初始化一局（数值全部取自配置）。 */
  init(classId: string, mode: RunMode = 'base'): void {
    const c = dataManager.get<any>('characters', classId);
    this.classId = classId;
    this.mode = mode;
    this.modeRewardFactor = 1;
    this.baseStats = {
      maxHp: c.base_hp,
      atk: c.base_atk,
      atkSpeed: c.atk_speed,
      critRate: c.crit_rate,
      critDmg: c.crit_dmg,
      moveSpeedPx: c.move_speed_px,
      pickupRangePx: c.pickup_range_px,
      hpRegenPerSecRatio: c.hp_regen_per_sec_ratio,
      expGain: c.exp_gain,
      goldGain: c.gold_gain,
      lifestealRatio: 0,
      // 职业基础穿透（未配置 = 0）：射手的普攻特性由 characters.json 提供
      bulletPierce: c.attack_pierce_count ?? 0,
    };
    this.activeEffects = [];
    // 局外养成（属性类注入加成型效果、增幅类缓存系数），必须在 recompute 之前
    this.metaBonuses.clear();
    this.applyMetaProgress();
    // 技能临时状态复位（技能系统每局重新开始，避免残留增幅/无敌）
    this.skillBonuses = [];
    this.buffBonuses = [];
    this.invuln = false;
    this.immuneRanged = false;
    this.clearDot(); // 开局清掉上一局可能残留的烧伤
    // 本局随机种子：让"每局同一层的布局都不同"（此前种子只由层号推导 → 前几关地图每局雷同）
    this.runSeed = newRunSeed();
    // 读取上限（禁止硬编码）
    const bal = dataManager.get<any>('balance', 'attr_cap');
    this.attrCaps = {
      atk_speed: bal.atk_speed, crit_rate: bal.crit_rate, move_speed_px: bal.move_speed_px,
      pickup_range_px: bal.pickup_range_px, hp_regen_per_sec_ratio: bal.hp_regen_per_sec_ratio,
      exp_gain: bal.exp_gain, gold_gain: bal.gold_gain,
    };
    this.pctCap = dataManager.get<any>('balance', 'damage').percent_buff_cap;
    this.recompute();
    this.hp = this.stats.maxHp;
    this.exp = 0;
    this.level = 1;
    this.gold = 0;
    this.layer = 0;
    this.kills = 0;
    this.runActive = true;
    this.alive = true;
    this.reviveUsed = false;
    this.shieldRatio = 0;
    this.paused = false;
    this.manualPaused = false;
    this.endReason = 'death';
    this.buffs = [];
    this.layerRewardMultiplier = 1;
  }

  private flat(kind: string): number {
    return this.activeEffects
      .filter(e => e.kind === kind && e.op === 'add_flat')
      .reduce((s, e) => s + e.value, 0);
  }

  private pct(kind: string): number {
    const sum = this.activeEffects
      .filter(e => e.kind === kind && e.op === 'add_percent')
      .reduce((s, e) => s + e.value, 0);
    return Math.min(sum, this.pctCap);
  }

  /** 由基础属性 + 已激活增益重算当前属性，并施加 balance 上限。 */
  private recompute(): void {
    const b = this.baseStats;
    const cap = this.attrCaps;
    const oldMax = this.stats.maxHp;

    const maxHp = (b.maxHp + this.flat('max_hp')) * (1 + this.pct('max_hp'));
    const atk = (b.atk + this.flat('atk')) * (1 + this.pct('atk'));
    const atkSpeed = MathUtils.clamp((b.atkSpeed + this.flat('atk_speed')) * (1 + this.pct('atk_speed')), 0, cap.atk_speed);
    const critRate = MathUtils.clamp(b.critRate + this.flat('crit_rate') + this.pct('crit_rate'), 0, cap.crit_rate);
    const critDmg = b.critDmg + this.flat('crit_dmg') + this.pct('crit_dmg');
    const moveSpeedPx = MathUtils.clamp((b.moveSpeedPx + this.flat('move_speed')) * (1 + this.pct('move_speed')), 0, cap.move_speed_px);
    const pickupRangePx = MathUtils.clamp((b.pickupRangePx + this.flat('pickup_range')) * (1 + this.pct('pickup_range')), 0, cap.pickup_range_px);
    const hpRegenPerSecRatio = MathUtils.clamp((b.hpRegenPerSecRatio + this.flat('hp_regen_per_sec')) * (1 + this.pct('hp_regen_per_sec')), 0, cap.hp_regen_per_sec_ratio);
    const expGain = b.expGain + this.flat('exp_gain') + this.pct('exp_gain');
    const goldGain = b.goldGain + this.flat('gold_gain') + this.pct('gold_gain');
    const lifestealRatio = b.lifestealRatio + this.flat('lifesteal') + this.pct('lifesteal');
    // 穿透是「个数」：只吃加成型增益（百分比对其无意义，不参与结算）
    const bulletPierce = b.bulletPierce + this.flat('bullet_pierce');

    this.stats = {
      maxHp, atk, atkSpeed, critRate, critDmg, moveSpeedPx,
      pickupRangePx, hpRegenPerSecRatio, expGain, goldGain, lifestealRatio, bulletPierce,
    };
    // 最大生命提升时同步回血，避免 Buff 反而扣血
    if (maxHp > oldMax) this.hp += (maxHp - oldMax);
    this.hp = Math.min(this.hp, maxHp);
  }

  /**
   * 应用局外养成（文档 2.9 / 7.5）：按 meta.json 各项目的当前等级换算。
   *  - 属性类（STAT_KIND_MAP 命中）：注入 `add_flat` 效果 → 走既有 recompute，天然受
   *    `balance.attr_cap` / `percent_buff_cap` 约束（宪法 6.9：倍率必须有硬上限）；
   *  - 增幅 / 成长类（流派伤害、投射物数量与体积、爆开范围、局外 Buff 数值等）：缓存为系数，
   *    由伤害公式 / 子弹 / Buff 系统经 `getMetaBonus(kind)` 读取；
   *  - 解锁类（unlock_class / buff_slot）不在此结算：购买时已由 MetaState 应用到局外状态。
   */
  private applyMetaProgress(): void {
    if (!dataManager.isLoaded('meta')) {
      return;
    }
    const items = dataManager.getTable<any[]>('meta');
    for (const item of items) {
      if (item.enabled === false) {
        continue; // 该养成项当前未启用（如按裁决关闭的职业解锁）
      }
      const level = metaState.getLevel(item.id);
      if (level <= 0 || !item.effect || typeof item.effect.per_level !== 'number') {
        continue;
      }
      const value = item.effect.per_level * level;
      const statKind = STAT_KIND_MAP[item.effect.kind];
      if (statKind) {
        // 来源标记为 meta：局外效果不参与 Buff 卸下/替换
        this.activeEffects.push({ kind: statKind, op: 'add_flat', value, source: 'meta' });
      } else {
        this.metaBonuses.set(item.effect.kind, value);
      }
    }
  }

  /** 局外增幅系数（如 melee_dmg_up / projectile_size_up / bullet_pierce / extra_projectile）。 */
  getMetaBonus(kind: string): number {
    return this.metaBonuses.get(kind) ?? 0;
  }

  /** 总增幅系数 = 局外养成 + 技能临时增幅 + 局内 Buff 系数（消费方统一读此方法）。 */
  getBonus(kind: string): number {
    let total = this.metaBonuses.get(kind) ?? 0;
    for (let i = 0; i < this.skillBonuses.length; i++) {
      if (this.skillBonuses[i].kind === kind) {
        total += this.skillBonuses[i].value;
      }
    }
    return total + this.getBuffBonus(kind, 0);
  }

  /** 追加技能临时增幅（由技能系统施加，`source` 用于技能结束时整批移除）。 */
  addSkillBonus(kind: string, value: number, source: string): void {
    this.skillBonuses.push({ kind, value, source });
  }

  /** 移除某来源施加的全部技能增幅（技能结束时调用）。 */
  removeSkillBonusesOf(source: string): void {
    const before = this.skillBonuses.length;
    this.skillBonuses = this.skillBonuses.filter((b) => b.source !== source);
    if (this.skillBonuses.length !== before) {
      this.recompute();
    }
  }

  /**
   * 登记一条局内 Buff 系数（由 BuffSystem 在应用 Buff 时调用）。
   * @param slot > 0 时表示该系数只作用于对应技能槽
   */
  addBuffBonus(kind: string, value: number, source: string, slot = 0): void {
    this.buffBonuses.push({ kind, slot, value, source });
  }

  /** 移除某个 Buff 登记的全部系数（Buff 被替换 / 卸下时调用）。 */
  removeBuffBonusesOf(source: string): void {
    const before = this.buffBonuses.length;
    this.buffBonuses = this.buffBonuses.filter((b) => b.source !== source);
    if (this.buffBonuses.length !== before) {
      this.recompute();
    }
  }

  /** 局内 Buff 系数查询（`slot = 0` 为不限槽位的通用系数）。 */
  getBuffBonus(kind: string, slot = 0): number {
    let total = 0;
    for (let i = 0; i < this.buffBonuses.length; i++) {
      const b = this.buffBonuses[i];
      if (b.kind === kind && b.slot === slot) {
        total += b.value;
      }
    }
    return total;
  }

  /** 是否携带了某类 Buff 系数（布尔类行为 Buff，如「不屈」「经验磁场」）。 */
  hasBuffBonus(kind: string): boolean {
    for (let i = 0; i < this.buffBonuses.length; i++) {
      if (this.buffBonuses[i].kind === kind) {
        return true;
      }
    }
    return false;
  }

  /** 无敌（技能 invuln 期）。 */
  setInvulnerable(value: boolean): void {
    this.invuln = value;
  }

  isInvulnerable(): boolean {
    return this.invuln;
  }

  /** 免疫远程（技能 immune_ranged 期）。 */
  setImmuneRanged(value: boolean): void {
    this.immuneRanged = value;
  }

  isImmuneRanged(): boolean {
    return this.immuneRanged;
  }

  /** 导出局内快照（存档 `progress.current_run`；不含地宫布局，文档 5.6）。 */
  snapshotRun(): RunSnapshot {
    return {
      classId: this.classId,
      mode: this.mode,
      layer: this.layer,
      hp: this.hp,
      exp: this.exp,
      level: this.level,
      gold: this.gold,
      kills: this.kills,
      bankedGold: 0,
      buffs: this.buffs.slice(),
    };
  }

  /**
   * 从快照恢复一局：先按职业与局外养成重置，再覆盖进度数值。
   * 已选 Buff 的属性效果由 BuffSystem 收到 `on_run_resume` 后重放（避免 core ← combat 反向依赖）。
   */
  restoreRun(snapshot: RunSnapshot): void {
    // 旧档（v3 及以前）没有 mode 字段：按本体处理，保证续玩不崩
    this.init(snapshot.classId, snapshot.mode ?? 'base');
    this.level = snapshot.level;
    this.exp = snapshot.exp;
    this.gold = snapshot.gold;
    this.kills = snapshot.kills;
    // 恢复携带的局内 Buff（层数即等级）：技能型 Buff 的运行时由 BehaviorSkillSystem 在
    // 随后的 `on_run_start` 中读取本列表重建，因此这里必须真正写回，而不是清空。
    this.buffs = Array.isArray(snapshot.buffs) ? snapshot.buffs.slice() : [];
    // 至少保留 1 点血：存档中的进行中局面不应是"0 血但仍存活"的状态
    this.hp = Math.min(Math.max(1, snapshot.hp), this.stats.maxHp);
    eventBus.emit(EventNames.on_hp_changed, this.hp);
  }

  /**
   * 应用一条增益效果（由 BuffSystem 调用）。
   * @param source 效果来源（Buff id；局外养成用 `meta`），用于按来源整批移除
   */
  applyEffect(effect: StatEffect, source = ''): void {
    const hpBefore = this.hp;
    this.activeEffects.push({ kind: effect.kind, op: effect.op, value: effect.value, source });
    this.recompute();
    // 最大生命提升会同步回血：立即广播，避免 UI 等下一次掉血才刷新
    if (this.hp !== hpBefore) {
      eventBus.emit(EventNames.on_hp_changed, this.hp);
    }
  }

  /** 移除某个来源贡献的全部属性效果（Buff 卸下 / 槽位替换时使用）。 */
  removeEffectsOf(source: string): void {
    const before = this.activeEffects.length;
    this.activeEffects = this.activeEffects.filter((e) => e.source !== source);
    if (this.activeEffects.length !== before) {
      this.recompute();
      eventBus.emit(EventNames.on_hp_changed, this.hp);
    }
  }

  /**
   * 卸下一个局内 Buff：清空其属性效果并从携带列表移除。
   * 用途（文档 2.8）：行为型 Buff 有「同时携带上限」，超出时替换最早携带的那一个。
   */
  removeBuff(id: string): void {
    const idx = this.buffs.indexOf(id);
    if (idx < 0) {
      return;
    }
    this.buffs.splice(idx, 1);
    this.removeEffectsOf(id);
    this.removeBuffBonusesOf(id); // 同时回收该 Buff 登记的非属性系数
  }

  // —— 只读查询 ——
  getClassId(): string { return this.classId; }
  /** 本局随机种子（地宫生成用；DungeonService.generateLayer 读取）。 */
  getRunSeed(): number { return this.runSeed; }
  getStats(): Readonly<PlayerStats> { return this.stats; }
  getBaseAtk(): number { return this.baseStats.atk; }
  getHp(): number { return this.hp; }
  getMaxHp(): number { return this.stats.maxHp; }
  getLevel(): number { return this.level; }
  getExp(): number { return this.exp; }
  getGold(): number { return this.gold; }
  getLayer(): number { return this.layer; }
  getKills(): number { return this.kills; }
  isRunActive(): boolean { return this.runActive; }
  isAlive(): boolean { return this.alive; }
  /** 是否处于暂停（升级选卡等待中 或 手动暂停）：玩法层每帧逻辑据此短路。 */
  isPaused(): boolean { return this.paused || this.manualPaused; }

  /** 手动暂停开关（局内暂停面板；与选卡等待区分，互不影响）。 */
  setManualPaused(value: boolean): void {
    this.manualPaused = value;
  }

  isManualPaused(): boolean { return this.manualPaused; }

  /**
   * 是否正处于「升级选卡等待」。
   * 与手动暂停分开暴露：选卡进行中必须**禁止手动暂停**，
   * 否则选卡面板与暂停面板会同时出现、互相叠字（实测问题）。
   */
  isUpgradePending(): boolean { return this.paused; }
  getBuffs(): ReadonlyArray<string> { return this.buffs; }

  /**
   * 局内 Buff 的当前等级：同一 Buff 重复获得即升级，因此**携带层数 = 等级**。
   * 用层数表达等级的好处是存档结构不变（仍是 id 字符串数组），旧档天然兼容。
   */
  getBuffLevel(id: string): number {
    let n = 0;
    for (let i = 0; i < this.buffs.length; i++) {
      if (this.buffs[i] === id) {
        n++;
      }
    }
    return n;
  }

  // —— 变更（仅经方法）——
  /**
   * 玩家持续伤害（烧伤 DOT，来源：Boss 火焰大招等）。
   *
   * 口径（与敌人灼烧一致）：**不叠加** —— 同类只取「更强 / 更长」者；
   * 每 `dot_tick_ms` 结算一次（balance.combat），受击闪色复用 `takeDamage`（让"正在被烧"可见）。
   */
  applyDot(dps: number, durationSec: number): void {
    if (dps <= 0 || durationSec <= 0 || !this.runActive || !this.alive) {
      return;
    }
    this.dotDps = Math.max(this.dotDps, dps);
    this.dotLeftSec = Math.max(this.dotLeftSec, durationSec);
    if (this.dotRunning) {
      return; // 已在跑：由既有循环消化新的强度 / 时长
    }
    this.dotRunning = true;
    const stepSec = Math.max(0.1, (dataManager.get<any>('balance', 'combat').dot_tick_ms ?? 500) / 1000);
    const step = (): void => {
      if (!this.dotRunning) {
        return;
      }
      if (!this.runActive || !this.alive) {
        this.clearDot();
        return;
      }
      this.dotLeftSec -= stepSec;
      if (this.dotLeftSec <= 0) {
        this.clearDot();
        return;
      }
      this.takeDamage(Math.max(1, Math.floor(this.dotDps * stepSec)));
      timer.after(stepSec, step);
    };
    timer.after(stepSec, step);
  }

  /** 清除持续伤害状态（结算 / 开局 / 死亡）。 */
  clearDot(): void {
    this.dotRunning = false;
    this.dotDps = 0;
    this.dotLeftSec = 0;
  }

  heal(amount: number): void {
    if (!this.runActive || !this.alive || amount <= 0) return;
    this.hp = Math.min(this.stats.maxHp, this.hp + amount);
    eventBus.emit(EventNames.on_hp_changed, this.hp);
  }

  takeDamage(amount: number): void {
    if (!this.runActive || !this.alive || amount <= 0) return;
    if (this.invuln) return; // 技能无敌帧（invuln）：所有伤害源统一在此忽略
    // 护盾减伤（技能型 Buff「护盾」）：在唯一受击入口统一折算，硬上限由配置给出
    const finalAmount = this.shieldRatio > 0 ? amount * (1 - this.shieldRatio) : amount;
    // 先钳制到 0 再广播，避免 UI 出现负数血量
    this.hp = Math.max(0, this.hp - finalAmount);
    eventBus.emit(EventNames.on_player_hurt, finalAmount);
    eventBus.emit(EventNames.on_hp_changed, this.hp);
    if (this.hp <= 0) {
      // 不屈（revive_once）：每局一次，濒死时按配置比例回血复活并消耗掉该 Buff
      if (!this.reviveUsed && this.hasBuffBonus('revive_once')) {
        const ratio = this.getBuffBonus('revive_once.ratio') || 0.5;
        this.reviveUsed = true;
        this.hp = Math.max(1, Math.floor(this.stats.maxHp * ratio));
        this.consumeBuffByKind('revive_once');
        eventBus.emit(EventNames.on_hp_changed, this.hp);
        console.log(`[GameState] 「不屈」触发：以 ${Math.round(ratio * 100)}% 生命复活（本局一次）`);
        return;
      }
      this.alive = false;
      this.runActive = false;
      this.paused = false;
      eventBus.emit(EventNames.on_player_died);
    }
  }

  /** 消耗掉携带中、含指定效果 kind 的 Buff（一次性效果用，如「不屈」）。 */
  private consumeBuffByKind(kind: string): void {
    if (!dataManager.isLoaded('buffs')) {
      return;
    }
    const all = dataManager.getTable<any[]>('buffs');
    for (const id of this.buffs.slice()) {
      const def = all.find((b) => b.id === id);
      if (def && Array.isArray(def.effects) && def.effects.some((e: any) => e && e.kind === kind)) {
        this.removeBuff(id);
      }
    }
  }

  addExp(amount: number): void {
    if (!this.runActive || amount <= 0) return;
    // 收益 = 基础 × 经验加成 × 层内软上限 × 模式系数（挑战地图按 1.12^层数 递增，文档 3.8）
    this.exp += amount * this.stats.expGain * this.layerRewardMultiplier * this.modeRewardFactor;
    eventBus.emit(EventNames.on_exp_gained, amount);
  }

  addGold(amount: number): void {
    if (!this.runActive || amount <= 0) return;
    this.gold += Math.floor(
      amount * this.stats.goldGain * this.layerRewardMultiplier * this.modeRewardFactor,
    );
    eventBus.emit(EventNames.on_gold_gained, amount);
  }

  /** 本局模式（`base` / `normal` / `challenge`）。 */
  getMode(): RunMode { return this.mode; }

  /**
   * 写入模式收益系数（由 dungeon/RunFlow 每层按模式计算，文档 3.8）。
   * 说明：`addBonusGold`（层结算奖励）**不**乘该系数 —— 它由本层已含系数的金币推导而来，再乘会重复计算。
   */
  setModeRewardFactor(factor: number): void {
    this.modeRewardFactor = factor > 0 ? factor : 1;
  }

  /** 当前模式收益系数。 */
  getModeRewardFactor(): number { return this.modeRewardFactor; }

  /**
   * 写入层内收益软上限倍率（由 dungeon/LayerRisk 按停留时间计算，文档 3.7）。
   * 掉落结算统一在此施加，故 combat / entities 无需各自改写数值。
   */
  setLayerRewardMultiplier(multiplier: number): void {
    this.layerRewardMultiplier = MathUtils.clamp(multiplier, 0, 1);
  }

  /** 当前层内收益软上限倍率（0~1）。 */
  getLayerRewardMultiplier(): number { return this.layerRewardMultiplier; }

  /**
   * 设置护盾减伤比例（技能型 Buff「护盾」）。
   * 硬上限取 `balance.attr_cap.shield_max_reduction`（用户口径：最高不超过 50%），宪法 6.9 要求倍率有硬上限。
   */
  setShieldRatio(ratio: number): void {
    const cap = dataManager.isLoaded('balance')
      ? (dataManager.get<any>('balance', 'attr_cap').shield_max_reduction ?? 0.5)
      : 0.5;
    this.shieldRatio = MathUtils.clamp(ratio, 0, cap);
  }

  /** 当前护盾减伤比例（0 = 无护盾）。 */
  getShieldRatio(): number { return this.shieldRatio; }

  /**
   * 层结算奖励金币（提前离开奖励，文档 3.7）：直接落袋，
   * 不再叠加金币加成与收益软上限（奖励本身即是「及时推进」的正反馈）。
   */
  addBonusGold(amount: number): void {
    if (!this.runActive || amount <= 0) return;
    this.gold += Math.floor(amount);
    eventBus.emit(EventNames.on_gold_gained, amount);
  }

  /** 记录一次击杀（由战斗系统在敌人死亡时调用，结算界面展示用）。 */
  addKill(): void {
    if (!this.runActive) return;
    this.kills += 1;
  }

  addBuff(id: string): void {
    this.buffs.push(id);
    eventBus.emit(EventNames.on_buff_selected, id);
  }

  /** 由升级系统在校验阈值后调用。 */
  levelUp(): void {
    this.level += 1;
    eventBus.emit(EventNames.on_player_levelup, this.level);
  }

  setLayer(layer: number): void {
    this.layer = layer;
    eventBus.emit(EventNames.on_layer_start, layer);
  }

  /** 暂停局内逻辑（升级选卡）：只冻结玩法层，UI 与事件总线不受影响。 */
  pauseRun(): void {
    if (!this.runActive || this.paused) return;
    this.paused = true;
    eventBus.emit(EventNames.on_game_pause);
  }

  /** 恢复局内逻辑（选卡完成后）。 */
  resumeRun(): void {
    if (!this.paused) return;
    this.paused = false;
    eventBus.emit(EventNames.on_game_resume);
  }

  /**
   * 结束本局：无论死亡、通关还是主动退出，都保证恰好广播一次 on_run_end。
   * `reason` 供结算面板判断是否展示（主动退出 `suspend` 不弹结算）。
   */
  endRun(reason: 'death' | 'clear' | 'suspend' = 'death'): void {
    this.clearDot(); // 结算：停止烧伤结算循环

    this.runActive = false;
    this.paused = false;
    this.manualPaused = false;
    this.endReason = reason;
    eventBus.emit(EventNames.on_run_end, reason);
  }

  /** 本局结束原因（结算面板 / 界面流转据此分流）。 */
  getEndReason(): 'death' | 'clear' | 'suspend' { return this.endReason; }
}

export const gameState = new GameState();

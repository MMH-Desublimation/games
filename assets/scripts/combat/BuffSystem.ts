import { dataManager } from '../data/DataManager';
import { gameState, StatEffect, STAT_KIND_MAP } from '../core/GameState';
import { metaState } from '../core/MetaState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { ticker } from '../core/Ticker';
import { Random } from '../utils/Random';

/**
 * Buff 系统（系统层）：升级检测 -> 发放候选 -> 应用所选 buff。
 * 数值结算逻辑留在 core（GameState 单一状态源），本类只做翻译与编排。
 */
class BuffSystem {
  private rng = new Random(1);
  private offered: string[] = [];
  private offerCount = 3;
  private expBase = 5;
  private expGrowth = 1.15;
  /** 「百分比自动回血」结算周期（秒，来自 balance.combat.hp_regen_interval_ms）。 */
  private regenIntervalSec = 1;
  private regenAccumSec = 0;

  constructor() {
    this.rng = new Random((Date.now() >>> 0) || 1);
    eventBus.on(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.on(EventNames.on_exp_gained, this.onExpGained, this);
    // UI 选择后经事件总线请求应用（宪法 6.4：跨模块通信走事件总线）
    eventBus.on(EventNames.on_buff_pick_requested, this.onPickRequested, this);
    // 续玩：恢复存档中已选的局内 Buff 效果
    eventBus.on(EventNames.on_run_resume, this.onRunResume, this);
    ticker.add(this.tick);
  }

  /**
   * 逐帧驱动：按职业的「每秒回血（%最大生命）」结算自然回复（文档 3.3 `hp_regen_per_sec`）。
   * 累计到结算周期才回一次，避免逐帧发血量事件（宪法 6.10：不在高频逻辑里制造抖动）。
   * 暂停（升级选卡）/ 结算 / 死亡时冻结；回血数值取自 GameState 快照（含 hp_regen_up 类 Buff）。
   */
  private tick = (dt: number): void => {
    if (!gameState.isRunActive() || !gameState.isAlive() || gameState.isPaused()) {
      return;
    }
    this.regenAccumSec += dt;
    if (this.regenAccumSec < this.regenIntervalSec) {
      return;
    }
    this.regenAccumSec = 0;
    const stats = gameState.getStats();
    const amount = stats.maxHp * stats.hpRegenPerSecRatio;
    if (amount > 0) {
      gameState.heal(amount);
    }
  };

  /** UI 请求应用所选 buff。 */
  private onPickRequested(id: string): void {
    this.applyBuff(id);
  }

  /** 配置就绪后读取升级曲线与候选数量（不硬编码）。 */
  private onConfigLoaded(): void {
    const bal = dataManager.getTable<any>('balance');
    if (bal.buff && typeof bal.buff.offer_count === 'number') {
      this.offerCount = bal.buff.offer_count;
    }
    const combat = bal.combat;
    if (combat && combat.hp_regen_interval_ms > 0) {
      this.regenIntervalSec = combat.hp_regen_interval_ms / 1000;
    }
    const ec = dataManager.getTable<any>('exp_curve');
    this.expBase = ec.base_exp;
    this.expGrowth = ec.exp_growth;
  }

  /** 经验变化后检查是否升级（升级曲线：base_exp × exp_growth^(level-1)）。 */
  private onExpGained(): void {
    if (!gameState.isRunActive() || !gameState.isAlive()) return;
    // 已有待选择的候选时暂缓结算，选完再继续（避免 UI 叠多个选择框）
    if (this.offered.length > 0) return;
    let leveled = false;
    while (gameState.getExp() >= this.threshold(gameState.getLevel())) {
      gameState.levelUp();
      leveled = true;
    }
    if (leveled) this.offer();
  }

  private threshold(level: number): number {
    return this.expBase * Math.pow(this.expGrowth, level - 1);
  }

  /** 发放 N 选 1 候选（UI 监听 on_buff_offered 展示，选择后回调 applyBuff）。 */
  private offer(): void {
    this.offered = this.rollChoices(this.rng, this.offerCount);
    eventBus.emit(EventNames.on_buff_offered, this.offered);
  }

  /**
   * 行为型 Buff 的「同时携带上限」（文档 2.8「额外 Buff 槽位由局外养成解锁」）。
   * = `balance.buff.carry_slots_base` + (局外槽位数 − 1)；未解锁时即基数（默认 3）。
   */
  private carrySlotsLimit(): number {
    // 局外当前上限（基础 = balance.buff.carry_slots_base，解锁项把上限推到 carry_slots_max）
    return Math.max(1, metaState.getBuffSlots());
  }

  /**
   * 属性 / 技能类强化的叠加上限：
   * 全局默认取 `balance.buff.stat_stack_max`，条目可通过 `max_stack` 单独覆盖。
   */
  private stackMaxOf(def: any): number {
    if (typeof def.max_stack === 'number' && def.max_stack > 0) {
      return Math.round(def.max_stack);
    }
    const cfg = dataManager.get<any>('balance', 'buff');
    return Math.max(1, Math.round(cfg.stat_stack_max ?? 1));
  }

  /**
   * 「技能型 Buff」（周期释放类，如沙旋风 / 雷电）的**独立**携带上限。
   * 用户裁决：不占用行为型槽位，单独计数（`balance.buff.behavior_skill_slots`）。
   */
  private skillSlotsLimit(): number {
    return Math.max(1, metaState.getBehaviorSkillSlots());
  }

  /** 查某 Buff 的类型（buffs 为数组表，按 id 查找）。 */
  private buffTypeOf(id: string): string {
    try {
      return dataManager.get<any>('buffs', id)?.type ?? '';
    } catch {
      return '';
    }
  }

  /** 应用玩家所选 buff（校验必须在本次候选内，防外部随意调用）。 */
  applyBuff(id: string): void {
    if (this.offered.length > 0 && !this.offered.includes(id)) return;
    const all = dataManager.isLoaded('buffs') ? dataManager.getTable<any[]>('buffs') : [];
    const buff = all.find((b) => b.id === id);
    if (!buff) {
      console.error('[BuffSystem] 未知 buff:', id);
      return;
    }

    // —— 技能型 Buff（周期释放类）：重复获得即**升级**（不占新槽位、不重复登记效果）——
    if (buff.type === 'skill_behavior') {
      const level = gameState.getBuffLevel(id);
      const maxLevel = Array.isArray(buff.levels) ? buff.levels.length : 0;
      if (level > 0) {
        if (level >= maxLevel) {
          console.log(`[BuffSystem] 「${buff.name}」已满级（Lv${maxLevel}），本次提升无额外效果`);
          this.offered = [];
          return;
        }
        gameState.addBuff(id); // 层数即等级（存档仍为字符串数组，天然兼容）
        console.log(`[BuffSystem] 「${buff.name}」升级至 Lv${level + 1}/${maxLevel}`);
        this.offered = [];
        return;
      }
      const limit = this.skillSlotsLimit();
      const carried = this.carriedIds('skill_behavior');
      // 用户口径：**替换时继承等级** —— 被替换者 Lv3，则新技能直接 Lv3（不因"换了技能"而白丢等级）
      let inheritLevel = 1;
      if (carried.length >= limit) {
        const oldest = carried[0];
        inheritLevel = Math.min(maxLevel, Math.max(1, gameState.getBuffLevel(oldest)));
        this.removeBuffCompletely(oldest);
        console.log(`[BuffSystem] 技能型 Buff 已达携带上限 ${limit}，替换「${oldest}」→`
          + ` 新技能继承 Lv${inheritLevel}`);
      }
      for (let i = 0; i < inheritLevel; i++) {
        gameState.addBuff(id); // 层数即等级
      }
      console.log(`[BuffSystem] 获得技能型 Buff「${buff.name}」Lv${inheritLevel}/${maxLevel}`);
      this.offered = [];
      return;
    }

    // —— 属性 / 技能类强化：不占槽位，但受**叠加上限**约束（用户裁决）——
    if (buff.type === 'stat' || buff.type === 'skill') {
      const maxStack = this.stackMaxOf(buff);
      const level = gameState.getBuffLevel(id);
      if (level >= maxStack) {
        console.log(`[BuffSystem] 「${buff.name}」已达叠加上限（${maxStack} 层），本次无额外效果`);
        this.offered = [];
        return;
      }
      this.applyBuffEffects(id);
      if (level > 0) {
        console.log(`[BuffSystem] 「${buff.name}」叠加至 ${level + 1}/${maxStack} 层`);
      }
      this.offered = [];
      return;
    }

    // —— 行为型 Buff：受「同时携带上限」约束（与技能型独立计数）——
    if (buff.type === 'behavior') {
      const limit = this.carrySlotsLimit();
      const carried = this.carriedIds('behavior');
      if (carried.length >= limit) {
        const oldest = carried[0];
        this.removeBuffCompletely(oldest);
        console.log(`[BuffSystem] 行为型 Buff 已达携带上限 ${limit}，替换最早携带的「${oldest}」`);
      }
    }
    this.applyBuffEffects(id);
    this.offered = [];
  }

  /** 携带中的某类型 Buff id 列表（去重，保持首次携带顺序）。 */
  private carriedIds(type: string): string[] {
    const out: string[] = [];
    for (const id of gameState.getBuffs()) {
      if (this.buffTypeOf(id) === type && out.indexOf(id) < 0) {
        out.push(id);
      }
    }
    return out;
  }

  /** 彻底移除某 Buff 的全部层数（携带上限替换时使用）。 */
  private removeBuffCompletely(id: string): void {
    while (gameState.getBuffs().indexOf(id) >= 0) {
      gameState.removeBuff(id);
    }
  }

  /**
   * 应用某 Buff 的全部效果并登记携带（不校验候选、不处理携带槽位）。
   * 供「正常选择」与「续玩重放存档中的已选 Buff」共用。
   */
  private applyBuffEffects(id: string): void {
    // 用查表替代 dataManager.get：存档可能携带已下线的 Buff（如「经验磁场」），跳过而不是抛错
    const all = dataManager.isLoaded('buffs') ? dataManager.getTable<any[]>('buffs') : [];
    const buff = all.find((b) => b.id === id);
    if (!buff) {
      console.warn(`[BuffSystem] 忽略未知 Buff（可能已下线）: ${id}`);
      return;
    }
    gameState.addBuff(id); // 内部广播 on_buff_selected（UI 反馈）
    // 技能型 Buff 的数值由 BehaviorSkillSystem 按 levels 读取，不走系数通道
    if (buff.type === 'skill_behavior') {
      return;
    }
    if (!Array.isArray(buff.effects)) {
      return;
    }
    for (const e of buff.effects) {
      const slot = typeof e.slot === 'number' ? e.slot : 0;
      const statKind = STAT_KIND_MAP[e.kind];
      if (statKind && typeof e.ratio === 'number') {
        // 属性类：走属性快照（天然受 attr_cap / percent_buff_cap 约束）
        // 局外「局内Buff数值」增幅：按倍率放大本次 Buff 的百分比效果（阶段 3 growth 类）
        const value = e.ratio * (1 + gameState.getMetaBonus('buff_value_up'));
        gameState.applyEffect({ kind: statKind, op: 'add_percent', value } as StatEffect, id);
        continue;
      }
      // 非属性类（技能类 / 行为类）：统一登记为「增幅系数」，由各消费方经
      // `getBonus()` / `getBuffBonus(kind, slot)` 读取。
      // 说明：此前这里只特判了穿透，其余（7 个技能类 + 13 个行为类）效果被**静默丢弃**，
      // 表现为「选了 Buff 却完全没有效果」；统一登记后，凡已接入消费方的效果立即生效。
      const value = typeof e.ratio === 'number' ? e.ratio
        : (typeof e.value === 'number' ? e.value
          : (typeof e.count === 'number' ? e.count : 1));
      gameState.addBuffBonus(e.kind, value, id, slot);
      // 复杂机制的附加参数（灼烧时长 / 冰缓概率 / 光环半径…）以 `kind.参数名` 一并登记，
      // 使后续实现机制时不必再改数据层。
      for (const key of ['ratio', 'duration_ms', 'chance', 'dps_ratio', 'range_px']) {
        if (typeof (e as any)[key] === 'number') {
          gameState.addBuffBonus(`${e.kind}.${key}`, (e as any)[key], id, slot);
        }
      }
    }
  }

  /** 续玩：重放存档中已选 Buff 的效果（`on_run_resume` 携带快照）。 */
  private onRunResume(snapshot: { buffs?: string[] }): void {
    const ids = snapshot && Array.isArray(snapshot.buffs) ? snapshot.buffs : [];
    for (const id of ids) {
      this.applyBuffEffects(id);
    }
    if (ids.length > 0) {
      console.log(`[BuffSystem] 续玩：已重放 ${ids.length} 个局内 Buff`);
    }
  }

  /** N 选 1：按权重抽取 count 个不重复 buff id（读整张 buffs 数组表）。 */
  rollChoices(rng: Random, count: number): string[] {
    const all = dataManager.getTable<any[]>('buffs');
    const poolIds = all.map((b) => b.id);
    const poolW = all.map((b) => b.weight ?? 1);
    const out: string[] = [];
    for (let i = 0; i < count && poolIds.length > 0; i++) {
      const chosen = rng.weightedPick(poolIds, poolW);
      out.push(chosen);
      const idx = poolIds.indexOf(chosen);
      poolIds.splice(idx, 1);
      poolW.splice(idx, 1);
    }
    return out;
  }
}

export const buffSystem = new BuffSystem();

import { dataManager } from '../data/DataManager';
import { eventBus } from './EventBus';
import { EventNames } from './EventNames';
// 仅类型引用（编译后擦除），不会形成运行时循环依赖
import type { RunMode } from './GameState';

/**
 * 局内快照（存档文档 5.1 的 `progress.current_run`；不存地宫布局，只存必要进度）。
 * 定义在此处：`progress` 由本类持有，而 `GameState` 只需要按类型读写（避免 core ↔ save 反向依赖）。
 */
export interface RunSnapshot {
  classId: string;
  /** 本局模式（文档 2.6）：旧档缺省视为本体 `base`。 */
  mode?: RunMode;
  layer: number;
  hp: number;
  exp: number;
  level: number;
  gold: number;
  kills: number;
  /** 本局已入账局外的金币水位（避免重开重复入账）。 */
  bankedGold: number;
  /** 已选 Buff 的 id 列表（恢复时由 BuffSystem 重放效果）。 */
  buffs: string[];
}

/** 局外养成数据（存档 data.meta）。 */
export interface MetaSave {
  levels: Record<string, number>;
  unlockedClasses: string[];
  /** 行为型 Buff 的同时携带上限（基础取 balance.buff.carry_slots_base，局外可解锁到 carry_slots_max）。 */
  buffSlots: number;
  /** 技能型 Buff 的同时携带上限（独立计数；基础取 balance.buff.behavior_skill_slots，上限 behavior_skill_slots_max）。 */
  behaviorSkillSlots: number;
  /** 局内道具框格数（文档 2.10：1–3 格由局外解锁；基础取 balance.item.slots_base，上限 slots_max）。 */
  itemSlots: number;
  gold: number;
}

/** 进度数据（存档 data.progress；文档 5.1 `base_cleared` 即终局解锁标记）。 */
export interface ProgressSave {
  maxLayerCleared: number;
  /** 本体是否已通关（文档 5.1 `base_cleared`）：为真时解锁终局双模式。 */
  baseCleared: boolean;
  /** 终局·普通地图到达过的最深层数。 */
  normalBestLayer: number;
  /** 终局·挑战地图到达过的最深层数（卡关点观测指标，文档 7.6 验收 20–30 层）。 */
  challengeBestLayer: number;
  currentRun: RunSnapshot | null;
}

/** 统计数据（存档 data.stats）。 */
export interface StatsSave {
  totalRuns: number;
  totalKills: number;
}

/**
 * 跨局持久状态源（局外养成 + 进度 + 统计；存档 data 的内存镜像）。
 *
 * 规则（项目宪法 5 / 6.4）：本类只负责内存状态与读写方法；
 * 序列化与落盘（localStorage）统一由 save/SaveManager 处理，禁止在此直接读写存档。
 * 规则（宪法 6.4）：状态变更只能经方法，变更后广播 `on_meta_upgraded`（由 SaveManager 落盘、UI 刷新）。
 *
 * 计价与上限全部来自配置：`meta.json`（`max_level` / `price_multiplier` / `fixed_price`）
 * + `balance.meta_price`（`base_price` / `price_growth`），本类不出现任何游戏数值（宪法 6.7）。
 */
class MetaState {
  private levels: Record<string, number> = {};
  private unlockedClasses: string[] = ['warrior'];
  private buffSlots = 4;
  private behaviorSkillSlots = 3;
  /** 局内道具框格数（文档 2.10；上限与基础值全部来自 balance.item）。 */
  private itemSlots = 1;
  /** 局外金币（文档 2.1：局外资源，永久保留；结算时由流程层入账）。 */
  private gold = 0;

  // —— 进度与统计（文档 5.1 data.progress / data.stats）——
  private maxLayerCleared = 0;
  /** 本体是否已通关（终局解锁标记，文档 5.1 `base_cleared`）。 */
  private baseCleared = false;
  /** 终局各模式到达过的最深层数。 */
  private normalBestLayer = 0;
  private challengeBestLayer = 0;
  private currentRun: RunSnapshot | null = null;
  private totalRuns = 0;
  private totalKills = 0;

  /**
   * 由 SaveManager 在读取存档后调用，恢复内存状态。
   * 兼容两种形状：结构化 `{ meta, progress, stats }`（v3）与旧版「仅 meta 对象」。
   */
  loadFrom(data: any): void {
    const meta: Partial<MetaSave> = data && data.meta ? data.meta : (data ?? {});
    this.levels = meta.levels ?? {};
    this.unlockedClasses = meta.unlockedClasses ?? ['warrior'];
    // 槽位：以配置基数为下限（旧档里的 1~3 会被抬到新的基础值，避免"升级后反而变少"）
    const cfg = this.buffConfig();
    const carryBase = cfg.carry_slots_base ?? this.buffSlots;
    const skillBase = cfg.behavior_skill_slots ?? this.behaviorSkillSlots;
    this.buffSlots = Math.max(carryBase, meta.buffSlots ?? carryBase);
    this.behaviorSkillSlots = Math.max(skillBase, meta.behaviorSkillSlots ?? skillBase);
    const itemBase = this.itemConfig().slots_base ?? this.itemSlots;
    this.itemSlots = Math.max(itemBase, meta.itemSlots ?? itemBase);
    this.gold = meta.gold ?? 0;

    const progress: Partial<ProgressSave> = (data && data.progress) ?? {};
    this.maxLayerCleared = progress.maxLayerCleared ?? 0;
    // 终局字段：旧档（v3 及以前）没有 → 默认未解锁 / 0 层（迁移函数同时兜底）
    this.baseCleared = progress.baseCleared === true;
    this.normalBestLayer = progress.normalBestLayer ?? 0;
    this.challengeBestLayer = progress.challengeBestLayer ?? 0;
    this.currentRun = progress.currentRun ?? null;

    const stats: Partial<StatsSave> = (data && data.stats) ?? {};
    this.totalRuns = stats.totalRuns ?? 0;
    this.totalKills = stats.totalKills ?? 0;
  }

  /** 由 SaveManager 在落盘前调用，导出可序列化对象（= 存档 data 字段）。 */
  toSave(): { meta: MetaSave; progress: ProgressSave; stats: StatsSave } {
    return {
      meta: {
        levels: this.levels,
        unlockedClasses: this.unlockedClasses,
        buffSlots: this.buffSlots,
        behaviorSkillSlots: this.behaviorSkillSlots,
        itemSlots: this.itemSlots,
        gold: this.gold,
      },
      progress: {
        maxLayerCleared: this.maxLayerCleared,
        baseCleared: this.baseCleared,
        normalBestLayer: this.normalBestLayer,
        challengeBestLayer: this.challengeBestLayer,
        currentRun: this.currentRun,
      },
      stats: {
        totalRuns: this.totalRuns,
        totalKills: this.totalKills,
      },
    };
  }

  /** 新建档 / 清档：重置全部跨局数据（槽位回到配置基数）。 */
  resetAll(): void {
    const cfg = this.buffConfig();
    this.levels = {};
    this.unlockedClasses = ['warrior'];
    this.buffSlots = cfg.carry_slots_base ?? this.buffSlots;
    this.behaviorSkillSlots = cfg.behavior_skill_slots ?? this.behaviorSkillSlots;
    this.itemSlots = this.itemConfig().slots_base ?? this.itemSlots;
    this.gold = 0;
    this.maxLayerCleared = 0;
    this.baseCleared = false;
    this.normalBestLayer = 0;
    this.challengeBestLayer = 0;
    this.currentRun = null;
    this.totalRuns = 0;
    this.totalKills = 0;
  }

  // —— 金币 ——

  getGold(): number {
    return this.gold;
  }

  /** 入账局外金币（结算获得；禁止外部直接赋值，宪法 6.4）。 */
  addGold(amount: number): void {
    if (!(amount > 0)) return;
    this.gold += Math.floor(amount);
  }

  // —— 进度 / 统计 ——

  getMaxLayerCleared(): number {
    return this.maxLayerCleared;
  }

  /** 记录到达过的最深层数。 */
  noteLayerCleared(layer: number): void {
    if (layer > this.maxLayerCleared) {
      this.maxLayerCleared = layer;
    }
  }

  /** 未完成一局的快照（无则为 null）。 */
  getCurrentRun(): RunSnapshot | null {
    return this.currentRun;
  }

  setCurrentRun(snapshot: RunSnapshot | null): void {
    this.currentRun = snapshot;
  }

  clearCurrentRun(): void {
    this.currentRun = null;
  }

  // —— 终局进度（文档 2.6 / 7.6 阶段 4）——

  /** 本体是否已通关。 */
  isBaseCleared(): boolean {
    return this.baseCleared;
  }

  /** 记录本体通关（解锁终局；由流程层在通关时调用）。 */
  noteBaseCleared(): void {
    this.baseCleared = true;
  }

  /** 各模式到达过的最深层数（`base` 复用 `maxLayerCleared`）。 */
  getBestLayer(mode: RunMode): number {
    if (mode === 'challenge') {
      return this.challengeBestLayer;
    }
    if (mode === 'normal') {
      return this.normalBestLayer;
    }
    return this.maxLayerCleared;
  }

  /** 记录某模式到达过的层数（挑战地图用于观测卡关点，文档 7.6）。 */
  noteModeLayer(mode: RunMode, layer: number): void {
    if (mode === 'challenge') {
      if (layer > this.challengeBestLayer) {
        this.challengeBestLayer = layer;
      }
    } else if (mode === 'normal') {
      if (layer > this.normalBestLayer) {
        this.normalBestLayer = layer;
      }
    } else {
      this.noteLayerCleared(layer);
    }
  }

  getTotalRuns(): number {
    return this.totalRuns;
  }

  getTotalKills(): number {
    return this.totalKills;
  }

  /** 本局结束时累计统计。 */
  noteRunFinished(kills: number): void {
    this.totalRuns += 1;
    this.totalKills += Math.max(0, Math.floor(kills));
  }

  // —— 局外养成：查询与购买（阶段 3：文档 2.9 / 3.9）——

  /** meta.json 中的养成项定义（未加载配置时返回 null）。 */
  private getItem(id: string): any | null {
    if (!dataManager.isLoaded('meta')) {
      return null;
    }
    try {
      return dataManager.get<any>('meta', id);
    } catch {
      return null;
    }
  }

  /** 该养成项是否启用（meta.json.enabled，缺省 true；未启用的项不展示、不可购买、不参与结算）。 */
  isEnabled(id: string): boolean {
    const item = this.getItem(id);
    return !!item && item.enabled !== false;
  }

  /** 该项的等级上限（meta.json.max_level；未启用返回 0）。 */
  getMaxLevel(id: string): number {
    const item = this.getItem(id);
    return item && item.enabled !== false ? item.max_level : 0;
  }

  /** 是否已满级。 */
  isMaxed(id: string): boolean {
    const max = this.getMaxLevel(id);
    return max > 0 && this.getLevel(id) >= max;
  }

  /**
   * 下一级价格：
   *  - 配置了 `fixed_price` 的项目（解锁类）直接用固定价；
   *  - 其余 = floor(base_price × price_growth^当前等级 × price_multiplier)（文档 3.9 公式）。
   */
  getUpgradeCost(id: string): number {
    const item = this.getItem(id);
    if (!item || !dataManager.isLoaded('balance')) {
      return 0;
    }
    if (typeof item.fixed_price === 'number') {
      return Math.max(0, Math.floor(item.fixed_price));
    }
    const price = dataManager.get<any>('balance', 'meta_price');
    const multiplier = item.price_multiplier ?? 1;
    const level = this.getLevel(id);
    return Math.floor(price.base_price * Math.pow(price.price_growth, level) * multiplier);
  }

  /** 是否可购买（已启用、未满级且金币足够）。 */
  canUpgrade(id: string): boolean {
    if (!this.isEnabled(id) || this.isMaxed(id)) {
      return false;
    }
    const cost = this.getUpgradeCost(id);
    return cost > 0 && this.gold >= cost;
  }

  /** 当前等级的累计花费（结算/展示用，不影响状态）。 */
  getSpentGold(id: string): number {
    const item = this.getItem(id);
    if (!item || !dataManager.isLoaded('balance')) {
      return 0;
    }
    const level = this.getLevel(id);
    if (typeof item.fixed_price === 'number') {
      return Math.max(0, Math.floor(item.fixed_price)) * level;
    }
    const price = dataManager.get<any>('balance', 'meta_price');
    const multiplier = item.price_multiplier ?? 1;
    let total = 0;
    for (let lv = 0; lv < level; lv++) {
      total += Math.floor(price.base_price * Math.pow(price.price_growth, lv) * multiplier);
    }
    return total;
  }

  /**
   * 购买一级局外养成：校验上限与金币 → 扣款 → 提升等级 → 应用解锁类效果 → 广播 on_meta_upgraded。
   * @returns 是否购买成功（失败不改变任何状态）
   */
  purchaseUpgrade(id: string): boolean {
    if (!this.canUpgrade(id)) {
      return false;
    }
    const item = this.getItem(id);
    if (!item) {
      return false;
    }
    const cost = this.getUpgradeCost(id);
    this.gold -= cost;
    this.levels[id] = this.getLevel(id) + 1;
    // 解锁类效果在此应用（职业解锁 / 额外 Buff 槽位）
    const effect = item.effect;
    if (effect && effect.kind === 'unlock_class' && typeof effect.value === 'string') {
      this.unlockClass(effect.value);
    } else if (effect && effect.kind === 'buff_slot' && typeof effect.value === 'number') {
      this.setBuffSlots(effect.value);
    } else if (effect && effect.kind === 'behavior_skill_slot' && typeof effect.value === 'number') {
      this.setBehaviorSkillSlots(effect.value);
    } else if (effect && effect.kind === 'item_slot' && typeof effect.value === 'number') {
      // 道具框格数解锁（文档 2.10：1–3 格）
      this.setItemSlots(effect.value);
    }
    eventBus.emit(EventNames.on_meta_upgraded, id);
    return true;
  }

  getLevel(id: string): number {
    return this.levels[id] ?? 0;
  }

  setUpgrade(id: string, level: number): void {
    this.levels[id] = level;
  }

  isClassUnlocked(classId: string): boolean {
    return this.unlockedClasses.includes(classId);
  }

  unlockClass(classId: string): void {
    if (!this.unlockedClasses.includes(classId)) {
      this.unlockedClasses.push(classId);
    }
  }

  getBuffSlots(): number {
    return this.buffSlots;
  }

  setBuffSlots(n: number): void {
    this.buffSlots = n;
  }

  /** 局内道具框格数（文档 2.10）。 */
  getItemSlots(): number {
    return this.itemSlots;
  }

  /** 设置道具框格数（按 balance.item.slots_max 收敛）。 */
  setItemSlots(n: number): void {
    const max = this.itemConfig().slots_max ?? 3;
    this.itemSlots = Math.max(1, Math.min(max, Math.round(n)));
  }

  /** 道具配置（balance.item：基础格数 / 上限）。 */
  private itemConfig(): any {
    return dataManager.isLoaded('balance')
      ? ((dataManager.getTable<any>('balance') as any).item ?? {})
      : {};
  }

  /** 技能型 Buff 的同时携带上限（独立计数，不占用行为型槽位）。 */
  getBehaviorSkillSlots(): number {
    return this.behaviorSkillSlots;
  }

  setBehaviorSkillSlots(n: number): void {
    this.behaviorSkillSlots = n;
  }

  /** `balance.buff` 配置（槽位基数 / 上限；配置未就绪时返回空对象走保守默认）。 */
  private buffConfig(): any {
    if (!dataManager.isLoaded('balance')) {
      return {};
    }
    return dataManager.getTable<any>('balance').buff ?? {};
  }
}

export const metaState = new MetaState();

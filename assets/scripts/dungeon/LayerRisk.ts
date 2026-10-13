import { dataManager } from '../data/DataManager';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { ticker } from '../core/Ticker';
import { endgameRules } from './EndgameRules';

/**
 * 层内风险递增节奏系统（dungeon 系统层，文档 2.4 三机制 / 文档 3.7 公式）。
 *
 * 三机制（必须同时生效）：
 *  1) 时间压力：`time_factor = min(1 + step_ratio × ⌊停留秒数 / interval_s⌋, max)`，
 *     作用于本层怪物的 HP / ATK（文档 3.6，由实体层在建怪时作为入参取走）。
 *  2) 猎杀者：本层首个在 `hunter.first_delay_s` 后刷新，其后间隔
 *     `max(interval_base_s − layer, interval_min_s)` 递减（文档 3.7）；本系统只发「请求生成」事件，
 *     实际节点生成由 entities 层负责（宪法 6.13：模块间不直接引用实例通信）。
 *  3) 收益软上限 / 提前离开：金币与经验掉落乘 `max(min_ratio, 1 − decay_ratio × ⌊停留秒数 / interval_s⌋)`
 *     （写入 GameState，由 addExp / addGold 统一施加）；层结算时按
 *     `min(cap, 1 + bonus_per_interval × ⌊未使用的风险时间 / interval_s⌋)` 发放层结算奖励，
 *     其中「未使用的风险时间 = recommended_layer_s − 本层实际停留秒数」（口径见交接包裁决：窗口可配）。
 *
 * 生命周期：模块级单例，逐帧逻辑经 core/ticker 驱动（与 DungeonSystem 同模式）。
 *  - 暂停（升级选卡）与结算必须冻结计时：tick 内检查 isRunActive / isPaused / isAlive。
 *  - 换层重置点：`on_dungeon_built`（同时重置计时、三机制倍率与猎杀者倒计时）。
 *  - 结算点：`on_exit_reached`（须早于 RunFlow 订阅，故由 RunFlow 顶部副作用引入本模块）。
 *
 * 规则：所有数值取自 balance.json，本文件不出现任何游戏数值（宪法 6.7 / 6.13）。
 */
class LayerRisk {
  // —— 配置（on_config_loaded 后填充，禁止硬编码）——
  private intervalSec = 0;
  private stepRatio = 0;
  private maxFactor = 1;
  private decayRatio = 0;
  private minRatio = 1;
  private bonusPerInterval = 0;
  private bonusCap = 1;
  private recommendedLayerSec = 0;
  private hunterFirstDelaySec = 0;
  private hunterIntervalBaseSec = 0;
  private hunterIntervalMinSec = 0;

  // —— 本层运行时状态 ——
  private elapsedSec = 0;
  private timeFactor = 1;
  private rewardMultiplier = 1;
  private earlyLeaveMultiplier = 1;
  private hunterCountdownSec = 0;
  /** 本层开始时玩家金币快照（层结算奖励以「本层掉落金币」为基数）。 */
  private layerGoldStart = 0;
  /** 已发布的区间序号（避免每帧重算与重复广播）。 */
  private publishedIntervalIndex = -1;
  /** 是否处于「本层进行中」（换层重置 / 层结算 / 本局结束后为 false）。 */
  private layerActive = false;
  private configReady = false;

  constructor() {
    eventBus.on(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
    eventBus.on(EventNames.on_dungeon_built, this.onDungeonBuilt, this);
    eventBus.on(EventNames.on_exit_reached, this.onExitReached, this);
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);
    ticker.add(this.tick);
  }

  // —— 只读查询（供实体层 / 视图层取层内风险系数）——

  /** 本层当前时间压力系数（作用于怪物 HP / ATK）。 */
  getTimeFactor(): number { return this.timeFactor; }

  /** 本层当前收益软上限倍率（0~1）。 */
  getRewardMultiplier(): number { return this.rewardMultiplier; }

  /** 本层当前提前离开奖励倍率（1~cap）。 */
  getEarlyLeaveMultiplier(): number { return this.earlyLeaveMultiplier; }

  /** 本层已停留秒数（调试 / 试玩核对用）。 */
  getElapsedSec(): number { return this.elapsedSec; }

  // —— 配置与生命周期 ——

  private onConfigLoaded(): void {
    const timePressure = dataManager.get<any>('balance', 'time_pressure');
    const softcap = dataManager.get<any>('balance', 'reward_softcap');
    const earlyLeave = dataManager.get<any>('balance', 'early_leave_bonus');
    const hunter = dataManager.get<any>('balance', 'hunter');
    this.intervalSec = timePressure.interval_s;
    this.stepRatio = timePressure.step_ratio;
    this.maxFactor = timePressure.max;
    this.decayRatio = softcap.decay_ratio;
    this.minRatio = softcap.min_ratio;
    this.bonusPerInterval = earlyLeave.bonus_per_interval;
    this.bonusCap = earlyLeave.cap;
    this.recommendedLayerSec = earlyLeave.recommended_layer_s;
    this.hunterFirstDelaySec = hunter.first_delay_s;
    this.hunterIntervalBaseSec = hunter.interval_base_s;
    this.hunterIntervalMinSec = hunter.interval_min_s;
    this.configReady = true;
  }

  /** 开局：重置整局风险状态（换层重置在 on_dungeon_built 内完成）。 */
  private onRunStart(): void {
    this.resetLayerState();
    this.layerActive = false;
  }

  /** 新一层地宫：以本层为起点重置计时、三机制倍率与猎杀者倒计时。 */
  private onDungeonBuilt(): void {
    this.resetLayerState();
    this.layerActive = true;
  }

  /** 本局结束（死亡 / 通关）：停止计时，避免结算界面仍在累计停留时间。 */
  private onRunEnd(): void {
    this.layerActive = false;
  }

  private resetLayerState(): void {
    this.elapsedSec = 0;
    this.timeFactor = 1;
    this.rewardMultiplier = 1;
    this.earlyLeaveMultiplier = this.bonusCap; // 停留 0 秒即最大奖励（上限 cap）
    this.hunterCountdownSec = this.hunterFirstDelaySec;
    this.publishedIntervalIndex = -1;
    this.layerGoldStart = gameState.getGold();
    gameState.setLayerRewardMultiplier(1);
  }

  /**
   * 逐帧推进。暂停 / 结算 / 死亡时整体冻结（文档 2.4：暂停不得继续累计风险）。
   * dt 采用真实秒（与 core/Timer 一致）：停留时间按墙钟计，不因掉帧变慢。
   */
  private tick = (dt: number): void => {
    if (!this.configReady || !this.layerActive) return;
    if (!gameState.isRunActive() || gameState.isPaused() || !gameState.isAlive()) return;

    this.elapsedSec += dt;

    const intervalIndex = Math.floor(this.elapsedSec / this.intervalSec);
    if (intervalIndex !== this.publishedIntervalIndex) {
      this.publishedIntervalIndex = intervalIndex;
      this.recomputeMultipliers();
      gameState.setLayerRewardMultiplier(this.rewardMultiplier);
      // 供实体层刷新休眠怪物的层内加成（未接战的怪重算属性，不出现战斗中血量跳变）
      // 参数顺序必须与 Hud 一致：(时间压力, 收益软上限, 提前离开倍率, 本层停留秒数)
      eventBus.emit(
        EventNames.on_layer_risk_changed,
        this.timeFactor, this.rewardMultiplier, this.earlyLeaveMultiplier, this.elapsedSec,
      );
      console.log(
        `[LayerRisk] 第 ${gameState.getLayer()} 层停留 ${this.elapsedSec.toFixed(0)}s：`
        + `时间压力 ×${this.timeFactor.toFixed(2)}，收益 ×${this.rewardMultiplier.toFixed(2)}，`
        + `提前离开倍率 ×${this.earlyLeaveMultiplier.toFixed(2)}`,
      );
    }

    this.tickHunter(dt);
  };

  /** 按文档 3.7 重算三机制当前倍率。 */
  private recomputeMultipliers(): void {
    const intervalIndex = Math.floor(this.elapsedSec / this.intervalSec);
    this.timeFactor = Math.min(1 + this.stepRatio * intervalIndex, this.maxFactor);
    this.rewardMultiplier = Math.max(this.minRatio, 1 - this.decayRatio * intervalIndex);
    // 文档 2.6：「普通地图难度低、资源产出稳定」——终局两模式关闭层内收益软上限；
    // 本体保留软上限（鼓励及时推进，文档 3.7）。
    if (!endgameRules.softCapEnabled(gameState.getMode())) {
      this.rewardMultiplier = 1;
    }
    const unusedRiskSec = Math.max(0, this.recommendedLayerSec - this.elapsedSec);
    // 用 ceil 计「未使用风险时间」的档位：停留 0⁺ 秒时仍算满档（使 cap 真实可达，与
    // resetLayerState 的初值一致）；若用 floor，刚进层就会立刻丢一档（实测 1.50 → 1.45）。
    this.earlyLeaveMultiplier = Math.min(
      this.bonusCap,
      1 + this.bonusPerInterval * Math.ceil(unusedRiskSec / this.intervalSec),
    );
  }

  /** 猎杀者刷新调度：首个延迟 hunter.first_delay_s，其后间隔随层数递减至下限。 */
  private tickHunter(dt: number): void {
    this.hunterCountdownSec -= dt;
    if (this.hunterCountdownSec > 0) return;
    const layer = gameState.getLayer();
    this.hunterCountdownSec += Math.max(this.hunterIntervalBaseSec - layer, this.hunterIntervalMinSec);
    eventBus.emit(EventNames.on_hunter_spawn_requested, layer);
  }

  /**
   * 层结算（玩家抵达出口房）：发放提前离开奖励，结算基数 = 本层掉落金币。
   * 奖励口径：`floor(本层掉落金币 × (提前离开倍率 − 1))`。
   * 必须早于 RunFlow 处理 on_exit_reached，否则末层结算面板会读到未发放的值。
   */
  private onExitReached(): void {
    if (!this.configReady || !this.layerActive) return;
    this.layerActive = false;
    const layer = gameState.getLayer();
    const layerGold = Math.max(0, gameState.getGold() - this.layerGoldStart);
    const bonusGold = Math.floor(layerGold * (this.earlyLeaveMultiplier - 1));
    if (bonusGold > 0) {
      gameState.addBonusGold(bonusGold);
    }
    console.log(
      `[LayerRisk] 第 ${layer} 层结算：停留 ${this.elapsedSec.toFixed(1)}s，本层掉落金币 ${layerGold}，`
      + `提前离开倍率 ×${this.earlyLeaveMultiplier.toFixed(2)}，层结算奖励 +${bonusGold} 金币`,
    );
  }

}

export const layerRisk = new LayerRisk();

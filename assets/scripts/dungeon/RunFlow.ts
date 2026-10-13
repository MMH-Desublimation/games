import { gameState, RunMode } from '../core/GameState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { saveManager } from '../save/SaveManager';
import { metaState, RunSnapshot } from '../core/MetaState';
import { dungeonService } from './DungeonService';
import { endgameRules } from './EndgameRules';
// 副作用引入：层内风险节奏系统。必须早于本文件的 RunFlow 实例构造，
// 使其 on_exit_reached 订阅先于流程层，从而「层结算奖励」先于换层 / 结算面板生效。
import './LayerRisk';

/**
 * 关卡流程编排（系统层，项目宪法 6.2 / 文档 4.2：只管编排，不碰节点、不管战斗）。
 *
 * 流程（文档 2.2 / 2.3）：
 *   开局 -> 生成第 1 层地宫 -> 玩家逐房战斗 -> 抵达出口房 -> 下一层 -> …… -> 第 N 层出口 -> 结算。
 * 地宫的生成与校验交给 dungeon 模块的 DungeonService（纯逻辑层，同目录）。
 * 节点生成（敌人/Boss）交由 entities 监听房间进入事件完成。
 *
 * 订阅生命周期：本类为 App 级常驻系统，构造时即订阅，无需在场景销毁时取消。
 */
class RunFlow {
  /** 本局模式（`base` 本体 / `normal` 普通地图 / `challenge` 挑战地图，文档 2.6）。 */
  private mode: RunMode = 'base';
  /**
   * 本局层数上限（0 = 无限）。
   * 由 `endgame.json` 决定（本体有上限 → 打到最后一层即通关并解锁终局；终局两模式无限）。
   */
  private layersPerRun = 0;
  private currentLayer = 0;
  private runInProgress = false;
  /** 本局已入账局外的金币水位（避免重复入账；每小关结束与结算各同步一次）。 */
  private bankedGold = 0;

  constructor() {
    eventBus.on(EventNames.on_config_loaded, this.onConfigLoaded, this);
    // 开局：UI 只发「请求」，由本模块先初始化状态，**再**广播 on_run_start（见 on_run_start_requested 注释）
    eventBus.on(EventNames.on_run_start_requested, this.startRun, this);
    eventBus.on(EventNames.on_exit_reached, this.onExitReached, this);
    eventBus.on(EventNames.on_player_died, this.onPlayerDied, this);
    eventBus.on(EventNames.on_run_resume, this.resumeRun, this);
    eventBus.on(EventNames.on_pause_requested, this.togglePause, this);
    eventBus.on(EventNames.on_run_exit_requested, this.suspendRun, this);
  }

  /** 请求切换暂停（暂停按钮 / ESC）。只有局内进行中才响应。 */
  private togglePause(): void {
    if (!this.runInProgress || !gameState.isRunActive()) {
      return;
    }
    // 升级选卡进行中禁止手动暂停：否则选卡面板与暂停面板同时显示、互相叠字（实测问题）
    if (gameState.isUpgradePending()) {
      console.log('[RunFlow] 正在选择强化：忽略暂停请求');
      return;
    }
    const next = !gameState.isManualPaused();
    gameState.setManualPaused(next);
    eventBus.emit(EventNames.on_pause_changed, next);
    console.log(`[RunFlow] ${next ? '已暂停' : '已恢复'}本局`);
  }

  /**
   * 主动退出本局（暂停面板「退出到存档」）。
   * 语义：**保留本局进度**（写入 `progress.current_run`，可在存档界面「进入」继续），
   * 本局金币照常入账局外；以 `endRun('suspend')` 的原因分流，不弹结算面板。
   */
  private suspendRun(): void {
    if (!this.runInProgress) {
      return;
    }
    // 主动退出：全额入账（进度与收益都保留）。挑战地图的 50% 折扣只针对**失败**，
    // 不能惩罚「先停下、之后再继续」的正常操作；入账水位同步写进快照，续玩不会重复入账。
    this.bankRunGold();
    // 注意：不能走 persistRunProgress()，它会把「当前所在层」记成已通关层数
    const snapshot: RunSnapshot = gameState.snapshotRun();
    snapshot.bankedGold = this.bankedGold;
    metaState.setCurrentRun(snapshot);
    this.runInProgress = false;
    gameState.endRun('suspend');
    saveManager.save();
    console.log(`[RunFlow] 已退出到存档：进度保留在第 ${this.currentLayer} 层，可在存档界面继续`);
  }

  /** 配置就绪后读取兜底层数（模式在开局时才确定，故这里只记录本体的上限用于日志核对）。 */
  private onConfigLoaded(): void {
    this.layersPerRun = endgameRules.maxLayers(this.mode);
  }

  /**
   * 开始新的一局（响应 UI 的 `on_run_start_requested`）。
   *
   * 顺序至关重要：**先 `gameState.init()` 清空上一局状态（携带 Buff / 系数 / 技能临时增幅），
   * 再广播 `on_run_start`**。否则模块级单例（BehaviorSkillSystem 等）可能先于本模块收到事件，
   * 读到上一局的携带 Buff，表现为「新一局里上一局的技能型 Buff 仍在释放」。
   */
  private startRun(classId: string, mode: RunMode = 'base'): void {
    if (this.runInProgress) return;
    // 终局需本体通关后解锁（文档 2.6）；未解锁时按本体开局，避免绕过进度
    // （`endgame.unlock.require_base_clear = false` 可整体关闭该门槛，用于开发期验收）
    this.mode = endgameRules.isModeAvailable(mode, metaState.isBaseCleared()) ? mode : 'base';
    this.layersPerRun = endgameRules.maxLayers(this.mode);
    gameState.init(classId, this.mode);
    this.runInProgress = true;
    this.currentLayer = 0;
    this.bankedGold = 0;
    eventBus.emit(EventNames.on_run_start, classId);
    console.log(`[RunFlow] 开局：模式 ${endgameRules.nameOf(this.mode)}`
      + `（层数上限 ${this.layersPerRun > 0 ? this.layersPerRun : '无限'}）`);
    this.startLayer(1);
  }

  /**
   * 把本局「尚未入账」的金币同步进局外（文档 2.1：局外资源金币永久保留）。
   * 调用点：每小关结算时、本局结束时——因此每小关的落盘都包含该层已得收益，
   * 中途刷新/退出也不会把养成收益丢掉（文档 2.2「每小关结束自动存档」）。
   */
  private bankRunGold(keepRatio = 1): void {
    const total = gameState.getGold();
    const delta = total - this.bankedGold;
    if (delta <= 0) {
      return;
    }
    // `keepRatio < 1` 用于挑战地图失败结算（文档 2.6：失败保留 50% 收益）
    metaState.addGold(delta * keepRatio);
    this.bankedGold = total;
  }

  /**
   * 本模式是否「层间即时入账」。
   * 本体 / 普通地图：每小关结束即入账（进度安全，刷新不丢收益）。
   * 挑战地图：**本局结束才结算**（失败按 50% 入账，文档 2.6）——若层间就入账，"失败保留 50%" 将失去意义。
   * 主动退出（suspend）时金币随 `current_run` 快照保留，继续该局不受影响。
   */
  private banksPerLayer(): boolean {
    return this.mode !== 'challenge';
  }

  /** 进入第 layer 层：设置层状态、每小关自动存档，并广播本层地宫（视图/玩家/实体据此布点）。 */
  private startLayer(layer: number): void {
    this.currentLayer = layer;
    gameState.setLayer(layer);
    // 模式收益系数（文档 3.8：挑战地图单层收益 = 基础 × 1.12^层数；其余模式恒为 1）
    gameState.setModeRewardFactor(endgameRules.rewardFactor(this.mode, layer));
    // 每小关自动存档（文档 2.2 / 5.3，宪法 6.8：写入时机而非逐帧写）
    this.persistRunProgress();
    // 传入本局随机种子：同一层在不同局里布局不同（用户反馈"前几关地图基本一样"）
    eventBus.emit(EventNames.on_dungeon_built, dungeonService.generateLayer(layer, gameState.getRunSeed()));
  }

  /**
   * 写入当前进度并落盘：记录到达层数，并在局内进行中写入 `progress.current_run` 快照，
   * 使刷新页面后可从存档界面「继续」本局（文档 5.1：current_run 只在关卡间写入）。
   */
  private persistRunProgress(): void {
    metaState.noteModeLayer(this.mode, this.currentLayer);
    if (this.runInProgress) {
      const snapshot: RunSnapshot = gameState.snapshotRun();
      snapshot.bankedGold = this.bankedGold;
      metaState.setCurrentRun(snapshot);
    }
    saveManager.save();
  }

  /**
   * 从存档快照继续未完成的一局（存档界面点「进入」）。
   *
   * 关键：续玩必须与新建一局共用同一条「开局初始化」通道 —— 即广播 `on_run_start`。
   * 否则 Player（精灵/缩放/显示/操控）、CombatSystem（攻击类型与射程缓存）、
   * EntityManager（玩法层激活）、Hud、LayerRisk（层计时）都不会初始化，
   * 表现为「进了对应层但没有角色、无法操控、无攻击、无 HUD」。
   * 先置 `runInProgress` 再广播：`startRun` 的守卫会忽略这次事件，不会重复开局。
   */
  private resumeRun(snapshot: RunSnapshot): void {
    if (this.runInProgress) {
      return;
    }
    // 旧档没有 mode：按本体续玩（`restoreRun` 内部同样兜底）
    this.mode = snapshot.mode ?? 'base';
    this.layersPerRun = endgameRules.maxLayers(this.mode);
    gameState.restoreRun(snapshot);
    this.runInProgress = true;
    this.currentLayer = snapshot.layer;
    this.bankedGold = snapshot.bankedGold;
    eventBus.emit(EventNames.on_run_start, snapshot.classId);
    this.startLayer(Math.max(1, snapshot.layer));
  }

  /**
   * 玩家踏入出口点（文档 2.3：出口即推进；越早离开收益越高，见 2.4）。
   * 本层收益先入账局外（此时 LayerRisk 的层结算奖励已发放），再进行换层落盘。
   */
  private onExitReached(): void {
    if (!this.runInProgress) return;
    if (this.banksPerLayer()) {
      this.bankRunGold();
    }
    // 本体：到达最后一层出口即通关（`layersPerRun = 0` 表示无限模式，永不自动通关）
    if (this.layersPerRun > 0 && this.currentLayer >= this.layersPerRun) {
      this.finishRun('clear');
      return;
    }
    this.startLayer(this.currentLayer + 1);
  }

  /**
   * 结束本局：结算获得金币并入账局外，再统一落盘（死亡 / 通关共用）。
   * 顺序说明：先入账再广播 on_run_end，结算面板才能立刻读到「局外金币（累计）」。
   */
  private finishRun(reason: 'death' | 'clear'): void {
    if (!this.runInProgress) return;
    this.runInProgress = false;
    // 文档 2.1 / 2.2：结算获得金币；死亡只保留金币，不保留关卡进度 → 本局剩余金币入账局外。
    // 挑战地图失败按 `fail_keep_ratio` 保留（文档 2.6：保留 50%）；挑战模式层间不入账，
    // 因此这里的 delta 就是「本局全部收益」，折扣语义正确。
    const keep = reason === 'death' ? endgameRules.failKeepRatio(this.mode) : 1;
    this.bankRunGold(keep);
    metaState.noteModeLayer(this.mode, this.currentLayer);
    metaState.noteRunFinished(gameState.getKills());
    if (reason === 'clear' && this.mode === 'base') {
      // 本体通关 → 解锁终局（文档 5.1 `base_cleared` / 文档 2.6）
      metaState.noteBaseCleared();
      console.log('[RunFlow] 本体通关：终局（普通地图 / 挑战地图）已解锁');
    }
    metaState.clearCurrentRun(); // 本局已结束：清除进行中快照（下次进入该档回到职业选择）
    gameState.endRun(reason); // 内部广播 on_run_end（死亡 / 通关 / 退出三条路径都恰好一次）
    saveManager.save();
  }

  /** 玩家死亡：结束本局并落盘养成。 */
  private onPlayerDied(): void {
    this.finishRun('death');
  }
}

export const runFlow = new RunFlow();

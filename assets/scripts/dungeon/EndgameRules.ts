import { dataManager } from '../data/DataManager';
import type { RunMode } from '../core/GameState';

/**
 * 终局规则（dungeon 纯规则层，文档 2.6 / 3.8 / 7.6 阶段 4）。
 *
 * 职责：把 `endgame.json` 的**模式定义**翻译成流程层与实体层要用的几个数字，
 * 解决「本体 / 普通地图 / 挑战地图」在**层数上限、敌方成长公式、收益递进、失败保留**上的差异。
 *
 * 规则（宪法 6.7 / 6.9）：本文件不出现任何游戏数值，全部读配置；
 * 不持有状态、不订阅事件，可被流程层（RunFlow）、实体层（Enemy）与表现层安全共享。
 */
class EndgameRules {
  /** 默认模式（配置未就绪时的兜底，保证不崩）。 */
  private static readonly FALLBACK_MODE = 'base';

  private table(): any {
    return dataManager.isLoaded('endgame') ? dataManager.getTable<any>('endgame') : null;
  }

  /** 某模式的配置块（缺省回落到本体）。 */
  modeConfig(mode: RunMode): any {
    const t = this.table();
    const modes = t && t.modes ? t.modes : null;
    if (!modes) {
      return {};
    }
    return modes[mode] ?? modes[EndgameRules.FALLBACK_MODE] ?? {};
  }

  /** 模式显示名（UI 用；缺失时返回 id）。 */
  nameOf(mode: RunMode): string {
    const cfg = this.modeConfig(mode);
    return cfg.name ? String(cfg.name) : mode;
  }

  /** 层数上限（0 = 无限）。 */
  maxLayers(mode: RunMode): number {
    const cfg = this.modeConfig(mode);
    return cfg.unlimited === true ? 0 : Math.max(0, Math.floor(cfg.max_layers ?? 0));
  }

  isUnlimited(mode: RunMode): boolean {
    return this.maxLayers(mode) === 0;
  }

  /** 是否启用层内「收益软上限」（文档 3.7；普通 / 挑战地图为稳定收益 → 关闭）。 */
  softCapEnabled(mode: RunMode): boolean {
    return this.modeConfig(mode).soft_cap === true;
  }

  /** 失败（死亡）时本局收益保留比例（文档 2.6：挑战地图保留 50%）。 */
  failKeepRatio(mode: RunMode): number {
    const r = this.modeConfig(mode).fail_keep_ratio;
    return typeof r === 'number' && r >= 0 && r <= 1 ? r : 1;
  }

  /**
   * 单层收益系数（文档 3.8：挑战地图 `单层收益 = 基础收益 × 1.12^层数`）。
   * 本体 / 普通地图为稳定收益 → 恒为 1。
   */
  rewardFactor(mode: RunMode, layer: number): number {
    const cfg = this.modeConfig(mode);
    const growth = cfg.reward_growth ?? 1;
    if (!(growth > 0) || growth === 1) {
      return 1;
    }
    // 硬上限（宪法 6.9 / 文档 3.1：所有倍率设上限，防指数膨胀）
    const cap = cfg.max_reward_factor > 0 ? cfg.max_reward_factor : Infinity;
    return Math.min(cap, Math.pow(growth, Math.max(0, layer)));
  }

  /**
   * 敌方裸数值（普通怪基准）。三种模式各有曲线：
   *  - `round_formula`（本体 / 普通地图，方案 A）：**轮次制** ——
   *    每 `round_layers` 层为一轮，轮内 ×`*_per_layer`、轮间 ×`*_per_round`；
   *    基数取 `enemies.normal.base_hp` / `base_atk`（敌人基数的唯一来源仍是 enemies.json）。
   *    取代原先「每层 ×`layer_growth`」的指数曲线：25 层从 ≈555× 降到 ≈13×，使 25 层本体可通关。
   *  - `challenge_formula`（挑战地图，文档 3.8）：`HP = hp_base × hp_growth^层 × (1 + hp_layer_bonus × 层)`、
   *    `ATK = atk_base × atk_growth^层`。
   *
   * @returns `{ hp, atk }` 裸值；两者为 0 表示沿用 `enemies.json` 的层数成长（兜底）。
   */
  enemyScaling(mode: RunMode, layer: number): { hp: number; atk: number } {
    const cfg = this.modeConfig(mode);
    const L = Math.max(1, layer);
    if (cfg.difficulty === 'challenge_formula') {
      const hp = cfg.enemy_hp_base * Math.pow(cfg.enemy_hp_growth, L) * (1 + cfg.enemy_hp_layer_bonus * L);
      const atk = cfg.enemy_atk_base * Math.pow(cfg.enemy_atk_growth, L);
      return { hp, atk };
    }
    if (cfg.difficulty === 'round_formula' && (cfg.hp_factor_per_layer > 0)) {
      const base = this.enemyBase(); // enemies.json 的普通怪基数
      const perRound = Math.max(1, Math.floor(cfg.round_layers ?? 1));
      const roundIdx = Math.floor((L - 1) / perRound);
      const inRound = (L - 1) % perRound;
      const hp = base.hp * Math.pow(cfg.hp_factor_per_round ?? 1, roundIdx)
        * Math.pow(cfg.hp_factor_per_layer, inRound);
      const atk = base.atk * Math.pow(cfg.atk_factor_per_round ?? 1, roundIdx)
        * Math.pow(cfg.atk_factor_per_layer ?? 1, inRound);
      return { hp, atk };
    }
    return { hp: 0, atk: 0 };
  }

  /** 敌方普通怪基数（`enemies.json`；配置未就绪时返回 0，调用方走兜底曲线）。 */
  private enemyBase(): { hp: number; atk: number } {
    if (!dataManager.isLoaded('enemies')) {
      return { hp: 0, atk: 0 };
    }
    const normal = dataManager.get<any>('enemies', 'normal');
    return { hp: normal.base_hp ?? 0, atk: normal.base_atk ?? 0 };
  }

  /** 终局是否要求先通关本体（`endgame.unlock.require_base_clear`；开发期可置 false 免控制台验收）。 */
  requiresBaseClear(): boolean {
    const t = this.table();
    return !(t && t.unlock && t.unlock.require_base_clear === false);
  }

  /** 某模式当前是否可选（本体恒可选；终局按解锁规则）。 */
  isModeAvailable(mode: RunMode, baseCleared: boolean): boolean {
    if (mode === 'base') {
      return true;
    }
    return this.requiresBaseClear() ? baseCleared : true;
  }

  /** 卡关点目标层数区间（文档 3.8 / 7.6 验收：约 20–30 层），仅供校验脚本与文档核对。 */
  stallTargetLayers(): number[] {
    const t = this.table();
    return t && Array.isArray(t.stall_target_layers) ? t.stall_target_layers : [];
  }
}

export const endgameRules = new EndgameRules();

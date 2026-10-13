/**
 * 存档结构迁移（**纯函数模块，零运行时依赖**）。
 *
 * 为什么单独成文件（宪法 6.2 / 6.8）：
 *  - 6.8 要求「结构变更必须 +1 `version` 并**提供迁移函数**」，而迁移是**最容易悄悄坏掉**的一段逻辑
 *    —— 玩家升级版本后读不出旧档 = 直接丢进度，比任何玩法 bug 都严重。所以它必须能被**离线自动测试**；
 *  - `SaveManager` 依赖 `cc.sys.localStorage`，在 Node 里跑不起来；把迁移抽成纯函数后，
 *    `tools/test_save_migration.js` 可以单独编译本文件，用**各历史版本的样例存档**逐一验证。
 *
 * 类型一律用 `import type`（编译后完全消除）⇒ 本模块最终**不含任何 import 语句**。
 */
import type { MetaSave, ProgressSave, StatsSave } from '../core/MetaState';

/** 当前存档结构版本（文档 5.4）。v4 = 增加 `progress.baseCleared` 等终局字段。 */
export const SAVE_VERSION = 4;

export interface SaveData {
  version: number;
  timestamp: number;
  /** 简单校验和（文档 5.1：仅用于防损坏，不防篡改）。 */
  checksum: string;
  data: { meta: MetaSave; progress: ProgressSave; stats: StatsSave };
}

/**
 * 把任意历史版本的存档统一迁移到当前版本（v4）。
 * @returns 迁移后的存档；结构不可识别（缺 `version` / 缺关键字段）时返回 `null`（调用方按"档损坏"处理）
 */
export function migrateSave(parsed: any): SaveData | null {
  if (!parsed || typeof parsed.version !== 'number') {
    return null;
  }
  if (parsed.version >= 3) {
    if (!parsed.data || !parsed.data.meta) {
      return null;
    }
    // v3 → v4：补齐终局进度字段（默认值兜底，旧档可继续使用）
    const data = parsed.version >= 4 ? parsed.data : migrateV3ToV4(parsed.data);
    return {
      version: SAVE_VERSION,
      timestamp: parsed.timestamp ?? 0,
      checksum: parsed.checksum ?? '',
      data,
    };
  }
  // v1 / v2：meta 在顶层
  return {
    version: SAVE_VERSION,
    timestamp: parsed.timestamp ?? 0,
    checksum: '',
    data: migrateV2ToV3(parsed.meta),
  };
}

/** v2 → v3：顶层 meta 收进 data，并补齐 progress / stats 默认值。 */
export function migrateV2ToV3(meta: any): SaveData['data'] {
  return {
    meta: {
      levels: meta?.levels ?? {},
      unlockedClasses: meta?.unlockedClasses ?? ['warrior'],
      // 槽位留 0 交由 MetaState.loadFrom 按 balance.buff 的基数校正（避免在存档层硬编码数值）
      buffSlots: meta?.buffSlots ?? 0,
      behaviorSkillSlots: meta?.behaviorSkillSlots ?? 0,
      // 道具框格数同样留 0：由 MetaState.loadFrom 按 balance.item.slots_base 校正
      itemSlots: meta?.itemSlots ?? 0,
      gold: meta?.gold ?? 0,
    },
    progress: {
      maxLayerCleared: 0,
      baseCleared: false,
      normalBestLayer: 0,
      challengeBestLayer: 0,
      currentRun: null,
    },
    stats: { totalRuns: 0, totalKills: 0 },
  };
}

/** v3 → v4：补齐 `progress` 的终局字段（本体通关标记 / 终局各模式最深层），缺字段全部兜底。 */
export function migrateV3ToV4(data: any): SaveData['data'] {
  const progress: any = data?.progress ?? {};
  return {
    meta: data?.meta,
    progress: {
      maxLayerCleared: progress.maxLayerCleared ?? 0,
      baseCleared: progress.baseCleared === true,
      normalBestLayer: progress.normalBestLayer ?? 0,
      challengeBestLayer: progress.challengeBestLayer ?? 0,
      currentRun: progress.currentRun ?? null,
    },
    stats: data?.stats ?? { totalRuns: 0, totalKills: 0 },
  };
}

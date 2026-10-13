import { sys } from 'cc';
import { metaState } from '../core/MetaState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { dataManager } from '../data/DataManager';
import { SAVE_VERSION, SaveData, migrateSave } from './SaveMigration';

/** 存档槽键名（文档 5.2：主存档 + 备份存档）。 */
const SLOT_PREFIX = 'ROGUELITE_SLOT';
/** 旧版单槽键（v1 / v2）：首次启动时迁移到槽 1，避免玩家进度丢失。 */
const LEGACY_KEY = 'ROGUELITE_SAVE_V1';
// 结构版本与版本迁移函数抽到 `SaveMigration.ts`（纯函数、零依赖）⇒ 可被 tools/test_save_migration.js 离线测试。
// 迁移是最容易"悄悄坏掉且代价最大"（玩家丢档）的一段逻辑，必须能自动验证（宪法 6.8）。

/** 存档槽摘要（供存档选择界面展示）。 */
export interface SlotInfo {
  slot: number;
  exists: boolean;
  classId: string;
  layer: number;
  level: number;
  metaGold: number;
  totalRuns: number;
  maxLayerCleared: number;
  /** 本体是否已通关（终端解锁标记，文档 5.1 `base_cleared`）。 */
  baseCleared: boolean;
  /** 终局·挑战地图到达过的最深层数（卡关点观测，文档 7.6）。 */
  challengeBestLayer: number;
}

/**
 * 存档管理器（项目宪法 6.8 / 文档 5：唯一允许读写 localStorage 的模块）。
 *
 * 结构（v3，文档 5.1）：`{ version, timestamp, checksum, data: { meta, progress, stats } }`；
 * 写入流程（文档 5.2）：把现有主档复制到备份 → 校验新数据 → 写主档；
 * 读取流程（文档 5.2）：读主档并校验 checksum → 失败读备份 → 都失败视为空档；
 * 迁移（文档 5.4）：v1 / v2 顶层 `meta` 结构自动迁移到 v3 的 `data` 结构（默认值兜底）。
 *
 * 槽位：`balance.save_slots` 个独立存档，每个存档含 `_main` / `_backup` 两个键。
 */
class SaveManager {
  /** 当前活动槽（0 = 未选择，此时不落盘）。 */
  private activeSlot = 0;

  constructor() {
    // 局外购买后自动落盘（文档 5.3 写入时机含「局外养成购买」）
    eventBus.on(EventNames.on_meta_upgraded, this.onMetaUpgraded, this);
  }

  private onMetaUpgraded(): void {
    this.save();
  }

  // —— 槽位 ——

  getSlotCount(): number {
    const n = dataManager.isLoaded('balance') ? dataManager.get<any>('balance', 'save_slots') : 0;
    return Number.isInteger(n) && n > 0 ? n : 1;
  }

  getActiveSlot(): number {
    return this.activeSlot;
  }

  hasActiveSlot(): boolean {
    return this.activeSlot > 0;
  }

  private mainKey(slot: number): string {
    return `${SLOT_PREFIX}_${slot}_main`;
  }

  private backupKey(slot: number): string {
    return `${SLOT_PREFIX}_${slot}_backup`;
  }

  /** 启动准备：把旧版单槽存档迁移到槽 1（只做一次）。 */
  prepareSlots(): void {
    try {
      const legacy = sys.localStorage.getItem(LEGACY_KEY);
      if (legacy && !sys.localStorage.getItem(this.mainKey(1))) {
        sys.localStorage.setItem(this.mainKey(1), legacy);
        console.log('[SaveManager] 检测到旧版单槽存档，已迁移到槽 1');
      }
      if (legacy) {
        sys.localStorage.removeItem(LEGACY_KEY);
      }
    } catch (e) {
      console.error('[SaveManager] 旧档迁移失败:', e);
    }
  }

  /** 各槽摘要（不存在则 exists = false）。 */
  listSlots(): SlotInfo[] {
    const out: SlotInfo[] = [];
    for (let slot = 1; slot <= this.getSlotCount(); slot++) {
      const data = this.load(slot);
      if (!data) {
        out.push({
          slot, exists: false, classId: '', layer: 0, level: 0,
          metaGold: 0, totalRuns: 0, maxLayerCleared: 0,
          baseCleared: false, challengeBestLayer: 0,
        });
        continue;
      }
      const run = data.data.progress.currentRun;
      out.push({
        slot,
        exists: true,
        classId: run?.classId ?? '',
        layer: run?.layer ?? 0,
        level: run?.level ?? 0,
        metaGold: data.data.meta.gold ?? 0,
        totalRuns: data.data.stats.totalRuns ?? 0,
        maxLayerCleared: data.data.progress.maxLayerCleared ?? 0,
        baseCleared: data.data.progress.baseCleared === true,
        challengeBestLayer: data.data.progress.challengeBestLayer ?? 0,
      });
    }
    return out;
  }

  /** 进入槽位：已有档则加载；空档则新建（重置 + 按配置赠送初始金币并落盘）。 */
  enterSlot(slot: number): void {
    this.activeSlot = slot;
    const data = this.load(slot);
    if (data) {
      metaState.loadFrom(data.data);
      console.log(
        `[SaveManager] 槽 ${slot} 已载入 v${data.version}：局外金币 ${metaState.getGold()}，`
        + `已完成 ${metaState.getTotalRuns()} 局`,
      );
      eventBus.emit(EventNames.on_save_changed, metaState.getGold());
      return;
    }
    metaState.resetAll();
    const startGold = this.getStartGold();
    if (startGold > 0) {
      metaState.addGold(startGold);
    }
    this.save();
    console.log(`[SaveManager] 槽 ${slot} 新建存档（初始金币 ${startGold}）`);
  }

  /** 删除槽位（主档 + 备份）。 */
  deleteSlot(slot: number): void {
    try {
      sys.localStorage.removeItem(this.mainKey(slot));
      sys.localStorage.removeItem(this.backupKey(slot));
      if (this.activeSlot === slot) {
        this.activeSlot = 0;
      }
      console.log(`[SaveManager] 槽 ${slot} 已删除`);
      eventBus.emit(EventNames.on_save_slots_changed);
    } catch (e) {
      console.error('[SaveManager] 删除槽位失败:', e);
    }
  }

  // —— 读写 ——

  /** 读取指定槽（默认当前槽）：主档优先，失败回退备份。 */
  load(slot = this.activeSlot): SaveData | null {
    if (slot <= 0) {
      return null;
    }
    const main = this.tryRead(this.mainKey(slot));
    if (main) {
      return main;
    }
    const backup = this.tryRead(this.backupKey(slot));
    if (backup) {
      console.warn(`[SaveManager] 槽 ${slot} 主档不可用，已回退备份档`);
      return backup;
    }
    return null;
  }

  private tryRead(key: string): SaveData | null {
    let raw: string | null = null;
    try {
      raw = sys.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      // v3 起校验 checksum（旧档迁移后不校验，避免误伤）
      if (typeof parsed?.version === 'number' && parsed.version >= 3 && parsed.checksum) {
        if (checksumOf(JSON.stringify(parsed.data)) !== parsed.checksum) {
          console.error(`[SaveManager] 存档校验和不一致: ${key}`);
          return null;
        }
      }
      return migrateSave(parsed);
    } catch (e) {
      console.error(`[SaveManager] 解析存档失败: ${key}`, e);
      return null;
    }
  }

  /** 把当前 metaState 落盘到活动槽（文档 5.2 写入流程）。 */
  save(): void {
    const slot = this.activeSlot;
    if (slot <= 0) {
      return;
    }
    try {
      const json = this.serialize();
      const current = sys.localStorage.getItem(this.mainKey(slot));
      if (current) {
        sys.localStorage.setItem(this.backupKey(slot), current); // 1) 主档转备份
      }
      sys.localStorage.setItem(this.mainKey(slot), json); // 2) 写主档
      const meta = metaState.toSave();
      console.log(
        `[SaveManager] 槽 ${slot} 已落盘 v${SAVE_VERSION}：局外金币 ${meta.meta.gold}，`
        + `养成项 ${Object.keys(meta.meta.levels).length}，进行中局面 ${meta.progress.currentRun ? '有' : '无'}`,
      );
      eventBus.emit(EventNames.on_save_changed, metaState.getGold());
    } catch (e) {
      console.error('[SaveManager] 写入存档失败:', e);
    }
  }

  private serialize(): string {
    const data = metaState.toSave();
    const payload: SaveData = {
      version: SAVE_VERSION,
      timestamp: Date.now(),
      checksum: checksumOf(JSON.stringify(data)),
      data,
    };
    return JSON.stringify(payload);
  }

  // —— 导入 / 导出（文档 5.5：Base64 文本）——

  /** 导出槽位为 Base64 文本（不存在返回 null）。 */
  exportSlot(slot: number): string | null {
    const data = this.load(slot);
    if (!data) {
      return null;
    }
    return toBase64(JSON.stringify({ version: SAVE_VERSION, timestamp: Date.now(), checksum: '', data: data.data }));
  }

  /** 从 Base64 文本导入到指定槽（覆盖）。 */
  importSlot(text: string, slot: number): boolean {
    const json = fromBase64(text);
    if (!json) {
      return false;
    }
    try {
      const data = migrateSave(JSON.parse(json));
      if (!data) {
        return false;
      }
      const payload: SaveData = {
        version: SAVE_VERSION,
        timestamp: Date.now(),
        checksum: checksumOf(JSON.stringify(data.data)),
        data: data.data,
      };
      sys.localStorage.setItem(this.mainKey(slot), JSON.stringify(payload));
      if (this.activeSlot === slot) {
        metaState.loadFrom(data.data);
      }
      console.log(`[SaveManager] 已导入到槽 ${slot}`);
      eventBus.emit(EventNames.on_save_slots_changed);
      return true;
    } catch (e) {
      console.error('[SaveManager] 导入失败:', e);
      return false;
    }
  }

  /** 清空当前活动槽（调试 / 重置）。 */
  clear(): void {
    if (this.activeSlot <= 0) {
      return;
    }
    const slot = this.activeSlot;
    sys.localStorage.removeItem(this.mainKey(slot));
    sys.localStorage.removeItem(this.backupKey(slot));
    console.log(`[SaveManager] 槽 ${slot} 已清空`);
    eventBus.emit(EventNames.on_save_slots_changed);
  }

  // —— 迁移：已抽到 `save/SaveMigration.ts`（纯函数、可离线测试；见该文件头注释）——

  /** 新档初始金币（balance.meta_start_gold；配置未就绪时为 0）。 */
  private getStartGold(): number {
    if (!dataManager.isLoaded('balance')) {
      return 0;
    }
    return dataManager.get<any>('balance', 'meta_start_gold') ?? 0;
  }
}

/** 简单校验和（FNV-1a 32 位，转 16 进制；文档 5.1：只防损坏）。 */
function checksumOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** 文本 → Base64（Web：btoa；无 btoa 环境用 UTF-8 转义兜底）。 */
function toBase64(text: string): string {
  const btoaFn = (globalThis as any).btoa as ((s: string) => string) | undefined;
  const encoded = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_m, p1: string) =>
    String.fromCharCode(parseInt(p1, 16)));
  return btoaFn ? btoaFn(encoded) : encoded;
}

/** Base64 → 文本（解析失败返回 null）。 */
function fromBase64(text: string): string | null {
  try {
    const atobFn = (globalThis as any).atob as ((s: string) => string) | undefined;
    const decoded = atobFn ? atobFn(text) : text;
    return decodeURIComponent(decoded.split('').map((c) =>
      `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`).join(''));
  } catch (e) {
    return null;
  }
}

export const saveManager = new SaveManager();

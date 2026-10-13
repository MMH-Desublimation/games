import { Color, SpriteFrame, resources } from 'cc';
import { dataManager } from '../data/DataManager';
import { sliceFrameByGrid } from './SpriteSheet';

/**
 * 演员表（core：资源封装 + 帧动画播放器；不含玩法数值）。
 *
 * 数据源：`actors.json`（路径 / 帧网格 / 取帧方向 / 播放节奏），本文件零硬编码数值（宪法 6.7）。
 *
 * 关于「取帧方向」（axis）——**实测两种素材布局相反，必须按表配置**：
 *  - `row`：**每行一个朝向**，同一行的各帧是连续动画（如 `Character/NinjaRed/SpriteSheet.png` 行走图、
 *            怪物 `SpriteSheet.png`：4 列 × 4 行，第 0 行 = 朝下的 4 帧）；
 *  - `col`：**每列一个朝向**，同一列的各帧是连续动画（如 `CharacterAnimated/<角色>/Separate/Idle.png`：
 *            4 列 = 下/左/右/上，每列 4 帧）。
 *
 * > 历史缺陷：此前一律按「行」取帧，于是 Separate 表取到的是**4 个不同朝向的第 1 帧** ——
 * > 角色看起来在**原地旋转**；同时帧尺寸误配（16px 帧按 32px 切）导致怪物**整片不可见**。
 */

/** 取帧方向（见文件头说明）。 */
export type SheetAxis = 'row' | 'col';

/** 一张动作表的定义（来自 actors.json）。 */
export interface SheetDef {
  path: string;
  frameW: number;
  frameH: number;
  cols: number;
  rows: number;
  /** 取帧方向：'row' = 行内连续帧（行是朝向）；'col' = 列内连续帧（列是朝向）。 */
  axis: SheetAxis;
  /** 起始行（axis='row' 时即"朝向行"；axis='col' 时通常是 0）。 */
  row: number;
  /** 起始列（axis='col' 时即"朝向列"；axis='row' 时通常是 0）。 */
  col: number;
  /** 本动作的帧数。 */
  frames: number;
  /** 每帧显示时长（毫秒）。 */
  frameMs: number;
  /** 是否循环（Idle/Walk 循环；Attack/Hit 播一次）。 */
  loop: boolean;
}

/** 帧动画播放器（纯逻辑：不持有节点，只回答"当前该显示哪一帧"）。 */
export class SheetAnim {
  private index = 0;
  private elapsedSec = 0;
  private finished = false;

  constructor(private readonly def: SheetDef, private readonly frames: SpriteFrame[]) {}

  /** 复位。`randomPhase = true` 时随机起始相位，避免同屏同素材的怪"整齐划一"。 */
  reset(randomPhase = false): void {
    this.index = 0;
    this.finished = false;
    this.elapsedSec = randomPhase ? Math.random() * (this.def.frameMs / 1000) : 0;
  }

  get frame(): SpriteFrame | null {
    return this.frames[this.index] ?? null;
  }

  /** 非循环动作是否已播完（用于"播完回到 Idle"）。 */
  get done(): boolean {
    return this.finished;
  }

  get action(): SheetDef {
    return this.def;
  }

  /** 推进时间轴；返回当前帧（帧未变化时返回 null，调用方可跳过 setSpriteFrame）。 */
  tick(dtSec: number): SpriteFrame | null {
    if (this.finished || this.frames.length === 0) {
      return null;
    }
    this.elapsedSec += dtSec;
    const stepSec = Math.max(0.016, this.def.frameMs / 1000);
    if (this.elapsedSec < stepSec) {
      return null;
    }
    this.elapsedSec -= stepSec;
    if (this.index + 1 >= this.frames.length) {
      if (this.def.loop) {
        this.index = 0;
      } else {
        this.finished = true;
        this.index = this.frames.length - 1;
      }
    } else {
      this.index += 1;
    }
    return this.frame;
  }
}

type ActorKind = 'player' | 'monsters' | 'bosses';

/** 演员表缓存（异步加载一次，运行时按 id + 动作取帧序列）。 */
class ActorSheetCache {
  private defs = new Map<string, SheetDef>();
  private frames = new Map<string, SpriteFrame[]>();
  private loaded = false;

  private key(kind: ActorKind, id: string, action: string): string {
    return `${kind}|${id}|${action}`;
  }

  /** 把一个动作表定义（含 path）解析为标准 SheetDef。 */
  private parse(raw: any, fallbackPath = ''): SheetDef | null {
    const path = typeof raw?.path === 'string' && raw.path ? raw.path : fallbackPath;
    if (!raw || !path) {
      return null;
    }
    const axis: SheetAxis = raw.axis === 'col' ? 'col' : 'row';
    return {
      path,
      frameW: raw.frame_w ?? 16,
      frameH: raw.frame_h ?? 16,
      cols: Math.max(1, raw.cols ?? 1),
      rows: Math.max(1, raw.rows ?? 1),
      axis,
      row: Math.max(0, raw.row ?? 0),
      col: Math.max(0, raw.col ?? 0),
      frames: Math.max(1, raw.frames ?? 1),
      frameMs: Math.max(16, raw.frame_ms ?? 150),
      loop: raw.loop !== false,
    };
  }

  /**
   * 预加载全部动作表（配置就绪后调用）。
   * 玩家：每个「职业 × 动作」一条（职业各自一张行走图，颜色天然区分，不再依赖染色）；
   * 怪物：每个 id 一条；Boss：每个 id 的 idle/walk/attack。
   */
  preload(onDone?: () => void): void {
    if (!dataManager.isLoaded('actors')) {
      onDone?.();
      return;
    }
    const table = dataManager.getTable<any>('actors');
    const jobs: { key: string; def: SheetDef }[] = [];
    // 玩家：职业 → 行走图路径（同一套网格参数，按动作配节奏）
    const classSheet: Record<string, string> = table.player?.class_sheet ?? {};
    for (const classId of Object.keys(classSheet)) {
      for (const action of ['idle', 'walk', 'attack', 'hit']) {
        const def = this.parse(table.player?.[action], classSheet[classId]);
        if (def) {
          jobs.push({ key: this.key('player', classId, action), def });
        }
      }
    }
    for (const id of Object.keys(table.monsters ?? {})) {
      const def = this.parse(table.monsters[id]?.sheet);
      if (def) {
        jobs.push({ key: this.key('monsters', id, 'sheet'), def });
      }
    }
    for (const id of Object.keys(table.bosses ?? {})) {
      for (const action of ['idle', 'walk', 'attack']) {
        const def = this.parse(table.bosses[id]?.[action]);
        if (def) {
          jobs.push({ key: this.key('bosses', id, action), def });
        }
      }
    }
    if (jobs.length === 0) {
      this.loaded = true;
      onDone?.();
      return;
    }
    let remain = jobs.length;
    for (const job of jobs) {
      resources.load(`${job.def.path}/spriteFrame`, SpriteFrame, (err, frame) => {
        if (!err && frame) {
          this.defs.set(job.key, job.def);
          this.frames.set(job.key, this.sliceFrames(frame, job.def));
        } else {
          console.warn(`[ActorSheet] 素材缺失：${job.def.path}（该动作退回单帧 / 不显示动画）`);
        }
        remain -= 1;
        if (remain === 0) {
          this.loaded = true;
          console.log(`[ActorSheet] 动作表就绪：${this.frames.size}/${jobs.length}`);
          onDone?.();
        }
      });
    }
  }

  /**
   * 切帧（按 `axis` 决定"哪个方向是朝向"）：
   *  - `row`：从 (col, row) 起按**行优先**取 `frames` 帧（跨行延续）；
   *  - `col`：从 (col, row) 起按**列优先**取 `frames` 帧（跨列延续）。
   */
  private sliceFrames(source: SpriteFrame, def: SheetDef): SpriteFrame[] {
    const out: SpriteFrame[] = [];
    const capacity = def.axis === 'row'
      ? (def.rows - def.row) * def.cols
      : (def.cols - def.col) * def.rows;
    const n = Math.max(1, Math.min(def.frames, Math.max(1, capacity)));
    for (let i = 0; i < n; i++) {
      let c = 0;
      let r = 0;
      if (def.axis === 'row') {
        const flat = def.row * def.cols + def.col + i;
        c = flat % def.cols;
        r = Math.min(def.rows - 1, Math.floor(flat / def.cols));
      } else {
        const flat = def.col * def.rows + def.row + i;
        r = flat % def.rows;
        c = Math.min(def.cols - 1, Math.floor(flat / def.rows));
      }
      out.push(sliceFrameByGrid(source, c, r, def.cols, def.rows));
    }
    return out;
  }

  private animOf(key: string): SheetAnim | null {
    const def = this.defs.get(key);
    const frames = this.frames.get(key);
    if (!def || !frames || frames.length === 0) {
      return null;
    }
    return new SheetAnim(def, frames);
  }

  /** 取玩家某动作的播放器（素材按职业区分颜色）。 */
  playerAnim(classId: string, action: string): SheetAnim | null {
    return this.animOf(this.key('player', classId, action));
  }

  /** 取怪物动作表播放器。 */
  monsterAnim(id: string): SheetAnim | null {
    return this.animOf(this.key('monsters', id, 'sheet'));
  }

  /** 取 Boss 某动作播放器。 */
  bossAnim(id: string, action: string): SheetAnim | null {
    return this.animOf(this.key('bosses', id, action));
  }

  hasMonster(id: string): boolean {
    return this.frames.has(this.key('monsters', id, 'sheet'));
  }

  /** 角色常态色（素材自带颜色，无需染色；受击闪色后恢复到它）。 */
  baseColor(): Color {
    return new Color(255, 255, 255, 255);
  }

  /**
   * Boss 素材的**归一化显示系数**（`actors.bosses.<id>.scale`）。
   * Boss 素材帧尺寸差异很大（48~82px），该系数把它们统一到原 52px Boss 素材的观感，
   * 避免"换一个 Boss 就忽然变成巨无霸 / 迷你怪"。
   */
  bossScale(id: string): number {
    const s = dataManager.isLoaded('actors')
      ? (dataManager.getTable<any>('actors').bosses?.[id]?.scale ?? 0) : 0;
    return s > 0 ? s : 1;
  }

  /** 是否已有 Boss 某动作（idle / walk / attack）。 */
  hasBoss(id: string, action: string): boolean {
    return this.frames.has(this.key('bosses', id, action));
  }

  /** 怪物素材的显示缩放（体积差异：熊大、蝙蝠小）。 */
  monsterScale(id: string): number {
    const s = dataManager.isLoaded('actors')
      ? (dataManager.getTable<any>('actors').monsters?.[id]?.scale ?? 0) : 0;
    return s > 0 ? s : 1;
  }

  /** 当前已就绪的动作表数量（自检用）。 */
  get readyCount(): number {
    return this.frames.size;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }
}

export const actorSheets = new ActorSheetCache();

import {
  _decorator, Component, Node, Rect, Size, Sprite, SpriteFrame, UIOpacity, UITransform, Vec2, resources,
} from 'cc';
import { PoolManager } from '../core/PoolManager';
import { attachToViewLayer } from '../core/ViewRoot';
import { MAX_DT_SEC } from '../core/Timer';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { getWhiteFrame } from '../core/WhiteFrame';
import { dataManager } from '../data/DataManager';
import { playerRef } from '../entities/Player';

const { ccclass } = _decorator;

/** 特效对象池 key（预分配与上限取自 balance.performance.preload_effect / max_effect_count）。 */
export const FX_POOL = 'fx_effect';

/** `fx.json` 的一条特效定义。 */
interface FxDef {
  key: string;
  name: string;
  /** resources 下的目录路径（该目录内放序列帧图 sheet）。 */
  path: string;
  frame_w: number;
  frame_h: number;
  frames: number;
  /** 每帧显示时长（毫秒）：越大动画越慢（用户反馈原先"一瞬间就消失"）。 */
  frame_ms: number;
  /** 动画重复次数：> 1 时在「在场时长」内循环播放，形成持续、交叠的观感。 */
  anim_repeat: number;
  /** 末帧停留（毫秒）：动画播完后保持最后一帧，便于看清。 */
  hold_ms: number;
  scale: number;
  /** 默认是否跟随玩家（护盾 / 增幅光环这类） */
  follow: boolean;
}

/** 一次播放的运行时参数（由 fx.json 折算，技能可覆盖在场时长）。 */
export interface FxPlayOptions {
  frameSec: number;
  totalSec: number;
  holdSec: number;
  follow: boolean;
  scale: number;
  angleDeg: number;
}

/***
 * 序列帧特效播放（视图层）：订阅 `on_fx(key, x, y, 角度, 是否跟随)`，
 * 从 `fx.json` 取帧几何，在运行时把序列帧图按 rect 切成帧并播放（对象池复用）。
 *
 * 资源策略（灰盒先行 / 文档 1.5）：
 *  - 美术资源**缺失时静默降级**——只打一条 warn，游戏逻辑不受影响；
 *  - 序列帧图按 key 懒加载并缓存（每 key 只加载一次、只切一次帧）；
 *  - 加载期间到达的播放请求入队，加载完成后补播（队列有上限，避免堆积）。
 */
/** 灰盒兜底闪烁时长（秒）与初始不透明度。 */
const GRAYBOX_SEC = 0.18;
const GRAYBOX_ALPHA = 170;

@ccclass('FxInstance')
export class FxInstance extends Component {
  private frames: SpriteFrame[] = [];
  /** 每帧时长 / 在场总时长 / 末帧停留（秒）。 */
  private frameSec = 0.08;
  private totalSec = 0.6;
  private holdSec = 0.1;
  private follow = false;
  private elapsedSec = 0;
  private index = 0;
  private playing = false;
  /** 灰盒模式（美术资源缺失时的可见性兜底）。 */
  private graybox = false;
  private grayboxSec = 0;
  private opacity: UIOpacity | null = null;

  /** 灰盒闪烁：白色方块快速淡出，用于「美术资源不可用但技能确实触发」的可见反馈。 */
  playGraybox(xPx: number, yPx: number, sizePx: number): void {
    this.graybox = true;
    this.grayboxSec = 0;
    this.playing = true;
    this.follow = false;
    const sp = this.node.getComponent(Sprite);
    if (sp) {
      sp.spriteFrame = getWhiteFrame();
      sp.sizeMode = Sprite.SizeMode.CUSTOM;
    }
    const ut = this.node.getComponent(UITransform);
    if (ut) {
      ut.setContentSize(sizePx, sizePx);
    }
    this.opacity = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
    if (this.opacity) {
      this.opacity.opacity = GRAYBOX_ALPHA;
    }
    this.node.setPosition(xPx, yPx, 0);
  }

  playFrames(
    frames: SpriteFrame[], xPx: number, yPx: number, frameW: number, frameH: number,
    opts: FxPlayOptions,
  ): void {
    this.graybox = false;
    if (this.opacity) {
      this.opacity.opacity = 255;
    }
    this.frames = frames;
    this.frameSec = opts.frameSec > 0 ? opts.frameSec : 0.08;
    this.totalSec = Math.max(this.frameSec, opts.totalSec);
    this.holdSec = Math.max(0, Math.min(opts.holdSec, this.totalSec));
    this.follow = opts.follow;
    this.elapsedSec = 0;
    this.index = 0;
    this.playing = true;
    this.node.angle = opts.angleDeg;
    // 关键：Sprite 为 CUSTOM 尺寸模式，必须显式设定 contentSize = 单帧像素尺寸，
    // 否则会用默认尺寸渲染（实测表现为"特效几乎不可见"）。
    const ut = this.node.getComponent(UITransform);
    if (ut) {
      ut.setContentSize(frameW, frameH);
    }
    this.node.setPosition(xPx, yPx, 0);
    this.applyFrame();
  }

  update(dt: number): void {
    if (!this.playing || gameState.isPaused()) {
      return;
    }
    const step = Math.min(dt, MAX_DT_SEC);
    if (this.graybox) {
      this.grayboxSec += step;
      const t = Math.min(1, this.grayboxSec / GRAYBOX_SEC);
      if (this.opacity) {
        this.opacity.opacity = Math.floor(GRAYBOX_ALPHA * (1 - t));
      }
      if (t >= 1) {
        this.playing = false;
        PoolManager.release(FX_POOL, this.node);
      }
      return;
    }
    this.elapsedSec += step;
    if (this.elapsedSec >= this.totalSec) {
      this.playing = false;
      PoolManager.release(FX_POOL, this.node);
      return;
    }
    // 播放区间 = 在场时长去掉「末帧停留」；区间内按固定帧时长循环播放序列帧
    // （循环即用户要求的「反复播放、交叠」观感，而不是一闪而过）
    const playSpan = Math.max(this.frameSec, this.totalSec - this.holdSec);
    if (this.elapsedSec < playSpan) {
      const idx = Math.floor(this.elapsedSec / this.frameSec) % this.frames.length;
      if (idx !== this.index) {
        this.index = idx;
        this.applyFrame();
      }
    } else if (this.index !== this.frames.length - 1) {
      this.index = this.frames.length - 1; // 末帧停留，便于看清
      this.applyFrame();
    }
    if (this.follow && playerRef) {
      const p = playerRef.position;
      this.node.setPosition(p.x, p.y, 0);
    }
  }

  private applyFrame(): void {
    const sp = this.node.getComponent(Sprite);
    if (sp && this.frames[this.index]) {
      sp.spriteFrame = this.frames[this.index];
    }
  }
}

/** 池内节点工厂：Sprite（帧由播放时指定）+ FxInstance。 */
function createFxNode(): Node {
  const node = new Node('fx');
  const sp = node.addComponent(Sprite);
  sp.sizeMode = Sprite.SizeMode.CUSTOM;
  node.addComponent(FxInstance);
  return node;
}

/** 注册特效池（由 Boot 在配置就绪后调用）。 */
export function registerFxPool(): void {
  const perf = dataManager.get<any>('balance', 'performance');
  PoolManager.registerFactory(FX_POOL, createFxNode, perf.preload_effect, perf.max_effect_count);
}

class FxPlayer {
  private defs: Map<string, FxDef> = new Map();
  /** 已切好的帧序列（每 key 一份）。 */
  private cache: Map<string, SpriteFrame[]> = new Map();
  private loading: Set<string> = new Set();
  /** 资源不可用的特效 key（此后一律走灰盒闪烁兜底，不再重复请求加载）。 */
  private failed: Set<string> = new Set();
  private pending: {
    key: string; x: number; y: number; angle: number; follow: boolean;
    totalSec?: number; targetPx?: number;
  }[] = [];

  constructor() {
    eventBus.on(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.on(EventNames.on_fx, this.onFx, this);
    // 开局 / 结束都要清空在播特效：否则上一局的长时长特效（技能引导可达数秒）
    // 会跨局继续播放 —— 表现为「退出 / 重进 / 换职业后开局一瞬看到上一局的技能动画残留」（用户反馈）。
    eventBus.on(EventNames.on_run_start, this.clearPlaying, this);
    eventBus.on(EventNames.on_run_end, this.clearPlaying, this);
  }

  /** 回收全部在播特效（并丢弃尚未加载完成的待播请求）。 */
  private clearPlaying(): void {
    this.pending.length = 0;
    PoolManager.releaseAll(FX_POOL);
  }

  private onConfigLoaded(): void {
    this.defs.clear();
    this.cache.clear();
    this.loading.clear();
    this.failed.clear();
    this.pending.length = 0;
    if (!dataManager.isLoaded('fx')) {
      console.warn('[Fx] fx.json 未加载：技能特效将不可见（其余玩法不受影响）');
      return;
    }
    for (const d of dataManager.getTable<FxDef[]>('fx')) {
      this.defs.set(d.key, d);
    }
    console.log(`[Fx] 特效配置就绪：${this.defs.size} 种`);
  }

  /**
   * 播放一次特效。
   * @param totalSec 可选：覆盖在场时长（远程类技能让它持续到射程尽头 / 技能持续期结束）
   * @param targetPx 可选：**目标世界尺寸**（最长边 px）。
   *   传入时按 `targetPx / 帧最长边` 自动推算缩放，使动画尺寸与实际作用范围一致；
   *   不传则用 `fx.json` 的 `scale`。
   */
  private onFx(
    key: string, xPx: number, yPx: number, angleDeg: number, follow: boolean,
    totalSec?: number, targetPx?: number,
  ): void {
    const def = this.defs.get(key);
    if (!def) {
      return; // 未配置的特效 key：忽略（不发警告，避免刷屏）
    }
    const frames = this.cache.get(key);
    if (frames) {
      this.spawn(def, frames, xPx, yPx, angleDeg, follow, totalSec, targetPx);
      return;
    }
    if (this.failed.has(key)) {
      // 美术资源不可用：灰盒闪烁兜底，保证技能触发可见
      const s = this.scaleOf(def, targetPx);
      this.spawnGraybox(xPx, yPx, Math.max(def.frame_w, def.frame_h) * s);
      return;
    }
    // 尚未加载：入队 + 触发懒加载（加载完成后按 key 补播）
    if (this.pending.length < 24) {
      this.pending.push({ key, x: xPx, y: yPx, angle: angleDeg, follow, totalSec, targetPx });
    }
    this.load(def);
  }

  /** 缩放：优先按「目标世界尺寸 / 帧最长边」，否则用 fx.json 的 scale。 */
  private scaleOf(def: FxDef, targetPx?: number): number {
    if (targetPx && targetPx > 0) {
      const base = Math.max(def.frame_w, def.frame_h);
      return base > 0 ? targetPx / base : 1;
    }
    return def.scale > 0 ? def.scale : 1;
  }

  /** 把等待该特效的请求转为灰盒闪烁（资源不可用时调用）。 */
  private drainPendingAsGraybox(def: FxDef): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.key !== def.key) {
        continue;
      }
      this.pending.splice(i, 1);
      this.spawnGraybox(p.x, p.y, def.frame_w * def.scale);
    }
  }

  private load(def: FxDef): void {
    if (this.loading.has(def.key) || this.cache.has(def.key)) {
      return;
    }
    this.loading.add(def.key);
    resources.load(`${def.path}/spriteFrame`, SpriteFrame, (err, sheet) => {
      this.loading.delete(def.key);
      if (err || !sheet) {
        console.warn(`[Fx] 序列帧加载失败（改用灰盒闪烁兜底）: ${def.path}`, err);
        this.failed.add(def.key);
        this.drainPendingAsGraybox(def);
        return;
      }
      const frames = sliceSheet(sheet, def);
      if (frames.length === 0) {
        console.warn(`[Fx] 切帧失败（改用灰盒闪烁兜底）: ${def.path}`);
        this.failed.add(def.key);
        this.drainPendingAsGraybox(def);
        return;
      }
      this.cache.set(def.key, frames);
      console.log(`[Fx] 载入特效 ${def.key}：${frames.length} 帧 ${def.frame_w}x${def.frame_h}`);
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const p = this.pending[i];
        if (p.key !== def.key) {
          continue;
        }
        this.pending.splice(i, 1);
        this.spawn(def, frames, p.x, p.y, p.angle, p.follow, p.totalSec, p.targetPx);
      }
    });
  }

  private spawn(
    def: FxDef, frames: SpriteFrame[], xPx: number, yPx: number, angleDeg: number, follow: boolean,
    totalSecOverride?: number, targetPxOverride?: number,
  ): void {
    const node = PoolManager.get(FX_POOL);
    if (!node) {
      return; // 同屏特效到上限：本次跳过（不做排队，避免雪崩）
    }
    attachToViewLayer(node, 'effect');
    const s = this.scaleOf(def, targetPxOverride);
    node.setScale(s, s, 1);
    // 帧时长 / 在场时长 / 末帧停留全部来自 fx.json；技能可覆盖在场时长（远程类跟随射程时长）
    const frameSec = (def.frame_ms > 0 ? def.frame_ms : 80) / 1000;
    const animSec = frameSec * def.frames;
    const repeat = def.anim_repeat > 0 ? def.anim_repeat : 1;
    const totalSec = totalSecOverride && totalSecOverride > 0
      ? totalSecOverride
      : animSec * repeat + (def.hold_ms > 0 ? def.hold_ms : 0) / 1000;
    const inst = node.getComponent(FxInstance);
    if (!inst) {
      return;
    }
    inst.playFrames(frames, xPx, yPx, def.frame_w, def.frame_h, {
      frameSec,
      totalSec,
      holdSec: (def.hold_ms > 0 ? def.hold_ms : 0) / 1000,
      follow: follow || def.follow,
      scale: s,
      angleDeg,
    });
  }

  /**
   * 灰盒兜底：美术资源不可用时，在技能位置播放一次短暂白色闪烁，
   * 保证「技能确实触发了」始终可见（灰盒先行，文档 1.5）。
   */
  private spawnGraybox(xPx: number, yPx: number, sizePx: number): void {
    const node = PoolManager.get(FX_POOL);
    if (!node) {
      return;
    }
    attachToViewLayer(node, 'effect');
    node.setScale(1, 1, 1);
    node.angle = 0;
    node.getComponent(FxInstance)?.playGraybox(xPx, yPx, sizePx);
  }
}

/**
 * 把一张序列帧图按 `fx.json` 的帧几何切成帧序列。
 * 帧尺寸来自配置（推断自素材的近似方形单元格，可在 fx.json 中随时校正）。
 */
function sliceSheet(sheet: SpriteFrame, def: FxDef): SpriteFrame[] {
  const tex = sheet.texture;
  if (!tex || !(def.frame_w > 0) || !(def.frame_h > 0) || !(def.frames > 0)) {
    return [];
  }
  const out: SpriteFrame[] = [];
  for (let i = 0; i < def.frames; i++) {
    const frame = new SpriteFrame();
    frame.texture = tex;
    frame.rect = new Rect(i * def.frame_w, 0, def.frame_w, def.frame_h);
    frame.originalSize = new Size(def.frame_w, def.frame_h);
    frame.offset = new Vec2(0, 0);
    // 运行时自建帧必须关闭动态合图：否则可能被打进图集而按错误的 uv 采样（表现为"看不到"）
    frame.packable = false;
    out.push(frame);
  }
  return out;
}

export const fxPlayer = new FxPlayer();

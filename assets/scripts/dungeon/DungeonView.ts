import { Color, Graphics, Node, Rect, Size, Sprite, SpriteFrame, UITransform, resources } from 'cc';
import { dataManager } from '../data/DataManager';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { attachToViewLayer, ensureWorldRoot } from '../core/ViewRoot';
import { getWhiteFrame } from '../core/WhiteFrame';
import { DungeonCorridor, DungeonMap, DungeonRoom } from './DungeonTypes';

/**
 * 地宫表现（dungeon 模块的「表现层」）：订阅 on_dungeon_built，把房间 / 走廊 / 出口画到「地面」层。
 *
 * 视觉方案（用户口径，阶段 5 美术替换）：
 *  - **地面** = **单层纯色块**（白图 + 最终色）：普通房草绿 / 走廊更暗 / 出生房稍亮 / 出口房土黄；
 *    ⚠️ **不要**改回 tileset 平铺：`TilesetField` 是带描边的瓦片图，平铺会出现"砖块 / 分隔线"接缝，
 *    且同尺寸下 `Sprite.Type.TILED` 偶发整块不渲染（房间只剩底色）—— 详见 `FLOOR_*_TINT` 注释；
 *  - **出口点** = 金色**三级台阶** + 圆环（半径与 `dungeon.exit_trigger_radius_px` 一致，所见即判定区）；
 *    Boss 层未击杀 Boss 时整体转红（on_exit_lock_changed）；
 *  - **边界美化** = `TilesetNature` 的**树丛**沿房间外框摆放，作为"墙"的视觉边界（用户口径）；
 *    **走廊开口处自动留空**（否则视觉上像"树把通道封死"，尽管碰撞是独立的、仍可通行）。
 *
 * 规则（宪法）：只读地宫数据与配置、不改任何游戏状态；节点只在换层时重建（不在 update 创建/销毁）。
 */

/**
 * 地面配色（**纯色块**，表现常量；这里存的是**最终颜色**，不再乘素材）。
 *
 * ⚠️ 为什么**不用** tileset 平铺（实测踩过，两个顽症）：
 *  ① `TilesetField` 每行是 `[32px 带描边大瓦片][16px 空隙][32px 无缝块]`，取到大瓦片 ⇒ 平铺每 16px 出现描边
 *     （用户看到的"砖块 / 分隔线"）；取无缝块也仍有 1px 边缘杂色 ⇒ 竖条接缝；
 *  ② 同一尺寸下 `Sprite.Type.TILED` 偶发**整块不渲染**（房间只剩兜底底色 ⇒ "房间没颜色"）。
 * 纯色块 ⇒ **一定可见、零接缝、零节点开销**。配色取自素材草地平均色 (172,188,58) 系。
 * 若日后要纹理，请换一张**真正的无缝贴图**再考虑平铺。
 */
const FLOOR_ROOM_TINT = new Color(150, 168, 62, 255);      // 普通房间：草绿
const FLOOR_CORRIDOR_TINT = new Color(118, 134, 50, 255);  // 走廊：更暗，便于区分
const FLOOR_ENTRY_TINT = new Color(172, 186, 80, 255);     // 出生房：稍亮
/** 出口房间地面：土黄 / 橙色（用户口径）。 */
const FLOOR_EXIT_TINT = new Color(198, 150, 78, 255);
/** 出口台阶配色（表现常量）。 */
const STAIR_COLOR = new Color(255, 206, 110, 255);
const STAIR_LOCKED_COLOR = new Color(190, 96, 96, 255);
const STAIR_EDGE_COLOR = new Color(255, 240, 200, 255);
const EXIT_RING_COLOR = new Color(255, 226, 150, 255);
const EXIT_RING_LOCKED_COLOR = new Color(230, 120, 120, 255);
const EXIT_RING_WIDTH_PX = 8;
/** 出口台阶尺寸（px，表现常量）。 */
const STAIR_W_PX = 130;
const STAIR_H_PX = 46;

/**
 * 「树墙」用的树丛矩形（`TilesetNature.png`，均已放大目视确认是**完整一棵树**）。
 *
 * ⚠️ **高度必须是 31**：逐行密度曲线测得（x 0..32 / 32..66 / 160..195 三处一致）——
 * `y = 0..30` 是树（密度 33%→100%），**`y = 31` 完全透明**（树底边），
 * `y ≥ 32` 是图集里**另一排物件**（密度稳定 44%）。
 * 之前写 `h: 40` ⇒ 每棵树都会多带一条"其他素材的边角料"（用户反馈的现象）。
 */
const TREE_RECTS = [
  { x: 0, y: 0, w: 32, h: 31 },    // 圆润绿树
  { x: 32, y: 0, w: 34, h: 31 },   // 深绿塔形树
  { x: 160, y: 0, w: 34, h: 31 },  // 白雪树
];
/** 树沿房间外框摆放的**步距**（px，≈ 树宽 ⇒ 连成树篱）与向外偏移（px）。 */
const TREE_STEP_PX = 30;
const TREE_OFFSET_PX = 10;
/** 走廊开口处的留空半径（px）：树篱遇到走廊连接处要让开，避免"树把通道封死"（纯视觉，不影响碰撞）。 */
const CORRIDOR_GAP_PX = 30;

class DungeonView {
  /** 本层渲染节点（换层时整体销毁并重建）。 */
  private nodes: Node[] = [];
  /** 出口点节点（封锁状态变化时重绘着色）。 */
  private exitNode: Node | null = null;
  /** 出口点半径（px，来自 dungeon.exit_trigger_radius_px）。 */
  private exitRadiusPx = 0;
  /** 树丛贴图（多种随机取用；空 = 无素材，跳过树墙）。 */
  private treeFrames: SpriteFrame[] = [];
  /** 最近一次地宫数据（素材就绪后据此重绘）。 */
  private lastMap: DungeonMap | null = null;

  constructor() {
    eventBus.on(EventNames.on_dungeon_built, this.build, this);
    eventBus.on(EventNames.on_exit_lock_changed, this.onExitLockChanged, this);
    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);

    // 预加载树丛素材（异步一次）：地面已改为纯色块，不再加载 `tileset_field`
    resources.load('bg/tileset_nature/spriteFrame', SpriteFrame, (err, frame) => {
      if (!err && frame) {
        this.treeFrames = TREE_RECTS
          .map((r) => makeSubFrame(frame, r))
          .filter((f): f is SpriteFrame => !!f);
        if (this.treeFrames.length === 0) {
          console.warn('[DungeonView] tileset_nature 已加载但树丛切图失败：跳过树墙');
        }
      } else {
        console.warn('[DungeonView] tileset_nature 缺失：跳过边界树墙');
      }
      this.rebuildIfLoaded();
    });
  }

  /** 素材就绪后按最近一次地宫数据重绘（解决"首层建得比素材早"的时序问题）。 */
  private rebuildIfLoaded(): void {
    if (this.lastMap) {
      this.build(this.lastMap);
    }
  }

  /** 开局（含续玩）：显示世界根，让地宫 / 敌人 / 玩家等玩法视觉重新可见。 */
  private onRunStart(): void {
    const root = ensureWorldRoot();
    if (root) {
      root.active = true;
    }
  }

  /** 结束 / 通关 / 主动退出：隐藏整个世界根，回到纯 UI 界面（避免残留色块）。 */
  private onRunEnd(): void {
    const root = ensureWorldRoot();
    if (root) {
      root.active = false;
    }
  }

  /** 按地宫数据重建画面（走廊在下、房间在上、出口点最上）。 */
  private build(map: DungeonMap): void {
    this.lastMap = map;
    this.clear();
    const dungeon = dataManager.getTable<any>('dungeon');
    this.exitRadiusPx = dungeon.exit_trigger_radius_px;
    // 诊断（用户口径：地宫渲染问题排查用；正常是一行轻量日志）
    console.log(
      `[DungeonView] 建层 L${map.layer}：房间 ${map.rooms.length} / 走廊 ${map.corridors.length}；`
      + `树素材=${this.treeFrames.length} 种（地面=纯色块）`,
    );

    for (const c of map.corridors) {
      this.addFloor(
        `corridor_${c.fromId}_${c.toId}`, c.x, c.y,
        c.horizontal ? c.lengthPx : c.widthPx,
        c.horizontal ? c.widthPx : c.lengthPx,
        FLOOR_CORRIDOR_TINT,
      );
    }
    for (const r of map.rooms) {
      const tint = r.kind === 'entry' ? FLOOR_ENTRY_TINT
        : (r.kind === 'exit' ? FLOOR_EXIT_TINT : FLOOR_ROOM_TINT);
      this.addFloor(`room_${r.id}`, r.x, r.y, r.widthPx, r.heightPx, tint);
    }
    // 边界树墙（用户口径：树要覆盖**房间外框 + 走廊两侧**；走廊开口处留空）
    this.addAllTrees(map);

    const exit = map.rooms.find((r) => r.id === map.exitId);
    if (exit) {
      const locked = dungeon.boss_every_layers > 0 && map.layer % dungeon.boss_every_layers === 0;
      this.exitNode = this.makeExitPoint(exit.x, exit.y, locked);
      this.nodes.push(this.exitNode);
    }
  }

  /** 出口点封锁状态变化（Boss 被击杀后解锁）：重绘为可用色。 */
  private onExitLockChanged(locked: boolean): void {
    if (!this.exitNode || !this.exitNode.isValid) {
      return;
    }
    this.drawExitPoint(locked);
  }

  private clear(): void {
    for (const n of this.nodes) {
      if (n.isValid) {
        n.destroy();
      }
    }
    this.nodes.length = 0;
    this.exitNode = null;
  }

  private makeExitPoint(xPx: number, yPx: number, locked: boolean): Node {
    const node = new Node('exit_point');
    node.addComponent(Graphics);
    attachToViewLayer(node, 'ground', xPx, yPx);
    this.exitNode = node;
    this.drawExitPoint(locked);
    return node;
  }

  /** 出口点 = 判定圈（与逻辑同半径）+ **显眼的三级台阶**（用户口径：出口要足够显眼）。 */
  private drawExitPoint(locked: boolean): void {
    const g = this.exitNode ? this.exitNode.getComponent(Graphics) : null;
    if (!g) {
      return;
    }
    const r = this.exitRadiusPx;
    g.clear();
    // 判定圈
    g.fillColor = locked ? new Color(190, 64, 64, 90) : new Color(255, 196, 84, 90);
    g.circle(0, 0, r);
    g.fill();
    g.lineWidth = EXIT_RING_WIDTH_PX;
    g.strokeColor = locked ? EXIT_RING_LOCKED_COLOR : EXIT_RING_COLOR;
    g.circle(0, 0, r);
    g.stroke();
    // 台阶（下宽上窄，居中）
    g.fillColor = locked ? STAIR_LOCKED_COLOR : STAIR_COLOR;
    const baseY = -STAIR_H_PX / 2;
    for (let i = 0; i < 3; i++) {
      const w = STAIR_W_PX * (1 - i * 0.18);
      const h = STAIR_H_PX / 3;
      g.rect(-w / 2, baseY + i * h, w, h);
      g.fill();
    }
    g.lineWidth = 4;
    g.strokeColor = STAIR_EDGE_COLOR;
    g.rect(-STAIR_W_PX / 2, baseY, STAIR_W_PX, STAIR_H_PX);
    g.stroke();
  }

  /**
   * 画一块地面（房间 / 走廊 / 出口）：**单个纯色块**（白图 + 最终颜色）。
   * 不用 tileset 平铺的原因见 `FLOOR_*_TINT` 处的说明（接缝 + 偶发不渲染）。
   */
  private addFloor(name: string, xPx: number, yPx: number, wPx: number, hPx: number, tint: Color): void {
    const node = new Node(name);
    const sp = node.addComponent(Sprite);
    sp.spriteFrame = getWhiteFrame();
    sp.sizeMode = Sprite.SizeMode.CUSTOM;
    sp.type = Sprite.Type.SIMPLE;
    sp.color = tint;
    const ut = node.getComponent(UITransform);
    if (ut) {
      ut.setContentSize(wPx, hPx);
    }
    attachToViewLayer(node, 'ground', xPx, yPx);
    this.nodes.push(node);
  }

  /** 摆满整层的树篱：房间外框 + 走廊两侧（用户口径：树墙要覆盖走廊边界）。 */
  private addAllTrees(map: DungeonMap): void {
    if (this.treeFrames.length === 0) {
      return;
    }
    for (const r of map.rooms) {
      this.addTreesAroundRoom(r, map);
    }
    for (const c of map.corridors) {
      this.addTreesAlongCorridor(c, map);
    }
  }

  /**
   * 沿一条线段**均匀**摆树（含两端），保证相邻树距不超过 `TREE_STEP_PX`。
   *
   * ⚠️ 必须"按长度算段数"（`round(len / step)` 后按比例取点），**不能**用 `for (d = -half; d <= half; d += step)`
   * 那种按坐标累加的写法：边长不能被步长整除时，累加会在边界处留下**大空档**
   * （用户三次反馈"部分边界没有树篱"，根因就是累加式循环在长边两端留白 + 残余步长不均）。
   */
  private addTreeLine(x0: number, y0: number, x1: number, y1: number, map: DungeonMap): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const segs = Math.max(1, Math.round(len / TREE_STEP_PX));
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      this.tryAddTree(x0 + dx * t, y0 + dy * t, map);
    }
  }

  /** 沿一间房的外框摆树（**四条边各走一遍**，走廊门洞处留空）。 */
  private addTreesAroundRoom(r: DungeonRoom, map: DungeonMap): void {
    const halfW = r.widthPx / 2;
    const halfH = r.heightPx / 2;
    const o = TREE_OFFSET_PX;
    const left = r.x - halfW - o;
    const right = r.x + halfW + o;
    const top = r.y + halfH + o;
    const bottom = r.y - halfH - o;
    this.addTreeLine(left, top, right, top, map);
    this.addTreeLine(left, bottom, right, bottom, map);
    this.addTreeLine(left, bottom, left, top, map);
    this.addTreeLine(right, bottom, right, top, map);
  }

  /** 沿一条走廊的**两侧长边**摆树。 */
  private addTreesAlongCorridor(c: DungeonCorridor, map: DungeonMap): void {
    const half = c.lengthPx / 2;
    const o = c.widthPx / 2 + TREE_OFFSET_PX;
    if (c.horizontal) {
      this.addTreeLine(c.x - half, c.y - o, c.x + half, c.y - o, map);
      this.addTreeLine(c.x - half, c.y + o, c.x + half, c.y + o, map);
    } else {
      this.addTreeLine(c.x - o, c.y - half, c.x - o, c.y + half, map);
      this.addTreeLine(c.x + o, c.y - half, c.x + o, c.y + half, map);
    }
  }

  /**
   * 摆树前的两道避让（用户反馈过一个都不能少）：
   *  1. **走廊开口**处留空 —— 否则视觉上"通道被树封死"；
   *  2. **房间内部**不长树 —— 走廊两侧的树不该冒进房间里。
   */
  private tryAddTree(xPx: number, yPx: number, map: DungeonMap): void {
    if (this.isAtCorridorMouth(xPx, yPx, map) || this.isInsideAnyRoom(xPx, yPx, map)) {
      return;
    }
    this.addTree(xPx, yPx);
  }

  /** 是否落在某条走廊的**两端开口**附近（树要在此留空，让通道看起来是通的）。 */
  private isAtCorridorMouth(xPx: number, yPx: number, map: DungeonMap): boolean {
    for (const c of map.corridors) {
      const half = c.lengthPx / 2;
      const wid = c.widthPx / 2 + CORRIDOR_GAP_PX;
      if (c.horizontal) {
        const nearY = Math.abs(yPx - c.y) <= wid;
        const nearEnd = Math.abs(xPx - (c.x - half)) <= wid || Math.abs(xPx - (c.x + half)) <= wid;
        if (nearY && nearEnd) {
          return true;
        }
      } else {
        const nearX = Math.abs(xPx - c.x) <= wid;
        const nearEnd = Math.abs(yPx - (c.y - half)) <= wid || Math.abs(yPx - (c.y + half)) <= wid;
        if (nearX && nearEnd) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 是否落在任一房间**内部**。
   *
   * ⚠️ 判据**不能带余量**：摆树点本身就在房间边界外 `TREE_OFFSET_PX` 处，
   * 若这里写成 `<= 半宽 + TREE_OFFSET_PX`，边界上的点会被判为"在房间内"而全部跳过
   * —— 实测症状是**上下两侧有树、左右两侧全无**（两轴的比较恰好一真一假），故改为严格小于房间矩形。
   */
  private isInsideAnyRoom(xPx: number, yPx: number, map: DungeonMap): boolean {
    for (const r of map.rooms) {
      if (Math.abs(xPx - r.x) < r.widthPx / 2 && Math.abs(yPx - r.y) < r.heightPx / 2) {
        return true;
      }
    }
    return false;
  }

  /** 摆一棵树：随机取一种树丛，并做 ±8% 的随机缩放，避免整排看起来是同一个贴图。 */
  private addTree(xPx: number, yPx: number): void {
    const node = new Node('tree');
    const sp = node.addComponent(Sprite);
    sp.spriteFrame = this.treeFrames[(Math.random() * this.treeFrames.length) | 0];
    sp.sizeMode = Sprite.SizeMode.RAW;
    const k = 0.92 + Math.random() * 0.16;
    node.setScale(k, k, 1);
    attachToViewLayer(node, 'ground', xPx, yPx);
    this.nodes.push(node);
  }
}

/** 从整图取一个子矩形帧（rect 原点在纹理左上角，与 `sliceFrameByGrid` 保持一致）。 */
function makeSubFrame(src: SpriteFrame, r: { x: number; y: number; w: number; h: number }): SpriteFrame {
  const frame = new SpriteFrame();
  frame.texture = src.texture;
  frame.rect = new Rect(r.x, r.y, r.w, r.h);
  frame.originalSize = new Size(r.w, r.h);
  frame.packable = false;
  return frame;
}

export const dungeonView = new DungeonView();

import { Color, Node, Sprite, UITransform } from 'cc';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { ticker } from '../core/Ticker';
import {
  ensureUiRoot, getGameAreaHeight, getVisibleHeight, getVisibleWidth, UI_EDGE_INSET_PX,
} from '../core/ViewRoot';
import { getWhiteFrame } from '../core/WhiteFrame';
import { makeRoundRectBg } from './UiKit';
import { playerRef } from '../entities/Player';
import { DungeonMap } from '../dungeon/DungeonTypes';

/**
 * 小地图（视图层）。
 *
 * 背景：一层地宫跨度 2900~4100px，一屏（1280×720）装不下，必须有小地图看全貌与出口方向
 * （文档 4.7 小地图图标；文档 2.3 出口视觉引导）。
 *
 * 规则：
 *  - **战争迷雾**：只有「曾经出现在画面里」的房间/走廊才会在地图上揭示（未探索区域不显示）；
 *  - 玩家光点恒在最上层（否则会被后画的地图块盖住）；
 *  - 只读地宫数据与玩家位置，不改任何游戏状态；地图块仅在换层时重建（不在 update 中创建/销毁）。
 */

/** 尺寸与配色（表现常量，非游戏数值；用户多轮反馈"右上角 UI 继续扩大"）。 */
const PANEL_W = 380;
const PANEL_H = 280;
const PANEL_MARGIN = UI_EDGE_INSET_PX;
const PANEL_PAD = 12;
/** 底衬（圆角、半透明）。不透明度从 170 降到 130：原值在画面上"压得重"（用户反馈遮挡画面）。 */
const BG_COLOR = new Color(10, 12, 18, 130);
const BG_RADIUS = 10;
const CORRIDOR_COLOR = new Color(92, 92, 104, 255);
const ROOM_COLOR = new Color(150, 150, 160, 255);
const ENTRY_COLOR = new Color(110, 190, 210, 255);
const EXIT_COLOR = new Color(255, 196, 84, 255);
const PLAYER_COLOR = new Color(255, 255, 255, 255);
const PLAYER_DOT_PX = 8;

/** 地图块（世界矩形 + 节点，用于迷雾揭示）。 */
interface MinimapCell {
  node: Node;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

class Minimap {
  private root: Node | null = null;
  private plot: Node | null = null;
  private cells: MinimapCell[] = [];
  private playerDot: Node | null = null;
  private scale = 1;
  private centerX = 0;
  private centerY = 0;
  /** 视野半宽 / 半高（px）：相机跟随角色，故视野 = 屏幕（设计分辨率） */
  private viewHalfW = 0;
  private viewHalfH = 0;

  constructor() {
    eventBus.on(EventNames.on_dungeon_built, this.build, this);
    eventBus.on(EventNames.on_run_start, this.show, this);
    eventBus.on(EventNames.on_run_end, this.hide, this);
    ticker.add(this.tick);
  }

  /** 新一层地宫：建面板、算缩放、铺地图块（初始全部未揭示）。 */
  private build(map: DungeonMap): void {
    if (!this.ensurePanel()) {
      return;
    }
    this.clearCells();

    const bounds = this.computeBounds(map);
    const spanX = Math.max(1, bounds.maxX - bounds.minX);
    const spanY = Math.max(1, bounds.maxY - bounds.minY);
    this.scale = Math.min((PANEL_W - PANEL_PAD * 2) / spanX, (PANEL_H - PANEL_PAD * 2) / spanY);
    this.centerX = (bounds.minX + bounds.maxX) / 2;
    this.centerY = (bounds.minY + bounds.maxY) / 2;

    for (const c of map.corridors) {
      this.addCell(
        `c_${c.fromId}_${c.toId}`, c.x, c.y,
        c.horizontal ? c.lengthPx : c.widthPx,
        c.horizontal ? c.widthPx : c.lengthPx,
        CORRIDOR_COLOR,
      );
    }
    for (const r of map.rooms) {
      const color = r.kind === 'entry' ? ENTRY_COLOR : (r.kind === 'exit' ? EXIT_COLOR : ROOM_COLOR);
      this.addCell(`r_${r.id}`, r.x, r.y, r.widthPx, r.heightPx, color);
    }

    // 玩家光点必须在最上层：地图块是后加的，会让光点被盖住
    if (this.playerDot && this.plot) {
      this.playerDot.setSiblingIndex(this.plot.children.length - 1);
      this.playerDot.active = true;
      this.updatePlayerDot();
      this.revealAround();
    }
  }

  private show(): void {
    if (this.root && this.root.isValid) {
      this.root.active = true;
    }
  }

  private hide(): void {
    if (this.root && this.root.isValid) {
      this.root.active = false;
    }
  }

  /** 面板（背景 + 绘图容器 + 玩家光点）只在首次需要时创建。 */
  private ensurePanel(): boolean {
    if (this.root && this.root.isValid) {
      return true;
    }
    const uiRoot = ensureUiRoot();
    if (!uiRoot) {
      return false;
    }
    // 竖屏分区：小地图贴**游戏画面区**的右上角（不是屏幕右上角 —— 那是操作区方向）。
    // 视野尺寸也改用游戏区尺寸（迷雾揭示按"画面里出现过"判定）。
    const halfW = getVisibleWidth() / 2;
    const topY = getVisibleHeight() / 2;
    this.viewHalfW = halfW;
    this.viewHalfH = getGameAreaHeight() / 2;

    this.root = new Node('Minimap');
    this.root.layer = uiRoot.layer;
    uiRoot.addChild(this.root);
    this.root.setPosition(halfW - PANEL_W / 2 - PANEL_MARGIN, topY - PANEL_H / 2 - PANEL_MARGIN, 0);

    // 底衬改**圆角**（直角黑块压得重）：用 Graphics 绘制，其余地图块仍走 Sprite
    makeRoundRectBg(this.root, 'bg', 0, 0, PANEL_W, PANEL_H, BG_RADIUS, BG_COLOR);

    this.plot = new Node('plot');
    this.plot.layer = uiRoot.layer;
    this.root.addChild(this.plot);

    this.playerDot = this.makeRect('player', PLAYER_DOT_PX, PLAYER_DOT_PX, PLAYER_COLOR);
    this.plot.addChild(this.playerDot);
    return true;
  }

  private clearCells(): void {
    for (const cell of this.cells) {
      if (cell.node.isValid) {
        cell.node.destroy();
      }
    }
    this.cells.length = 0;
  }

  /** 添加地图块（世界矩形用于迷雾判定；初始未揭示）。 */
  private addCell(name: string, xPx: number, yPx: number, wPx: number, hPx: number, color: Color): void {
    if (!this.plot) {
      return;
    }
    const node = this.makeRect(name, Math.max(2, wPx * this.scale), Math.max(2, hPx * this.scale), color);
    node.setPosition((xPx - this.centerX) * this.scale, (yPx - this.centerY) * this.scale, 0);
    node.active = false; // 未探索：不揭示
    this.plot.addChild(node);
    this.cells.push({
      node,
      minX: xPx - wPx / 2,
      maxX: xPx + wPx / 2,
      minY: yPx - hPx / 2,
      maxY: yPx + hPx / 2,
    });
  }

  private makeRect(name: string, wPx: number, hPx: number, color: Color): Node {
    const node = new Node(name);
    const sp = node.addComponent(Sprite);
    sp.spriteFrame = getWhiteFrame();
    sp.sizeMode = Sprite.SizeMode.CUSTOM;
    sp.color = color;
    const ut = node.getComponent(UITransform);
    if (ut) {
      ut.setContentSize(wPx, hPx);
    }
    return node;
  }

  private tick = (): void => {
    if (!this.root || !this.root.isValid || !this.root.active) {
      return;
    }
    this.updatePlayerDot();
    this.revealAround();
  };

  /**
   * 战争迷雾：把「已进入视野矩形」的房间/走廊揭示出来。
   * 视野 = 角色位置 ± 屏幕半宽/半高（相机严格跟随角色，故等价于"画面里出现过"）。
   */
  private revealAround(): void {
    if (!playerRef) {
      return;
    }
    const px = playerRef.position.x;
    const py = playerRef.position.y;
    const minX = px - this.viewHalfW;
    const maxX = px + this.viewHalfW;
    const minY = py - this.viewHalfH;
    const maxY = py + this.viewHalfH;
    for (const cell of this.cells) {
      if (cell.node.active) {
        continue;
      }
      if (cell.maxX < minX || cell.minX > maxX || cell.maxY < minY || cell.minY > maxY) {
        continue;
      }
      cell.node.active = true;
    }
  }

  private updatePlayerDot(): void {
    if (!this.playerDot || !this.playerDot.isValid || !playerRef) {
      return;
    }
    const p = playerRef.position;
    this.playerDot.setPosition((p.x - this.centerX) * this.scale, (p.y - this.centerY) * this.scale, 0);
  }

  private computeBounds(map: DungeonMap): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of map.rooms) {
      minX = Math.min(minX, r.x - r.widthPx / 2);
      maxX = Math.max(maxX, r.x + r.widthPx / 2);
      minY = Math.min(minY, r.y - r.heightPx / 2);
      maxY = Math.max(maxY, r.y + r.heightPx / 2);
    }
    return { minX, minY, maxX, maxY };
  }
}

export const minimap = new Minimap();

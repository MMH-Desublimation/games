/**
 * 地宫数据结构（纯类型，无引擎/配置依赖）。
 * 设计依据：文档 2.3（房间图 + 走廊连接，不用 BSP；1 出生房 + 1 出口大房 + 普通房）。
 *
 * 坐标约定：地宫逻辑坐标（px，y 向上），与渲染/相机无关；
 * 渲染接入时由表现层负责映射到屏幕（世界根节点偏移）。
 */

/** 房间类型。 */
export type RoomKind = 'entry' | 'normal' | 'exit';

/** 一间房。 */
export interface DungeonRoom {
  id: number;
  kind: RoomKind;
  /** 房间中心（逻辑坐标，px）。 */
  x: number;
  y: number;
  /** 房间尺寸（px）。 */
  widthPx: number;
  heightPx: number;
  /** 相邻房间 id 列表（无向图，升序，便于比对与调试）。 */
  neighbors: number[];
}

/** 一条走廊（连接两间相邻房，轴对齐矩形）。 */
export interface DungeonCorridor {
  fromId: number;
  toId: number;
  /** 走廊中心（逻辑坐标，px）。 */
  x: number;
  y: number;
  /** true = 水平走廊（沿 x 展开），false = 垂直走廊（沿 y 展开）。 */
  horizontal: boolean;
  /** 走廊宽度（px，= dungeon.corridor_width_px）。 */
  widthPx: number;
  /** 走廊长度（px，沿主轴）。 */
  lengthPx: number;
}

/** 一层地宫。 */
export interface DungeonMap {
  layer: number;
  /** 生成本层所用随机种子（预生成 + 随机种子，便于复现问题）。 */
  seed: number;
  rooms: DungeonRoom[];
  corridors: DungeonCorridor[];
  entryId: number;
  exitId: number;
}

/** 生成器入参（由 DungeonService 从 dungeon.json 读取，纯逻辑层不直接碰配置）。 */
export interface DungeonConfig {
  /** 房间数量下限 / 上限（文档 2.3：8–15 间）。 */
  roomsMin: number;
  roomsMax: number;
  /** 普通房尺寸（px）。 */
  roomNormalPx: number;
  /** 出口大房尺寸（px）。 */
  roomBigPx: number;
  /** 走廊宽度（px）。 */
  corridorWidthPx: number;
  /**
   * 额外环路比例（0~1）。
   * 走廊 = 生成树边（保证连通且形态像地宫）+ 少量回环；
   * 比例过高会退化成「四通八达的小房间」（参考 RPG Maker MZ 自动地牢的树 + 少量环路）。
   */
  corridorLoopRatio: number;
  /** 连通性校验失败后的最大重生成次数。 */
  maxRegenerate: number;
}

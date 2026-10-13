import { DungeonMap } from './DungeonTypes';

/**
 * 地宫可行走区域（纯函数，无引擎依赖，可离线自检）。
 *
 * 可走范围 = 房间矩形 ∪ 走廊矩形。
 * 判定按实体半径内缩（贴墙不越界）；走廊沿**主轴外扩**半径，使其与房间门口互相重叠，
 * 避免门口出现「谁都不可走」的缝隙而把角色卡住。
 */

let currentMap: DungeonMap | null = null;

/** 设置当前地宫（换层时由地宫系统调用；null 表示不做移动限制）。 */
export function setCollisionMap(map: DungeonMap | null): void {
  currentMap = map;
}

/** 是否可行走（radiusPx = 实体半径，0 表示只测中心点）。 */
export function isWalkableAt(xPx: number, yPx: number, radiusPx = 0): boolean {
  const map = currentMap;
  if (!map) {
    return true; // 未开局：不做限制
  }
  for (let i = 0; i < map.rooms.length; i++) {
    const r = map.rooms[i];
    if (Math.abs(xPx - r.x) <= r.widthPx / 2 - radiusPx && Math.abs(yPx - r.y) <= r.heightPx / 2 - radiusPx) {
      return true;
    }
  }
  for (let i = 0; i < map.corridors.length; i++) {
    const c = map.corridors[i];
    const halfWidth = c.widthPx / 2 - radiusPx;
    if (halfWidth < 0) {
      continue; // 实体比走廊还宽：该走廊不可通行（退化情形）
    }
    const halfLength = c.lengthPx / 2 + radiusPx; // 外扩：与房间门口无缝衔接
    const dx = Math.abs(xPx - c.x);
    const dy = Math.abs(yPx - c.y);
    if (c.horizontal ? (dx <= halfLength && dy <= halfWidth) : (dx <= halfWidth && dy <= halfLength)) {
      return true;
    }
  }
  return false;
}

/** 复用的结果对象，避免逐帧分配（宪法 6.10）。 */
const scratch = { x: 0, y: 0 };

/**
 * 带沿墙滑动的移动求解：优先整体移动，被挡则尝试单轴（贴墙滑行手感）。
 * @returns 复用的结果对象（调用方应立即读取，不要长期持有）
 */
export function resolveWalkableMove(
  xPx: number, yPx: number, targetX: number, targetY: number, radiusPx: number,
): Readonly<{ x: number; y: number }> {
  if (isWalkableAt(targetX, targetY, radiusPx)) {
    scratch.x = targetX;
    scratch.y = targetY;
  } else if (isWalkableAt(targetX, yPx, radiusPx)) {
    scratch.x = targetX;
    scratch.y = yPx;
  } else if (isWalkableAt(xPx, targetY, radiusPx)) {
    scratch.x = xPx;
    scratch.y = targetY;
  } else {
    scratch.x = xPx;
    scratch.y = yPx;
  }
  return scratch;
}

/** 复用的脱困结果对象（含是否发生修正）。 */
const nudgeScratch = { x: 0, y: 0, moved: false };

/**
 * 把「落在不可行走处」的实体拨回最近的可行走点（脱困）。
 *
 * 为什么需要：位移类技能（玩家冲刺 / Boss 冲锋）都走 `resolveWalkableMove`，理论上不穿墙；
 * 但地宫存在**窄缝 / 门口夹角**等退化情形，实体一旦落在不可行走处，
 * 后续 `resolveWalkableMove` 会因「起点非法」而永远返回原地 ⇒ 表现为
 * 「**冲刺突进过猛，卡进墙边无法移动**」「Boss 卡住后原地反复抖/打转」。
 * 本函数逐帧兜底：不可行走时按同心圆向外找最近的可走点（命中即返回）。
 *
 * @returns 复用的结果对象（调用方立即读取）；`moved` 表示是否发生了修正
 */
export function nudgeToWalkable(
  xPx: number, yPx: number, radiusPx: number, stepPx = 8, maxRings = 16,
): Readonly<{ x: number; y: number; moved: boolean }> {
  if (isWalkableAt(xPx, yPx, radiusPx)) {
    nudgeScratch.x = xPx;
    nudgeScratch.y = yPx;
    nudgeScratch.moved = false;
    return nudgeScratch;
  }
  for (let ring = 1; ring <= maxRings; ring++) {
    const r = ring * stepPx;
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i;
      const nx = xPx + Math.cos(a) * r;
      const ny = yPx + Math.sin(a) * r;
      if (isWalkableAt(nx, ny, radiusPx)) {
        nudgeScratch.x = nx;
        nudgeScratch.y = ny;
        nudgeScratch.moved = true;
        return nudgeScratch;
      }
    }
  }
  nudgeScratch.x = xPx;
  nudgeScratch.y = yPx;
  nudgeScratch.moved = false;
  return nudgeScratch;
}

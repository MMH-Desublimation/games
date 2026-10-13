import { Random } from '../utils/Random';
import { farthestRoomId, isFullyConnected } from './Connectivity';
import { DungeonConfig, DungeonCorridor, DungeonMap, DungeonRoom, RoomKind } from './DungeonTypes';

/** 槽位四邻域（用于房间图生长与邻接判定）。 */
const SLOT_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 重生成时使用的种子步进（质数，避免不同尝试落到相近布局）。 */
const RETRY_SEED_STEP = 7919;

/** 边编码基数（槽位下标 < 该值，保证 a*BASE+b 唯一）。 */
const EDGE_KEY_BASE = 1024;

/**
 * 生成一层地宫（纯函数：无引擎、无配置依赖，可离线自检）。
 *
 * 算法（文档 2.3：房间图 + 走廊连接，不用 BSP；预生成 + 随机种子）：
 *  1) 把地图划为**等距槽位**（槽距 = 大房尺寸 + 走廊宽度），任何房型组合都不会重叠；
 *  2) 从随机槽位做**随机生长**，取 rooms.min~max 个相连槽位（记录父子关系）；
 *  3) 走廊 = **生成树边**（保证连通、形态像地宫）+ **少量环路**（corridor_loop_ratio），
 *     —— 不再把「所有相邻房间」都连起来，否则退化成四通八达的小房间（参考 RPG Maker MZ 自动地牢）；
 *  4) 入口 = 生长起点；出口 = 距入口 BFS 最远的房（远但有通路，不藏死路）；
 *  5) 出口房为大房，其余为普通房；
 *  6) 用 Connectivity 校验（入口可达全部房间 + 出口可达），失败则换种子重生成。
 */
export function generateDungeon(layer: number, seed: number, cfg: DungeonConfig): DungeonMap {
  const attempts = Math.max(1, cfg.maxRegenerate + 1);
  let lastMap: DungeonMap | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const map = buildOnce(layer, (seed + attempt * RETRY_SEED_STEP) >>> 0, cfg);
    if (isFullyConnected(map)) {
      return map;
    }
    lastMap = map;
  }
  console.error(`[Dungeon] 层 ${layer} 连续 ${attempts} 次生成均未通过连通性校验（按构造不应发生），返回最后一次结果`);
  return lastMap as DungeonMap;
}

/** 单次生成（不做校验，由 generateDungeon 负责校验与重试）。 */
function buildOnce(layer: number, seed: number, cfg: DungeonConfig): DungeonMap {
  const rng = new Random(seed || 1);
  const roomCount = rng.int(cfg.roomsMin, cfg.roomsMax);
  const cols = Math.ceil(Math.sqrt(roomCount));
  const rows = Math.ceil(roomCount / cols);
  const cellPx = cfg.roomBigPx + cfg.corridorWidthPx;

  const startIdx = rng.int(0, rows - 1) * cols + rng.int(0, cols - 1);
  const grown = growSlots(startIdx, roomCount, rows, cols, rng);
  const slots = grown.slots;
  const occupancy = new Set<number>(slots);

  // 所有「相邻槽位对」（四邻域，且 a < b）
  const adjacentPairs: Array<[number, number]> = [];
  for (const idx of slots) {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    for (const [dr, dc] of SLOT_NEIGHBORS) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) {
        continue;
      }
      const nIdx = nr * cols + nc;
      if (!occupancy.has(nIdx) || idx >= nIdx) {
        continue;
      }
      adjacentPairs.push([idx, nIdx]);
    }
  }

  // 边集 = 生成树边 + 少量环路
  const chosenEdges = new Set<number>();
  const connect = (a: number, b: number): void => {
    chosenEdges.add(Math.min(a, b) * EDGE_KEY_BASE + Math.max(a, b));
  };
  for (const [child, parent] of grown.parentOf) {
    connect(child, parent);
  }
  for (const [a, b] of adjacentPairs) {
    if (chosenEdges.has(a * EDGE_KEY_BASE + b)) {
      continue;
    }
    if (rng.next() < cfg.corridorLoopRatio) {
      connect(a, b);
    }
  }

  const neighborsOf = new Map<number, number[]>();
  for (const idx of slots) {
    neighborsOf.set(idx, []);
  }
  for (const [a, b] of adjacentPairs) {
    if (!chosenEdges.has(a * EDGE_KEY_BASE + b)) {
      continue;
    }
    neighborsOf.get(a)?.push(b);
    neighborsOf.get(b)?.push(a);
  }
  for (const list of neighborsOf.values()) {
    list.sort((x, y) => x - y);
  }

  const rooms: DungeonRoom[] = slots.map((idx) => {
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const kind: RoomKind = 'normal';
    return {
      id: idx,
      kind,
      x: col * cellPx + cellPx / 2,
      y: row * cellPx + cellPx / 2,
      widthPx: cfg.roomNormalPx,
      heightPx: cfg.roomNormalPx,
      neighbors: neighborsOf.get(idx) ?? [],
    };
  });
  const byId = new Map<number, DungeonRoom>(rooms.map((r) => [r.id, r]));

  // slots[0] 恒为生长起点
  const entryId = slots[0];
  const exitId = farthestRoomId({ layer, seed, rooms, corridors: [], entryId, exitId: entryId }, entryId);
  for (const room of rooms) {
    if (room.id === entryId) {
      room.kind = 'entry';
    } else if (room.id === exitId) {
      room.kind = 'exit';
      room.widthPx = cfg.roomBigPx;
      room.heightPx = cfg.roomBigPx;
    }
  }

  const corridors: DungeonCorridor[] = [];
  for (const [a, b] of adjacentPairs) {
    if (!chosenEdges.has(a * EDGE_KEY_BASE + b)) {
      continue;
    }
    const from = byId.get(a);
    const to = byId.get(b);
    if (!from || !to) {
      continue;
    }
    const corridor = buildCorridor(from, to, cfg.corridorWidthPx);
    if (corridor) {
      corridors.push(corridor);
    }
  }

  return { layer, seed, rooms, corridors, entryId, exitId };
}

/**
 * 从起点做随机生长，取 count 个四邻相连的槽位，并记录每个槽位的「生长父节点」。
 * 返回数组第 0 个元素恒为起点（用作出生房）；父子关系即生成树边。
 */
function growSlots(
  startIdx: number, count: number, rows: number, cols: number, rng: Random,
): { slots: number[]; parentOf: Map<number, number> } {
  const slots: number[] = [startIdx];
  const seen = new Set<number>([startIdx]);
  const parentOf = new Map<number, number>();
  const frontier: number[] = [startIdx];
  while (slots.length < count && frontier.length > 0) {
    const pick = rng.int(0, frontier.length - 1);
    const from = frontier[pick];
    const row = Math.floor(from / cols);
    const col = from % cols;
    const candidates: number[] = [];
    for (const [dr, dc] of SLOT_NEIGHBORS) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) {
        continue;
      }
      const idx = nr * cols + nc;
      if (!seen.has(idx)) {
        candidates.push(idx);
      }
    }
    if (candidates.length === 0) {
      frontier.splice(pick, 1);
      continue;
    }
    const next = candidates[rng.int(0, candidates.length - 1)];
    seen.add(next);
    slots.push(next);
    parentOf.set(next, from);
    frontier.push(next);
  }
  return { slots, parentOf };
}

/** 由两间相邻房生成轴对齐走廊（边缘到边缘；长度非正时返回 null）。 */
function buildCorridor(from: DungeonRoom, to: DungeonRoom, widthPx: number): DungeonCorridor | null {
  if (Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)) {
    const left = from.x <= to.x ? from : to;
    const right = from.x <= to.x ? to : from;
    const startX = left.x + left.widthPx / 2;
    const endX = right.x - right.widthPx / 2;
    const lengthPx = endX - startX;
    if (lengthPx <= 0) {
      return null;
    }
    return {
      fromId: from.id, toId: to.id,
      x: (startX + endX) / 2, y: (left.y + right.y) / 2,
      horizontal: true, widthPx, lengthPx,
    };
  }
  const bottom = from.y <= to.y ? from : to;
  const top = from.y <= to.y ? to : from;
  const startY = bottom.y + bottom.heightPx / 2;
  const endY = top.y - top.heightPx / 2;
  const lengthPx = endY - startY;
  if (lengthPx <= 0) {
    return null;
  }
  return {
    fromId: from.id, toId: to.id,
    x: (bottom.x + top.x) / 2, y: (startY + endY) / 2,
    horizontal: false, widthPx, lengthPx,
  };
}

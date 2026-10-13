import { DungeonMap } from './DungeonTypes';

/**
 * 连通性校验（纯函数，文档 2.3：生成后必须校验出口可达，失败则重生成）。
 * 实现：以房间邻接表做 BFS，不依赖引擎。
 */

/** 从起始房做 BFS，返回「房间 id -> 步数」。 */
export function bfsDistances(map: DungeonMap, fromId: number): Map<number, number> {
  const adjacency = new Map<number, number[]>();
  for (const room of map.rooms) {
    adjacency.set(room.id, room.neighbors);
  }
  const dist = new Map<number, number>();
  if (!adjacency.has(fromId)) {
    return dist;
  }
  dist.set(fromId, 0);
  const queue: number[] = [fromId];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const next = adjacency.get(id) ?? [];
    for (const nid of next) {
      if (dist.has(nid)) {
        continue;
      }
      dist.set(nid, (dist.get(id) ?? 0) + 1);
      queue.push(nid);
    }
  }
  return dist;
}

/** 从入口出发可到达的房间集合。 */
export function collectReachable(map: DungeonMap, fromId = map.entryId): Set<number> {
  return new Set(bfsDistances(map, fromId).keys());
}

/**
 * 校验：入口可到达全部房间，且出口可达（文档 2.3 硬要求）。
 */
export function isFullyConnected(map: DungeonMap): boolean {
  if (map.rooms.length === 0) {
    return false;
  }
  const reachable = collectReachable(map, map.entryId);
  return reachable.size === map.rooms.length && reachable.has(map.exitId);
}

/** 距入口最远的房间 id（用于挑出口房：远但有通路，不藏死路）。 */
export function farthestRoomId(map: DungeonMap, fromId = map.entryId): number {
  const dist = bfsDistances(map, fromId);
  let bestId = fromId;
  let bestDist = -1;
  for (const [id, d] of dist) {
    if (d > bestDist || (d === bestDist && id < bestId)) {
      bestId = id;
      bestDist = d;
    }
  }
  return bestId;
}

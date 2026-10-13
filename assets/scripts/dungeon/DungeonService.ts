import { dataManager } from '../data/DataManager';
import { generateDungeon } from './DungeonGenerator';
import { DungeonConfig, DungeonMap } from './DungeonTypes';

/**
 * 地宫服务（dungeon 模块对外入口）。
 * 职责边界（文档 4.2）：只做「生成与校验」，不管战斗、不碰节点渲染。
 * 唯一与配置表耦合的位置：把 dungeon.json 翻译成 DungeonConfig，纯逻辑层不直接读配置。
 */
class DungeonService {
  private config: DungeonConfig | null = null;

  /** 读取并缓存生成参数（配置就绪后调用；单位即 px，无需换算）。 */
  readConfig(): DungeonConfig {
    if (this.config) {
      return this.config;
    }
    const d = dataManager.getTable<any>('dungeon');
    this.config = {
      roomsMin: d.rooms.min,
      roomsMax: d.rooms.max,
      roomNormalPx: d.room_size_px.normal,
      roomBigPx: d.room_size_px.big,
      corridorWidthPx: d.corridor_width_px,
      corridorLoopRatio: d.corridor_loop_ratio,
      maxRegenerate: d.connectivity.max_regenerate,
    };
    return this.config;
  }

  /**
   * 生成第 `layer` 层地宫。
   * @param runSeed 本局随机种子（`gameState.getRunSeed()`）。
   *   之前只用层号推导种子 ⇒ **每局同一层的布局完全一样**（用户反馈"前几关地图基本一样"）；
   *   现在把本局种子混入：同一层在**不同局**里布局不同，同一局内仍稳定可复现（便于排查）。
   */
  generateLayer(layer: number, runSeed = 0): DungeonMap {
    return generateDungeon(layer, seedOfLayer(layer, runSeed), this.readConfig());
  }
}

/** 层号 + 本局种子 -> 稳定种子（乘法散列：避免相邻层雷同，且每局不同）。 */
function seedOfLayer(layer: number, runSeed: number): number {
  const base = (Math.imul(layer, 0x27d4eb2d) ^ 0x9e3779b9) >>> 0;
  return (base ^ Math.imul(runSeed >>> 0, 0x85ebca6b)) >>> 0;
}

export const dungeonService = new DungeonService();

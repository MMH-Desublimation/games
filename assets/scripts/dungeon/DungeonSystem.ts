import { dataManager } from '../data/DataManager';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { ticker } from '../core/Ticker';
import { playerRef } from '../entities/Player';
import { setCollisionMap } from './DungeonCollision';
import { DungeonMap, DungeonRoom } from './DungeonTypes';

/**
 * 地宫进程系统（dungeon）：把「玩家当前在哪间房 / 是否踏入出口点」翻译成事件，驱动刷怪与关卡推进。
 *
 *  - 进入新房间            -> on_room_entered(room)（实体层据此按房刷怪）
 *  - 踏入出口房的**出口点** -> on_exit_reached（流程层据此推进下一层 / 结算）
 *  - Boss 层出口封锁状态变化 -> on_exit_lock_changed(locked)（表现层据此着色）
 *
 * 关键规则：
 *  - 「出口点」是出口大房中心的一个**圆形触发区**（半径 = dungeon.exit_trigger_radius_px），
 *    进入出口房本身不再推进关卡——玩家必须在房内走到出口点（文档 2.3 出口规则）；
 *  - Boss 层（layer % boss_every_layers == 0）出口点**先封锁**，本层 Boss 被击杀（on_boss_died）后解锁，
 *    避免玩家绕过 Boss 直接通关（文档 2.5：Boss 战是本 Run 的节奏高潮与终止点）；
 *  - 模块级单例，逐帧逻辑经 core/ticker 驱动（宪法 6.13：不与其他模块直接引用实例）；
 *    只读玩家位置，不改任何状态（状态变更都在各自模块内完成）。
 */
class DungeonSystem {
  private map: DungeonMap | null = null;
  private visitedRooms: Set<number> = new Set();
  private exitReached = false;
  /** 出口点触发半径（px，dungeon.exit_trigger_radius_px）。 */
  private exitRadiusPx = 0;
  /** 每几层出现一次 Boss（dungeon.boss_every_layers）。 */
  private bossEveryLayers = 1;
  /** Boss 层出口封锁中（击杀 Boss 后解锁）。 */
  private exitLocked = false;
  private exitRoom: DungeonRoom | null = null;

  constructor() {
    eventBus.on(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.on(EventNames.on_dungeon_built, this.onDungeonBuilt, this);
    eventBus.on(EventNames.on_boss_died, this.onBossDied, this);
    ticker.add(this.tick);
  }

  private onConfigLoaded(): void {
    const dungeon = dataManager.getTable<any>('dungeon');
    this.exitRadiusPx = dungeon.exit_trigger_radius_px;
    this.bossEveryLayers = dungeon.boss_every_layers;
  }

  /** 新一层地宫：记录地图、同步可行走区域、重置访问状态与出口封锁。 */
  private onDungeonBuilt(map: DungeonMap): void {
    this.map = map;
    setCollisionMap(map);
    this.visitedRooms.clear();
    this.exitReached = false;
    this.exitRoom = map.rooms.find((r) => r.id === map.exitId) ?? null;
    this.exitLocked = this.bossEveryLayers > 0 && map.layer % this.bossEveryLayers === 0;
    eventBus.emit(EventNames.on_exit_lock_changed, this.exitLocked);
  }

  /** 本层 Boss 被击杀：解锁出口点。 */
  private onBossDied(): void {
    if (!this.exitLocked) {
      return;
    }
    this.exitLocked = false;
    eventBus.emit(EventNames.on_exit_lock_changed, false);
  }

  private tick = (): void => {
    // 非进行中（开局前 / 结算界面）不判定房间与出口
    if (!this.map || !playerRef || !gameState.isRunActive()) {
      return;
    }
    const px = playerRef.position.x;
    const py = playerRef.position.y;
    const room = this.roomAt(px, py);
    if (room && !this.visitedRooms.has(room.id)) {
      this.visitedRooms.add(room.id);
      eventBus.emit(EventNames.on_room_entered, room);
    }
    if (this.exitReached || this.exitLocked || !this.exitRoom) {
      return; // 已推进 / 出口封锁中（Boss 未死）/ 无出口房
    }
    const dx = px - this.exitRoom.x;
    const dy = py - this.exitRoom.y;
    if (dx * dx + dy * dy > this.exitRadiusPx * this.exitRadiusPx) {
      return; // 只在出口点内才推进
    }
    this.exitReached = true;
    eventBus.emit(EventNames.on_exit_reached);
  };

  /** 玩家所在房间（不在任何房间内 = 在走廊）。 */
  private roomAt(xPx: number, yPx: number): DungeonRoom | null {
    if (!this.map) {
      return null;
    }
    const rooms = this.map.rooms;
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      if (Math.abs(xPx - r.x) <= r.widthPx / 2 && Math.abs(yPx - r.y) <= r.heightPx / 2) {
        return r;
      }
    }
    return null;
  }
}

export const dungeonSystem = new DungeonSystem();

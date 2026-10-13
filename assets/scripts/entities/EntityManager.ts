import { _decorator, Component, Layers, Node, Prefab, Sprite, resources, SpriteFrame } from 'cc';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { PoolManager } from '../core/PoolManager';
import { gameState } from '../core/GameState';
import { attachToViewLayer, setLayerRecursive } from '../core/ViewRoot';
import { sliceFrameByGrid } from '../core/SpriteSheet';
import { dataManager } from '../data/DataManager';
import { Random } from '../utils/Random';
import { MathUtils } from '../utils/MathUtils';
import { bfsDistances } from '../dungeon/Connectivity';
import { isWalkableAt } from '../dungeon/DungeonCollision';
import { layerRisk } from '../dungeon/LayerRisk';
import { DungeonCorridor, DungeonMap, DungeonRoom } from '../dungeon/DungeonTypes';
import { BossBehavior } from './BossBehavior';
import { Enemy, EnemyKind } from './Enemy';
import { enemyVariants } from './EnemyVariants';
import { playerRef } from './Player';

const { ccclass, property } = _decorator;

const POOL_KEY = 'enemy';

/** 供战斗系统获取存活敌人（避免场景查询）。 */
export let entityManagerRef: EntityManager | null = null;

/**
 * 实体管理（实体层）：敌人的**预置 / 唤醒 / 休眠 / 回收**。
 *
 * 生成策略（避免"进房瞬间凭空冒怪"）：
 *  1) 预置：地宫生成时、以及玩家每次进入新房间时，为「当前房 + preload_room_hops 跳内的房 + 相邻走廊」
 *     预先创建敌人（保持休眠，不可见、不更新）；
 *  2) 唤醒：玩家进入 activate_radius_px 内且当前激活数 < max_concurrent 时激活（此时早已在该房间内）；
 *  3) 休眠：玩家离开 deactivate_radius_px 后重新休眠（保留位置，避免跨房间长尾追击）；
 *  4) 回收：死亡或换层时归还对象池（宪法 6.5：全程池化）。
 *
 * 规则（文档 4.7）：本节点挂在「敌人」层；坐标统一为世界根坐标。
 * 美术：CC0 Ninja Adventure，行走图按 enemies.json 的 sheet_* 网格切帧（禁止硬编码帧数）。
 */
@ccclass('EntityManager')
export class EntityManager extends Component {
  @property(Prefab) enemyPrefab: Prefab = null!;
  @property(Node) playerNode: Node = null!;

  /** 已激活敌人「逻辑体」节点（供战斗系统使用）。 */
  private aliveNodes: Node[] = [];
  /** 已预置但休眠的敌人节点。 */
  private dormantNodes: Node[] = [];
  /** 逻辑体 -> 池根节点（池化回收用；兼容 prefab 里组件挂在子节点的情况）。 */
  private rootOf: Map<Node, Node> = new Map();
  /** 常驻追击的精英（猎杀者）：不因远离玩家而休眠（文档 2.4：持续追踪）。 */
  private persistentNodes: Set<Node> = new Set();
  private populatedRooms: Set<number> = new Set();
  private populatedCorridors: Set<string> = new Set();
  /** 每间房「已生成且未死亡」的敌人数（含休眠），用于持续刷怪补足到目标数量。 */
  private roomAlive: Map<number, number> = new Map();
  /** 持续刷怪计时（秒）。 */
  private respawnTimerSec = 0;
  private map: DungeonMap | null = null;

  private rawEnemyFrame: SpriteFrame | null = null;
  private rawBossFrame: SpriteFrame | null = null;
  private enemyFrame: SpriteFrame | null = null;
  private bossFrame: SpriteFrame | null = null;
  private rng = new Random(1);
  private slicingReady = false;

  onLoad(): void {
    entityManagerRef = this;
    this.rng = new Random((Date.now() >>> 0) || 1);
    // 挂到「敌人」层（文档 4.7）：敌人是本节点的子节点，随之一并可渲染
    attachToViewLayer(this.node, 'enemy');

    if (this.enemyPrefab) {
      PoolManager.register(POOL_KEY, this.enemyPrefab);
    } else {
      console.error('[EntityManager] enemyPrefab 未设置，无法刷怪（请在 Inspector 指定 Enemy.prefab）');
    }

    eventBus.on(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.on(EventNames.on_dungeon_built, this.onDungeonBuilt, this);
    eventBus.on(EventNames.on_room_entered, this.onRoomEntered, this);
    eventBus.on(EventNames.on_enemy_died, this.onEnemyDied, this);
    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);
    eventBus.on(EventNames.on_layer_risk_changed, this.onLayerRiskChanged, this);
    eventBus.on(EventNames.on_hunter_spawn_requested, this.onHunterSpawnRequested, this);
    // 开局前 / 结算后隐藏玩法层：与开局面板不叠加
    this.node.active = false;
    // 单图 SpriteFrame 需加载子资源路径 xxx/spriteFrame（CC0：Ninja Adventure）
    resources.load('characters/enemy/spriteFrame', SpriteFrame, (e, f) => {
      if (!e && f) { this.rawEnemyFrame = f; this.rebuildFrames(); }
    });
    resources.load('characters/boss/spriteFrame', SpriteFrame, (e, f) => {
      if (!e && f) { this.rawBossFrame = f; this.rebuildFrames(); }
    });
  }

  onDestroy(): void {
    eventBus.off(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.off(EventNames.on_dungeon_built, this.onDungeonBuilt, this);
    eventBus.off(EventNames.on_room_entered, this.onRoomEntered, this);
    eventBus.off(EventNames.on_enemy_died, this.onEnemyDied, this);
    eventBus.off(EventNames.on_run_start, this.onRunStart, this);
    eventBus.off(EventNames.on_run_end, this.onRunEnd, this);
    eventBus.off(EventNames.on_layer_risk_changed, this.onLayerRiskChanged, this);
    eventBus.off(EventNames.on_hunter_spawn_requested, this.onHunterSpawnRequested, this);
    entityManagerRef = null;
    this.map = null;
    this.rootOf.clear();
    this.persistentNodes.clear();
    this.populatedRooms.clear();
    this.populatedCorridors.clear();
    this.roomAlive.clear();
    this.respawnTimerSec = 0;
    PoolManager.clear(POOL_KEY);
  }

  /** 开局：显示玩法层（清场与预置在 onDungeonBuilt 里做）。 */
  private onRunStart(): void {
    this.node.active = true;
  }

  /** 结算（死亡 / 通关）：回收全部敌人并隐藏玩法层。 */
  private onRunEnd(): void {
    this.clearAll();
    this.node.active = false;
  }

  /** 新一层地宫就绪：清场、重置记录、预置出生房周围的敌人。 */
  private onDungeonBuilt(map: DungeonMap): void {
    this.clearAll();
    this.map = map;
    this.populatedRooms.clear();
    this.populatedCorridors.clear();
    this.roomAlive.clear();
    this.respawnTimerSec = 0;
    this.node.active = true;
    // T14-S2 核对用：本层已解锁的敌人变体（随层递增），便于在控制台确认威胁度提升是否生效
    const layer = gameState.getLayer();
    const unlocked = enemyVariants.unlocked(layer).map((v) => v.name);
    console.log(`[EntityManager] 第 ${layer} 层敌人变体：`
      + `${unlocked.length > 0 ? unlocked.join(' / ') : '无（仅普通怪）'}`
      + `；每房目标数 ${this.roomTargetCount(map.rooms[0], dataManager.getTable<any>('dungeon'))}`);
    this.populateAround(map.entryId, map);
  }

  /** 玩家进入新房间：预置该房周围的敌人（提前于视野，避免凭空冒出）。 */
  private onRoomEntered(room: DungeonRoom): void {
    if (this.map) {
      this.populateAround(room.id, this.map);
    }
  }

  /**
   * 每帧：按玩家距离唤醒 / 休眠敌人；并按周期为玩家所在房间补足敌人（持续刷怪）。
   * 只切换 active、只从对象池取节点（不在 update 中创建/销毁节点，宪法 6.13）；暂停时整体冻结。
   */
  update(dt: number): void {
    if (!gameState.isRunActive() || !playerRef || !this.enemyPrefab) {
      return;
    }
    if (gameState.isPaused()) {
      return; // 升级选卡等待中：唤醒/休眠与刷怪节奏一并冻结
    }
    const spawn = dataManager.getTable<any>('dungeon').spawn;
    const activateSq = spawn.activate_radius_px * spawn.activate_radius_px;
    const deactivateSq = spawn.deactivate_radius_px * spawn.deactivate_radius_px;
    const px = playerRef.position.x;
    const py = playerRef.position.y;

    for (let i = this.dormantNodes.length - 1; i >= 0; i--) {
      if (this.aliveNodes.length >= spawn.max_concurrent) {
        break; // 同屏敌人到顶：其余保持休眠（文档 4.9）
      }
      const node = this.dormantNodes[i];
      if (MathUtils.distSq(px, py, node.position.x, node.position.y) > activateSq) {
        continue;
      }
      this.dormantNodes.splice(i, 1);
      this.setEntityActive(node, true);
      this.aliveNodes.push(node);
    }

    for (let i = this.aliveNodes.length - 1; i >= 0; i--) {
      const node = this.aliveNodes[i];
      if (this.persistentNodes.has(node)) {
        continue; // 猎杀者常驻追击：不因玩家远离而休眠（文档 2.4）
      }
      if (MathUtils.distSq(px, py, node.position.x, node.position.y) <= deactivateSq) {
        continue;
      }
      this.aliveNodes.splice(i, 1);
      this.setEntityActive(node, false);
      this.dormantNodes.push(node);
    }

    // 持续刷怪：按周期为玩家所在房间补足敌人（用户要求：房间不会被清空后永久空置）
    this.respawnTimerSec += dt;
    const intervalSec = spawn.respawn_interval_ms / 1000;
    if (intervalSec > 0 && this.respawnTimerSec >= intervalSec) {
      this.respawnTimerSec = 0;
      this.topUpCurrentRoom();
    }
  }

  /**
   * 激活 / 休眠一只敌人。
   *
   * 必须切换**池根节点**：prefab 若是"包装节点套逻辑节点"的结构，逻辑体其实是子节点，
   * 只切子节点的 active 会因为父节点仍停用而不生效——会出现"看不见的敌人照样打你、也能被你打死"的错位。
   */
  private setEntityActive(body: Node, active: boolean): void {
    const root = this.rootOf.get(body) ?? body;
    root.active = active;
  }

  /** 回收全部敌人（激活 + 休眠）到对象池（换层 / 结算时用）。 */
  private clearAll(): void {
    for (const list of [this.aliveNodes, this.dormantNodes]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const body = list[i];
        const root = this.rootOf.get(body);
        this.rootOf.delete(body);
        if (root) {
          PoolManager.release(POOL_KEY, root);
        }
      }
      list.length = 0;
    }
    this.persistentNodes.clear();
  }

  /** 返回当前已激活敌人节点（战斗系统用）。 */
  getEnemies(): ReadonlyArray<Node> {
    return this.aliveNodes;
  }

  /** 配置就绪后准备图集切帧。 */
  private onConfigLoaded(): void {
    this.slicingReady = true;
    this.rebuildFrames();
  }

  /** 按配置把整张行走图切成单帧（配置或图片任一先就绪都会尝试）。 */
  private rebuildFrames(): void {
    if (!this.slicingReady) return;
    const normal = dataManager.get<any>('enemies', 'normal');
    const boss = dataManager.get<any>('enemies', 'boss');
    if (this.rawEnemyFrame) {
      this.enemyFrame = sliceFrameByGrid(
        this.rawEnemyFrame, normal.sheet_col, normal.sheet_row, normal.sheet_cols, normal.sheet_rows,
      );
    }
    if (this.rawBossFrame) {
      this.bossFrame = sliceFrameByGrid(
        this.rawBossFrame, boss.sheet_col, boss.sheet_row, boss.sheet_cols, boss.sheet_rows,
      );
    }
  }

  /**
   * 预置「以 roomId 为中心、preload_room_hops 跳内的房间」及其相邻走廊的敌人（全部休眠）。
   * 出生房安全不刷；每个房间/走廊只预置一次。
   */
  private populateAround(roomId: number, map: DungeonMap): void {
    if (!this.enemyPrefab) {
      return;
    }
    const dungeon = dataManager.getTable<any>('dungeon');
    const hops = dungeon.spawn.preload_room_hops;
    const dist = bfsDistances(map, roomId);
    for (const room of map.rooms) {
      const d = dist.get(room.id);
      if (d === undefined || d > hops) {
        continue;
      }
      this.populateRoom(room, dungeon);
      this.populateCorridorsOf(room, map, dungeon);
    }
  }

  /**
   * 预置单个房间的敌人（休眠状态）。
   * @returns 该房的目标敌人数（持续刷怪会以此为上限补足）
   */
  private populateRoom(room: DungeonRoom, dungeon: any): void {
    if (room.kind === 'entry' || this.populatedRooms.has(room.id)) {
      return;
    }
    this.populatedRooms.add(room.id);

    const layer = gameState.getLayer();
    const count = this.roomTargetCount(room, dungeon);
    for (let i = 0; i < count; i++) {
      this.spawnDormant(layer, room, null, 'normal');
    }
    // Boss 层：出口房额外出 Boss（文档 2.5）
    if (room.kind === 'exit' && layer % dungeon.boss_every_layers === 0) {
      this.spawnDormant(layer, room, null, 'boss');
    }
  }

  /** 房间的目标敌人数（层数与房型决定；持续刷怪补足到该数量）。 */
  private roomTargetCount(room: DungeonRoom, dungeon: any): number {
    const layer = gameState.getLayer();
    const perRoom = dungeon.spawn.normal_per_room + (layer - 1) * dungeon.spawn.enemy_count_growth;
    const isBig = room.kind === 'exit';
    return Math.max(1, Math.round(perRoom * (isBig ? dungeon.big_room_spawn_rate : 1)));
  }

  /**
   * 持续刷怪（用户要求 + 文档 2.3「出口大房供快速刷怪」）：
   * 玩家所在房间的「存活（含休眠）敌人数」少于目标时按周期补足，
   * 单次最多 `spawn.respawn_batch_max` 只，且总量不超过 `spawn.max_concurrent`（文档 4.9 同屏上限）；
   * 出生点距玩家至少 `spawn.respawn_min_dist_px`，避免贴脸凭空冒出。
   * 出生房（entry）保持安全，不补充。
   */
  private topUpCurrentRoom(): void {
    if (!this.map || !playerRef) {
      return;
    }
    const room = this.roomAtPlayer();
    if (!room || room.kind === 'entry') {
      return;
    }
    const dungeon = dataManager.getTable<any>('dungeon');
    const spawn = dungeon.spawn;
    const roomBudget = this.roomTargetCount(room, dungeon) - (this.roomAlive.get(room.id) ?? 0);
    const screenBudget = spawn.max_concurrent - this.aliveNodes.length;
    const batch = Math.min(spawn.respawn_batch_max, roomBudget, screenBudget);
    if (batch <= 0) {
      return;
    }
    const layer = gameState.getLayer();
    for (let i = 0; i < batch; i++) {
      this.spawnDormant(layer, room, null, 'normal', spawn.respawn_min_dist_px);
    }
  }

  /** 玩家所在房间（不在任何房间内 = 在走廊）。 */
  private roomAtPlayer(): DungeonRoom | null {
    if (!this.map || !playerRef) {
      return null;
    }
    const px = playerRef.position.x;
    const py = playerRef.position.y;
    const rooms = this.map.rooms;
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      if (Math.abs(px - r.x) <= r.widthPx / 2 && Math.abs(py - r.y) <= r.heightPx / 2) {
        return r;
      }
    }
    return null;
  }

  /** 预置某房间相邻走廊内的少量敌人（休眠状态，文档：走廊也可少量放置）。 */
  private populateCorridorsOf(room: DungeonRoom, map: DungeonMap, dungeon: any): void {
    const perCorridor = dungeon.spawn.corridor_enemies_per_corridor;
    if (perCorridor <= 0) {
      return;
    }
    for (const c of map.corridors) {
      if (c.fromId !== room.id && c.toId !== room.id) {
        continue;
      }
      const key = `${Math.min(c.fromId, c.toId)}_${Math.max(c.fromId, c.toId)}`;
      if (this.populatedCorridors.has(key)) {
        continue;
      }
      this.populatedCorridors.add(key);
      for (let i = 0; i < perCorridor; i++) {
        this.spawnDormant(gameState.getLayer(), null, c, 'normal');
      }
    }
  }

  /**
   * 生成一只休眠敌人并登记（room / corridor 二选一决定出生区域）。
   * 顺序：属性（含显示缩放）-> 精灵（决定命中半径）-> 区域内布点 -> 休眠。
   */
  private spawnDormant(
    layer: number, room: DungeonRoom | null, corridor: DungeonCorridor | null,
    kind: EnemyKind, minDistFromPlayerPx = 0, keepAwake = false,
  ): Node | null {
    const root = PoolManager.get(POOL_KEY);
    if (!root) return null;
    this.node.addChild(root);
    const { body, enemy } = this.resolveBody(root);
    if (!enemy) console.error('[EntityManager] Enemy.prefab 上找不到 Enemy 组件');
    setLayerRecursive(root, Layers.Enum.UI_2D);
    // 层内时间压力（文档 3.6 的 time_factor）在建怪时定型（休眠期间还会随区间刷新）
    // 敌人变体（T14-S2）：普通怪按层随机取一种（层数越高解锁的种类越多）；精英 / Boss 不用变体
    const variant = kind === 'normal' ? enemyVariants.pick(layer, this.rng) : null;
    // 素材（actors.json）：变体自带 sheet，否则用默认 sheet；有动作表则由帧动画接管显示
    const actorId = kind === 'boss'
      ? this.bossActorForLayer(layer)
      : (kind === 'normal' ? (variant?.sheet || enemyVariants.defaultSheet()) : '');
    // 顺序很重要：**先**保证 Sprite 与兜底图，**再**初始化逻辑。
    // （Sprite 组件此前只由 applySprite 动态添加；若因为有动作表而跳过它，怪物会连 Sprite 都没有 ⇒ 完全不可见）
    this.applySprite(body, kind === 'boss' ? this.bossFrame : this.enemyFrame);
    // 有动作表时，setup 内会用动画帧覆盖兜底图（Enemy.ensureSprite 也会兜底创建 Sprite）
    enemy?.setup(layer, playerRef ?? this.playerNode, kind, layerRisk.getTimeFactor(), variant, actorId);
    this.setupBossBehavior(body, kind, layer);

    const radius = enemy ? enemy.getHitRadiusPx() : 0;
    if (room) {
      this.placeInRect(body, room.x, room.y, room.widthPx, room.heightPx, radius, minDistFromPlayerPx);
    } else if (corridor) {
      this.placeInRect(
        body, corridor.x, corridor.y,
        corridor.horizontal ? corridor.lengthPx : corridor.widthPx,
        corridor.horizontal ? corridor.widthPx : corridor.lengthPx,
        radius,
      );
    }

    // 房间存活计数（持续刷怪以此为「已占用」额度；走廊不参与补足）
    if (room) {
      (body as any).__roomId = room.id;
      this.roomAlive.set(room.id, (this.roomAlive.get(room.id) ?? 0) + 1);
    } else {
      (body as any).__roomId = -1;
    }

    this.rootOf.set(body, root);
    root.active = keepAwake; // 休眠：不可见、不参与更新（切池根，见 setEntityActive 注释）
    if (!keepAwake) {
      this.dormantNodes.push(body);
    }
    return body;
  }

  /**
   * 本轮 Boss 的素材 id（用户裁决：5 个 Boss 按轮次依次登场，打满一轮后循环并继续提升数值）。
   * 轮次 = `floor(层数 / dungeon.boss_every_layers)`（第 5 层为第 1 轮），取自 `enemies.boss.actors`。
   */
  private bossActorForLayer(layer: number): string {
    const list = dataManager.get<any>('enemies', 'boss').actors;
    if (!Array.isArray(list) || list.length === 0) {
      return ''; // 未配置 → 用兜底单帧素材
    }
    const every = dataManager.getTable<any>('dungeon').boss_every_layers;
    const round = Math.max(1, Math.floor(layer / every));
    return String(list[(round - 1) % list.length]);
  }


  /**
   * Boss 行为装配（文档 2.5：Boss 必须有独立行为，不做小怪放大）。
   * 池节点可能被复用为普通怪，故非 Boss 一律关闭该组件，避免残留冲锋逻辑。
   */
  private setupBossBehavior(body: Node, kind: EnemyKind, layer: number): void {
    const behavior = body.getComponent(BossBehavior);
    if (kind === 'boss') {
      const target = behavior ?? body.addComponent(BossBehavior);
      target.setup(layer);
      target.enabled = true;
    } else if (behavior) {
      behavior.enabled = false;
    }
  }

  /**
   * 在矩形内随机布点（按实体半径内缩，避免贴边或站到墙里）。
   * @param minDistFromPlayerPx 与玩家的最小距离（持续刷怪用，避免贴脸凭空冒出；0 = 不限制）
   */
  private placeInRect(
    node: Node, cx: number, cy: number, wPx: number, hPx: number,
    radiusPx: number, minDistFromPlayerPx = 0,
  ): void {
    const halfW = Math.max(0, wPx / 2 - radiusPx);
    const halfH = Math.max(0, hPx / 2 - radiusPx);
    const px = playerRef ? playerRef.position.x : cx;
    const py = playerRef ? playerRef.position.y : cy;
    const minSq = minDistFromPlayerPx * minDistFromPlayerPx;
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = cx + this.rng.range(-halfW, halfW);
      const y = cy + this.rng.range(-halfH, halfH);
      if (minDistFromPlayerPx <= 0 || MathUtils.distSq(px, py, x, y) >= minSq) {
        node.setPosition(x, y, 0);
        return;
      }
    }
    // 兜底：房内取不到足够远的点 → 取相对玩家最远的房角
    node.setPosition(
      cx + (px >= cx ? -halfW : halfW),
      cy + (py >= cy ? -halfH : halfH),
      0,
    );
  }

  /**
   * 取「逻辑体」节点：优先取挂 Enemy 组件的那个节点。
   * 兼容编辑器里"空节点套空节点"的结构——精灵与移动必须作用在同一个节点上，
   * 否则会出现"精灵不动、逻辑节点在动"的错位。
   */
  private resolveBody(root: Node): { body: Node; enemy: Enemy | null } {
    const enemy = root.getComponent(Enemy) ?? root.getComponentInChildren(Enemy);
    return { body: enemy ? enemy.node : root, enemy };
  }

  private applySprite(node: Node, frame: SpriteFrame | null): void {
    if (!frame) return;
    let sp = node.getComponent(Sprite);
    if (!sp) sp = node.addComponent(Sprite);
    sp.sizeMode = Sprite.SizeMode.RAW;
    sp.spriteFrame = frame;
  }

  /**
   * 层内时间压力刷新（文档 2.4 机制 1）：只重算「尚未接战」的休眠敌人，
   * 避免战斗中的敌人血量忽然跳变；已激活的敌人保持建怪时定型的系数。
   */
  private onLayerRiskChanged(timeFactor: number): void {
    if (!this.map) return;
    for (let i = 0; i < this.dormantNodes.length; i++) {
      const node = this.dormantNodes[i];
      const enemy = node.getComponent(Enemy);
      if (!enemy) continue;
      const layer = typeof (node as any).__layer === 'number' ? (node as any).__layer : gameState.getLayer();
      // 保留原有变体（池复用后仍按各自的种类刷新属性）
      const variantId = typeof (node as any).__variantId === 'string' ? (node as any).__variantId : '';
      const variant = variantId ? enemyVariants.byId(variantId) : null;
      const actorId = typeof (node as any).__actorId === 'string' ? (node as any).__actorId : '';
      enemy.setup(layer, playerRef ?? this.playerNode, enemy.getKind(), timeFactor, variant, actorId);
    }
  }

  /** 猎杀者刷新请求（由 dungeon/LayerRisk 依文档 3.7 的间隔广播）。 */
  private onHunterSpawnRequested(layer: number): void {
    if (!this.enemyPrefab || !this.map || !playerRef) return;
    const spawn = dataManager.getTable<any>('dungeon').spawn;
    if (this.aliveNodes.length >= spawn.max_concurrent) {
      return; // 同屏到顶：本次跳过，等下一个间隔（不排队堆积）
    }
    const root = PoolManager.get(POOL_KEY);
    if (!root) return;
    this.node.addChild(root);
    const { body, enemy } = this.resolveBody(root);
    if (!enemy) console.error('[EntityManager] Enemy.prefab 上找不到 Enemy 组件');
    setLayerRecursive(root, Layers.Enum.UI_2D);
    enemy?.setup(layer, playerRef, 'hunter', layerRisk.getTimeFactor());
    this.applySprite(body, this.enemyFrame);
    this.placeHunter(body, spawn.activate_radius_px, enemy ? enemy.getHitRadiusPx() : 0);

    this.rootOf.set(body, root);
    root.active = true;
    this.aliveNodes.push(body);
    this.persistentNodes.add(body); // 常驻：不因玩家远离而休眠，持续追踪
    eventBus.emit(EventNames.on_hunter_spawned, body);
  }

  /**
   * 猎杀者落点：以 activate_radius_px 为起始半径、由远及近多角度探测可行走点，
   * 使精英从画面外逼近；等价于「玩家视野外出现并持续追踪」。
   */
  private placeHunter(node: Node, ringPx: number, radiusPx: number): void {
    const px = playerRef ? playerRef.position.x : node.position.x;
    const py = playerRef ? playerRef.position.y : node.position.y;
    const radii = [ringPx, ringPx * 0.75, ringPx * 0.5, ringPx * 0.35];
    for (let r = 0; r < radii.length; r++) {
      for (let i = 0; i < 6; i++) {
        const angle = this.rng.range(0, Math.PI * 2);
        const x = px + Math.cos(angle) * radii[r];
        const y = py + Math.sin(angle) * radii[r];
        if (isWalkableAt(x, y, radiusPx)) {
          node.setPosition(x, y, 0);
          return;
        }
      }
    }
    node.setPosition(px + ringPx * 0.35, py, 0); // 兜底：极端布局下落在玩家附近（仍可贴墙滑行）
  }

  private onEnemyDied(node: Node): void {
    this.persistentNodes.delete(node);
    const idx = this.aliveNodes.indexOf(node);
    if (idx < 0) return; // 已回收 / 非激活态，忽略
    this.aliveNodes.splice(idx, 1);
    // 释放该房额度 → 持续刷怪会在下个周期补足
    const roomId = (node as any).__roomId;
    if (typeof roomId === 'number' && roomId >= 0) {
      const cur = this.roomAlive.get(roomId) ?? 0;
      if (cur > 0) {
        this.roomAlive.set(roomId, cur - 1);
      }
    }
    const isBoss = !!(node as any).__isBoss;
    const root = this.rootOf.get(node);
    if (root) {
      this.rootOf.delete(node);
      PoolManager.release(POOL_KEY, root);
    }
    if (isBoss) {
      // Boss 被击杀：地宫系统据此解锁本层出口点（文档 2.5）
      eventBus.emit(EventNames.on_boss_died);
    }
    if (this.aliveNodes.length === 0) {
      // 当前无激活敌人（供后续节奏 / 收益机制使用）
      eventBus.emit(EventNames.on_layer_clear);
    }
  }
}

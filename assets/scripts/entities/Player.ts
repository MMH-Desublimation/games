import { _decorator, Color, Component, Node, input, Input, KeyCode, EventKeyboard, Vec2, Sprite, UITransform } from 'cc';
import { gameState } from '../core/GameState';
import { attachToViewLayer, setFollowTarget } from '../core/ViewRoot';
import { DungeonMap } from '../dungeon/DungeonTypes';
import { nudgeToWalkable, resolveWalkableMove } from '../dungeon/DungeonCollision';
import { MAX_DT_SEC, timer } from '../core/Timer';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { dataManager } from '../data/DataManager';
import { SheetAnim, actorSheets } from '../core/ActorSheet';
import { getWhiteFrame } from '../core/WhiteFrame';
import { virtualInput } from '../core/VirtualInput';

/** 摇杆死区（长度阈值）：轻触不移动，避免手指落点抖动导致角色"自己走"。 */
const STICK_DEAD_ZONE = 0.28;

const { ccclass } = _decorator;

/**
 * 玩家节点引用（实体层内的只读注册表）。
 * 与 entityManagerRef 同源：战斗/敌人追击需要拿到“真正会移动的那个节点”，
 * 避免编辑器里 @property 指到同名包装节点导致追错目标。
 */
export let playerRef: Node | null = null;

/** 受击闪色与常态色（表现常量，非游戏数值）。 */
const HURT_FLASH_COLOR = new Color(255, 96, 96, 255);
const NORMAL_COLOR = new Color(255, 255, 255, 255);

/** 强制位移速度（px/s）：Boss 气浪 / 大招击退把玩家推出去的速度（表现常量）。 */
const PUSH_SPEED_PX = 900;

/**
 * 玩家控制组件（实体层）。
 * 移动速度取自 gameState（由 characters.json 初始化，可被 Buff 修改）。
 * 攻击/受击由 combat 模块处理，本组件只负责位移与精灵指认。
 *
 * 键盘轮询说明：Cocos 3.8 的 input 没有 keyboard/isPressed 轮询 API，
 * 这里用 KEY_DOWN/KEY_UP 事件维护按键集合，语义等价于按下状态查询。
 */
@ccclass('Player')
export class Player extends Component {
  /** 当前按下的键集合（KEY_DOWN 加入 / KEY_UP 移除）。 */
  private pressedKeys: Set<KeyCode> = new Set();
  /** 受击闪色的恢复任务 id（0 表示无）。 */
  private hurtFlashTimerId = 0;
  /** 是否允许玩家手动移动（冲刺等技能期间关闭，位移交由技能系统驱动）。 */
  private controlEnabled = true;
  /** 移速倍率（技能降速效果用，如剑刃旋风期间 ×0.4）。 */
  private moveSpeedScale = 1;
  /** 最近一次移动朝向（技能自动瞄准的兜底方向）。 */
  private facing: Vec2 = new Vec2(0, -1);
  /**
   * 动作表动画（Ninja Adventure 忍者素材，三职业靠染色区分）：
   * `idle / walk / hit` 三个动作，按移动状态与受击切换（用户要求：加入行动序列帧动画）。
   */
  private anims: Record<string, SheetAnim> = {};
  private anim: SheetAnim | null = null;
  /** 当前动作名（用于避免每帧重复切换）。 */
  private animName = '';
  /** 职业染色（Warrior/Mage/Ranger 用同一套忍者素材 + 不同颜色）。 */
  private tint: Color = NORMAL_COLOR;
  /** 受击动作的结束任务（受击动画只播一次，到期回到 idle/walk）。 */
  private hitAnimTimerId = 0;
  /** 强制位移（Boss 气浪 / 大招击退）：方向 + 剩余距离（px）。 */
  private pushDirX = 0;
  private pushDirY = 0;
  private pushLeftPx = 0;

  onLoad(): void {
    // 挂到「玩家」渲染层（文档 4.7）并归位屏幕中心：不在 Canvas 子树内的 Sprite 不会被渲染
    attachToViewLayer(this.node, 'player');
    playerRef = this.node;

    // 玩家素材**完全由演员表（actorSheets）按职业提供**（Ninja Adventure 忍者，一职业一色）。
    // 这里**不能**再加载兜底单图：那个 `resources.load` 是异步的，回调可能晚于 onRunStart，
    // 会把已经设好的动作表帧**覆盖**掉（实测踩过：三职业忍者被 `characters/player.png` 的灰色小人顶掉）。
    // 只确保节点身上有 Sprite 组件，具体帧交给 buildAnims() / 每帧动画推进。
    if (!this.getComponent(Sprite)) {
      this.addComponent(Sprite);
    }

    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    // 窗口失焦时按键可能收不到 KEY_UP，清空避免"幽灵移动"
    window.addEventListener('blur', this.clearKeys);

    // 开局前 / 结算后不显示角色：避免与开局面板叠在一起（由 on_run_start 唤醒）
    this.node.active = false;
    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);
    eventBus.on(EventNames.on_dungeon_built, this.onDungeonBuilt, this);
    eventBus.on(EventNames.on_player_hurt, this.playHurtFlash, this);
  }

  /** 新一层地宫就绪：把角色放到出生房中心，并让相机跟随角色。 */
  private onDungeonBuilt(map: DungeonMap): void {
    const entry = map.rooms.find((r) => r.id === map.entryId);
    if (entry) {
      this.node.setPosition(entry.x, entry.y, 0);
    }
    setFollowTarget(this.node);
    this.pressedKeys.clear();
  }

  /** 受击闪色：让"被怪物碰到"可见（敌人压在玩家层之下，光靠 HP 数字难以察觉）。 */
  private playHurtFlash(): void {
    const sp = this.node.getComponent(Sprite);
    if (!sp) {
      return;
    }
    sp.color = HURT_FLASH_COLOR;
    if (this.hurtFlashTimerId) {
      timer.cancel(this.hurtFlashTimerId);
    }
    const ms = dataManager.get<any>('balance', 'combat').hit_flash_ms;
    this.hurtFlashTimerId = timer.after(ms / 1000, () => {
      this.hurtFlashTimerId = 0;
      const s = this.node.getComponent(Sprite);
      if (s) {
        s.color = this.tint; // 恢复职业染色（不是纯白）
      }
    });
    // 受击动作：播一次 Hit 序列帧，结束后自动回到 idle / walk
    const hit = this.anims.hit;
    if (hit) {
      hit.reset();
      this.anim = hit;
      this.animName = 'hit';
      if (this.hitAnimTimerId) {
        timer.cancel(this.hitAnimTimerId);
      }
      const durSec = (hit.action.frameMs * Math.max(1, 3)) / 1000;
      this.hitAnimTimerId = timer.after(durSec, () => {
        this.hitAnimTimerId = 0;
        this.animName = ''; // 让 update 重新选择 idle / walk
      });
    }
  }

  /**
   * 开局：按职业配置设置显示大小并显示。
   * 位置由 onDungeonBuilt 放到出生房（同一事件内先派发地宫，后走此处，故不在此复位坐标）。
   */
  private onRunStart(): void {
    const cls = dataManager.get<any>('characters', gameState.getClassId());
    const s = cls.render_scale;
    this.node.setScale(s, s, 1);
    // 素材按职业区分颜色（actors.json 的 player.class_sheet）：战士黄 / 法师蓝 / 射手红，**不需要染色**
    this.tint = actorSheets.baseColor();
    const sp = this.node.getComponent(Sprite) ?? this.node.addComponent(Sprite);
    if (sp) {
      sp.sizeMode = Sprite.SizeMode.RAW;
      sp.color = this.tint;
    }
    // 动作表动画：idle / walk / hit（缺素材时保留旧单帧素材，不阻塞）
    this.buildAnims();
    this.hurtFlashTimerId = 0;
    if (this.hitAnimTimerId) {
      timer.cancel(this.hitAnimTimerId);
      this.hitAnimTimerId = 0;
    }
    this.pressedKeys.clear();
    this.controlEnabled = true;
    this.moveSpeedScale = 1;
    this.pushLeftPx = 0; // 清掉上一局的强制位移
    this.node.angle = 0; // 兜底：保证不残留任何旋转角度
    this.node.active = true;
  }

  /** 构建玩家动作表（缺某个动作则该项为 null，由动画切换逻辑跳过）。 */
  private buildAnims(): void {
    this.anims = {};
    for (const action of ['idle', 'walk', 'hit']) {
      const anim = actorSheets.playerAnim(gameState.getClassId(), action);
      if (anim) {
        anim.reset(action === 'idle' || action === 'walk');
        this.anims[action] = anim;
      }
    }

    this.animName = '';
    this.anim = this.anims.idle ?? null;
    this.animName = this.anim ? 'idle' : '';
    if (!this.anim) {
      // 动作表还未就绪（异步加载中）：先用白图兜底避免"人不见了"，
      // update 里会在素材就绪后自动重建动作表。
      const fallback = this.node.getComponent(Sprite);
      if (fallback && !fallback.spriteFrame) {
        fallback.spriteFrame = getWhiteFrame();
        fallback.sizeMode = Sprite.SizeMode.RAW;
      }
      return;
    }
    this.applyAnimFrame(true);
  }

  /**
   * 切换动作（仅在动作名变化时重建播放器相位）：
   * 受击期间保持 `hit` 直到计时结束；否则按是否移动切 walk / idle。
   */
  private switchAnim(name: string): void {
    if (this.animName === name) {
      return;
    }
    const anim = this.anims[name];
    if (!anim) {
      return;
    }
    anim.reset(false);
    this.anim = anim;
    this.animName = name;
    this.applyAnimFrame(true);
  }

  /** 应用当前帧到 Sprite（传入 null 时不动，避免每帧重复设置）。 */
  private applyAnimFrame(force = false): void {
    const sp = this.node.getComponent(Sprite);
    if (!sp || !this.anim) {
      return;
    }
    const frame = this.anim.frame;
    if (frame && (force || sp.spriteFrame !== frame)) {
      sp.spriteFrame = frame;
    }
  }

  /**
   * 是否允许玩家手动移动（冲刺等技能期间关闭，位移交由技能系统接管）。
   *
   * 注意：这里**不清空 `pressedKeys`**（曾经的实现会清空，导致"按着 W 按技能 1，位移结束后必须松开再按才能继续移动"）。
   * `onKeyDown` / `onKeyUp` 始终维护按键集合（不受本开关影响），因此关闭期间玩家松开/按下的变化都能被正确记录，
   * 恢复控制后立刻按当前真实按键状态继续移动 —— 操作连贯（用户反馈的顺滑度问题）。
   */
  setControlEnabled(enabled: boolean): void {
    this.controlEnabled = enabled;
  }

  /** 移速倍率（技能降速效果，如剑刃旋风期间 0.4）。 */
  setMoveSpeedScale(scale: number): void {
    this.moveSpeedScale = scale > 0 ? scale : 1;
  }

  /** 最近一次移动朝向（技能冲刺方向 / 施展方向）。 */
  getFacingDir(): Readonly<Vec2> {
    return this.facing;
  }

  /**
   * 朝向表现：水平翻转。
   * 当前美术只有单张正面图（无四方向行走帧），先以左右翻转让「面朝方向」可见；
   * 后续补多方向美术时，改在此处切换 `characters.json` 的 sprite sheet 帧即可。
   */
  private applyFacingFlip(faceLeft: boolean): void {
    const scaleY = Math.abs(this.node.scale.y) || Math.abs(this.node.scale.x) || 1;
    const scaleX = Math.abs(this.node.scale.x) || scaleY;
    this.node.setScale(faceLeft ? -scaleX : scaleX, scaleY, 1);
  }

  /** 结算（死亡 / 通关）：隐藏角色、取消相机跟随，回到"待开局"状态。 */
  private onRunEnd(): void {
    this.pressedKeys.clear();
    this.node.active = false;
    setFollowTarget(null);
  }

  onDestroy(): void {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    window.removeEventListener('blur', this.clearKeys);
    eventBus.off(EventNames.on_run_start, this.onRunStart, this);
    eventBus.off(EventNames.on_run_end, this.onRunEnd, this);
    eventBus.off(EventNames.on_dungeon_built, this.onDungeonBuilt, this);
    eventBus.off(EventNames.on_player_hurt, this.playHurtFlash, this);
    if (playerRef === this.node) playerRef = null;
  }

  private onKeyDown(e: EventKeyboard): void {
    this.pressedKeys.add(e.keyCode);
  }

  private onKeyUp(e: EventKeyboard): void {
    this.pressedKeys.delete(e.keyCode);
  }

  private clearKeys = (): void => {
    this.pressedKeys.clear();
  };

  // 复用向量对象，避免每帧分配（宪法 6.10：单帧内禁止大量临时对象）
  private dirVec: Vec2 = new Vec2(0, 0);

  update(dt: number): void {
    if (!gameState.isRunActive() || !gameState.isAlive()) return;
    // 表现：先推进帧动画（冲刺 / 暂停期间也要把当前动作播完，避免"卡在某一帧"）
    // 素材异步加载：若开局时尚未就绪（走兜底单帧），就绪后补建一次动作表（只做一次）
    if (!this.anims.idle && actorSheets.isLoaded) {
      this.buildAnims();
    }
    this.tickAnim(dt);
    if (gameState.isPaused()) return; // 升级选卡等待中冻结玩法层
    this.nudgeOutOfWall(); // 脱困：冲刺 / 地宫窄缝可能把角色留在不可行走处
    this.tickPush(dt); // 强制位移（Boss 气浪 / 击退）
    // 动作切换：受击动作优先播完；否则按"是否按着移动键"切 walk / idle
    if (this.animName !== 'hit') {
      this.switchAnim(this.isMovingInput() ? 'walk' : 'idle');
    }
    if (!this.controlEnabled) return; // 技能接管位移（如冲锋斩冲刺期间）
    this.readInput(this.dirVec);
    if (this.dirVec.x === 0 && this.dirVec.y === 0) return;
    this.facing.set(this.dirVec.x, this.dirVec.y); // 记录朝向供技能瞄准
    if (this.dirVec.x !== 0) {
      this.applyFacingFlip(this.dirVec.x < 0); // 朝向表现：左右水平翻转
    }
    const speed = gameState.getStats().moveSpeedPx * this.moveSpeedScale;
    const step = speed * Math.min(dt, MAX_DT_SEC);
    const p = this.node.position;
    // 可行走区域限制（房间 ∪ 走廊）：越界时停止或沿墙滑行
    const moved = resolveWalkableMove(
      p.x, p.y, p.x + this.dirVec.x * step, p.y + this.dirVec.y * step, this.bodyRadiusPx(),
    );
    this.node.setPosition(moved.x, moved.y, p.z);
  }

  /** 身体半径（px）：由精灵实际尺寸 × 显示缩放推导，用于贴墙不越界。 */
  private bodyRadiusPx(): number {
    const ut = this.node.getComponent(UITransform);
    if (!ut) {
      return 0;
    }
    // scale.x 会因朝向翻转取负，故用绝对值
    return Math.max(ut.contentSize.width, ut.contentSize.height) * Math.abs(this.node.scale.x) * 0.5;
  }

  /**
   * 脱困：若角色落在不可行走处（贴墙 / 窄缝 / 位移技能留下的非法点），把它拨回最近的可走点。
   *
   * 用户反馈「dash 技能突进过猛，卡进墙边无法移动」——根因是**起点一旦非法**，
   * `resolveWalkableMove` 会一直返回原地 ⇒ 彻底卡死。这里逐帧兜底修复。
   */
  private nudgeOutOfWall(): void {
    const p = this.node.position;
    const fixed = nudgeToWalkable(p.x, p.y, this.bodyRadiusPx());
    if (fixed.moved) {
      this.node.setPosition(fixed.x, fixed.y, p.z);
    }
  }

  /**
   * 强制位移（用户口径：Boss 的气浪"没有伤害，但会短暂击退玩家、造成强制位移"）。
   * 在后续若干帧内朝方向平滑推开 `distancePx`；撞墙会被挡住（走可行走求解）。
   */
  applyPush(dirX: number, dirY: number, distancePx: number): void {
    if (distancePx <= 0) {
      return;
    }
    const len = Math.max(1e-6, Math.hypot(dirX, dirY));
    this.pushDirX = dirX / len;
    this.pushDirY = dirY / len;
    this.pushLeftPx = distancePx;
  }

  /** 逐帧结算强制位移（推完或被墙挡住即结束）。 */
  private tickPush(dt: number): void {
    if (this.pushLeftPx <= 0) {
      return;
    }
    const step = Math.min(this.pushLeftPx, PUSH_SPEED_PX * Math.min(dt, MAX_DT_SEC));
    const p = this.node.position;
    const moved = resolveWalkableMove(
      p.x, p.y, p.x + this.pushDirX * step, p.y + this.pushDirY * step, this.bodyRadiusPx(),
    );
    const actual = Math.hypot(moved.x - p.x, moved.y - p.y);
    this.node.setPosition(moved.x, moved.y, p.z);
    this.pushLeftPx -= step;
    if (this.pushLeftPx <= 0 || actual < step * 0.5) {
      this.pushLeftPx = 0; // 推完 / 被墙挡住：结束强制位移
    }
  }

  /** 推进当前动作的帧动画（只在实际换帧时写 SpriteFrame）。 */
  private tickAnim(dt: number): void {
    if (!this.anim) {
      return;
    }
    const frame = this.anim.tick(Math.min(dt, MAX_DT_SEC));
    if (!frame) {
      return;
    }
    const sp = this.node.getComponent(Sprite);
    if (sp && sp.spriteFrame !== frame) {
      sp.spriteFrame = frame;
    }
  }

  /** 是否按着移动键（只读按键集合，不受 `controlEnabled` 影响：冲刺期间也走行走动画）。 */
  private isMovingInput(): boolean {
    const k = this.pressedKeys;
    return k.has(KeyCode.KEY_A) || k.has(KeyCode.KEY_D) || k.has(KeyCode.KEY_W) || k.has(KeyCode.KEY_S)
      || k.has(KeyCode.ARROW_LEFT) || k.has(KeyCode.ARROW_RIGHT)
      || k.has(KeyCode.ARROW_UP) || k.has(KeyCode.ARROW_DOWN)
      || virtualInput.isActive();
  }

  /**
   * 读取**键盘 + 虚拟摇杆**输入并写入 out（归一化）。
   *
   * 手机端（竖屏）由操作区左下角的 `VirtualStick` 提供方向；两者**合并**后统一归一化。
   * 摇杆带**死区**：轻触不移动，避免手指刚落下的抖动导致角色"自己走"。
   */
  private readInput(out: Vec2): void {
    let x = 0;
    let y = 0;
    if (this.pressedKeys.has(KeyCode.KEY_A) || this.pressedKeys.has(KeyCode.ARROW_LEFT)) x -= 1;
    if (this.pressedKeys.has(KeyCode.KEY_D) || this.pressedKeys.has(KeyCode.ARROW_RIGHT)) x += 1;
    if (this.pressedKeys.has(KeyCode.KEY_W) || this.pressedKeys.has(KeyCode.ARROW_UP)) y += 1;
    if (this.pressedKeys.has(KeyCode.KEY_S) || this.pressedKeys.has(KeyCode.ARROW_DOWN)) y -= 1;

    const axis = virtualInput.getAxis();
    if (Math.hypot(axis.x, axis.y) >= STICK_DEAD_ZONE) {
      x += axis.x;
      y += axis.y;
    }

    const len = Math.hypot(x, y);
    if (len > 0) {
      x /= len;
      y /= len;
    }
    out.set(x, y);
  }
}

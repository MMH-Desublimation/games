import { Color, EventTouch, Graphics, Node, UITransform, Vec3 } from 'cc';
import { gameState } from '../core/GameState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { virtualInput } from '../core/VirtualInput';
import {
  ensureUiRoot, getCtrlAreaCenterY, getCtrlAreaTopY, getVisibleHeight, getVisibleWidth, isPortrait,
} from '../core/ViewRoot';
import { ticker } from '../core/Ticker';

/**
 * 虚拟摇杆（**操作区左下角，固定常驻**；用户口径：手机竖屏下部分是可拖动的摇杆 + 上端两个技能）。
 *
 * 设计要点：
 *  - **固定位置常驻显示**（不是"触摸才出现"）：用户反馈"没有看到摇杆" —— 常驻才一眼可见；
 *    触摸时底盘高亮、摇杆头跟随手指；
 *  - **触摸区 = 操作区左半、顶部让开技能栏**：手指偏一点仍然有效。触摸区挂在 UIRoot 下、
 *    且**先于技能栏创建** ⇒ 层级更低；Cocos 触摸按层级派发，点技能 / 面板按钮不会误触发摇杆；
 *  - **输出归一化方向**（长度 0~1）：推得越远方向强度越大（玩家侧有死区过滤）；松手立即归零；
 *  - 只在触摸事件里更新方向，**不轮询**（宪法 6.13）；只用 `Graphics` 绘制，无素材依赖。
 */

/** 底盘 / 摇杆头半径与配色（表现常量；用户口径：加大，便于手机操作）。 */
const BASE_RADIUS = 200;
const KNOB_RADIUS = 92;
/**
 * 摇杆在操作区的**纵向微调**（相对操作区中心；正数偏上、负数偏下）。
 * 用户口径："操作区摇杆稍微偏下一点" ⇒ 取负值。
 */
const CENTER_OFFSET_Y = -60;
/** 触摸区以摇杆中心为中心的边长（比底盘大一圈即可；太大则手指落在角落时方向恒偏）。 */
const TOUCH_BOX_PAD = 200;
/**
 * 操作区顶部**留给技能按钮的高度**（px）：触摸区不得伸进这一带。
 * 与 `SkillBar` 的 `BTN_H + TOP_GAP` 匹配（260 + 34 ⇒ 取 300 留余量）。
 */
const SKILL_ROW_H = 300;
const BASE_FILL = new Color(255, 255, 255, 26);
const BASE_RING = new Color(242, 238, 224, 120);
const BASE_FILL_ACTIVE = new Color(255, 255, 255, 46);
const BASE_RING_ACTIVE = new Color(255, 208, 120, 220);
const KNOB_FILL = new Color(242, 238, 224, 190);

class VirtualStick {
  /** 触摸区（左半操作区）：**只接事件**，不负责显示。 */
  private touchArea: Node | null = null;
  /** 底盘（固定位置，常驻）。 */
  private baseNode: Node | null = null;
  private knob: Node | null = null;
  /** 底盘在 UIRoot 局部坐标下的位置（算偏移用）。 */
  private baseX = 0;
  private baseY = 0;

  /** 当前可见状态（用于避免每帧重复 setActive）。 */
  private visible = false;

  constructor() {
    // 只在**局内**显示：开局面板 / 结算 / 局外养成阶段不该出现摇杆
    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);
    // 可见性自愈：选卡 / 暂停是模态弹窗，摇杆浮在上面既无用也会抢触摸
    ticker.add(this.tick);
  }

  /** 每帧校正可见性（与 `SkillBar` 同口径：局内 且 非选卡 且 非暂停）。 */
  private tick = (): void => {
    const v = gameState.isRunActive()
      && isPortrait()
      && !gameState.isUpgradePending()
      && !gameState.isManualPaused();
    if (v === this.visible) {
      return;
    }
    this.visible = v;
    this.setVisible(v);
  };

  private onRunStart(): void {
    // 横屏（电脑端）用键盘操作，不显示摇杆
    this.setVisible(isPortrait() && gameState.isRunActive());
  }

  private onRunEnd(): void {
    this.setVisible(false);
  }

  /** 首次进入局内时创建（开局面板阶段不占节点）。 */
  private ensure(): boolean {
    if (this.baseNode && this.baseNode.isValid) {
      return true;
    }
    const uiRoot = ensureUiRoot();
    if (!uiRoot) {
      return false;
    }
    // 固定位置：**操作区中间、略偏下**（用户口径：原先在左下角够不到，后在中间、再"稍微偏下一点"）
    const baseX = 0;
    const baseY = getCtrlAreaCenterY() + CENTER_OFFSET_Y;
    this.baseX = baseX;
    this.baseY = baseY;

    const baseNode = new Node('VirtualStickBase');
    baseNode.layer = uiRoot.layer;
    uiRoot.addChild(baseNode);
    baseNode.setPosition(baseX, baseY, 0);
    this.baseNode = baseNode;
    this.drawBase(false);

    const knob = new Node('VirtualStickKnob');
    knob.layer = uiRoot.layer;
    baseNode.addChild(knob);
    const kg = knob.addComponent(Graphics);
    kg.fillColor = KNOB_FILL;
    kg.circle(0, 0, KNOB_RADIUS);
    kg.fill();
    this.knob = knob;

    // 触摸区：以摇杆中心为中心的一块方形（比底盘大一圈）。**不能覆盖整个操作区** ——
    // 固定摇杆的方向是"相对底盘中心"算的，触摸区过大时手指落在角落会被判成大幅偏移。
    const w = (BASE_RADIUS + TOUCH_BOX_PAD) * 2;
    const fullH = (BASE_RADIUS + TOUCH_BOX_PAD) * 2;
    // ⚠️ **上边界必须压在技能行之下**：操作区顶边往上 300px 留给两个技能按钮
    // （技能栏在 `getCtrlAreaTopY() - TOP_GAP` 处排开）。触摸区若伸到那里，
    // 手指按技能按钮时会被摇杆抢走事件（用户实测："多次点击不到技能"）。
    const topLimit = getCtrlAreaTopY() - SKILL_ROW_H;
    const top = Math.min(baseY + fullH / 2, topLimit);
    const h = Math.max(200, top - (baseY - fullH / 2));
    const area = new Node('VirtualStickArea');
    area.layer = uiRoot.layer;
    uiRoot.addChild(area);
    // ⚠️ **置底**：本节点只接事件、不显示。排在 UIRoot 最底层 ⇒ 只有"没有任何 UI 接住"
    // 的触摸才归摇杆，技能按钮 / 面板 / 按钮全部优先。这比调尺寸更根本地消除抢事件。
    area.setSiblingIndex(0);
    const aut = area.addComponent(UITransform);
    aut.setAnchorPoint(0.5, 0.5);
    aut.setContentSize(w, h);
    area.setPosition(baseX, top - h / 2, 0);
    this.touchArea = area;

    area.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
    area.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
    area.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
    area.on(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    this.setVisible(isPortrait() && gameState.isRunActive()); // 横屏不显示；竖屏按是否局内决定
    return true;
  }

  /** 重画底盘（默认 / 高亮两态）。 */
  private drawBase(active: boolean): Graphics | null {
    if (!this.baseNode) {
      return null;
    }
    let g = this.baseNode.getComponent(Graphics);
    if (!g) {
      g = this.baseNode.addComponent(Graphics);
    }
    g.clear();
    g.lineWidth = 6;
    g.fillColor = active ? BASE_FILL_ACTIVE : BASE_FILL;
    g.strokeColor = active ? BASE_RING_ACTIVE : BASE_RING;
    g.circle(0, 0, BASE_RADIUS);
    g.fill();
    g.stroke();
    return g;
  }

  /** 显示 / 隐藏整套摇杆（局内才显示）。 */
  setVisible(visible: boolean): void {
    if (!this.ensure()) {
      return;
    }
    if (this.baseNode) {
      this.baseNode.active = visible;
    }
    if (this.touchArea) {
      this.touchArea.active = visible;
    }
    if (!visible) {
      virtualInput.clear();
    }
  }

  /**
   * 触摸落点 → **相对底盘中心的偏移**（px）。
   *
   * ⚠️ 这里**刻意不用** `convertToNodeSpaceAR`：它对"传入 UI 坐标还是世界坐标"的语义
   * 在不同版本/场景下有差异，一旦不匹配会**静默算错** —— 实测踩过两次
   * （表现为"拖动只能往右上走"，因为坐标全为正）。
   *
   * 直接用可靠等价式：`UIRoot` 就在**屏幕中心**、无缩放无偏移，
   * 所以「UI 坐标（左下原点）− 可见区中心 − 底盘位置」= 相对底盘的偏移。
   */
  private toBaseDelta(e: EventTouch, out: Vec3): Vec3 {
    const p = e.getUILocation();
    out.set(
      p.x - getVisibleWidth() / 2 - this.baseX,
      p.y - getVisibleHeight() / 2 - this.baseY,
      0,
    );
    return out;
  }

  private onTouchStart(e: EventTouch): void {
    if (!gameState.isRunActive()) {
      return;
    }
    this.drawBase(true); // 高亮
    this.onTouchMove(e);
  }

  private onTouchMove(e: EventTouch): void {
    if (!this.knob) {
      return;
    }
    const local = this.toBaseDelta(e, new Vec3());
    const dx = local.x;
    const dy = local.y;
    const len = Math.hypot(dx, dy);
    if (len <= 0.001) {
      virtualInput.clear();
      this.knob.setPosition(0, 0, 0);
      return;
    }
    // 摇杆头限制在底盘内；输出按**比例**给（轻推慢走、推满全速）
    const k = Math.min(1, len / BASE_RADIUS);
    virtualInput.setAxis((dx / len) * k, (dy / len) * k);
    this.knob.setPosition((dx / len) * BASE_RADIUS * k, (dy / len) * BASE_RADIUS * k, 0);
  }

  private onTouchEnd(): void {
    virtualInput.clear();
    if (this.knob) {
      this.knob.setPosition(0, 0, 0);
    }
    this.drawBase(false);
  }
}

/** 全局单例（`Boot` 副作用引入）。 */
export const virtualStick = new VirtualStick();

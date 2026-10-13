import { Graphics, HorizontalTextAlignment, Label, Node, UITransform } from 'cc';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { ensureUiRoot, getCtrlAreaTopY, getVisibleWidth } from '../core/ViewRoot';
import { ticker } from '../core/Ticker';
import { skillSystem } from '../combat/SkillSystem';
import {
  HUD_BG, HUD_TEXT_COLOR, makeIcon, makeLabel, makeRoundRectBg, redrawRoundRect,
} from './UiKit';

/**
 * 技能栏（视图层）：操作区**左右上角各一个大按钮**，显示技能名与冷却剩余，点击释放。
 *
 * ## 布局口径（第六十四轮，用户实机反馈后重做）
 *
 * 用户原话：**「将两个技能分别放在操作区左右上角。右侧为技能1（一只手操作，常点，方便），
 * 左上角放置技能2」**，同时要求**扩大 UI**（"多次点击不到技能"）。
 *
 * ```
 *   操作区顶边 ┌───────────────┐
 *              │ ┌────┐  ┌────┐│
 *              │ │技能2│  │技能1││   ← 左上 / 右上，各占半宽的大方块
 *              │ └────┘  └────┘│
 *              │      (摇杆)     │
 * ```
 *
 * ## 为什么之前"点不到"（重要）
 *
 * `VirtualStick` 的触摸区是一块 **800×800** 的方形，且**晚于本栏创建** ⇒ 在 UIRoot 里排在**更上层**，
 * 触摸事件优先被它吃掉，落在技能按钮边缘的点击全部失效。
 * 现由两端各自加固：**摇杆触摸区置底**（只在没人接事件时才响应）+ **本栏置顶**。
 *
 * ## 规则（宪法 6.4 / 6.13）
 *  - 只做表现与请求：释放逻辑在 `combat/SkillSystem`；本文件不持有任何游戏数值；
 *  - 文案仅在**内容变化**时写入 Label，避免每帧创建字符串与重排；
 *  - **可见性自愈**：以 `gameState` 为准逐帧校正（局内且**非选卡、非暂停**时显示），不依赖事件到达顺序。
 */

/**
 * 排版常量（表现层）。
 *
 * ⚠️ **选卡 / 暂停时本栏必须隐藏**：这两者是模态弹窗（游戏已暂停），
 * 上一轮把技能栏无条件置顶后，它**压在了选卡面板上**（用户截图：三个选项下方浮着两个技能条）。
 */
const BTN_H = 260;
/** 单块最大宽度（再宽就与中间的摇杆打架）。 */
const BTN_W_MAX = 640;
/** 与屏幕左 / 右边缘的留白。 */
const EDGE = 45;
/** 与操作区顶边的间距。 */
const TOP_GAP = 34;
/** 与摇杆之间的安全距离：摇杆触摸区的上边界会被压到本行之下（见 VirtualStick）。 */
const FONT_SIZE = 46;
const BG_RADIUS = 24;
/** 技能图标（Ninja Adventure `UI/Skill Icon`）：按职业给「普攻 / 大招」各一张。 */
const ICON_PX = 124;
const ICON_GAP = 22;
/** 图标距块左缘的留白。 */
const ICON_PAD = 26;
const SKILL_ICONS: Record<string, [string, string]> = {
  warrior: ['ui/skill/cut', 'ui/skill/cut'],
  mage: ['ui/skill/orb_fire', 'ui/skill/thunder'],
  ranger: ['ui/skill/arrow', 'ui/skill/vision'],
};
const FALLBACK_ICONS: [string, string] = ['ui/skill/cut', 'ui/skill/cut'];
/** 键位提示（与 SkillSystem 的键位保持一致）。 */
const KEY_HINT = ['J', 'K'];
/** 未就绪 / 未装配时的底衬（更淡，避免看起来像可点的空按钮）。 */
const HUD_BG_EMPTY = HUD_BG.clone();
HUD_BG_EMPTY.a = Math.round(HUD_BG.a * 0.35);

class SkillBar {
  private root: Node | null = null;
  private labels: (Label | null)[] = [null, null];
  private lastText: string[] = ['', ''];
  /** 每格的圆角底衬（整块大小，同时就是点击区）。 */
  private bgGs: (Graphics | null)[] = [null, null];
  /** 每格的中心（算底衬矩形用）。 */
  private centers: number[] = [0, 0];
  private btnW = BTN_W_MAX;

  constructor() {
    eventBus.on(EventNames.on_config_loaded, this.ensurePanel, this);
    eventBus.on(EventNames.on_run_start, this.ensurePanel, this);
    eventBus.on(EventNames.on_run_end, this.hide, this);
    ticker.add(this.tick);
  }

  private ensurePanel(): boolean {
    if (this.root && this.root.isValid) {
      return true;
    }
    const uiRoot = ensureUiRoot();
    if (!uiRoot) {
      return false;
    }
    const root = new Node('SkillBar');
    root.layer = uiRoot.layer;
    uiRoot.addChild(root);
    // ⚠️ **置顶**：技能按钮必须能点到 —— 摇杆触摸区已置底（见 VirtualStick），
    // 这里再显式置顶，双向保证"按在技能块上一定由技能响应"。
    root.setSiblingIndex(uiRoot.children.length - 1);
    this.root = root;

    const w = getVisibleWidth();
    const btnW = Math.min(w / 2 - EDGE * 1.5, BTN_W_MAX);
    const btnY = getCtrlAreaTopY() - TOP_GAP - BTN_H / 2;
    this.btnW = btnW;
    // 槽位 1（普攻，**右手常点**）⇒ 右上角；槽位 2（大招）⇒ 左上角。用户口径。
    const right = w / 2 - EDGE - btnW / 2;
    const left = -w / 2 + EDGE + btnW / 2;
    this.centers = [right, left];

    const icons = SKILL_ICONS[gameState.getClassId()] ?? FALLBACK_ICONS;
    for (let i = 0; i < 2; i++) {
      const cx = this.centers[i];
      const name = `skill_${i + 1}`;
      // 整块圆角底衬：既作视觉按钮，也是点击区（`UITransform` 由 makeRoundRectBg 建）
      this.bgGs[i] = makeRoundRectBg(root, `${name}_bg`, cx, btnY, btnW, BTN_H, BG_RADIUS, HUD_BG);
      // 图标在块内偏左
      const iconX = cx - btnW / 2 + ICON_PAD + ICON_PX / 2;
      makeIcon(root, `${name}_icon`, iconX, btnY, ICON_PX, icons[i]);
      // 文字占块内剩余宽度：居中 + **自动缩小**（长文案如「剑刃旋风[K]132.1s」不会顶出块外）
      const textLeft = iconX + ICON_PX / 2 + ICON_GAP;
      const textW = Math.max(80, cx + btnW / 2 - ICON_PAD - textLeft);
      const label = makeLabel(
        root, `${name}_text`, textLeft + textW / 2, btnY, FONT_SIZE, HUD_TEXT_COLOR, false,
      );
      label.horizontalAlign = HorizontalTextAlignment.CENTER;
      label.overflow = Label.Overflow.SHRINK;
      const ut = label.node.getComponent(UITransform);
      if (ut) {
        ut.setAnchorPoint(0.5, 0.5);
        ut.setContentSize(textW, FONT_SIZE + 20);
      }
      label.string = '';
      this.labels[i] = label;
      // 点击区 = **整块**（挂在底衬节点上）。
      // ⚠️ 必须显式补 `UITransform` 并设尺寸：`makeRoundRectBg` 只画图、**不建命中区**
      // （`redrawRoundRect` 亦然）。这正是用户"多次点击不到技能"的第二个原因 ——
      // 原先点击挂在**文字节点**上，只有那 580×96 的一小块，点图标或块的空处全都没反应。
      const bgNode = this.bgGs[i]?.node;
      if (bgNode) {
        const but = bgNode.getComponent(UITransform) ?? bgNode.addComponent(UITransform);
        but.setAnchorPoint(0.5, 0.5);
        but.setContentSize(btnW, BTN_H);
        bgNode.on(Node.EventType.TOUCH_END, () => skillSystem.cast(i + 1));
      }
    }
    root.active = false;
    return true;
  }

  private hide(): void {
    if (this.root && this.root.isValid) {
      this.root.active = false;
    }
  }

  /** 每帧读取只读快照；可见性与文案均在变化时才写入。 */
  private tick = (): void => {
    if (!this.ensurePanel() || !this.root) {
      return;
    }
    // 可见性自愈：**局内进行中、且既没在选卡也没在暂停**时显示。
    // 选卡 / 暂停都是模态弹窗，技能栏浮在上面会与面板叠字（用户截图）。
    const active = gameState.isRunActive() && !gameState.isUpgradePending() && !gameState.isManualPaused();
    if (this.root.active !== active) {
      this.root.active = active;
      this.lastText = ['', ''];
      if (active) {
        console.log('[SkillBar] 技能栏已显示');
      }
    }
    if (!active) {
      return;
    }
    for (let i = 0; i < this.labels.length; i++) {
      const label = this.labels[i];
      if (!label) {
        continue;
      }
      const info = skillSystem.getSlotInfo(i + 1);
      const key = KEY_HINT[i];
      // 文案同时给出「冷却总量 / 持续时长」：可直接与配置表对照，判断配置是否已生效
      // 保留的信息：技能名、键位、冷却中的剩余秒、冷却被重置的特殊提示。
      let text: string;
      if (!info) {
        // 未解析到时给出占位（便于一眼区分「没面板」与「没数据」）
        text = `技能${i + 1} [${key}]`;
      } else if (info.resetFlashSec > 0) {
        // 冷却被「疾影」等效果清零：必须提示，否则玩家会以为"技能没有冷却"（实测疑问）
        text = `${info.name} 冷却重置`;
      } else if (info.deniedFlashSec > 0 || info.remainSec > 0) {
        // 冷却中（含"按了但没放出来"的反馈）：只留剩余秒，避免玩家反复猛按
        text = `${info.name} [${key}] ${info.remainSec.toFixed(1)}s`;
      } else {
        text = `${info.name} [${key}]`; // 就绪：只留技能名 + 键位
      }
      if (text !== this.lastText[i]) {
        this.lastText[i] = text;
        label.string = text;
        // 底衬为固定整块 ⇒ 只需在**首次有文案**时确保可见（空文案时暗一些，提示"该技能未就绪/未装配"）
        const g = this.bgGs[i];
        if (g && g.node.isValid) {
          g.node.active = true;
          redrawRoundRect(g, this.btnW, BTN_H, BG_RADIUS, text ? HUD_BG : HUD_BG_EMPTY);
        }
      }
    }
  };
}

export const skillBar = new SkillBar();

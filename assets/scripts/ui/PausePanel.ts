import { Color, EventKeyboard, HorizontalTextAlignment, Input, input, KeyCode, Node, UITransform } from 'cc';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { ensureUiRoot, getVisibleHeight, getVisibleWidth } from '../core/ViewRoot';
import { DARK_TEXT_COLOR, fitPanelToScreen, makeBgButton, makeLabel, makeNineSliceBg, makePanelButton } from './UiKit';

/**
 * 局内暂停 / 退出（视图层，用户需求：局内需要「暂停」「退出」两个按键）。
 *
 * 组成：
 *  - **暂停按钮**：局内常驻右上角，点击即发 `on_pause_requested`（手机端主要入口）；
 *  - **暂停面板**：标题 + 「继续」/「退出到存档」两个按钮；
 *  - 键盘 `ESC` 等价于点暂停按钮（由流程层裁决，避免 UI 直接改状态，宪法 6.4）。
 *
 * 语义：暂停 = `gameState.setManualPaused(true)`（与升级选卡的等待区分开，两者取并集冻结玩法层）；
 * 「退出到存档」= 流程层挂起本局（保留进度，可继续）并回到存档界面，不弹结算面板。
 */

/** 排版常量（表现层）。 */
/**
 * 暂停按钮位置（竖屏分区后：贴着**游戏画面区**右上角，排在小地图**左侧**）。
 * ⚠️ 不能再用"屏幕坐标系"的固定 y —— 竖屏下屏幕中心是操作区，按钮会掉到操作区里去。
 * 小地图占住游戏区右上角（宽 220 + 边距 36），故暂停按钮从其左侧起算。
 */
/**
 * 暂停按钮位置：**竖直排在小地图下方**（右上角一列：小地图 → 暂停）。
 * ⚠️ 原先与小地图**并排**（放它左侧），但 HUD 底衬会随内容变宽、右端顶过来 ⇒ 三者重叠（实测）。
 * 改成纵向排列后与 HUD 不再竞争同一水平带。
 * 小地图尺寸须与 `Minimap.ts` 的 `PANEL_W` / `PANEL_H` 保持一致。
 */
const MINIMAP_H = 280; // 与 Minimap.ts 的 PANEL_H 保持一致
const EDGE_INSET = 36;
/** 暂停按钮尺寸（用户多轮反馈"继续扩大"）。 */
const PAUSE_BTN_W = 240;
const PAUSE_BTN_H = 86;
/** 与小地图之间的竖直间隙。 */
const PAUSE_GAP_Y = 24;
// （旧的横屏 y 常量已由竖屏纵向常量取代，见下方 PANEL_* 一组）
/**
 * 面板底衬（用户口径：**不要 UI 边框**，改用艺术字 + 少量缩小）。
 * 这里只铺一层**半透明深色**，让艺术字（带描边）在草地背景上依然清晰；不画任何边框。
 */
/**
 * 暂停面板本体：**竖屏纵向排开**（用户口径："暂停界面同理可以进行纵向排开、增大字体"）。
 * 1000×360 → **1100×1400**。
 */
const PANEL_BG_W = 1100;
const PANEL_BG_H = 1400;
const PANEL_BG_Y = 0;
const PANEL_BG_COLOR = new Color(20, 22, 28, 190);
/** 面板内的纵向位置与字号（竖屏放大）。 */
const PANEL_TITLE_Y = 480;
const PANEL_TITLE_FONT = 64;
const PANEL_HINT_Y = 340;
const PANEL_HINT_FONT = 32;
const PANEL_BTN_W = 800;
const PANEL_BTN_H = 150;
const PANEL_BTN_Y_RESUME = -60;
const PANEL_BTN_Y_EXIT = -300;
const PANEL_BTN_FONT = 48;
/** `ui/dialogue_box`（316×60）实测九宫格边框厚度。 */
const DIALOGUE_INSET = 7;
/** `ui/choice_box`（64×20）实测九宫格边框厚度。 */
const CHOICE_INSET = 6;

class PausePanel {
  private root: Node | null = null;
  private barNode: Node | null = null;
  private panelNode: Node | null = null;

  constructor() {
    eventBus.on(EventNames.on_config_loaded, this.ensurePanel, this);
    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);
    eventBus.on(EventNames.on_pause_changed, this.onPauseChanged, this);
    // 升级选卡期间隐藏暂停按钮并忽略 ESC：选卡面板与暂停面板不得同时出现（实测叠字问题）
    eventBus.on(EventNames.on_buff_offered, this.onUpgradeOpened, this);
    eventBus.on(EventNames.on_buff_selected, this.onUpgradeClosed, this);
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
  }

  private onKeyDown(e: EventKeyboard): void {
    if (e.keyCode !== KeyCode.ESCAPE || !gameState.isRunActive()) {
      return;
    }
    if (gameState.isUpgradePending()) {
      return; // 选卡中：ESC 无效
    }
    eventBus.emit(EventNames.on_pause_requested);
  }

  /** 选卡开始：隐藏暂停按钮（选卡期间不允许暂停）。 */
  private onUpgradeOpened(): void {
    if (this.barNode) {
      this.barNode.active = false;
    }
  }

  /** 选卡结束：局内进行中则恢复暂停按钮。 */
  private onUpgradeClosed(): void {
    if (this.barNode && gameState.isRunActive() && !gameState.isManualPaused()) {
      this.barNode.active = true;
    }
  }

  private ensurePanel(): boolean {
    if (this.root && this.root.isValid) {
      return true;
    }
    const uiRoot = ensureUiRoot();
    if (!uiRoot) {
      return false;
    }
    const root = new Node('PauseRoot');
    root.layer = uiRoot.layer;
    uiRoot.addChild(root);
    this.root = root;

    // 局内常驻的暂停按钮（右上角）：用户口径——不要 UI 边框，只留艺术字 + 淡底
    const bar = new Node('PauseBar');
    bar.layer = uiRoot.layer;
    root.addChild(bar);
    // 右上角一列：小地图在上、暂停在它正下方（右缘对齐）
    const rightEdge = getVisibleWidth() / 2 - EDGE_INSET;
    const miniBottomY = getVisibleHeight() / 2 - EDGE_INSET - MINIMAP_H;
    const pauseX = rightEdge - PAUSE_BTN_W / 2;
    const pauseY = miniBottomY - PAUSE_GAP_Y - PAUSE_BTN_H / 2;
    makePanelButton(bar, 'btn_pause', '暂停', pauseX, pauseY, PAUSE_BTN_W, PAUSE_BTN_H, () => {
      eventBus.emit(EventNames.on_pause_requested);
    }, 42);
    this.barNode = bar;

    // 暂停面板（居中；暂停时显示）：**先铺半透明底衬**再放文字（顺序决定层级）
    const panel = new Node('PausePanel');
    panel.layer = uiRoot.layer;
    root.addChild(panel);
    // 面板底 = `Ui/Dialog/DialogueBoxSimple` 九宫格（用户口径：UI 美化）；素材内部浅灰 ⇒ 文字用深色
    makeNineSliceBg(
      panel, 'bg', 0, PANEL_BG_Y, PANEL_BG_W, PANEL_BG_H,
      'ui/dialogue_box', DIALOGUE_INSET, PANEL_BG_COLOR,
    );
    // 颜色必须在**创建时**传入：UiKit 靠它判断「浅底深字」并自动不加描边（后赋值会错过）
    const title = makeLabel(panel, 'title', -400, PANEL_TITLE_Y, PANEL_TITLE_FONT, DARK_TEXT_COLOR);
    title.string = '已暂停';
    // ⚠️ 提示是一整句长文案（20+ 个汉字 ≈ 640px），`makeLabel` 默认锚点在**中间** ⇒
    // 以 x=-460 为中心向两侧展开会冲出面板木框左缘（用户实测："暂停界面字体显示不全"）。
    // 改**左缘对齐**并把宽度收在面板内 ⇒ 文本只向右排。
    const hint = makeLabel(panel, 'hint', -460, PANEL_HINT_Y, PANEL_HINT_FONT, DARK_TEXT_COLOR);
    hint.horizontalAlign = HorizontalTextAlignment.LEFT;
    const hintUt = hint.node.getComponent(UITransform);
    if (hintUt) {
      hintUt.setAnchorPoint(0, 0.5);
      hintUt.setContentSize(PANEL_BG_W - 200, PANEL_HINT_FONT + 16);
    }
    hint.string = '「退出到存档」会保留本局进度，可在存档界面继续';
    // 按钮不另铺底衬（bg = null）：底由面板底图提供，避免深色块盖住木框
    makeBgButton(
      panel, 'btn_resume', '继续', 0, PANEL_BTN_Y_RESUME, PANEL_BTN_W, PANEL_BTN_H,
      'ui/dialogue_box', DIALOGUE_INSET, () => {
        eventBus.emit(EventNames.on_pause_requested);
      }, PANEL_BTN_FONT,
    );
    makeBgButton(
      panel, 'btn_exit', '退出到存档', 0, PANEL_BTN_Y_EXIT, PANEL_BTN_W, PANEL_BTN_H,
      'ui/choice_box', CHOICE_INSET, () => {
        eventBus.emit(EventNames.on_run_exit_requested);
      }, PANEL_BTN_FONT,
    );
    this.panelNode = panel;
    panel.active = false;
    bar.active = false;
    return true;
  }

  private onRunStart(): void {
    if (!this.ensurePanel() || !this.root) {
      return;
    }
    this.root.active = true;
    if (this.barNode) {
      this.barNode.active = true;
    }
    if (this.panelNode) {
      this.panelNode.active = false;
    }
  }

  private onRunEnd(): void {
    if (this.panelNode) {
      this.panelNode.active = false;
    }
    if (this.barNode) {
      this.barNode.active = false;
    }
  }

  private onPauseChanged(paused: boolean): void {
    if (this.panelNode) {
      // 面板按当前可见区自适应缩放（竖屏 k=1 保持原尺寸；横屏自动缩小 ⇒ 完整可见）。
      // ⚠️ 只缩**面板本体**，不缩 `root`：root 还挂着右上角的暂停按钮栏（`barNode`），
      // 它的位置是按可见区算好的，跟着缩会错位（用户实测：暂停按钮跑到奇怪的地方）。
      if (paused) {
        fitPanelToScreen(this.panelNode, PANEL_BG_W, PANEL_BG_H);
      }
      this.panelNode.active = paused;
    }
    if (this.barNode) {
      // 暂停中隐藏按钮，避免与面板叠字
      this.barNode.active = !paused;
    }
  }
}

export const pausePanel = new PausePanel();

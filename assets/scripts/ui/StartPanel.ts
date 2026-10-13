import { _decorator, Component, HorizontalTextAlignment, Label, UITransform } from 'cc';
import { dataManager } from '../data/DataManager';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { metaState } from '../core/MetaState';
import { RunMode } from '../core/GameState';
import { endgameRules } from '../dungeon/EndgameRules';
import { DARK_TEXT_COLOR, PANEL_BG, makeBgButton, makeLabel, makeNineSliceBg, fitPanelToScreen } from './UiKit';

const { ccclass } = _decorator;

/** 模式选择顺序（本体 → 终局两模式；文档 2.6）。 */
const MODE_ORDER: RunMode[] = ['base', 'normal', 'challenge'];

/**
 * 九宫格边框厚度（实测）与各控件尺寸（表现层常量）。
 *
 * **竖屏纵向布局**（用户口径："把画面、效果、字体适当放大并纵向排开、充分利用竖屏空间"）：
 * 面板 980×660 → **1100×1900**；模式按钮由**横向 3 个**改为**纵向 3 个**；字号整体放大。
 */
const DIALOGUE_INSET = 7;
const CHOICE_INSET = 6;
const PANEL_W = 1100;
const PANEL_H = 1900;
const PANEL_Y = 0;
/** 标题 / 提示 / 金币。 */
const TITLE_FONT = 64;
const SMALL_FONT = 34;
/** 模式按钮（纵向排列）。 */
const MODE_BTN_W = 760;
const MODE_BTN_H = 120;
const MODE_GAP = 25;
const MODE_FONT = 38;
/** 职业按钮（纵向排列）。 */
const CLASS_BTN_W = 800;
const CLASS_BTN_H = 150;
const CLASS_GAP = 25;
const CLASS_FONT = 46;
/** 底部两个按钮。 */
const SUB_BTN_W = 800;
const SUB_BTN_H = 120;
const SUB_GAP = 25;
const SUB_FONT = 38;
/** 段间距（相邻"区块"之间；区块内部用各自的 `*_GAP`）。 */
const GAP_TITLE_HINT = 40;
const GAP_HINT_META = 25;
const GAP_META_MODE = 60;
const GAP_MODE_CLASS = 70;
const GAP_CLASS_SUB = 60;

/** 纵向排布结果（局部坐标，面板中心为 0；自上而下）。 */
interface RowPlan {
  titleY: number;
  hintY: number;
  metaY: number;
  modeY: number[];
  classY: number[];
  metaBtnY: number;
  slotsBtnY: number;
}

/**
 * **纵向自洽排布**：先算每个控件的**实际高度**，连同段间距求和得总高，
 * 再从**总高的一半**往下依次落位 ⇒ 整体竖直居中，且**相邻控件间距恒定**。
 *
 * ⚠️ 为什么不再用固定 y 常量（旧版写法）：
 * 原先 `MODE_START_Y/STEP` 与 `CLASS_START_Y/STEP` 是**两组各自独立**的常量，
 * 3 个模式按钮的下沿在 `+30`，而第 1 个职业按钮的上沿在 `+115` —— **重叠 85px**。
 * 实测表现：「挑战地图」按钮被「战士」按钮**压住一半**，在手机上只看到一条橙色空框
 * （用户截图）。改成自洽排布后，这类"两段常量各写各的"造成的重叠从机制上不会再出现。
 */
function planRows(modeCount: number, classCount: number): RowPlan {
  const titleH = TITLE_FONT * 1.2;
  const textH = SMALL_FONT * 1.4;
  const modeBlock = modeCount * MODE_BTN_H + Math.max(0, modeCount - 1) * MODE_GAP;
  const classBlock = classCount * CLASS_BTN_H + Math.max(0, classCount - 1) * CLASS_GAP;
  const total = titleH + GAP_TITLE_HINT + textH + GAP_HINT_META + textH + GAP_META_MODE
    + modeBlock + GAP_MODE_CLASS + classBlock + GAP_CLASS_SUB
    + SUB_BTN_H + SUB_GAP + SUB_BTN_H;
  let cursor = total / 2; // 从总高上沿往下排
  const take = (own: number, gap: number): number => {
    const center = cursor - own / 2;
    cursor -= own + gap;
    return center;
  };
  const titleY = take(titleH, GAP_TITLE_HINT);
  const hintY = take(textH, GAP_HINT_META);
  const metaY = take(textH, GAP_META_MODE);
  const modeY: number[] = [];
  for (let i = 0; i < modeCount; i++) {
    modeY.push(take(MODE_BTN_H, i === modeCount - 1 ? GAP_MODE_CLASS : MODE_GAP));
  }
  const classY: number[] = [];
  for (let i = 0; i < classCount; i++) {
    classY.push(take(CLASS_BTN_H, i === classCount - 1 ? GAP_CLASS_SUB : CLASS_GAP));
  }
  const metaBtnY = take(SUB_BTN_H, SUB_GAP);
  const slotsBtnY = take(SUB_BTN_H, 0);
  return { titleY, hintY, metaY, modeY, classY, metaBtnY, slotsBtnY };
}

/**
 * 开局面板（视图层）：配置就绪后按 characters.json 动态生成职业按钮，
 * 点击发 `on_run_start_requested(classId, mode)`（RunFlow 监听）。本局结束（死亡/通关）后重新显示。
 * 职业名 / 模式名 / 层数上限全部来自配置，零硬编码（宪法 6.7）。
 *
 * 模式（文档 2.6 / 7.6 阶段 4）：本体（有层数上限，通关解锁终局）、
 * 普通地图 / 挑战地图（终局，需本体通关后解锁）。
 */
@ccclass('StartPanel')
export class StartPanel extends Component {
  private built = false;
  private metaLabel: Label | null = null;
  private hintLabel: Label | null = null;
  /** 当前选择的模式（点击职业时一并提交给流程层）。 */
  private mode: RunMode = 'base';
  /** 模式按钮的文本节点（创建时直接持有，避免运行时再查找组件）。 */
  private modeLabels: (Label | null)[] = [];

  onLoad(): void {
    eventBus.on(EventNames.on_config_loaded, this.build, this);
    eventBus.on(EventNames.on_run_start, this.hide, this);
    // 返回存档选择（本面板的「返回存档」/ 结算面板入口）：必须让位，否则与存档列表叠字
    eventBus.on(EventNames.on_slot_panel_open, this.hide, this);
    // 本局结束先走结算界面，玩家确认（on_result_confirmed）后再回到职业选择
    eventBus.on(EventNames.on_result_confirmed, this.show, this);
    eventBus.on(EventNames.on_save_changed, this.refreshMeta, this);
    // 局外养成面板打开时让位，关闭后恢复（避免两块界面叠加）
    eventBus.on(EventNames.on_meta_panel_open, this.hide, this);
    eventBus.on(EventNames.on_meta_panel_close, this.show, this);
    // 存档流程：选定存档后才显示职业选择；续玩未完成的一局时直接进入游戏
    eventBus.on(EventNames.on_slot_entered, this.show, this);
    eventBus.on(EventNames.on_run_resume, this.hide, this);
    this.node.active = false; // 首屏为存档选择面板（SaveSlotPanel）
  }

  onDestroy(): void {
    eventBus.off(EventNames.on_config_loaded, this.build, this);
    eventBus.off(EventNames.on_run_start, this.hide, this);
    eventBus.off(EventNames.on_result_confirmed, this.show, this);
    eventBus.off(EventNames.on_save_changed, this.refreshMeta, this);
    eventBus.off(EventNames.on_meta_panel_open, this.hide, this);
    eventBus.off(EventNames.on_meta_panel_close, this.show, this);
    eventBus.off(EventNames.on_slot_entered, this.show, this);
    eventBus.off(EventNames.on_run_resume, this.hide, this);
  }

  private build(): void {
    if (this.built) return;
    this.built = true;
    // 面板底 = `Ui/Dialog` 九宫格木框：本面板原先是"悬浮文字"，加底后与其它面板风格统一。
    // 素材异步加载，未就绪时用 PANEL_BG 兜底；**最先添加** ⇒ 位于所有文字 / 按钮之下。
    makeNineSliceBg(
      this.node, 'bg', 0, PANEL_Y, PANEL_W, PANEL_H, 'ui/dialogue_box', DIALOGUE_INSET, PANEL_BG,
    );

    // 职业数量来自配置（宪法 6.7：零硬编码）⇒ 先取表，再据此排布
    const chars = dataManager.getTable<any>('characters');
    const classIds = Object.keys(chars);
    const plan = planRows(MODE_ORDER.length, classIds.length);

    // 颜色必须在**创建时**传入：UiKit 靠它判断「浅底深字」并自动不加描边（后赋值会错过）
    const title = makeLabel(this.node, 'title', -260, plan.titleY, TITLE_FONT, DARK_TEXT_COLOR);
    title.string = '地牢生存';
    // ⚠️ 这两行是**会变长的说明文字**（模式说明最长「当前：本体（共 25 层，通关后解锁终局）」、
    // 金币位数会增长）。`makeLabel` 默认锚点是**居中** ⇒ 长文案会以 x=-420 为中心**向两侧展开**，
    // 左半边直接冲出面板木框（用户实测：提示文字左缘被屏幕裁掉）。
    // 改为**左缘对齐**（anchor 0）：文本只向右伸展，右边界由面板宽度兜住。
    this.hintLabel = makeLabel(this.node, 'hint', -420, plan.hintY, SMALL_FONT, DARK_TEXT_COLOR);
    this.hintLabel.horizontalAlign = HorizontalTextAlignment.LEFT;
    const hintUt = this.hintLabel.node.getComponent(UITransform);
    if (hintUt) {
      hintUt.setAnchorPoint(0, 0.5);
      hintUt.setContentSize(PANEL_W - 200, SMALL_FONT + 16);
    }
    this.hintLabel.string = '选择模式与职业开始挑战';
    this.metaLabel = makeLabel(this.node, 'meta', -420, plan.metaY, SMALL_FONT, DARK_TEXT_COLOR);
    this.metaLabel.horizontalAlign = HorizontalTextAlignment.LEFT;
    const metaUt = this.metaLabel.node.getComponent(UITransform);
    if (metaUt) {
      metaUt.setAnchorPoint(0, 0.5);
      metaUt.setContentSize(PANEL_W - 200, SMALL_FONT + 16);
    }
    this.refreshMeta();

    // 模式选择（本体 / 普通地图 / 挑战地图）：**纵向排列**，选中项以 ▶ 标记，未解锁的给出提示
    for (let m = 0; m < MODE_ORDER.length; m++) {
      const mode = MODE_ORDER[m];
      this.modeLabels.push(makeBgButton(
        this.node, `btn_mode_${mode}`, '', 0, plan.modeY[m], MODE_BTN_W, MODE_BTN_H,
        'ui/choice_box', CHOICE_INSET, () => this.selectMode(mode), MODE_FONT,
      ));
    }
    this.refreshMode();

    for (let i = 0; i < classIds.length; i++) {
      const classId = classIds[i];
      makeBgButton(
        this.node, `btn_${classId}`, chars[classId].name, 0, plan.classY[i],
        CLASS_BTN_W, CLASS_BTN_H,
        'ui/dialogue_box', DIALOGUE_INSET, () => {
          // 只发「请求」：由 RunFlow 先初始化状态、再广播 on_run_start（避免读到上一局残留状态）
          eventBus.emit(EventNames.on_run_start_requested, classId, this.mode);
        }, CLASS_FONT,
      );
    }

    // 局外养成入口（与职业按钮同款底图；打开后本面板由事件让位）
    makeBgButton(
      this.node, 'btn_meta', '局外养成', 0, plan.metaBtnY, SUB_BTN_W, SUB_BTN_H,
      'ui/choice_box', CHOICE_INSET, () => {
        eventBus.emit(EventNames.on_meta_panel_open);
      }, SUB_FONT,
    );
    // 返回存档选择（可切换 / 新建 / 导入其他存档）
    makeBgButton(
      this.node, 'btn_slots', '返回存档', 0, plan.slotsBtnY, SUB_BTN_W, SUB_BTN_H,
      'ui/choice_box', CHOICE_INSET, () => {
        eventBus.emit(EventNames.on_slot_panel_open);
      }, SUB_FONT,
    );
  }

  /** 选择模式：终局两模式需本体通关后解锁（文档 2.6）；未解锁时只给提示、不改变选择。 */
  private selectMode(mode: RunMode): void {
    if (!endgameRules.isModeAvailable(mode, metaState.isBaseCleared())) {
      this.setHint(`「${endgameRules.nameOf(mode)}」需先通关本体（${endgameRules.maxLayers('base')} 层）后解锁`);
      return;
    }
    this.mode = mode;
    this.refreshMode();
    this.setHint(this.modeHint(mode));
  }

  /** 模式说明（含关键规则，避免玩家不知道终局与本体差异）。 */
  private modeHint(mode: RunMode): string {
    if (mode === 'normal') {
      return '当前：普通地图（无限层 · 收益稳定）';
    }
    if (mode === 'challenge') {
      return '当前：挑战地图（无限层 · 逐层变强 · 失败保留 50% 收益）';
    }
    return `当前：本体（共 ${endgameRules.maxLayers('base')} 层，通关后解锁终局）`;
  }

  private refreshMode(): void {
    for (let i = 0; i < this.modeLabels.length; i++) {
      const mode = MODE_ORDER[i];
      const locked = !endgameRules.isModeAvailable(mode, metaState.isBaseCleared());
      const label = this.modeLabels[i];
      if (label) {
        label.string = `${mode === this.mode ? '▶ ' : ''}${endgameRules.nameOf(mode)}`
          + (locked ? '（未解锁）' : '');
      }
    }
  }

  private setHint(text: string): void {
    if (this.hintLabel) {
      this.hintLabel.string = text;
    }
  }

  /**
   * 局外金币余额（存档生效与否的直接证据）。
   * 同时刷新模式行：调试解锁 / 通关解锁都会触发 `on_save_changed`（落盘事件），
   * 因此解锁后模式按钮会立即变为可选，无需重开面板。
   */
  private refreshMeta(): void {
    if (this.metaLabel) {
      this.metaLabel.string = `局外金币：${metaState.getGold()}`;
    }
    this.refreshMode();
  }

  private show(): void {
    // 按当前可见区校正面板缩放（竖屏 k=1 保持原尺寸；横屏自动缩小 ⇒ 完整可见）
    fitPanelToScreen(this.node, PANEL_W, PANEL_H);
    this.node.active = true;
    this.refreshMeta();
    // 通关后可能刚解锁终局：回到本面板时刷新模式行与提示
    this.refreshMode();
    this.setHint(this.modeHint(this.mode));
  }

  private hide(): void {
    this.node.active = false;
  }
}

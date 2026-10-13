import { Label, Node, UITransform } from 'cc';
import { dataManager } from '../data/DataManager';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { metaState } from '../core/MetaState';
import { ensureUiRoot } from '../core/ViewRoot';
import { DARK_TEXT_COLOR, PANEL_BG, makeBgButton, makeLabel, makeNineSliceBg, fitPanelToScreen } from './UiKit';

/**
 * 局外养成面板（视图层，文档 2.9 / 7.5 阶段 3）。
 *
 * 入口：开局面板的「局外养成」按钮（`on_meta_panel_open`），返回时发 `on_meta_panel_close`；
 * 进入战斗（`on_run_start`）自动关闭。
 *
 * 规则（文档 4.2 / 宪法 6.4、6.13）：
 *  - 只做表现与「请求购买」：数值与校验全在 `core/MetaState`（唯一局外状态源），
 *    购买成功由 `on_meta_upgraded` 事件回传，本面板据此重建列表；落盘由 SaveManager 订阅完成；
 *  - 节点用代码构建（与 Minimap 同模式，不占用场景接线），仅在显示 / 类别切换 / 购买后重建，
 *    不在 update 中创建或销毁节点；
 *  - 类别与项目全部来自 `meta.json`，文案由数据生成（零硬编码游戏数值）。
 */

/** 类别顺序与显示名（表现层文案）。 */
const CATEGORIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'attr', label: '数值' },
  { key: 'growth', label: '成长' },
  { key: 'amp', label: '增幅' },
  { key: 'function', label: '技能' },
  { key: 'unlock', label: '解锁' },
];

/**
 * 排版常量（表现层，非游戏数值）—— **竖屏纵向布局**（用户口径："纵向排开、放大、充分利用竖屏空间"）。
 * 面板 1240×700 → **1100×1700**，行距 44 → **120**，字号整体放大。
 */
const TITLE_Y = 700;
const COIN_Y = 620;
const TAB_Y = 520;
const TAB_START_X = -460;
const TAB_STEP_X = 230;
const ROW_START_Y = 340;
const ROW_STEP_Y = 120;
const MAX_ROWS = 9;
/** 列位置：名称/价格用**左对齐锚点**（文本自 x 向右排，长文本不会被屏幕左缘裁剪）。 */
const COL_NAME_X = -500;
const COL_PRICE_X = 120;
const COL_BUTTON_X = 380;
const BACK_X = 380;
const BACK_Y = -740;
/** 九宫格边框厚度（实测）与控件尺寸。 */
const DIALOGUE_INSET = 7;
const CHOICE_INSET = 6;
/** 面板底：覆盖名称列（x -600）到返回按钮（x 430+）的全部内容。 */
const PANEL_W = 1100;
const PANEL_H = 1700;
const PANEL_Y = -10;
const TAB_BTN_W = 200;
const TAB_BTN_H = 90;
const ROW_BTN_W = 240;
const ROW_BTN_H = 80;

class MetaPanel {
  private root: Node | null = null;
  private listNode: Node | null = null;
  private coinLabel: Label | null = null;
  private categoryIndex = 0;

  constructor() {
    eventBus.on(EventNames.on_meta_panel_open, this.show, this);
    eventBus.on(EventNames.on_meta_panel_close, this.hide, this);
    eventBus.on(EventNames.on_meta_upgraded, this.rebuild, this);
    eventBus.on(EventNames.on_run_start, this.hide, this); // 进入战斗自动关闭
  }

  private show(): void {
    if (!this.ensurePanel() || !this.root) {
      return;
    }
    // 按当前可见区校正面板缩放（竖屏 k=1 保持原尺寸；横屏自动缩小 ⇒ 完整可见）
    fitPanelToScreen(this.root!, PANEL_W, PANEL_H);
    this.root.active = true;
    this.rebuild();
  }

  private hide(): void {
    if (this.root && this.root.isValid) {
      this.root.active = false;
    }
  }

  /** 首次显示时构建静态骨架（标题 / 金币 / 类别按钮 / 列表容器 / 返回）。 */
  private ensurePanel(): boolean {
    if (this.root && this.root.isValid) {
      return true;
    }
    const uiRoot = ensureUiRoot();
    if (!uiRoot) {
      return false;
    }
    const root = new Node('MetaPanel');
    root.layer = uiRoot.layer;
    uiRoot.addChild(root);
    this.root = root;

    // 面板底 = `Ui/Dialog` 九宫格木框（**最先添加** ⇒ 位于所有内容之下）；素材异步加载，先用 PANEL_BG 兜底
    makeNineSliceBg(
      root, 'bg', 0, PANEL_Y, PANEL_W, PANEL_H, 'ui/dialogue_box', DIALOGUE_INSET, PANEL_BG,
    );

    // 颜色必须在**创建时**传入：UiKit 靠它判断「浅底深字」并自动不加描边（后赋值会错过）
    const title = makeLabel(root, 'title', -260, TITLE_Y, 60, DARK_TEXT_COLOR);
    title.string = '局外养成';
    this.coinLabel = this.makeLeftLabel(root, 'coin', COL_NAME_X, COIN_Y, 38);

    for (let i = 0; i < CATEGORIES.length; i++) {
      const index = i;
      makeBgButton(
        root, `tab_${CATEGORIES[i].key}`, CATEGORIES[i].label,
        TAB_START_X + i * TAB_STEP_X, TAB_Y, TAB_BTN_W, TAB_BTN_H,
        'ui/choice_box', CHOICE_INSET, () => {
          this.categoryIndex = index;
          this.rebuild();
        }, 48,
      );
    }

    this.listNode = new Node('list');
    this.listNode.layer = uiRoot.layer;
    root.addChild(this.listNode);

    makeBgButton(root, 'btn_back', '返回', BACK_X, BACK_Y, 280, 110, 'ui/choice_box', CHOICE_INSET, () => {
      eventBus.emit(EventNames.on_meta_panel_close);
    }, 30);
    return true;
  }

  /** 重建当前类别的列表（类别切换 / 购买成功 / 显示时调用）。 */
  private rebuild(): void {
    if (!this.root || !this.root.isValid || !this.root.active || !this.listNode) {
      return;
    }
    if (this.coinLabel) {
      this.coinLabel.string = `局外金币：${metaState.getGold()}`;
    }
    this.listNode.destroyAllChildren();
    const key = CATEGORIES[this.categoryIndex].key;
    // 未启用的项（meta.json.enabled === false，如当前按裁决关闭的职业解锁）不展示
    const items = dataManager.getTable<any[]>('meta')
      .filter((m) => m.category === key && m.enabled !== false);
    for (let i = 0; i < items.length && i < MAX_ROWS; i++) {
      this.buildRow(items[i], i);
    }
  }

  /** 左对齐标签：文本自 x 向右排，避免居中锚点导致长文本超出屏幕左缘被裁剪。 */
  private makeLeftLabel(parent: Node, name: string, xPx: number, yPx: number, fontSize = 24): Label {
    const label = makeLabel(parent, name, xPx, yPx, fontSize, DARK_TEXT_COLOR);
    const ut = label.node.getComponent(UITransform);
    if (ut) {
      ut.setAnchorPoint(0, 0.5);
    }
    return label;
  }

  /** 单个养成项一行：名称 + 等级 + 每级效果 / 价格 / 购买按钮。 */
  private buildRow(item: any, index: number): void {
    if (!this.listNode) {
      return;
    }
    const y = ROW_START_Y - index * ROW_STEP_Y;
    const level = metaState.getLevel(item.id);
    const maxLevel = metaState.getMaxLevel(item.id);
    const maxed = level >= maxLevel;
    const cost = metaState.getUpgradeCost(item.id);

    this.makeLeftLabel(this.listNode, `n_${item.id}`, COL_NAME_X, y, 34).string =
      `${item.name}  Lv${level}/${maxLevel}  ${this.describeEffect(item)}`;
    this.makeLeftLabel(this.listNode, `p_${item.id}`, COL_PRICE_X, y, 34).string =
      maxed ? '已满级' : `${cost} 金币`;

    const affordable = metaState.canUpgrade(item.id);
    // 标准九宫格按钮（底图整块可点）；返回的 Label 直接就是文案节点，省去再查组件
    makeBgButton(
      this.listNode, `b_${item.id}`, maxed ? '已满' : (affordable ? '升级' : '金币不足'),
      COL_BUTTON_X, y, ROW_BTN_W, ROW_BTN_H, 'ui/choice_box', CHOICE_INSET,
      () => {
        // 购买校验在 MetaState 内完成（金币不足 / 已满级直接失败且不改变状态）
        metaState.purchaseUpgrade(item.id);
      }, 36,
    );
  }

  /** 百分比文案：能整除就用更少的小数位，保证「1.3%」「0.65%」「0.065%」都精确可见。 */
  private static formatPercent(pct: number): string {
    const r2 = Math.round(pct * 100);
    if (Math.abs(pct * 100 - r2) < 1e-9) {
      return String(r2 / 100);
    }
    const r3 = Math.round(pct * 1000);
    if (Math.abs(pct * 1000 - r3) < 1e-9) {
      return (r3 / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    }
    return pct.toFixed(3);
  }

  /** 效果描述（按 unit 生成后缀，避免逐项硬编码文案）。 */
  private describeEffect(item: any): string {
    const effect = item.effect;
    if (!effect) {
      return '';
    }
    if (effect.kind === 'unlock_class') {
      return '解锁职业';
    }
    if (effect.kind === 'buff_slot') {
      return `强化槽位 ${effect.value}`;
    }
    if (effect.kind === 'behavior_skill_slot') {
      return `技能槽位 ${effect.value}`;
    }
    const per = effect.per_level;
    if (typeof per !== 'number') {
      return '';
    }
    switch (effect.unit) {
      case 'ratio':
        // 保留真实精度（1.3% / 0.65% / 0.065% 都要显示准确，不能四舍五入成整数）
        return `+${MetaPanel.formatPercent(per * 100)}%/级`;
      case 'px':
        return `+${per}px/级`;
      case 'count':
        return `+${per}/级`;
      default:
        return `+${per}/级`;
    }
  }
}

export const metaPanel = new MetaPanel();

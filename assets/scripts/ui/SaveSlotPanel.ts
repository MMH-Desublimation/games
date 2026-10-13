import { Label, Node, UITransform } from 'cc';
import { dataManager } from '../data/DataManager';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { metaState } from '../core/MetaState';
import { ensureUiRoot } from '../core/ViewRoot';
import { saveManager, SlotInfo } from '../save/SaveManager';
import { timer } from '../core/Timer';
import { DARK_TEXT_COLOR, PANEL_BG, makeBgButton, makeLabel, makeNineSliceBg, fitPanelToScreen } from './UiKit';

/**
 * 存档选择面板（视图层，文档 5.2 / 5.5；用户裁决：3 个存档槽）。
 *
 * 流程：启动 → 本面板（选空档 = 新建并进入职业选择；选已有档 = 加载该档，若有未完成的一局则续玩）
 *      → 职业选择（StartPanel） → 局内。
 * 每槽提供：进入 / 新建、导出（Base64 到剪贴板并打印）、删除；空档提供导入。
 *
 * 规则（宪法 6.4 / 6.8 / 6.13）：
 *  - 只做表现与请求：槽位读写、checksum、迁移全在 `save/SaveManager`；
 *  - 节点代码构建（与 Minimap / MetaPanel 同模式），仅在显示 / 列表变化时重建，不在 update 中创建销毁；
 *  - 槽位数量与文案均由配置与数据生成，无硬编码游戏数值。
 */

/**
 * 排版常量（表现层）—— **竖屏纵向布局**。
 *
 * 用户两轮反馈："依然是小小的横屏放在竖屏里面，可以把画面、效果、字体适当放大并纵向排开、
 * 充分利用竖屏空间"。故由原先的「文本一行 + 三个按钮挤在右侧」改为**每个槽位占两行**：
 * ```
 * 槽 1   战士 · 第 1 层 · 局外金币 1265 · 本体未通关
 *        [ 进入 ]  [ 导出 ]  [ 删除 ]
 * ```
 * 面板由 1240×660（横屏比例）改为 **1140×1560**（竖长），字号同步放大。
 */
const TITLE_Y = 620;
const ROW_START_Y = 380;
const ROW_STEP_Y = 300;
const TEXT_X = -520;
/**
 * 按钮列 x（槽位第二行，三列并排，整体居中于面板）。
 * ⚠️ 离线验证发现：按钮行与 36 号文本行只隔 40px，缩略后**看着挤在一起** ⇒ 行距加大到 140。
 */
const BTN_ROW_DY = -140;
const BTN_PRIMARY_X = -360;
const BTN_SECOND_X = -140;
const BTN_THIRD_X = 80;
const HINT_Y = -640;
/** 操作反馈提示的位置与停留时长（导出 / 导入结果）。 */
const TOAST_Y = 240;
const TOAST_MS = 2200;
/** 九宫格边框厚度（实测）与控件尺寸。 */
const DIALOGUE_INSET = 7;
const CHOICE_INSET = 6;
/** 面板底：竖长比例，充分利用竖屏纵向空间。 */
const PANEL_W = 1140;
const PANEL_H = 1560;
const PANEL_Y = 0;
/** 槽位按钮尺寸（竖屏放大，便于点按）。 */
const ROW_BTN_W = 190;
const ROW_BTN_H = 76;

/** 槽位按钮的关闭/进入语义（与文案一一对应）。 */
const LABEL_ENTER = '进入';
const LABEL_CREATE = '新建';
const LABEL_EXPORT = '导出';
const LABEL_DELETE = '删除';
const LABEL_IMPORT = '导入';

class SaveSlotPanel {
  private root: Node | null = null;
  private listNode: Node | null = null;
  private toastLabel: Label | null = null;
  private toastTimerId = 0;

  constructor() {
    // 首屏改为**开始封面**（`CoverPanel`）：本面板不再在配置就绪时自动显示，
    // 而是由封面的「开始游戏」按钮调用 `show()`（用户口径：要有开始封面）。
    eventBus.on(EventNames.on_save_slots_changed, this.rebuild, this);
    eventBus.on(EventNames.on_slot_panel_open, this.show, this);
    // 进入游戏后隐藏：选档完成 / 续玩 / 开局都退出本面板
    eventBus.on(EventNames.on_slot_entered, this.hide, this);
    eventBus.on(EventNames.on_run_resume, this.hide, this);
    eventBus.on(EventNames.on_run_start, this.hide, this);
    // 主动退出本局（暂停面板「退出到存档」）后回到本界面；死亡/通关走结算面板
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);
  }

  /** 本局结束：主动退出（suspend）回到本界面；死亡 / 通关由结算面板接管。 */
  private onRunEnd(reason?: string): void {
    if (reason !== 'suspend') {
      return;
    }
    this.show();
  }

  show(): void {
    if (!this.ensurePanel() || !this.root) {
      return;
    }
    // 按当前可见区校正面板缩放（竖屏 k=1 保持原尺寸；横屏自动缩小 ⇒ 完整可见）
    fitPanelToScreen(this.root!, PANEL_W, PANEL_H);
    this.root.active = true;
    this.rebuild();
  }

  hide(): void {
    if (this.root && this.root.isValid) {
      this.root.active = false;
    }
  }

  /** 首次显示时构建骨架（标题 / 列表容器 / 底部提示）。 */
  private ensurePanel(): boolean {
    if (this.root && this.root.isValid) {
      return true;
    }
    const uiRoot = ensureUiRoot();
    if (!uiRoot) {
      return false;
    }
    const root = new Node('SaveSlotPanel');
    root.layer = uiRoot.layer;
    uiRoot.addChild(root);
    this.root = root;

    // 面板底 = `Ui/Dialog` 九宫格木框（**最先添加** ⇒ 位于标题 / 槽位列表 / 提示之下）；
    // 素材异步加载，未就绪时先用 PANEL_BG 兜底
    makeNineSliceBg(
      root, 'bg', 0, PANEL_Y, PANEL_W, PANEL_H, 'ui/dialogue_box', DIALOGUE_INSET, PANEL_BG,
    );

    // 颜色必须在**创建时**传入：UiKit 靠它判断「浅底深字」并自动不加描边（后赋值会错过）
    const title = makeLabel(root, 'title', -140, TITLE_Y, 56, DARK_TEXT_COLOR);
    title.string = '选择存档';

    this.listNode = new Node('list');
    this.listNode.layer = uiRoot.layer;
    root.addChild(this.listNode);

    const hint = this.makeLeftLabel(root, 'hint', TEXT_X, HINT_Y, 26);
    hint.string = '导出/导入使用 Base64 文本：导出会复制到剪贴板并打印在控制台，导入时粘贴到弹窗';

    // 操作反馈提示：玩家在预览里看不到控制台，导出/导入结果必须在界面内给出反馈
    this.toastLabel = this.makeLeftLabel(root, 'toast', TEXT_X, TOAST_Y, 24);
    this.toastLabel.string = '';
    return true;
  }

  /** 重建槽位列表（显示时 / 新建 / 删除 / 导入后调用）。 */
  private rebuild(): void {
    if (!this.root || !this.root.isValid || !this.root.active || !this.listNode) {
      return;
    }
    this.listNode.destroyAllChildren();
    const slots = saveManager.listSlots();
    for (let i = 0; i < slots.length; i++) {
      this.buildRow(slots[i], i);
    }
  }

  private buildRow(info: SlotInfo, index: number): void {
    if (!this.listNode) {
      return;
    }
    // 每个槽位占**两行**：第一行是描述文本，第二行是操作按钮（竖屏纵向排开）
    const y = ROW_START_Y - index * ROW_STEP_Y;
    const btnY = y + BTN_ROW_DY;
    this.makeLeftLabel(this.listNode, `t_${info.slot}`, TEXT_X, y, 36).string = this.describe(info);

    if (!info.exists) {
      makeBgButton(
        this.listNode, `c_${info.slot}`, LABEL_CREATE, BTN_PRIMARY_X, btnY, ROW_BTN_W, ROW_BTN_H,
        'ui/dialogue_box', DIALOGUE_INSET, () => this.onEnter(info.slot), 34,
      );
      makeBgButton(
        this.listNode, `i_${info.slot}`, LABEL_IMPORT, BTN_SECOND_X, btnY, ROW_BTN_W, ROW_BTN_H,
        'ui/choice_box', CHOICE_INSET, () => this.onImport(info.slot), 34,
      );
      return;
    }

    makeBgButton(
      this.listNode, `e_${info.slot}`, LABEL_ENTER, BTN_PRIMARY_X, btnY, ROW_BTN_W, ROW_BTN_H,
      'ui/dialogue_box', DIALOGUE_INSET, () => this.onEnter(info.slot), 34,
    );
    makeBgButton(
      this.listNode, `x_${info.slot}`, LABEL_EXPORT, BTN_SECOND_X, btnY, ROW_BTN_W, ROW_BTN_H,
      'ui/choice_box', CHOICE_INSET, () => this.onExport(info.slot), 34,
    );
    makeBgButton(
      this.listNode, `d_${info.slot}`, LABEL_DELETE, BTN_THIRD_X, btnY, ROW_BTN_W, ROW_BTN_H,
      'ui/choice_box', CHOICE_INSET, () => this.onDelete(info.slot), 34,
    );
  }

  /**
   * 槽位摘要（用户反馈：原先信息过多，长文本与右侧按钮文字交叠 → 只保留必要三项）。
   * 文案长度需控制在按钮列（x=180 起）左侧。
   */
  private describe(info: SlotInfo): string {
    const head = `槽 ${info.slot}`;
    if (!info.exists) {
      return `${head}   空存档`;
    }
    const gold = `局外金币 ${info.metaGold}`;
    // 终局进度：本体是否通关 + 挑战地图最深层（卡关点观测，文档 7.6）
    const endgame = info.baseCleared
      ? ` · 本体已通关 · 挑战最深 ${info.challengeBestLayer} 层` : ' · 本体未通关';
    if (!info.classId) {
      return `${head}   无进行中局面 · ${gold}${endgame}`;
    }
    return `${head}   ${this.classNameOf(info.classId)} · 第 ${info.layer} 层 · ${gold}${endgame}`;
  }

  private classNameOf(classId: string): string {
    try {
      return dataManager.get<any>('characters', classId).name ?? classId;
    } catch (e) {
      return classId;
    }
  }

  private onEnter(slot: number): void {
    saveManager.enterSlot(slot);
    const run = metaState.getCurrentRun();
    if (run) {
      eventBus.emit(EventNames.on_run_resume, run); // 续玩未完成的一局
    } else {
      eventBus.emit(EventNames.on_slot_entered); // 进入职业选择
    }
  }

  private onDelete(slot: number): void {
    saveManager.deleteSlot(slot);
  }

  private onExport(slot: number): void {
    const text = saveManager.exportSlot(slot);
    if (!text) {
      console.warn(`[SaveSlot] 槽 ${slot} 无存档可导出`);
      this.showToast(`槽 ${slot} 没有可导出的存档`);
      return;
    }
    console.log(`[SaveSlot] 槽 ${slot} 存档（Base64）：\n${text}`);
    const clipboard = (globalThis as any).navigator?.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text).then(
        () => {
          console.log('[SaveSlot] 已复制到剪贴板');
          this.showToast('存档已复制到剪贴板（同时打印在控制台）');
        },
        () => {
          console.warn('[SaveSlot] 剪贴板不可用，请从上方控制台复制');
          this.showToast('剪贴板不可用：请从控制台复制存档文本');
        },
      );
    } else {
      this.showToast('当前环境无剪贴板：请从控制台复制存档文本');
    }
  }

  private onImport(slot: number): void {
    const promptFn = (globalThis as any).prompt as ((msg: string) => string | null) | undefined;
    if (typeof promptFn !== 'function') {
      console.warn('[SaveSlot] 当前环境不支持弹窗输入，请在 Web 预览中使用导入');
      this.showToast('当前环境不支持弹窗输入，请在 Web 预览中使用导入');
      return;
    }
    const text = promptFn('粘贴存档 Base64 文本（会覆盖该槽）：');
    if (!text) {
      return;
    }
    if (saveManager.importSlot(text, slot)) {
      console.log(`[SaveSlot] 槽 ${slot} 导入成功`);
      this.showToast(`已导入到槽 ${slot}`);
    } else {
      console.warn('[SaveSlot] 导入失败：文本不是有效的存档');
      this.showToast('导入失败：文本不是有效的存档');
    }
  }

  /** 面板内操作反馈（导出 / 导入结果）；到点自动清除。 */
  private showToast(text: string): void {
    if (!this.toastLabel) {
      return;
    }
    this.toastLabel.string = text;
    if (this.toastTimerId) {
      timer.cancel(this.toastTimerId);
    }
    this.toastTimerId = timer.after(TOAST_MS / 1000, () => {
      this.toastTimerId = 0;
      if (this.toastLabel) {
        this.toastLabel.string = '';
      }
    });
  }

  /** 左对齐标签（长文本不会被屏幕左缘裁剪）。 */
  private makeLeftLabel(parent: Node, name: string, xPx: number, yPx: number, fontSize = 24): Label {
    const label = makeLabel(parent, name, xPx, yPx, fontSize, DARK_TEXT_COLOR);
    const ut = label.node.getComponent(UITransform);
    if (ut) {
      ut.setAnchorPoint(0, 0.5);
    }
    return label;
  }
}

export const saveSlotPanel = new SaveSlotPanel();

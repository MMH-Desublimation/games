import { Color, _decorator, Component, Node } from 'cc';
import { dataManager } from '../data/DataManager';
import { gameState } from '../core/GameState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { DARK_TEXT_COLOR, PANEL_BG, makeBgButton, makeLabel, makeNineSliceBg, fitPanelToScreen } from './UiKit';

const { ccclass } = _decorator;

/** `ui/dialogue_box`（316×60）实测九宫格边框厚度。 */
const DIALOGUE_INSET = 7;
/** `ui/choice_box`（64×20）实测九宫格边框厚度。 */
const CHOICE_INSET = 6;
/**
 * 竖屏纵向布局（用户口径："纵向排开、充分利用竖屏空间"）：
 * 面板 660×470 → **1040×1300**，选项 620×72 → **900×170**，字号整体放大。
 */
const OPTION_W = 900;
const OPTION_H = 170;
const OPTION_START_Y = 260;
const OPTION_STEP_Y = 220;
const PANEL_W = 1040;
const PANEL_H = 1300;
const TITLE_Y = 520;
const TITLE_FONT = 56;
const OPTION_FONT = 40;
/**
 * 底图**染色**（与原图相乘）。
 * 素材内部是浅灰白，整块面板满屏时**偏亮刺眼**（用户口径："太亮了、底色柔和一点、不要纯白"）
 * ⇒ 乘一层米色，得到柔和的米白。
 */
const PANEL_TINT = new Color(236, 222, 198, 255);
const OPTION_TINT = new Color(244, 234, 214, 255);

/**
 * 升级选卡面板（视图层）：监听 on_buff_offered(ids) 展示 N 选 1 按钮，
 * 点击后发 on_buff_pick_requested(id)，由 BuffSystem 应用（宪法 6.4：不经实例引用）。
 * 按钮文案取自 buffs.json 的 name，数量来自 offer 数组，零硬编码。
 *
 * 视觉（用户口径：UI 美化）：面板底 = `Ui/Dialog/DialogueBoxSimple` 九宫格（`ui/dialogue_box`），
 * 每个选项 = `Ui/Dialog/ChoiceBox` 九宫格（`ui/choice_box`）。素材内部是**浅灰底**，
 * 故选项与标题文字一律用 `DARK_TEXT_COLOR`（暖白字在浅底上看不清）。素材缺失时自动退回深色块。
 */
@ccclass('BuffPanel')
export class BuffPanel extends Component {
  /** 按钮容器：每次发放前整体重建（升级频次低，不在 update 中）。 */
  private optionsNode: Node | null = null;

  onLoad(): void {
    // 面板底（九宫格）：**最先添加** ⇒ 位于选项按钮之下
    makeNineSliceBg(
      this.node, 'bg', 0, 0, PANEL_W, PANEL_H, 'ui/dialogue_box', DIALOGUE_INSET, PANEL_BG, PANEL_TINT,
    );
    this.optionsNode = new Node('options');
    this.node.addChild(this.optionsNode);
    eventBus.on(EventNames.on_buff_offered, this.showOptions, this);
    eventBus.on(EventNames.on_run_start, this.hide, this);
    eventBus.on(EventNames.on_run_end, this.hide, this);
  }

  onDestroy(): void {
    eventBus.off(EventNames.on_buff_offered, this.showOptions, this);
    eventBus.off(EventNames.on_run_start, this.hide, this);
    eventBus.off(EventNames.on_run_end, this.hide, this);
  }

  private showOptions(ids: string[]): void {
    if (!this.optionsNode) return;
    // 按当前可见区校正面板缩放（竖屏 k=1 保持原尺寸；横屏自动缩小 ⇒ 完整可见）
    fitPanelToScreen(this.node, PANEL_W, PANEL_H);
    this.node.active = true;
    this.optionsNode.destroyAllChildren();

    // 颜色必须在**创建时**传入：UiKit 靠它判断「浅底深字」并自动不加描边（后赋值会错过）
    const title = makeLabel(this.node, 'title', -260, TITLE_Y, TITLE_FONT, DARK_TEXT_COLOR);
    title.string = '选择强化';
    // 标题挂在面板根节点，随 options 一起清理：先移到容器外，销毁时统一处理
    this.optionsNode.addChild(title.node);

    for (let i = 0; i < ids.length; i++) {
      const buff = dataManager.get<any>('buffs', ids[i]);
      // 技能型 Buff 重复获得即升级：候选文案直接标注「当前等级 → 升级后等级」
      let text = buff.name;
      if (buff.type === 'skill_behavior') {
        const level = gameState.getBuffLevel(ids[i]);
        const maxLevel = Array.isArray(buff.levels) ? buff.levels.length : 1;
        text = level > 0
          ? `${buff.name}  Lv${level} → Lv${Math.min(maxLevel, level + 1)}`
          : `${buff.name}  （新技能 Lv1）`;
      }
      // 选项 = 标准九宫格按钮（`choice_box` 底图 + 深色文字）；整块可点
      makeBgButton(
        this.optionsNode, `btn_${ids[i]}`, text, 0, OPTION_START_Y - i * OPTION_STEP_Y, OPTION_W, OPTION_H,
        'ui/choice_box', CHOICE_INSET, () => {
          eventBus.emit(EventNames.on_buff_pick_requested, ids[i]);
          this.hide();
        }, OPTION_FONT, undefined, undefined, OPTION_TINT,
      );
    }

    // 等待选择期间冻结玩法层（选完 hide() 恢复），UI 仍可点击
    gameState.pauseRun();
  }

  private hide(): void {
    this.node.active = false;
    gameState.resumeRun();
  }
}

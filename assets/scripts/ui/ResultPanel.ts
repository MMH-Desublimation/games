import { _decorator, Component, Label, Node } from 'cc';
import { gameState } from '../core/GameState';
import { metaState } from '../core/MetaState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { layerRisk } from '../dungeon/LayerRisk';
import { endgameRules } from '../dungeon/EndgameRules';
import { DARK_TEXT_COLOR, PANEL_BG, makeBgButton, makeLabel, makeNineSliceBg, fitPanelToScreen } from './UiKit';

const { ccclass } = _decorator;

/** `ui/dialogue_box`（316×60）与 `ui/choice_box`（64×20）实测九宫格边框厚度。 */
const DIALOGUE_INSET = 7;
const CHOICE_INSET = 6;
/**
 * 结算按钮尺寸。
 * 主按钮（再来一局）用 `dialogue_box`（与「开始游戏」「继续」同款），次按钮用 `choice_box`。
 */
/**
 * 竖屏纵向布局（用户口径："把画面、效果、字体适当放大并纵向排开、充分利用竖屏空间"）：
 * 面板由 680×600 改为 **1040×1500**，字号与行距整体放大。
 * ⚠️ 保留原先教训：按钮必须与末行文本留足间距（横屏版曾因只差 14px 而叠字）。
 */
const BTN_W = 420;
const BTN_H = 120;
const BTN_Y = -560;
const BTN_DX = 230;
const TEXT_X = -400;
const PANEL_W = 1040;
const PANEL_H = 1500;
/** 标题与各行的纵向位置 / 行距（竖屏放大）。 */
const TITLE_Y = 620;
const ROW_START_Y = 480;
const ROW_STEP_Y = 96;
const TITLE_FONT = 56;
const ROW_FONT = 34;
const BTN_FONT = 44;

/**
 * 死亡结算面板（视图层，对应文档 7 阶段 1 任务 4）。
 *
 * 职责：监听 on_run_end 展示本局战绩（数据全部来自只读查询），
 * 点击"再来一局"发 on_result_confirmed，由 StartPanel 回到职业选择。
 * 规则（文档 4.2）：ui 只做表现，不直接改游戏状态；文案数量取自状态，零硬编码数值。
 *
 * 结算行包含「局外金币（累计）」与「层内结算（停留 / 提前离开倍率）」，
 * 用于 T01 收益软上限与提前离开奖励的数值核对（文档 2.4 / 3.7）。
 */
@ccclass('ResultPanel')
export class ResultPanel extends Component {
  /** 每次展示前整体重建的文本容器（开局频次低，不在 update 中创建节点）。 */
  private linesNode: Node | null = null;

  onLoad(): void {
    // 面板底 = `Ui/Dialog/DialogueBoxSimple` 九宫格：**最先添加** ⇒ 位于所有文字之下
    // （同父节点中先加的渲染在下）。素材异步加载，未就绪时先用 PANEL_BG 兜底。
    makeNineSliceBg(this.node, 'bg', 0, 0, PANEL_W, PANEL_H, 'ui/dialogue_box', DIALOGUE_INSET, PANEL_BG);
    this.linesNode = new Node('lines');
    this.node.addChild(this.linesNode);
    eventBus.on(EventNames.on_run_end, this.show, this);
    eventBus.on(EventNames.on_run_start, this.hide, this);
    this.node.active = false;
  }

  onDestroy(): void {
    eventBus.off(EventNames.on_run_end, this.show, this);
    eventBus.off(EventNames.on_run_start, this.hide, this);
  }

  /**
   * 本局结束：按当前状态渲染战绩并显示。
   * 主动退出（`suspend`）不算战绩，直接让位给存档界面（进度已保留，可继续）。
   */
  private show(reason?: string): void {
    if (reason === 'suspend') {
      this.hide();
      return;
    }
    if (!this.linesNode) return;
    this.linesNode.destroyAllChildren();
    // 按当前可见区校正面板缩放（竖屏 k=1 保持原尺寸；横屏自动缩小 ⇒ 完整可见）
    fitPanelToScreen(this.node, PANEL_W, PANEL_H);
    this.node.active = true;

    const mode = gameState.getMode();
    // 通关（本体打完最后一层）与失败区分：通关是终局解锁的里程碑，必须让玩家明确看到
    const cleared = reason === 'clear';
    // 颜色必须在**创建时**传入：UiKit 靠它判断「浅底深字」并自动不加描边（后赋值会错过）
    const title: Label = makeLabel(this.linesNode, 'title', -260, TITLE_Y, TITLE_FONT, DARK_TEXT_COLOR);
    title.string = cleared ? '本体通关！' : '本局结算';

    const lines: string[] = [
      `模式：${endgameRules.nameOf(mode)}`,
      `到达层数：${gameState.getLayer()}`,
      `等级：${gameState.getLevel()}`,
      `击杀：${gameState.getKills()}`,
      `本局金币：${gameState.getGold()}`,
      `局外金币（累计）：${metaState.getGold()}`,
      `已选强化：${gameState.getBuffs().length}`,
      `层内结算：停留 ${layerRisk.getElapsedSec().toFixed(0)}s / 提前离开倍率 ×${layerRisk.getEarlyLeaveMultiplier().toFixed(2)}`,
    ];
    if (cleared) {
      lines.push('终局（普通地图 / 挑战地图）已解锁');
    } else if (mode === 'challenge') {
      lines.push(`挑战失败：本局收益保留 ${Math.round(endgameRules.failKeepRatio(mode) * 100)}%`);
    }
    for (let i = 0; i < lines.length; i++) {
      const line = makeLabel(this.linesNode, `line_${i}`, TEXT_X, ROW_START_Y - i * ROW_STEP_Y, ROW_FONT, DARK_TEXT_COLOR);
      line.string = lines[i];
    }

    makeBgButton(
      this.linesNode, 'btn_retry', '再来一局', -BTN_DX, BTN_Y, BTN_W, BTN_H,
      'ui/dialogue_box', DIALOGUE_INSET, () => {
        eventBus.emit(EventNames.on_result_confirmed);
        this.hide();
      }, BTN_FONT,
    );
    // 返回存档选择（可切换 / 新建 / 导入其他存档）
    makeBgButton(
      this.linesNode, 'btn_slots', '返回存档', BTN_DX, BTN_Y, BTN_W, BTN_H,
      'ui/choice_box', CHOICE_INSET, () => {
        eventBus.emit(EventNames.on_slot_panel_open);
        this.hide();
      }, BTN_FONT,
    );
  }

  private hide(): void {
    this.node.active = false;
  }
}

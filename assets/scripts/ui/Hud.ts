import { _decorator, Component, Graphics, Label, UITransform } from 'cc';
import { dataManager } from '../data/DataManager';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { metaState } from '../core/MetaState';
import { getGameAreaTopY, getVisibleWidth, UI_EDGE_INSET_PX } from '../core/ViewRoot';
import { endgameRules } from '../dungeon/EndgameRules';
import {
  HUD_BG, HUD_TEXT_COLOR, estimateTextWidth, makeLabel, makeRoundRectBg, redrawRoundRect,
} from './UiKit';

/**
 * HUD 各行相对**游戏画面区顶边**的向下偏移（px）。
 * ⚠️ 竖屏分区后不能再写死"屏幕中心坐标系"的 y（如 340）—— 那会跑到操作区里。
 * 顺序与 `onLoad` 建标签的顺序一一对应。
 *
 * 竖屏下**整体加大**（用户口径："左上角、右上角的 UI 可以适当加大"）：字号 30/24/20 → 38/30/26。
 */
const HUD_ROW_OFFSET = [88, 166, 228, 286, 344, 402];
const HUD_FONT = [46, 36, 32, 32, 32, 32];
/** 底衬内边距 / 圆角 / 每行半高（按**实际有内容的行**算底衬尺寸）。 */
const HUD_BG_PAD = 18;
const HUD_BG_RADIUS = 14;
const HUD_ROW_HALF_H = 26;
/**
 * HUD 底衬**右侧预留**（px）：右上角那一条让给小地图（宽 380）+ 边距，
 * 底衬最宽到此为止，否则会和小地图 / 暂停叠成一片（实测：三者重叠）。
 */
const HUD_RIGHT_RESERVE_PX = 460;

const { ccclass } = _decorator;

/**
 * HUD（视图层）：只读 gameState 快照 + 订阅事件刷新，禁止轮询（宪法 6.4）。
 * 标签在 onLoad 构建一次；刷新仅改 string，不创建/销毁节点（宪法 6.13）。
 *
 * 除基础信息外，额外显示**层内风险三机制实时读数**（时间压力 / 收益软上限 / 提前离开倍率 + 本层停留秒数），
 * 用于 T01 的实机核对（文档 2.4 / 3.7 的三个系数不再只能靠控制台日志观察）。
 *
 * **行序（用户口径：精简，共 6 行；后 3 行无内容时不渲染）**：
 * ```
 * HP 120 / 120                                  ← 唯一需要一眼看到的数值，字号最大
 * 战士 · 本体 ｜ 第 2 层 ｜ Lv3 ｜ 金币 100        ← 原「职业/层数/等级/金币」4 行压成 1 行
 * 压力×1.00 收益×1.00 早离×1.00 停留 0s           ← 风险三机制读数（每 15s 更新）
 * 出口封锁：击杀本层 Boss 后解锁                   ← 仅 Boss 层未击杀时出现
 * 强化 荆棘 / 连锁 (2/4)                          ← 仅携带行为型强化时出现
 * 技能 疾影 (1/3)                                ← 仅携带技能型强化时出现
 * ```
 * 位置**固定**（不随内容动态排版）⇒ 空内容只是不渲染，不会引起其它行跳动。
 *
 * 排版说明：所有标签锚点设为**左中对齐**（anchor 0,0.5），文本从 x 向右排。
 * 若用默认居中对齐，长文本会以中心点向两侧展开而超出屏幕左缘被裁剪。
 */
@ccclass('Hud')
export class Hud extends Component {
  /** 生命：HUD 最醒目的一行（独立大字号，血量是唯一需要"一眼看到"的数值）。 */
  private hpLabel: Label | null = null;
  /**
   * 基础信息压成**一行**：`职业 · 模式 ｜ 第N层 ｜ Lv ｜ 金币`。
   *
   * 原先职业 / 层数 / 等级 / 金币**各占一行**，加上风险三读数、出口提示、强化、技能共 **9 行**，
   * 在 1280×720 上把左上角糊满 —— 用户口径：**精简**。现固定 6 行（后 3 行无内容时不渲染）。
   */
  private infoLabel: Label | null = null;
  private riskLabel: Label | null = null;
  private exitLabel: Label | null = null;
  /** 已携带强化（含技能型 Buff 的等级）——用于让"携带/替换"对玩家可见。 */
  private buffLabel: Label | null = null;
  /**
   * 技能型 Buff（占独立槽位）。
   * 说明：这里**只显示技能名与等级**；技能型 Buff 的「下一发倒计时」原先另占一行，
   * 会造成「技能名一行 + CD 一行」的双列表观感（用户要求精简），故已移除。
   */
  private buffSkillLabel: Label | null = null;
  /** 底衬（圆角半透明；尺寸在 `redrawBg()` 里按**实际有内容**的行动态贴合）。 */
  private bgG: Graphics | null = null;

  onLoad(): void {
    // 贴左缘定位：可见宽度随屏幕比例变化（FIXED_HEIGHT 下 16:9 → 1280、20:9 → 1600）
    // ⇒ 硬编码 -600 会在长屏手机上离左边过远、在窄屏（4:3 平板）上被裁掉。
    const x = -getVisibleWidth() / 2 + UI_EDGE_INSET_PX;
    // 半透明**圆角**底衬：HUD 原先直接画在地宫上只能靠描边可读；有底衬后文字**不描边** ⇒ 字细。
    // ⚠️ 尺寸**必须动态贴合内容**：第一版用固定 620×240，可实际常年只有 3 行字，
    //    左上角白占一大块 —— 用户反馈"严重遮挡画面"。这里先建占位，尺寸交给 `redrawBg()`。
    this.bgG = makeRoundRectBg(this.node, 'bg', 0, 0, 10, 10, HUD_BG_RADIUS, HUD_BG);
    // 行序（自上而下）：HP → 基础信息 → 风险读数 → 出口提示 → 强化 → 技能
    // 位置**固定不变**，内容为空时 Label 不渲染 ⇒ 无需动态排版（宪法 6.13：onLoad 建一次）。
    // 职业放在基础信息行内：三职业共用同一张角色美术，不标注职业时无法分辨本局在玩谁。
    const top = getGameAreaTopY();
    this.hpLabel = this.makeHudLabel('hp', x, top - HUD_ROW_OFFSET[0], HUD_FONT[0]);
    this.infoLabel = this.makeHudLabel('info', x, top - HUD_ROW_OFFSET[1], HUD_FONT[1]);
    this.riskLabel = this.makeHudLabel('risk', x, top - HUD_ROW_OFFSET[2], HUD_FONT[2]);
    this.exitLabel = this.makeHudLabel('exit', x, top - HUD_ROW_OFFSET[3], HUD_FONT[3]);
    this.buffLabel = this.makeHudLabel('buffs', x, top - HUD_ROW_OFFSET[4], HUD_FONT[4]);
    this.buffSkillLabel = this.makeHudLabel('buffs_skill', x, top - HUD_ROW_OFFSET[5], HUD_FONT[5]);

    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
    eventBus.on(EventNames.on_hp_changed, this.refresh, this);
    eventBus.on(EventNames.on_layer_start, this.refresh, this);
    eventBus.on(EventNames.on_player_levelup, this.refresh, this);
    eventBus.on(EventNames.on_gold_gained, this.refresh, this);
    eventBus.on(EventNames.on_layer_risk_changed, this.onRiskChanged, this);
    eventBus.on(EventNames.on_exit_lock_changed, this.onExitLockChanged, this);
    // 携带强化变化（选中 / 替换 / 升级）时刷新列表
    eventBus.on(EventNames.on_buff_selected, this.refresh, this);
    // 互斥显示：结算界面 / 局外养成面板出现时隐藏局内 HUD，避免文字叠在一起
    eventBus.on(EventNames.on_run_end, this.hideForOverlay, this);
    eventBus.on(EventNames.on_meta_panel_open, this.hideForOverlay, this);
    eventBus.on(EventNames.on_meta_panel_close, this.restoreAfterOverlay, this);

    this.refresh();
    this.node.active = false; // 开局面板阶段不显示局内 HUD
  }

  onDestroy(): void {
    eventBus.off(EventNames.on_run_start, this.onRunStart, this);
    eventBus.off(EventNames.on_hp_changed, this.refresh, this);
    eventBus.off(EventNames.on_layer_start, this.refresh, this);
    eventBus.off(EventNames.on_player_levelup, this.refresh, this);
    eventBus.off(EventNames.on_gold_gained, this.refresh, this);
    eventBus.off(EventNames.on_layer_risk_changed, this.onRiskChanged, this);
    eventBus.off(EventNames.on_exit_lock_changed, this.onExitLockChanged, this);
    eventBus.off(EventNames.on_buff_selected, this.refresh, this);
    eventBus.off(EventNames.on_run_end, this.hideForOverlay, this);
    eventBus.off(EventNames.on_meta_panel_open, this.hideForOverlay, this);
    eventBus.off(EventNames.on_meta_panel_close, this.restoreAfterOverlay, this);
  }

  /**
   * 重画底衬：**只覆盖当前有内容的行**（空行不占位）⇒ 底衬始终贴着文字，不遮挡画面。
   * 只在内容变化时（刷新事件里）调用，不在 update 中（宪法 6.13）。
   */
  private redrawBg(): void {
    if (!this.bgG || !this.bgG.node.isValid) {
      return;
    }
    const labels = [
      this.hpLabel, this.infoLabel, this.riskLabel,
      this.exitLabel, this.buffLabel, this.buffSkillLabel,
    ];
    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let maxW_ = 0;
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (!label || !label.string) {
        continue; // 空行不参与尺寸计算
      }
      const y = getGameAreaTopY() - HUD_ROW_OFFSET[i];
      top = Math.max(top, y + HUD_ROW_HALF_H);
      bottom = Math.min(bottom, y - HUD_ROW_HALF_H);
      maxW_ = Math.max(maxW_, estimateTextWidth(label.string, label.fontSize));
    }
    if (top < bottom || maxW_ <= 0) {
      this.bgG.node.active = false; // 完全没有内容 ⇒ 不画底衬
      return;
    }
    this.bgG.node.active = true;
    const leftEdge = -getVisibleWidth() / 2 + UI_EDGE_INSET_PX;
    // 底衬**限宽**：不能伸到右上角（小地图 380 + 边距）那条带里去，否则与它叠成一片（实测）
    const maxW = getVisibleWidth() - UI_EDGE_INSET_PX * 2 - HUD_RIGHT_RESERVE_PX;
    const w = Math.min(maxW, maxW_ + HUD_BG_PAD * 2);
    const h = (top - bottom) + HUD_BG_PAD * 2;
    this.bgG.node.setPosition(leftEdge - HUD_BG_PAD + w / 2, (top + bottom) / 2, 0);
    redrawRoundRect(this.bgG, w, h, HUD_BG_RADIUS, HUD_BG);
  }

  /** 左对齐标签（长文本不会被屏幕左缘裁剪）；`outline = false` ⇒ 不描边，字体保持细。 */
  private makeHudLabel(name: string, xPx: number, yPx: number, fontSize = 26): Label {
    const label = makeLabel(this.node, name, xPx, yPx, fontSize, HUD_TEXT_COLOR, false);
    const ut = label.node.getComponent(UITransform);
    if (ut) {
      ut.setAnchorPoint(0, 0.5);
    }
    return label;
  }

  /** 开局：显示 HUD，风险读数归位到基线，出口提示清空，再刷新基础信息。 */
  private onRunStart(): void {
    this.node.active = true;
    this.onRiskChanged(1, 1, 1, 0);
    this.onExitLockChanged(false);
    this.refresh();
  }

  /** 结算界面 / 局外养成面板出现时让位。 */
  private hideForOverlay(): void {
    this.node.active = false;
  }

  /** 覆盖层关闭后：仅当局内进行中才恢复 HUD。 */
  private restoreAfterOverlay(): void {
    this.node.active = gameState.isRunActive();
  }

  /** 层内风险变化（dungeon/LayerRisk 每 15 秒区间广播一次）。 */
  private onRiskChanged(
    timeFactor: number, rewardMultiplier: number, earlyLeaveMultiplier: number, elapsedSec: number,
  ): void {
    if (!this.riskLabel) {
      return;
    }
    // 文案**刻意精简**（去掉"风险"前缀与"×"）：竖屏下 HUD 底衬向右伸展，过长会顶到右上角的小地图/暂停
    this.riskLabel.string = `压力${timeFactor.toFixed(2)} 收益${rewardMultiplier.toFixed(2)}`
      + ` 早离${earlyLeaveMultiplier.toFixed(2)} 停留${elapsedSec.toFixed(0)}s`;
    this.redrawBg();
  }

  /** 出口点封锁提示（Boss 层击杀 Boss 前封锁）。 */
  private onExitLockChanged(locked: boolean): void {
    if (!this.exitLabel) {
      return;
    }
    this.exitLabel.string = locked ? '出口封锁：击杀本层 Boss 后解锁' : '';
    this.redrawBg();
  }

  /** 当前职业显示名（取不到时退化为 id 或 —）。 */
  private classText(): string {
    const id = gameState.getClassId();
    if (!id) {
      return '—';
    }
    if (!dataManager.isLoaded('characters')) {
      return id;
    }
    const rec = dataManager.getTable<any>('characters')[id];
    return rec && rec.name ? rec.name : id;
  }

  private refresh(): void {
    if (!this.hpLabel) return;
    this.hpLabel.string = `HP ${Math.ceil(gameState.getHp())} / ${Math.ceil(gameState.getMaxHp())}`;
    // 基础信息压成一行：职业 · 模式 ｜ 第N层 ｜ Lv ｜ 金币
    // （同行附模式名：终局与本体共用同一套 HUD，不标模式玩家无法分辨当前在玩哪一种）
    if (this.infoLabel) {
      this.infoLabel.string = `${this.classText()} · ${endgameRules.nameOf(gameState.getMode())}`
        + ` ｜ 第 ${gameState.getLayer()} 层 ｜ Lv${gameState.getLevel()} ｜ 金币 ${gameState.getGold()}`;
    }
    this.refreshBuffs();
    this.redrawBg();
  }

  /**
   * 已携带强化列表（同名去重，等级 > 1 时标注）。
   * 目的：让「携带了哪些 Buff」「是否被携带上限替换掉」对玩家可见 ——
   * 此前玩家只能从弹道数量等间接现象推断，容易被误判成"Buff 效果丢失"。
   */
  private refreshBuffs(): void {
    if (!this.buffLabel) {
      return;
    }
    const ids = gameState.getBuffs();
    const all = dataManager.isLoaded('buffs') ? dataManager.getTable<any[]>('buffs') : [];
    const seen: string[] = [];
    const carry: string[] = []; // 行为型（占槽位）
    const skills: string[] = []; // 技能型（占独立槽位）
    for (const id of ids) {
      if (seen.indexOf(id) >= 0) {
        continue;
      }
      seen.push(id);
      const def = all.find((b) => b.id === id);
      const type = def ? def.type : '';
      // 只显示「占槽位」的两类：属性 / 技能类强化数量会无限增长，显示出来会遮挡画面（用户要求）
      if (type !== 'behavior' && type !== 'skill_behavior') {
        continue;
      }
      const name = def && def.name ? def.name : id;
      const level = gameState.getBuffLevel(id);
      const text = level > 1 ? `${name}Lv${level}` : name;
      if (type === 'behavior') {
        carry.push(text);
      } else {
        skills.push(text);
      }
    }
    const trim = (list: string[], max: number): string => (list.length > max
      ? `${list.slice(0, max).join(' / ')} …`
      : list.join(' / '));
    // 占槽类别后标注「已用/上限」，便于判断是否接近上限
    this.buffLabel.string = carry.length > 0
      ? `强化 ${trim(carry, 5)}  (${carry.length}/${metaState.getBuffSlots()})` : '';
    if (this.buffSkillLabel) {
      this.buffSkillLabel.string = skills.length > 0
        ? `技能 ${trim(skills, 5)}  (${skills.length}/${metaState.getBehaviorSkillSlots()})` : '';
    }
  }

}

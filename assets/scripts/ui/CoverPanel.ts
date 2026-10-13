import { Color, HorizontalTextAlignment, Node, Sprite, SpriteFrame, UITransform, resources } from 'cc';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { ensureUiRoot, getVisibleHeight, getVisibleWidth, isPortrait } from '../core/ViewRoot';
import { sliceFrameByGrid } from '../core/SpriteSheet';
import { DARK_TEXT_COLOR, makeIconRow, makeLabel, makeNineSliceBg, makeRect } from './UiKit';
import { saveSlotPanel } from './SaveSlotPanel';

/**
 * 开始封面（**首屏**，用户口径：游戏封面 / 开始游戏界面）。
 *
 * 定位：进游戏后**第一眼**看到的画面 —— 标题 + 一排角色 / 怪物立绘 + 「开始游戏」按钮 + 操作提示。
 * 点「开始游戏」进入存档选择（`SaveSlotPanel`）；任何真正开局的信号（开局 / 续玩 / 进入槽位）都会收起封面。
 *
 * **布局口径（第六十一轮修正，重要）**：
 * 原先各区块用的是**写死的绝对 y**（标题 900、立绘带 380 …），只在"竖屏 1280×2280"下成立。
 * 一旦布局模式判成横屏（设计 720 高），`y = 900` 直接跑到屏幕外 ⇒ 实测表现为"标题消失、
 * 立绘被挤到顶部、按钮宽出画面"。
 *
 * 现改为**按可见尺寸比例定位**（横竖屏通用）：
 *  - 纵向位置取 `可见高 × 比例`（比例值取"竖屏现状"，保证竖屏观感不变）；
 *  - 元素**大小**取 `min(可见宽, 可见高) × 比例`（"短边"基准 —— 横屏时短边是高度，元素自动变小）；
 *  - 立绘带高度再以 `可见高 × 0.26` 封顶，避免横屏下带子过高压到标题。
 *
 * 实现要点（宪法 6.13）：
 *  - 纯代码构建、单例（与 `PausePanel` / `SaveSlotPanel` 同模式），节点只在首次显示时建一次；
 *  - 装饰立绘复用已有的 CC0 素材（三职业忍者 + 史莱姆 / 熊 / 龙），**异步加载、失败静默跳过**；
 *  - 兜底：若封面因任何原因建不起来，直接显示存档选择面板，绝不让玩家卡在黑屏。
 */

/** 封面配色（表现常量）。 */
const BG_COLOR = new Color(18, 17, 26, 255);
const BAND_COLOR = new Color(30, 29, 42, 255);
const TITLE_COLOR = new Color(242, 233, 200, 255);
const SUB_COLOR = new Color(154, 163, 140, 255);
/** 「开始游戏」按钮兜底色（九宫格底图加载前后的兜底，深绿）。 */
const BTN_COLOR = new Color(62, 84, 62, 255);
const VER_COLOR = new Color(96, 104, 92, 255);
/** `ui/dialogue_box` 实测九宫格边框厚度。 */
const DIALOGUE_INSET = 7;

/** 背景尺寸：比任何常见可见区都大，保证铺满（节点按中心对齐）。 */
const BG_W = 2600;
const BG_H = 3600;

/**
 * 元素尺寸比例（相对可见**短边**，横竖屏自适应）。
 *
 * ⚠️ 这里**没有**纵向位置比例了 —— 纵向由 `planVertical()` **自洽排布**。
 * 原先各区块各用一个"可见高 × 比例"的 y，竖屏（可见高 2148~2771）下间距充裕、看着正常，
 * 但横屏可见高只有 720 ⇒ 同样的比例把标题与副标题算成 26px 间距，而标题字号 54 ⇒ **直接叠字**
 * （用户实测：「地牢生存」与「Roguelike 生存」糊在一起）。
 * 改为按**元素自身高度依次排**后，任何屏幕比例下都不可能重叠。
 */
const RS = {
  titleFont: 0.075, subFont: 0.028, verFont: 0.022,
  // `bandHMax` 以可见高封顶：横屏可见高只有 720，若只按短边算立绘带会压到标题/按钮
  bandH: 0.33, bandHMax: 0.23,
  decoScale: 0.0066, decoGap: 0.134, decoStart: -0.336,
  btnW: 0.484, btnH: 0.117, btnFont: 0.042,
  hintFont: 0.025, hintIcon: 0.031,
  /** 区块之间的竖直间距（相对短边）。 */
  gap: 0.04,
};

/** 纵向排布结果（自上而下：标题 → 副标题 → 立绘带 → 按钮 → 提示 → 版本）。 */
interface VerticalPlan {
  titleY: number; subY: number; bandY: number; btnY: number; hintY: number; verY: number;
  bandH: number; btnW: number; btnH: number;
  titleFont: number; subFont: number; verFont: number; btnFont: number; hintFont: number; iconPx: number;
}

/**
 * **纵向自洽排布**：先按"短边 × 比例"算出每个区块的**实际高度**，把它们连同间距加起来得到总高，
 * 再从**总高的一半**往下依次落位 ⇒ 整体竖直居中，且**相邻区块的间距恒等于 `gap`**（不会重叠）。
 */
function planVertical(w: number, h: number): VerticalPlan {
  const base = Math.min(w, h);
  const gap = base * RS.gap;
  const titleFont = base * RS.titleFont;
  const subFont = base * RS.subFont;
  const verFont = base * RS.verFont;
  const btnFont = base * RS.btnFont;
  const hintFont = base * RS.hintFont;
  const bandH = Math.min(base * RS.bandH, h * RS.bandHMax);
  const btnW = base * RS.btnW;
  const btnH = base * RS.btnH;
  // 各区块的竖直占位（文字按字号 ×1.2 / ×1.4 估行高；块状元素用自己的高度）
  const titleH = titleFont * 1.2;
  const subH = subFont * 1.4;
  const hintH = hintFont * 1.4;
  const verH = verFont * 1.4;
  const total = titleH + subH + bandH + btnH + hintH + verH + gap * 5;
  let cursor = total / 2; // 从总高的上沿开始往下排
  const down = (own: number): number => {
    const center = cursor - own / 2;
    cursor -= own + gap;
    return center;
  };
  const titleY = down(titleH);
  const subY = down(subH);
  const bandY = down(bandH);
  const btnY = down(btnH);
  const hintY = down(hintH);
  const verY = down(verH);
  return {
    titleY, subY, bandY, btnY, hintY, verY, bandH, btnW, btnH,
    titleFont, subFont, verFont, btnFont, hintFont, iconPx: base * RS.hintIcon,
  };
}

/** 封面立绘：素材路径 + 帧网格（取第 0 列第 0 行的第 1 帧）。位置在 `ensurePanel` 里按可见尺寸算。 */
interface Deco {
  path: string;
  cols: number;
  rows: number;
  /** 相对"可见短边"的横向偏移（第 1 个立绘的起点）。 */
  slot: number;
}

const DECOS: Deco[] = [
  { path: 'actors/player/yellow', cols: 4, rows: 7, slot: 0 },
  { path: 'actors/player/blue', cols: 4, rows: 7, slot: 1 },
  { path: 'actors/player/red', cols: 4, rows: 7, slot: 2 },
  { path: 'actors/monster/slime/SpriteSheet', cols: 4, rows: 4, slot: 3 },
  { path: 'actors/monster/bear/SpriteSheet', cols: 4, rows: 4, slot: 4 },
  { path: 'actors/monster/dragon/SpriteSheet', cols: 4, rows: 4, slot: 5 },
];

class CoverPanel {
  private root: Node | null = null;
  private decoLayer: Node | null = null;
  /** 立绘只加载一次（失败也记为已尝试，避免反复请求）。 */
  private decoRequested = false;
  /** 当前立绘布局参数（加载回调异步到达时用它摆位）。 */
  private decoScale = 1;
  private decoBaseX = 0;
  private decoGap = 0;
  /** 立绘所处的纵向位置（= 立绘带中心，由排布算法给）。 */
  private decoY = 0;

  constructor() {
    // 配置就绪即显示封面（首屏）
    eventBus.on(EventNames.on_config_loaded, this.show, this);
    // 任何"真的要进游戏"的信号都收起封面
    eventBus.on(EventNames.on_run_start, this.hide, this);
    eventBus.on(EventNames.on_run_resume, this.hide, this);
    eventBus.on(EventNames.on_slot_entered, this.hide, this);
    eventBus.on(EventNames.on_slot_panel_open, this.hide, this);
  }

  show(): void {
    if (!this.ensurePanel() || !this.root) {
      // 兜底：封面建不起来就直接进存档选择，不让玩家卡在黑屏
      saveSlotPanel.show();
      return;
    }
    const parent = this.root.parent;
    if (parent) {
      this.root.setSiblingIndex(parent.children.length - 1); // 置顶
    }
    this.root.active = true;
    saveSlotPanel.hide(); // 首屏是封面：先让开存档面板（其 show 由「开始游戏」触发）
    this.loadDecos();
  }

  hide(): void {
    if (this.root && this.root.isValid) {
      this.root.active = false;
    }
  }

  /** 首次显示时构建骨架（背景 / 横带 / 标题 / 按钮 / 提示），尺寸全部按当前可见区算。 */
  private ensurePanel(): boolean {
    if (this.root && this.root.isValid) {
      return true;
    }
    const uiRoot = ensureUiRoot();
    if (!uiRoot) {
      console.error('[CoverPanel] 找不到 UIRoot，无法构建封面');
      return false;
    }
    const root = new Node('CoverPanel');
    root.layer = uiRoot.layer;
    uiRoot.addChild(root);
    this.root = root;

    const h = getVisibleHeight();
    const w = getVisibleWidth();
    const base = Math.min(w, h); // 短边基准：竖屏=宽 1280，横屏=高 720
    const plan = planVertical(w, h);

    // 背景（铺满）+ 立绘横带（色块；封面是**首屏**，任何分辨率都不能露底）
    makeRect(root, 'bg', 0, 0, BG_W, BG_H, BG_COLOR);
    makeRect(root, 'band', 0, plan.bandY, BG_W, plan.bandH, BAND_COLOR);

    // 标题区
    this.centeredLabel(root, 'title', plan.titleY, plan.titleFont, '地牢生存', TITLE_COLOR);
    this.centeredLabel(root, 'sub', plan.subY, plan.subFont, 'Roguelike 生存 · 全部素材 CC0', SUB_COLOR);

    // 立绘布局参数（异步加载回调里用）
    this.decoScale = Math.max(1, base * RS.decoScale);
    this.decoGap = base * RS.decoGap;
    this.decoBaseX = base * RS.decoStart;
    this.decoY = plan.bandY;
    const btnW = plan.btnW;
    const btnH = plan.btnH;
    const btnY = plan.btnY;

    // 立绘容器（异步填充）
    const deco = new Node('deco');
    deco.layer = uiRoot.layer;
    root.addChild(deco);
    this.decoLayer = deco;

    // 开始游戏 → 交给存档选择（真正的开局入口）
    // 按钮底 = `Ui/Dialog` 九宫格（素材内部浅灰 ⇒ 文字用深色）。
    // 触摸监听挂在**底图节点**上：文字子节点不监听，点击会沿节点树冒泡上来 ⇒ 整块按钮都可点。
    const startBg = makeNineSliceBg(
      root, 'btn_start', 0, btnY, btnW, btnH, 'ui/dialogue_box', DIALOGUE_INSET, BTN_COLOR,
    );
    startBg.on(Node.EventType.TOUCH_END, () => {
      this.hide();
      saveSlotPanel.show();
    });
    const startText = makeLabel(root, 'btn_start_text', 0, btnY, plan.btnFont, DARK_TEXT_COLOR);
    startText.horizontalAlign = HorizontalTextAlignment.CENTER;
    startText.string = '开始游戏';
    const startUt = startText.node.getComponent(UITransform);
    if (startUt) {
      startUt.setContentSize(btnW, btnH);
    }

    // 操作提示（**图标 + 文字**）+ 版本信息：文案按布局模式给（手机看摇杆、电脑看键鼠）
    const hintFont = plan.hintFont;
    const iconPx = plan.iconPx;
    const hints = isPortrait()
      ? [
        { icon: 'ui/icon_gamepad', text: '左下摇杆移动' },
        { icon: 'ui/icon_keyboard', text: 'J 普攻 / K 技能' },
        { icon: 'ui/icon_mouse', text: '点击选卡' },
      ]
      : [
        { icon: 'ui/icon_keyboard', text: 'WASD 移动' },
        { icon: 'ui/icon_keyboard', text: 'J 普攻 / K 技能' },
        { icon: 'ui/icon_mouse', text: '点击选卡 / ESC 暂停' },
      ];
    makeIconRow(root, 'hints', -w * 0.28, plan.hintY, hints, hintFont, iconPx, iconPx * 0.4, hintFont * 1.1);
    this.centeredLabel(
      root, 'ver', plan.verY, plan.verFont,
      isPortrait() ? '手机竖屏：上部画面 · 下部操作区' : '电脑横屏：键盘 + 鼠标',
      VER_COLOR,
    );
    return true;
  }

  /** 居中文字（中文长文本必须显式给宽度并居中，否则会以中心展开被裁）。 */
  private centeredLabel(parent: Node, name: string, yPx: number, fontSize: number, text: string, color: Color): void {
    const label = makeLabel(parent, name, 0, yPx, fontSize, color);
    label.horizontalAlign = HorizontalTextAlignment.CENTER;
    label.string = text;
    const ut = label.node.getComponent(UITransform);
    if (ut) {
      ut.setContentSize(BG_W * 0.9, fontSize + 16);
    }
  }

  /** 异步加载立绘素材（三职业 + 三种怪），取每张行走图的第 1 帧摆放；失败静默跳过。 */
  private loadDecos(): void {
    if (this.decoRequested) {
      return;
    }
    this.decoRequested = true;
    for (const deco of DECOS) {
      resources.load(`${deco.path}/spriteFrame`, SpriteFrame, (err, frame) => {
        if (err || !frame || !this.decoLayer || !this.decoLayer.isValid) {
          return; // 没素材不影响开局
        }
        const sub = sliceFrameByGrid(frame, 0, 0, deco.cols, deco.rows);
        const node = new Node('deco_item');
        this.decoLayer?.addChild(node);
        node.setPosition(this.decoBaseX + deco.slot * this.decoGap, this.decoY, 0);
        node.setScale(this.decoScale, this.decoScale, 1);
        const sp = node.addComponent(Sprite);
        sp.spriteFrame = sub;
        sp.sizeMode = Sprite.SizeMode.RAW;
      });
    }
  }
}

export const coverPanel = new CoverPanel();

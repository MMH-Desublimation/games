import {
  Color, Font, Graphics, Label, Node, HorizontalTextAlignment, Sprite, SpriteFrame, UITransform, resources,
} from 'cc';
import { ensureUiRoot, getVisibleHeight, getVisibleWidth } from '../core/ViewRoot';
import { getWhiteFrame } from '../core/WhiteFrame';

/**
 * UI 构建工具（仅限 ui/ 模块使用）。
 * 全部用代码构建标签/按钮/色块，避免编辑器手工接线；
 * 静态 UI 节点仅在面板构建时创建一次，不在 update 中创建/销毁（宪法 6.13）。
 *
 * **字体方案（用户口径：不要 UI 边框，改用艺术字 / Q 版字体，并整体缩小一点）**：
 *  - 统一使用 `resources/ui/ui_font.ttf`（Ninja Adventure 的像素艺术字体），异步加载；
 *  - 所有文字**默认描边**（像素字体在草地 / 深色背景上都清晰，解决"字体颜色辨识度不高"）；
 *  - 字号统一乘 `FONT_SCALE`（0.86）⇒ 全局少量缩小，界面不再挤占画面；
 *  - 字体加载完成会**回填**到已创建的 Label（解决"字体晚于面板创建"的时序问题）。
 */

/** 全局字号缩放（用户口径：少量缩小显示大小，避免挤占）。 */
const FONT_SCALE = 0.86;
/** 文字描边（像素字体 + 细描边 = 任何背景上都清楚；宽度取 1，避免把点阵字糊掉）。 */
const OUTLINE_COLOR = new Color(22, 18, 26, 255);
const OUTLINE_WIDTH = 1;
/** 标签默认色（暖白，比纯白柔和且与深色描边对比足）。 */
const DEFAULT_TEXT_COLOR = new Color(248, 244, 228, 255);
/**
 * **深色文字**：用在 `Ui/` 的浅色底图（`dialogue_box` / `choice_box` 内部是浅灰 `242,234,241`）之上。
 * 暖白字在浅底上会看不清 —— 实测过，故底图上的文字必须换成它。
 */
export const DARK_TEXT_COLOR = new Color(74, 42, 32, 255);
/**
 * **局内文字色**（HUD / 技能栏）。
 * 这两处原先直接画在草地 / 地宫上，必须靠**描边**才看得清；描边会让像素字变粗
 * （用户口径："局内字体可以在细一点，不要加粗"）。
 * 改成：**给它们铺一层半透明深色底衬 + 文字不加描边** ⇒ 既清楚又细。
 */
export const HUD_TEXT_COLOR = DEFAULT_TEXT_COLOR;
/**
 * 局内 UI 的半透明底衬（比面板底衬淡得多，尽量少挡画面）。
 *
 * ⚠️ 教训：第一版用 `150` 的不透明度 + **固定大尺寸**（HUD 620×240），结果只有 3 行文字时
 * 也占满左上角一大块，用户反馈"**严重遮挡画面**"。现在改为：
 * **① 不透明度降到 110；② 尺寸由调用方按实际内容动态贴合（见 `makeRoundRectBg`）；③ 圆角**。
 */
export const HUD_BG = new Color(12, 14, 20, 110);

/**
 * **面板统一底衬色**（半透明深色）。
 *
 * 用户口径：本项目没有 UI 贴图，且用户明确**不要边框** —— 所以面板统一靠一层半透明深色底衬
 * 把艺术字（带描边）从草地上"抬起来"。比按钮底衬更实，保证长文本可读。
 * 各面板用 `makeRect(<根节点>, 'bg', x, y, w, h, PANEL_BG)`，**必须是最先添加的子节点**（否则盖住文字）。
 */
export const PANEL_BG = new Color(12, 14, 20, 170);

/** UI 艺术字体与加载状态（模块级单例）。 */
let uiFont: Font | null = null;
let fontRequested = false;

/** 启动加载 UI 艺术字体；就绪后回填到**已创建**的所有 Label。 */
export function preloadUiFont(): void {
  if (fontRequested) {
    return;
  }
  fontRequested = true;
  resources.load('ui/ui_font', Font, (err, font) => {
    if (err || !font) {
      console.warn('[UiKit] UI 艺术字体缺失（ui/ui_font.ttf）：退回系统字体，仅保留描边');
      return;
    }
    uiFont = font;
    const root = ensureUiRoot();
    if (root) {
      // 回填**只套字体**、不重算描边：否则会覆盖调用方"浅底不加描边"的设定
      for (const label of root.getComponentsInChildren(Label)) {
        applyFont(label);
      }
    }
    console.log('[UiKit] UI 艺术字体已应用');
  });
}

/** 给 Label 套上艺术字体 + 描边（字体未就绪时先只加描边）。 */
function applyTextStyle(label: Label, outline = true): void {
  // **浅底图上的深色字自动不加描边**：深棕字 + 深色描边会糊成一团，
  // 用户实测反馈"字体稍微有些粗，看不太清" —— 根因就是浅底图上的描边。
  const needOutline = outline && !isDarkOnLightBg(label.color);
  label.enableOutline = needOutline;
  if (needOutline) {
    label.outlineColor = OUTLINE_COLOR;
    label.outlineWidth = OUTLINE_WIDTH;
  }
  applyFont(label);
}

/** 只套字体、不碰描边（用于字体异步就绪后的**回填**，避免覆盖调用方显式设定的描边开关）。 */
function applyFont(label: Label): void {
  if (uiFont) {
    label.useSystemFont = false;
    label.font = uiFont;
  }
}

/** 是否为「浅底图上的深色字」（用于决定要不要描边）。 */
function isDarkOnLightBg(color: Color): boolean {
  return Math.abs(color.r - DARK_TEXT_COLOR.r) <= 10
    && Math.abs(color.g - DARK_TEXT_COLOR.g) <= 10
    && Math.abs(color.b - DARK_TEXT_COLOR.b) <= 10;
}

/** 创建一个文本标签并挂到 parent（默认**左对齐**：中文长文本以中心展开会被屏幕左缘裁掉）。 */
export function makeLabel(
  parent: Node, name: string, xPx: number, yPx: number,
  fontSize = 26, color: Color = DEFAULT_TEXT_COLOR, outline = true,
): Label {
  const n = new Node(name);
  parent.addChild(n);
  n.setPosition(xPx, yPx, 0);
  const label = n.addComponent(Label);
  const size = Math.max(12, Math.round(fontSize * FONT_SCALE));
  label.fontSize = size;
  label.lineHeight = size + 6;
  // 颜色在**创建时**传入（而不是创建后再赋值）：`applyTextStyle` 要靠它判断
  // 「浅底上的深色字」并自动**不加描边** —— 后赋值会错过这个判断。
  // `outline = false` 用于**局内**文字（HUD / 技能栏）：它们有自己的深色底衬，
  // 不需要描边；描边会让像素字变粗（用户口径：局内字体细一点，不要加粗）。
  label.color = color;
  label.horizontalAlign = HorizontalTextAlignment.LEFT;
  label.string = '';
  applyTextStyle(label, outline);
  return label;
}

/** 居中文本标签（显式给宽度，避免中文以中心展开被裁）。 */
export function makeCenteredLabel(
  parent: Node, name: string, xPx: number, yPx: number, wPx: number, fontSize = 26,
  color: Color = DEFAULT_TEXT_COLOR,
): Label {
  const label = makeLabel(parent, name, xPx, yPx, fontSize, color);
  label.horizontalAlign = HorizontalTextAlignment.CENTER;
  const ut = label.node.getComponent(UITransform);
  if (ut) {
    ut.setContentSize(wPx, label.fontSize + 16);
  }
  return label;
}

/** 创建一个文字按钮（触摸触发），挂到 parent。 */
export function makeTextButton(
  parent: Node, name: string, text: string, xPx: number, yPx: number,
  onClick: () => void, fontSize = 30, textColor: Color = DEFAULT_TEXT_COLOR,
): Node {
  const n = new Node(name);
  parent.addChild(n);
  n.setPosition(xPx, yPx, 0);
  const label = n.addComponent(Label);
  const size = Math.max(12, Math.round(fontSize * FONT_SCALE));
  label.fontSize = size;
  label.lineHeight = size + 8;
  label.color = textColor;
  label.horizontalAlign = HorizontalTextAlignment.CENTER;
  label.string = text;
  applyTextStyle(label); // 内部会按文字颜色自动决定要不要描边（浅底深字 ⇒ 不描边）
  n.on(Node.EventType.TOUCH_END, () => onClick());
  return n;
}

/** 创建一个**纯色矩形**（白图 + 颜色），挂到 parent。 */
export function makeRect(
  parent: Node, name: string, xPx: number, yPx: number,
  wPx: number, hPx: number, color: Color,
): Node {
  const n = new Node(name);
  parent.addChild(n);
  n.setPosition(xPx, yPx, 0);
  const sp = n.addComponent(Sprite);
  sp.spriteFrame = getWhiteFrame();
  sp.sizeMode = Sprite.SizeMode.CUSTOM;
  sp.type = Sprite.Type.SIMPLE;
  sp.color = color;
  const ut = n.getComponent(UITransform);
  if (ut) {
    ut.setContentSize(wPx, hPx);
  }
  return n;
}

/** 图标化操作提示的一项（图标 + 紧跟的说明文字）。 */
export interface IconHint {
  /** `resources` 下的路径（如 `ui/icon_keyboard`）。 */
  icon: string;
  /** 说明文字。 */
  text: string;
}

/**
 * **九宫格面板底图**（`Ui/` 素材，如 `ui/dialogue_box`）：四角不拉伸、边与中心拉伸，
 * 面板放大缩小时**边框粗细不变形**。
 *
 * 要点：
 *  - **必须克隆 SpriteFrame** 再设 `inset*`：直接改共享 frame 会波及所有用到同一张图的地方
 *    （用户会在别处看到边框跟着变形）；
 *  - 素材**异步**加载 ⇒ 先用 `fallback` **纯色兜底**铺上，加载到再替换（缺素材面板照常可见，不阻塞玩法）；
 *  - `inset` 为实测值：`dialogue_box`（316×60）→ 7；`choice_box`（64×20）→ 6。
 */
export function makeNineSliceBg(
  parent: Node, name: string, xPx: number, yPx: number,
  wPx: number, hPx: number, path: string, insetPx: number, fallback: Color = PANEL_BG,
  tint: Color | null = null,
): Node {
  const host = makeRect(parent, name, xPx, yPx, wPx, hPx, fallback);
  const sp = host.getComponent(Sprite);
  if (!sp) {
    return host;
  }
  loadFrame(path, (frame) => {
    if (!host.isValid || !sp.isValid) {
      return;
    }
    const sliced = frame.clone() as SpriteFrame;
    sliced.insetLeft = insetPx;
    sliced.insetRight = insetPx;
    sliced.insetTop = insetPx;
    sliced.insetBottom = insetPx;
    sp.spriteFrame = sliced;
    sp.type = Sprite.Type.SLICED;
    sp.sizeMode = Sprite.SizeMode.CUSTOM;
    // `tint` 会与原图**相乘**：素材内部是浅灰白，乘米色即得柔和的米白（用户口径："太亮了，柔和一点"）
    sp.color = tint ?? new Color(255, 255, 255, 255);
    const ut = host.getComponent(UITransform);
    if (ut) {
      ut.setContentSize(wPx, hPx);
    }
  });
  return host;
}

/**
 * **图标 + 文字**横排（用户口径：操作提示别只用纯文字，配 `Ui/` 的键鼠图标）。
 * 从左向右累加排布；文本宽度按「CJK 约 1em、其余约 0.55em」**估算**
 * （`Label` 的实测宽度要等下一帧才更新，布局期拿不到，故不依赖它）。
 */
export function makeIconRow(
  parent: Node, name: string, xPx: number, yPx: number,
  hints: IconHint[], fontSize = 22, iconPx = 24, gapPx = 8, itemGapPx = 22,
): Node {
  const host = new Node(name);
  parent.addChild(host);
  host.setPosition(xPx, yPx, 0);
  let cx = 0;
  for (let i = 0; i < hints.length; i++) {
    makeIcon(host, `icon_${i}`, cx + iconPx / 2, 0, iconPx, hints[i].icon);
    cx += iconPx + gapPx;
    const label = makeLabel(host, `text_${i}`, cx, 0, fontSize);
    const lut = label.node.getComponent(UITransform);
    if (lut) {
      lut.setAnchorPoint(0, 0.5); // 左缘对齐 → 文本只向右伸展，不再以中心向两侧展开
    }
    label.string = hints[i].text;
    cx += estimateTextWidth(hints[i].text, label.fontSize) + itemGapPx;
  }
  return host;
}

/**
 * **带九宫格底图的按钮**（本项目 UI 美化后的**标准按钮**）。
 *
 * 要点：
 *  - 触摸监听挂在**底图节点**上 ⇒ **整块都可点**。文字子节点不监听，点击会沿节点树冒泡上来；
 *    （若把监听挂在文字上，点击判定只有文字包围盒，按钮会"点不动" —— 实测踩过。）
 *  - 返回**文字 Label**：改文案用 `label.string`；需要底图节点时用 `label.node.parent`。
 *  - 文字默认 `DARK_TEXT_COLOR`：`Ui/` 的底图内部是浅灰，暖白字在上边看不清。
 */
export function makeBgButton(
  parent: Node, name: string, text: string, xPx: number, yPx: number,
  wPx: number, hPx: number, path: string, insetPx: number,
  onClick: () => void, fontSize = 30, textColor: Color = DARK_TEXT_COLOR,
  fallback: Color = PANEL_BG, tint: Color | null = null,
): Label {
  const bg = makeNineSliceBg(parent, name, xPx, yPx, wPx, hPx, path, insetPx, fallback, tint);
  bg.on(Node.EventType.TOUCH_END, () => onClick());
  const label = makeLabel(parent, `${name}_text`, xPx, yPx, fontSize, textColor);
  label.horizontalAlign = HorizontalTextAlignment.CENTER;
  label.string = text;
  const ut = label.node.getComponent(UITransform);
  if (ut) {
    ut.setContentSize(wPx, hPx);
  }
  return label;
}

/**
 * **圆角半透明底衬**（用 `Graphics` 绘制，不依赖任何 UI 贴图）。
 *
 * 为什么不直接用矩形贴图：直角大色块在画面上"压得很重"（用户反馈"严重遮挡画面"）；
 * 圆角 + 低透明度既保留文字可读性，又明显减轻压迫感。
 *
 * ⚠️ **尺寸必须由调用方按实际内容给**：不要用固定大尺寸 —— 内容为空的行不该占位
 * （第一版 HUD 固定 620×240，实际只有 3 行字，就白占了一大块）。
 * 返回 `Graphics` 组件，尺寸变化时用 `redrawRoundRect` 重画（只改绘制、不重建节点 ⇒ 宪法 6.13）。
 */
export function makeRoundRectBg(
  parent: Node, name: string, xPx: number, yPx: number,
  wPx: number, hPx: number, radiusPx: number, color: Color,
): Graphics {
  const n = new Node(name);
  parent.addChild(n);
  n.setPosition(xPx, yPx, 0);
  const g = n.addComponent(Graphics);
  redrawRoundRect(g, wPx, hPx, radiusPx, color);
  return g;
}

/** 重画圆角矩形（尺寸 / 颜色变化时调用；节点本身复用）。 */
export function redrawRoundRect(
  g: Graphics, wPx: number, hPx: number, radiusPx: number, color: Color,
): void {
  g.clear();
  g.fillColor = color;
  // 以节点自身为中心绘制 ⇒ 节点的 position 即底衬中心
  g.roundRect(-wPx / 2, -hPx / 2, wPx, hPx, Math.min(radiusPx, wPx / 2, hPx / 2));
  g.fill();
}

/**
 * **面板自适应缩放**：按可见区把面板根节点整体等比缩放，保证"按设计尺寸排好的面板"
 * 在任何屏幕上都**完整可见**。
 *
 * 为什么需要：面板（最大 1100×1900）是按**竖屏**排的。切换成横屏布局（设计 720 高）时，
 * 这些面板会**远远超出屏幕** ⇒ 只能看到中间一条。与其为两端各写一套面板尺寸，
 * 不如统一"按需整体缩放"：
 *
 * | 布局 | 可见区 | 1100×1900 的面板 → k | 结果 |
 * |---|---|---|---|
 * | 竖屏手机 | 1280×2771 | 1.0 | **原尺寸不变**（已验收的竖屏观感） |
 * | 横屏电脑 | 1195×720 | ≈0.35 | 缩到 383×662，**完整可见**（字偏小但可用） |
 *
 * @returns 实际使用的缩放系数（便于日志 / 调试）。
 */
export function fitPanelToScreen(root: Node, designW: number, designH: number): number {
  const w = getVisibleWidth();
  const h = getVisibleHeight();
  if (w <= 1 || h <= 1 || designW <= 0 || designH <= 0) {
    return 1;
  }
  const k = Math.min(1, (w * 0.94) / designW, (h * 0.92) / designH);
  root.setScale(k, k, 1);
  return k;
}

/** 估算像素艺术字宽度：CJK 全角约 1em，其余约 0.55em。 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    units += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  }
  return units * fontSize;
}

/**
 * **文字按钮（可选半透明底衬）**：默认不带边框（用户口径：不要 UI 边框），
 * 只给一层很淡的深色底提高可点区域的可见性；`bg` 传 null 则完全不画底。
 */
export function makePanelButton(
  parent: Node, name: string, text: string, xPx: number, yPx: number,
  wPx: number, hPx: number, onClick: () => void,
  fontSize = 30, bg: Color | null = new Color(30, 32, 40, 120),
  textColor: Color = DEFAULT_TEXT_COLOR,
): Node {
  const host = bg ? makeRect(parent, name, xPx, yPx, wPx, hPx, bg) : new Node(name);
  if (!bg) {
    parent.addChild(host);
    host.setPosition(xPx, yPx, 0);
    // 无底衬也必须给足**可点区域**：九宫格底图上的按钮走 bg=null（底由底图提供），
    // 若这里不给 UITransform，点击判定只剩文字本身的包围盒，按钮会「点不动」。
    const hut = host.addComponent(UITransform);
    hut.setContentSize(wPx, hPx);
  }
  const label = makeLabel(host, 'text', 0, 0, fontSize, textColor);
  label.horizontalAlign = HorizontalTextAlignment.CENTER;
  label.string = text;
  const lut = label.node.getComponent(UITransform);
  if (lut) {
    lut.setContentSize(wPx, hPx); // 让文字在按钮内水平居中
  }
  host.on(Node.EventType.TOUCH_END, () => onClick());
  return host;
}

/**
 * 异步取一张 `resources` 图片的 SpriteFrame（单图必须走 `xxx/spriteFrame` 子资源）。
 * 缺素材时静默跳过（UI 美化不应阻塞玩法）。
 */
export function loadFrame(path: string, onReady: (frame: SpriteFrame) => void): void {
  resources.load(`${path}/spriteFrame`, SpriteFrame, (err, frame) => {
    if (!err && frame) {
      onReady(frame);
    }
  });
}

/** 在 parent 下建一个固定尺寸的图片节点，异步贴上 `path`（缺素材静默跳过）。 */
export function makeIcon(
  parent: Node, name: string, xPx: number, yPx: number, sizePx: number, path: string,
): Node {
  const n = new Node(name);
  parent.addChild(n);
  n.setPosition(xPx, yPx, 0);
  const ut = n.addComponent(UITransform);
  ut.setContentSize(sizePx, sizePx);
  const sp = n.addComponent(Sprite);
  sp.sizeMode = Sprite.SizeMode.CUSTOM;
  sp.type = Sprite.Type.SIMPLE;
  loadFrame(path, (frame) => {
    if (n.isValid) {
      sp.spriteFrame = frame;
    }
  });
  return n;
}

/** 给节点贴一张图片（保持原始尺寸，或按 scale 放大；失败静默跳过）。 */
export function dressIcon(node: Node, path: string, scale = 1): void {
  loadFrame(path, (frame) => {
    if (!node.isValid) {
      return;
    }
    const sp = node.getComponent(Sprite) ?? node.addComponent(Sprite);
    sp.spriteFrame = frame;
    sp.sizeMode = Sprite.SizeMode.RAW;
    if (scale !== 1) {
      node.setScale(scale, scale, 1);
    }
  });
}

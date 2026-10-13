import {
  Canvas, Color, Graphics, Layers, Mask, Node, UITransform, find, view, ResolutionPolicy,
} from 'cc';

/**
 * 设计分辨率（**竖屏**；依据宪法 L11「单机 2D **竖屏** Roguelite」与交接 D12「1080×1920 竖屏布局」）。
 *
 * 口径：**宽 1280 固定（`FIXED_WIDTH`）× 高 2280**（1280 : 2280 ≈ 9 : 16）。
 * 为什么宽度仍取 1280：全部 UI（面板最大 1240 宽、HUD 左缘、按钮列）都是按 1280 宽设计的，
 * **固定宽度**后它们全部继续有效；竖屏只是把高度拉长，多出来的空间给底部操作区。
 *
 * 屏幕分区（用户口径：**上部分显示游戏画面、下部分操作区**，操作区没有画面）：
 * ```
 *  y = +H/2  ┌────────────────┐
 *            │    游戏画面区    │  高 = 可见高 - CTRL_AREA_H（≥ 640），由 Mask 裁剪
 *            ├────────────────┤ ← getCtrlAreaTopY()
 *            │    操作区        │  高 = CTRL_AREA_H（1000），无游戏画面
 *            │  摇杆 + 技能 ×2  │
 *  y = -H/2  └────────────────┘
 * ```
 */
export const DESIGN_W = 1280;
export const DESIGN_H = 2280;
/** 底部操作区高度（px，设计像素；竖屏 9:16 下约占 44%）。 */
export const CTRL_AREA_H = 1000;

/** 横屏（电脑端）设计分辨率：沿用最初的 1280×720，**没有操作区**（键盘 + 鼠标）。 */
export const LAND_W = 1280;
export const LAND_H = 720;

/** 布局模式。 */
export type LayoutMode = 'portrait' | 'landscape';
let layoutMode: LayoutMode = 'portrait';

/**
 * 「是否局内进行中」的**极简标志**（由 `Boot` 在开局 / 结束时设置）。
 *
 * 为什么不用 `gameState`：本文件是 core 底层的视图工具，被多处 import，
 * 引 `GameState` 会平添循环依赖风险。这里只需要一个布尔，由**已经订阅了事件的 Boot** 喂进来即可。
 */
let runActive = false;

/** 由 `Boot` 在 `on_run_start` / `on_run_end` 时调用。 */
export function setRunActiveFlag(active: boolean): void {
  runActive = active;
  const node = getViewRoot()?.getChildByName(CTRL_BG_NAME);
  if (node) {
    node.active = ctrlAreaBgShouldShow();
  }
}

/**
 * 操作区底衬**是否应当显示**：只在**局内进行中**的竖屏下显示。
 *
 * 菜单界面（封面 / 职业选择 / 存档 / 选卡 / 暂停 / 结算）一律不显示 ——
 * 那些界面本就没有"游戏画面 / 操作区"之分，铺底色没有意义；
 * 更关键的是**彻底消除它压住面板的可能**（用户连续两轮反馈面板被深色横带压住，
 * 该横带的位置与配色都与底衬吻合）。
 */
function ctrlAreaBgShouldShow(): boolean {
  return isPortrait() && runActive;
}

/** 当前布局模式（竖屏手机 / 横屏电脑）。 */
export function getLayoutMode(): LayoutMode {
  return layoutMode;
}

/** 是否竖屏布局（操作区 / 摇杆 / 分区 只在竖屏下存在）。 */
export function isPortrait(): boolean {
  return layoutMode === 'portrait';
}

/**
 * 操作区高度：**横屏为 0**（不分区，游戏画面占满全屏、用键盘操作）。
 * 所有分区几何函数都基于它，因此横屏下 `getGameAreaHeight()` 自动等于全屏高。
 */
export function getCtrlAreaHeight(): number {
  return isPortrait() ? CTRL_AREA_H : 0;
}

/**
 * **屏幕适配**（`Boot.start()` 最开头调用）。
 *
 * 策略 = **FIXED_WIDTH**（宽度优先）：手机竖屏比例（9:16 ~ 9:19.5）**都比设计更"长"**
 * ⇒ 宽度铺满 1280、高度向上多出可见区域，**不会裁切**任何 UI；
 * 多出来的高度全部给游戏画面区（操作区高度恒定、贴底）。
 *
 * ⚠️ 为什么必须在代码里设：项目设置里**没有**分辨率配置
 * （实测查过 `settings/v2/packages/*.json`），不设会落到引擎默认值，
 * 与场景 Canvas 摆放、全部 UI 坐标都不一致。
 */
export function applyScreenAdaptation(mode: LayoutMode, reconcile = true): void {
  layoutMode = mode;
  if (mode === 'landscape') {
    // 电脑端：沿用最初的横屏口径（高度优先，宽屏左右多出可见区）
    view.setDesignResolutionSize(LAND_W, LAND_H, ResolutionPolicy.FIXED_HEIGHT);
    finishAdaptation(reconcile);
    return;
  }
  view.setDesignResolutionSize(DESIGN_W, DESIGN_H, ResolutionPolicy.FIXED_WIDTH);
  finishAdaptation(reconcile);
}

/**
 * **布局模式判定**：按**引擎真实绘制尺寸**（`view.getFrameSize()`）比较宽高。
 *
 * ⚠️ 不要用 `window.innerWidth / innerHeight`：浏览器预览跑在 iframe 里，
 * 且 DevTools 设备模拟只改变 canvas 的显示尺寸 —— `window` 的值与"引擎实际在画多大"可能不一致，
 * **实测后果**：手机竖屏模拟被误判成横屏 ⇒ 用 1280×720 去渲染竖屏坐标的 UI ⇒
 * 标题跑到屏幕外、按钮宽出画面（用户截图里的错乱）。
 */
export function detectLayoutMode(): LayoutMode {
  const frame = view.getFrameSize();
  if (frame && frame.width > 1 && frame.height > 1) {
    return frame.width > frame.height ? 'landscape' : 'portrait';
  }
  return 'portrait';
}

/**
 * 设定分辨率之后的**自洽复核**（这是本轮修复的关键）。
 *
 * 思路：**不看窗口，看结果** —— 分辨率设完后再读一次 `view.getVisibleSize()`，
 * 如果"实际渲染出的可见区"与"当前模式"矛盾，就换成相符的那种：
 *
 * | 当前模式 | 窗口情况 | 可见区 | 复核结果 |
 * |---|---|---|---|
 * | portrait（FIXED_WIDTH 1280×2280） | 手机竖屏 | 1280×2771（竖） | 一致 ✓ 不动 |
 * | portrait | **桌面宽窗口** | 1280×720（横） | 矛盾 ⇒ **自动切横屏** ✓ |
 * | landscape（FIXED_HEIGHT 1280×720） | 桌面/横屏 | 1195×720（横） | 一致 ✓ 不动 |
 * | landscape | **竖长窗口** | 405×720（竖） | 矛盾 ⇒ **自动切竖屏** ✓ |
 *
 * 好处：模式判定不再依赖任何"窗口尺寸 API 是否可靠"，**渲染成什么样就按什么样布局**；
 * 同时天然实现 `layout_mode: 'auto'` 的语义（横窗口自动用横屏版）。
 */
function finishAdaptation(reconcile: boolean): void {
  if (reconcile) {
    const size = view.getVisibleSize();
    if (size && size.width > 1 && size.height > 1) {
      const want: LayoutMode = size.width > size.height ? 'landscape' : 'portrait';
      if (want !== layoutMode) {
        applyScreenAdaptation(want, false); // 只切一次，避免递归
      }
    }
  }
  relayoutStaticUi();
}

/**
 * **静态 UI 骨架重新布局**：模式 / 分辨率变化后，把已建好的几个常驻节点按新尺寸摆正。
 *
 * 为什么需要：`UIRoot` / `GameViewport`（Mask 视口）/ 操作区底衬都是**懒创建并缓存尺寸**的，
 * 一旦 `applyScreenAdaptation` 被再次调用（复核切换、配置覆盖），它们的 `contentSize` 就过时了 ——
 * 表现为裁剪区不对、操作区色块错位。这里统一刷新（节点不存在就跳过）。
 */
export function relayoutStaticUi(): void {
  const canvas = getViewRoot();
  if (!canvas) {
    return;
  }
  const uiRoot = canvas.getChildByName('UIRoot');
  if (uiRoot) {
    const ut = uiRoot.getComponent(UITransform);
    if (ut) {
      ut.setAnchorPoint(0.5, 0.5);
      ut.setContentSize(getVisibleWidth(), getVisibleHeight());
    }
    uiRoot.setPosition(0, 0, 0);
  }
  const viewport = canvas.getChildByName(GAME_VIEW_NAME);
  if (viewport) {
    applyGameViewportLayout(viewport);
  }
  // 底衬挂在 **Canvas** 下（不在 UIRoot 内），见 ensureCtrlAreaBg 的说明
  const ctrlBg = canvas.getChildByName(CTRL_BG_NAME);
  if (ctrlBg) {
    // 横屏没有操作区 ⇒ 隐藏；**菜单界面也隐藏**（见 ctrlAreaBgShouldShow 的说明）
    ctrlBg.active = ctrlAreaBgShouldShow();
    ctrlBg.setSiblingIndex(0); // 永远在 UIRoot 之前 ⇒ 所有 UI 之下
    if (isPortrait()) {
      const ut = ctrlBg.getComponent(UITransform);
      if (ut) {
        ut.setContentSize(getVisibleWidth(), getCtrlAreaHeight());
      }
      ctrlBg.setPosition(0, getCtrlAreaCenterY(), 0);
      const g = ctrlBg.getComponent(Graphics);
      if (g) {
        g.clear();
        g.fillColor = CTRL_BG_COLOR;
        g.rect(-getVisibleWidth() / 2, -getCtrlAreaHeight() / 2, getVisibleWidth(), getCtrlAreaHeight());
        g.fill();
        g.lineWidth = 4;
        g.strokeColor = CTRL_LINE_COLOR;
        g.moveTo(-getVisibleWidth() / 2, getCtrlAreaHeight() / 2);
        g.lineTo(getVisibleWidth() / 2, getCtrlAreaHeight() / 2);
        g.stroke();
      }
    }
  }
}

/**
 * 当前**可见区域宽度**（设计像素）。
 * FIXED_HEIGHT 下宽度随屏幕比例变化（16:9 ⇒ 1280；20:9 ⇒ 1600）⇒ **贴左右边缘的 UI 必须用它**，
 * 硬编码会在长屏手机上离边缘过远、在窄屏（如 4:3 平板）上被裁掉。
 */
export function getVisibleWidth(): number {
  const size = view.getVisibleSize();
  return size && size.width > 1 ? size.width : DESIGN_W;
}

/** 当前**可见区域高度**（设计像素）。 */
export function getVisibleHeight(): number {
  const size = view.getVisibleSize();
  return size && size.height > 1 ? size.height : DESIGN_H;
}

/** 贴左右边缘的 UI 留白（px）：给圆角 / 挖孔屏留余量。 */
export const UI_EDGE_INSET_PX = 36;

/** 游戏画面区高度：可见高减去底部操作区（下限 640，避免极扁屏把画面压没）。 */
export function getGameAreaHeight(): number {
  return Math.max(320, getVisibleHeight() - getCtrlAreaHeight());
}

/** 游戏画面区中心 y（局部坐标；屏幕中心为 0）。相机跟随把角色放在这里而不是屏幕中心。 */
export function getGameAreaCenterY(): number {
  return getVisibleHeight() / 2 - getGameAreaHeight() / 2;
}

/** 操作区中心 y。 */
export function getCtrlAreaCenterY(): number {
  return -getVisibleHeight() / 2 + getCtrlAreaHeight() / 2;
}

/** 操作区**顶边** y（技能按钮贴着它往下排；也是游戏画面区底边）。 */
export function getCtrlAreaTopY(): number {
  return -getVisibleHeight() / 2 + getCtrlAreaHeight();
}

/** 游戏画面区**顶边** y（= 屏幕顶边；HUD 从这条线往下排）。 */
export function getGameAreaTopY(): number {
  return getVisibleHeight() / 2;
}

/** 操作区底衬节点名。 */
const CTRL_BG_NAME = 'CtrlAreaBg';
/** 操作区底色（深蓝灰，与游戏画面明确区分；不用纯黑，避免和画面外的黑边混成一片）。 */
const CTRL_BG_COLOR = new Color(26, 28, 38, 255);
/** 操作区顶边的分隔线（橙色细线，与 UI 木框风格一致）。 */
const CTRL_LINE_COLOR = new Color(232, 152, 74, 200);

/**
 * **操作区底衬**：把下半屏铺成明确的深色面板 + 顶部一条橙色分隔线。
 *
 * 用户反馈（截图）：操作区与游戏画面外的黑边**混成一片**，看起来"没有操作区"。
 * 所以这里必须给一个**可见的底色**，让"上半屏是游戏、下半屏是操作"一目了然。
 * 挂在 UIRoot 的**最底层**（最先创建）⇒ 位于摇杆 / 技能 / 面板之下。
 */
export function ensureCtrlAreaBg(): Node | null {
  const canvas = getViewRoot();
  if (!canvas) {
    return null;
  }
  const existed = canvas.getChildByName(CTRL_BG_NAME);
  if (existed) {
    return existed;
  }
  const node = new Node(CTRL_BG_NAME);
  node.layer = Layers.Enum.UI_2D;
  node.active = ctrlAreaBgShouldShow(); // 建在菜单阶段就先不显示，开局时由 Boot 打开
  // ⚠️ **必须挂在 Canvas 下、且排在 UIRoot 之前**（而不是 UIRoot 内部）。
  //
  // 为什么：UIRoot 里既有**场景自带**的面板（职业选择 / 结果 / 选卡 / HUD，建场景时就存在），
  // 又有运行时创建的节点。底衬无论放进 UIRoot 的哪个位置，都会和其中一部分抢层级 ——
  // 上一轮试过 `setSiblingIndex(0)`，**实测仍然盖住了职业选择面板的下半部**
  // （用户手机截图：一条深色横带直接横穿面板）。
  //
  // 放到 Canvas 层就彻底没有竞争：`Canvas.children = [WorldRoot(游戏画面), UIRoot(全部 UI)]`，
  // 底衬插到最前 ⇒ 永远在**所有 UI 之下**，只在操作区露出自己的一层底色。
  // 坐标口径不变：UIRoot 自身在 (0, 0)，底衬与各面板仍用同一套可见区坐标。
  canvas.addChild(node);
  node.setSiblingIndex(0);
  const ut = node.addComponent(UITransform);
  ut.setAnchorPoint(0.5, 0.5);
  ut.setContentSize(getVisibleWidth(), getCtrlAreaHeight());
  node.setPosition(0, getCtrlAreaCenterY(), 0);
  const g = node.addComponent(Graphics);
  g.fillColor = CTRL_BG_COLOR;
  g.rect(-getVisibleWidth() / 2, -getCtrlAreaHeight() / 2, getVisibleWidth(), getCtrlAreaHeight());
  g.fill();
  // 顶分隔线
  g.lineWidth = 4;
  g.strokeColor = CTRL_LINE_COLOR;
  g.moveTo(-getVisibleWidth() / 2, getCtrlAreaHeight() / 2);
  g.lineTo(getVisibleWidth() / 2, getCtrlAreaHeight() / 2);
  g.stroke();
  return node;
}

/**
 * 视图层级与相机工具（core/：引擎封装，不含玩法逻辑）。
 *
 * 一、Canvas 渲染规则：Label / Sprite 这类 2D 组件只有在 **Canvas（RenderRoot2D）子树**内才会被绘制。
 *
 * 二、层级规范（文档 4.7）：
 *   背景 < 地面 < 掉落物 < 敌人 < 玩家 < 子弹 < 特效 < 飘字 < UI
 * 各层是 **世界根（WorldRoot）** 下的同名容器节点，靠同级顺序（= 绘制顺序）保证前后关系；
 * 世界根整体排在 UIRoot 之前，因此 UI 永远压在最上层。
 *
 * 三、坐标口径（重要）：
 * 玩法坐标统一使用 **世界根局部坐标**（= 地宫/关卡逻辑坐标，px）。
 * 各层容器与世界根都在原点，因此「节点局部坐标 == 世界根坐标」，玩法逻辑一律用 node.position 读数。
 *
 * 四、相机跟随（地宫比屏幕大，文档 2.3）：
 * 跟随 ≠ 移动相机，而是**反向平移世界根**，使跟随目标落在屏幕中心；UI 层不受影响。
 */

/** 层级容器名（ViewLayerKey -> 节点名）。 */
export const ViewLayer = {
  background: 'Layer_Background',
  ground: 'Layer_Ground',
  pickup: 'Layer_Pickup',
  enemy: 'Layer_Enemy',
  player: 'Layer_Player',
  bullet: 'Layer_Bullet',
  effect: 'Layer_Effect',
  floatText: 'Layer_FloatText',
} as const;

export type ViewLayerKey = keyof typeof ViewLayer;

/** 层级先后顺序（文档 4.7 原文顺序，禁止随意调整）。 */
const LAYER_ORDER: ViewLayerKey[] = [
  'background', 'ground', 'pickup', 'enemy', 'player', 'bullet', 'effect', 'floatText',
];

const WORLD_ROOT_NAME = 'WorldRoot';

/** 场景中的 UI 渲染根（Canvas）。找不到返回 null。 */
export function getViewRoot(): Node | null {
  const node = find('Canvas');
  return node && node.getComponent(Canvas) ? node : null;
}

/** 递归设置节点及其全部子节点的渲染层。 */
export function setLayerRecursive(node: Node, layer: number): void {
  node.layer = layer;
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    setLayerRecursive(children[i], layer);
  }
}

/**
 * 取得（必要时创建）UI 根节点（Canvas 下的 UIRoot）：HUD / 面板 / 小地图等界面都挂在它下面，
 * 不受世界根（相机跟随）位移影响。
 */
export function ensureUiRoot(): Node | null {
  const canvas = getViewRoot();
  if (!canvas) {
    return null;
  }
  const existed = canvas.getChildByName('UIRoot');
  if (existed) {
    // 兼容早期创建过的 UIRoot（可能没有 UITransform）——补上，否则触摸坐标转换会静默失效
    if (!existed.getComponent(UITransform)) {
      const old = existed.addComponent(UITransform);
      old.setAnchorPoint(0.5, 0.5);
      old.setContentSize(getVisibleWidth(), getVisibleHeight());
    }
    return existed;
  }
  const node = new Node('UIRoot');
  node.layer = Layers.Enum.UI_2D;
  canvas.addChild(node);
  // ⚠️ 必须带 UITransform：摇杆 / 面板等要用 `convertToNodeSpaceAR` 把**触摸点（屏幕坐标系）**
  // 转成 UI 局部坐标。没有它时 `getComponent(UITransform)` 返回 null、转换被静默跳过，
  // 触摸坐标会整段停留在"全为正数"的屏幕坐标系里 ⇒ 摇杆方向**恒指向右上**（实测 Bug）。
  const ut = node.addComponent(UITransform);
  ut.setAnchorPoint(0.5, 0.5);
  ut.setContentSize(getVisibleWidth(), getVisibleHeight());
  return node;
}

/** 游戏画面视口节点名（带 Mask，把玩法内容裁剪在"游戏画面区"内）。 */
const GAME_VIEW_NAME = 'GameViewport';
/** 游戏画面区底景色（深蓝绿；让"地宫之外"也有画面层次，而不是纯黑）。 */
const GAME_BG_COLOR = new Color(24, 30, 28, 255);

/**
 * **游戏画面视口**：Canvas 下的一个带 `Mask` 的容器，矩形范围即"上半部游戏画面区"。
 *
 * 用户口径：竖屏下**上部分是游戏画面、下部分是操作区（无画面）**。
 * 做法是把整个世界根塞进这个 Mask 里 ⇒ 越界的内容（比如走到画面外的地宫、飘出的特效）
 * 会被裁掉，不会溢到下方操作区。
 *
 * 位置与尺寸按**可见高度**动态算：`y = 游戏区中心`、`高 = 可见高 - 操作区高`。
 */
export function ensureGameViewport(): Node | null {
  const canvas = getViewRoot();
  if (!canvas) {
    return null;
  }
  const existed = canvas.getChildByName(GAME_VIEW_NAME);
  if (existed) {
    applyGameViewportLayout(existed);
    return existed;
  }
  const node = new Node(GAME_VIEW_NAME);
  node.layer = Layers.Enum.UI_2D;
  canvas.addChild(node);
  node.addComponent(Mask); // 默认 GRAPHICS_RECT：按 UITransform 的 contentSize 裁剪
  applyGameViewportLayout(node);
  // 画面区底景：地宫之外（房间之间的空隙）不该是"纯黑一片"（用户截图里的观感问题）
  const bg = new Node('GameBg');
  bg.layer = Layers.Enum.UI_2D;
  node.addChild(bg); // **最先添加** ⇒ 位于所有玩法内容之下
  const bgg = bg.addComponent(Graphics);
  bgg.fillColor = GAME_BG_COLOR;
  bgg.rect(-getVisibleWidth() / 2, -getGameAreaHeight() / 2, getVisibleWidth(), getGameAreaHeight());
  bgg.fill();
  // 排在 UIRoot 之前 ⇒ UI（HUD / 操作区 / 面板）永远压在游戏画面之上
  const ui = canvas.getChildByName('UIRoot');
  if (ui) {
    node.setSiblingIndex(ui.getSiblingIndex());
  }
  return node;
}

/** 按当前可见尺寸摆放视口（居中于游戏画面区）。 */
function applyGameViewportLayout(node: Node): void {
  const ut = node.getComponent(UITransform) ?? node.addComponent(UITransform);
  ut.setContentSize(getVisibleWidth(), getGameAreaHeight());
  ut.setAnchorPoint(0.5, 0.5);
  node.setPosition(0, getGameAreaCenterY(), 0);
}

/**
 * 取得（必要时创建）世界根：所有玩法层级的父节点。
 * ⚠️ 它挂在 **GameViewport（Mask）之下** ⇒ 玩法内容天然被裁剪在游戏画面区内。
 */
export function ensureWorldRoot(): Node | null {
  const viewport = ensureGameViewport();
  if (!viewport) {
    console.error('[ViewRoot] 场景中找不到 Canvas，无法渲染 2D 节点');
    return null;
  }
  const existed = viewport.getChildByName(WORLD_ROOT_NAME);
  if (existed) {
    return existed;
  }
  const root = new Node(WORLD_ROOT_NAME);
  root.layer = Layers.Enum.UI_2D;
  viewport.addChild(root);
  return root;
}

/**
 * 取得（必要时创建）某个渲染层容器。
 *
 * 关键：创建时**先递归保证上一个层级已存在**，再插到它之后。
 * 这样无论各层被访问的先后顺序如何，最终同级顺序始终等于文档 4.7 的层级顺序
 * （懒创建若只按访问顺序追加，会出现「敌人层跑到玩家层之上」这类错序）。
 */
export function ensureViewLayer(key: ViewLayerKey): Node | null {
  const worldRoot = ensureWorldRoot();
  if (!worldRoot) {
    return null;
  }
  const name = ViewLayer[key];
  const existed = worldRoot.getChildByName(name);
  if (existed) {
    return existed;
  }

  const index = LAYER_ORDER.indexOf(key);
  const prev = index > 0 ? ensureViewLayer(LAYER_ORDER[index - 1]) : null;

  const node = new Node(name);
  node.layer = Layers.Enum.UI_2D;
  worldRoot.addChild(node);
  if (prev && prev.parent === worldRoot) {
    node.setSiblingIndex(prev.getSiblingIndex() + 1);
  }
  return node;
}

/**
 * 把节点挂到指定渲染层（坐标原点为世界根原点），并统一渲染层为 UI_2D。
 * @param xPx 世界根坐标 x（px）
 * @param yPx 世界根坐标 y（px）
 */
export function attachToViewLayer(node: Node, key: ViewLayerKey, xPx = 0, yPx = 0): void {
  const layer = ensureViewLayer(key);
  if (layer && node.parent !== layer) {
    node.setParent(layer);
  }
  node.setPosition(xPx, yPx, 0);
  setLayerRecursive(node, Layers.Enum.UI_2D);
}

/** 世界根偏移（px）。相机跟随即把世界根反向平移。 */
export function setWorldOffset(xPx: number, yPx: number): void {
  const worldRoot = ensureWorldRoot();
  if (worldRoot) {
    worldRoot.setPosition(xPx, yPx, 0);
  }
}

/** 当前世界缩放（> 1 表示画面放大、视野变窄）。 */
let worldScale = 1;

/**
 * **视野缩放**（`Boot` 从配置读入后调用）。
 *
 * 用户反馈（截图）：竖屏下地宫只占画面中间一小条、左右大片空 —— 因为一屏宽 1280 而
 * 地宫房间只有 ~480 宽。按比例**放大世界根**即可让房间"撑满"画面，观感与竖屏比例匹配。
 * 缩放会一并影响跟随平移（见 `updateViewFollow`）。
 */
export function setWorldScale(scale: number): void {
  worldScale = scale > 0.1 ? scale : 1;
  const worldRoot = ensureWorldRoot();
  if (worldRoot) {
    worldRoot.setScale(worldScale, worldScale, 1);
  }
}

let followTarget: Node | null = null;

/** 设置相机跟随目标（null 取消并复位偏移）。 */
export function setFollowTarget(node: Node | null): void {
  followTarget = node;
  if (!node) {
    setWorldOffset(0, 0);
  }
}

/**
 * 每帧由 Boot 驱动：把世界根平移，使跟随目标处于**游戏画面区中心**。
 * ⚠️ 竖屏分区后不能再用屏幕中心（0）—— 那会把角色放到操作区里。
 */
export function updateViewFollow(): void {
  if (!followTarget) {
    return;
  }
  const p = followTarget.position;
  /**
   * ⚠️ **不要再加 `getGameAreaCenterY()`**。
   * `GameViewport` 节点本身已经摆在"游戏画面区中心"（见 `applyGameViewportLayout`），
   * 世界根是它的子节点 ⇒ 在世界根内部**只需做"把角色挪到原点"这一件事**。
   * 之前多加了一次中心偏移，等于**双重偏移**，角色被顶到画面偏上（实测 Bug）。
   *
   * 缩放同理：世界根被 `worldScale` 放大 ⇒ 平移量也乘 `worldScale`。
   */
  setWorldOffset(-p.x * worldScale, -p.y * worldScale);
}

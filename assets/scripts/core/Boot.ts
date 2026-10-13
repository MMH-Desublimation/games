import { _decorator, Component, director, view } from 'cc';
import { dataManager } from '../data/DataManager';
import { gameState } from './GameState';
import { saveManager } from '../save/SaveManager';
import { timer } from './Timer';
import { eventBus } from './EventBus';
import { EventNames } from './EventNames';
// 副作用引入：构造 RunFlow 单例并订阅事件（须早于 on_config_loaded）
import '../dungeon/RunFlow';
// 副作用引入：构造 BuffSystem 单例（升级检测 / Buff 发放）
import '../combat/BuffSystem';
// 副作用引入：表现层单例（飘字 / 受击特效订阅伤害与死亡事件）与池注册函数
import { registerBulletPool } from '../combat/Bullet';
import { registerEnemyBulletPool } from '../combat/EnemyBullet';
import { registerDamageTextPool } from '../ui/DamageText';
import { registerHitEffectPool } from '../ui/HitEffect';
// 副作用引入：Boss 危险范围预警表现（订阅 on_boss_telegraph）
import { registerDangerZonePool } from '../ui/DangerZone';
// 副作用引入：地宫灰盒表现（订阅 on_dungeon_built）与地宫进程系统（逐帧判定房间/出口）
import '../dungeon/DungeonView';
import '../dungeon/DungeonSystem';
// 副作用引入：小地图（订阅地宫/开局/结算事件）
import '../ui/Minimap';
// 副作用引入：局外养成面板（订阅面板开关 / 购买事件；节点代码构建）
import '../ui/MetaPanel';
// 副作用引入：存档选择面板（首屏；订阅配置就绪 / 槽位变化；节点代码构建）
import '../ui/SaveSlotPanel';
// 副作用引入：开始封面（首屏；须排在 SaveSlotPanel 之后 —— 它依赖 saveSlotPanel 单例）
import '../ui/CoverPanel';
// 副作用引入：技能系统（订阅开局 / 结算；键盘 J/K 释放）与技能栏（冷却显示 / 点击释放）
import '../combat/SkillSystem';
import '../ui/SkillBar';
// 副作用引入：虚拟摇杆（手机竖屏：操作区左下角拖动移动；触摸区须**早于**技能栏创建以保证层级更低）
import '../ui/VirtualStick';
// 副作用引入：局内暂停 / 退出面板（暂停按钮 / ESC / 退出到存档）
import '../ui/PausePanel';
// 副作用引入：技能型 / 环境型行为 Buff（周期释放、减速光环、击杀重置冷却）
import '../combat/BehaviorSkillSystem';
// 副作用引入：序列帧特效播放（订阅 on_fx；资源缺失时静默降级）
import { registerFxPool } from '../ui/FxPlayer';
import '../ui/FxPlayer';
import { ticker } from './Ticker';
import { actorSheets } from './ActorSheet';
import { preloadUiFont } from '../ui/UiKit';
import { audioSystem } from './AudioSystem';
import {
    applyScreenAdaptation, detectLayoutMode, ensureCtrlAreaBg, LayoutMode,
    setRunActiveFlag, setWorldScale, updateViewFollow,
} from './ViewRoot';

/**
 * 解析布局模式：`balance.layout_mode` = `'auto' | 'portrait' | 'landscape'`。
 * `'auto'`（或缺省）⇒ 交给 `detectLayoutMode()`（按引擎真实绘制尺寸，见 `ViewRoot` 的说明）；
 * 显式值 ⇒ 覆盖（编辑器宽窗口里也能预览竖屏布局）。
 */
function resolveLayoutMode(): LayoutMode {
    const configured = dataManager.get<any>('balance', 'layout_mode');
    if (configured === 'portrait' || configured === 'landscape') {
        return configured;
    }
    return detectLayoutMode();
}

const { ccclass } = _decorator;

/**
 * 启动引导组件（挂在 Boot 场景根节点）。
 * 负责：恢复养成存档 -> 异步加载全部配置 -> 驱动帧率无关计时器。
 * 其余玩法系统监听 on_config_loaded 后再开始运行。
 *
 * 注：开发期的 `mountTestHooks` / `ROGUE_TEST`（Boss 轮换、解锁终局、加金币）已按 D18 在阶段 5 发布前移除。
 */
@ccclass('Boot')
export class Boot extends Component {
    /** 启动时的屏幕方向（宽 > 高 = 横屏）；用于检测转屏。 */
    private landscapeAtStart = false;

    /** 当前绘制区是否为横向（`view.getFrameSize()`，与 `detectLayoutMode` 同口径）。 */
    private isLandscapeNow(): boolean {
        const frame = view.getFrameSize();
        return frame.width > 1 && frame.height > 1 && frame.width > frame.height;
    }

    /** 定时检查方向：反转则重载场景（UI 全部按新方向重建）。 */
    private checkOrientation(): void {
        if (this.isLandscapeNow() === this.landscapeAtStart) {
            return;
        }
        this.landscapeAtStart = this.isLandscapeNow();
        const scene = director.getScene();
        console.log(`[Boot] 屏幕方向变化 ⇒ 重载场景（${scene ? scene.name : '?'}）`);
        if (scene) {
            director.loadScene(scene.name);
        }
    }

    start() {
        // 0. **屏幕适配**（自动判定竖屏手机 / 横屏电脑）+ **操作区底衬**。
        // ⚠️ 必须在最前面：项目设置里**没有**分辨率配置（实测查过 settings/v2/packages/*.json），
        // 不设就会落到引擎默认值，与全部 UI 坐标不一致；后续的 `getVisibleWidth()` 也依赖它。
        // 判定按**引擎真实绘制尺寸**并做"自洽复核"（见 `ViewRoot.finishAdaptation`），
        // 不再依赖 window 尺寸 —— 那在 iframe 预览下会把竖屏误判成横屏。
        applyScreenAdaptation(detectLayoutMode());
        // 操作区底衬只在**局内进行中**显示（菜单界面不铺底色 ⇒ 它不可能再压住任何面板）。
        // 这个布尔由本组件喂给 `ViewRoot`，避免 core 底层反向依赖 `GameState`。
        eventBus.on(EventNames.on_run_start, () => setRunActiveFlag(true));
        eventBus.on(EventNames.on_run_end, () => setRunActiveFlag(false));
        // 记录启动时的屏幕方向，之后每 0.5s 检查 —— 方向反转（手机转屏 / 浏览器窗口改宽高）时**重载场景**。
        // 为什么重载而不是就地重排：面板节点在转向后仍保留旧尺寸与旧坐标（实测「竖屏启动→转横屏」
        // 标题跑到屏外、「横屏启动→转竖屏」标题巨大且立绘被裁）。逐个重排所有面板的复杂度与
        // 出错概率都远高于重开一局，而单机游戏**存档会保留本局进度**，代价可接受。
        this.landscapeAtStart = this.isLandscapeNow();
        this.schedule(this.checkOrientation, 0.5);
        // 1. 异步加载 8 张配置表（loadAll 为回调风格，宪法 6.4：完成事件统一走事件总线）
        dataManager.loadAll((err) => {
            if (err) {
                console.error('[Boot] 配置加载失败:', err);
                eventBus.emit(EventNames.on_error, err);
                return;
            }
            console.log('[Boot] 配置加载完成');
            // 1.2 布局模式校正：`balance.layout_mode` 为 'auto' 时保持自动判定；
            //     显式指定 'portrait' / 'landscape' 时覆盖（方便在**编辑器宽窗口里预览竖屏手机布局**）。
            //     `applyScreenAdaptation` 内部会做自洽复核并按新尺寸重排 UIRoot / 视口 / 操作区底衬，
            //     所以这里再调一次是安全且必要的（配置此时才可读）。
            applyScreenAdaptation(resolveLayoutMode());
            // 1.3 操作区底衬（竖屏才建；横屏下函数内部直接返回）
            ensureCtrlAreaBg();
            // 1.5 画面缩放（dungeon.view_zoom）：竖屏下让地宫更"饱满"，观感与竖屏比例匹配
            setWorldScale(dataManager.getTable<any>('dungeon').view_zoom);
            // 2. 存档准备：迁移旧版单槽存档（真正的加载由存档选择面板决定）
            saveManager.prepareSlots();
            // 3. 池化预分配：数量与上限全部取自 balance.performance（文档 4.5 / 4.9）
            registerBulletPool();
            registerDamageTextPool();
            registerHitEffectPool();
            registerEnemyBulletPool();
            registerDangerZonePool();
            registerFxPool();
            // 3.5 UI 艺术字体（像素字体）：尽早加载，晚建的面板直接带上，早建的由回填补上
            preloadUiFont();
            // 4. 演员表（角色 / 怪物 / Boss 的序列帧动作表）：异步预加载，缺素材不阻塞开局
            actorSheets.preload();
            console.log('[Boot] 动作表预加载中（忍者角色 / 怪物 / Boss）');
            // 5. 音频（BGM / 音效 / 结算音）：异步预加载，缺素材静默降级（阶段 5）
            audioSystem.preload();
            registerExitSave();
            eventBus.emit(EventNames.on_config_loaded);
        });
    }

    update(deltaTime: number) {
        // 帧率无关计时器（dt 单位：秒）。
        // 暂停（升级选卡 / 手动暂停）时推进 0 秒：Buff 时长、受击闪色、技能增幅到期等
        // 一并冻结，与玩法层的冻结保持同一时间轴。
        timer.update(gameState.isPaused() ? 0 : deltaTime);
        // 相机跟随：反向平移世界根，使跟随目标（角色）处于屏幕中心
        updateViewFollow();
        // 模块级系统的逐帧逻辑（地宫房间/出口判定等）
        ticker.update(deltaTime);
    }
}

/**
 * 退出前落盘（文档 5.3：Web 用 beforeunload）。
 * 浏览器刷新 / 关闭时保存当前进度（含 `progress.current_run`，刷新后可继续本局）。
 * 非 Web 平台没有 beforeunload，直接跳过（其他存档时机不受影响）。
 */
function registerExitSave(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return;
    }
    window.addEventListener('beforeunload', () => {
        if (saveManager.hasActiveSlot()) {
            saveManager.save();
        }
    });
}

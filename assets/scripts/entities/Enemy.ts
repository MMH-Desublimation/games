import { _decorator, Color, Component, Node, Sprite, UIOpacity, UITransform } from 'cc';
import { dataManager } from '../data/DataManager';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { gameState } from '../core/GameState';
import { MAX_DT_SEC, timer } from '../core/Timer';
import { nudgeToWalkable, resolveWalkableMove } from '../dungeon/DungeonCollision';
import { endgameRules } from '../dungeon/EndgameRules';
import { EnemyVariant, RangedSpec } from './EnemyVariants';
import { fireEnemyBullet } from '../combat/EnemyBullet';
import { damageFormula } from '../combat/DamageFormula';
import { SheetAnim, actorSheets } from '../core/ActorSheet';

const { ccclass } = _decorator;

/** 受击闪色与常态色（表现常量，非游戏数值）。 */
const HIT_FLASH_COLOR = new Color(255, 96, 96, 255);
const NORMAL_COLOR = new Color(255, 255, 255, 255);
/** 猎杀者常态色（精英标识；仅表现，便于实机辨认刷新，不参与数值）。 */
const HUNTER_COLOR = new Color(198, 128, 255, 255);
/** 灼烧中的染色（仅表现）：让「灼烧」Buff 的效果对玩家可见（实测反馈"看不到烧伤"）。 */
const BURN_COLOR = new Color(255, 150, 60, 255);

/** 敌人种类：普通怪 / 猎杀者（精英）/ Boss（文档 2.4 猎杀者、2.5 Boss）。 */
export type EnemyKind = 'normal' | 'hunter' | 'boss';

/**
 * 敌人行为组件（实体层）。
 * 属性全部取自 enemies.json 并按层数缩放（文档 3.6），禁止硬编码。
 * 仅负责：按层初始化属性、追击玩家、受击死亡。伤害结算交由 combat 模块。
 */
@ccclass('Enemy')
export class Enemy extends Component {
  private maxHp = 1;
  private hp = 1;
  private atk = 1;
  private speedPx = 0;
  private playerNode: Node | null = null;
  /** 受击闪色的恢复任务 id（0 表示无）。 */
  private flashTimerId = 0;
  private kind: EnemyKind = 'normal';
  /** 常态颜色（猎杀者用精英色；受击闪色恢复时还原此色）。 */
  private baseColor: Color = NORMAL_COLOR;
  /** 常规追击开关：Boss 冲锋 / 跳砸期间由行为组件关闭，避免与技能位移冲突（文档 2.5）。 */
  private chaseEnabled = true;
  /** 移速倍率（Boss 加速行为 / 技能减速与定身；1 = 原始速度，0 = 定身）。 */
  private speedMultiplier = 1;
  /** 状态计时令牌：新状态施加时 +1，使先前状态的到期回调失效（避免旧回调覆盖新状态）。 */
  private statusToken = 0;
  /** 持续伤害（Buff「灼烧」）：每秒伤害 / 剩余秒数 / 未结算的累计伤害。 */
  private burnDps = 0;
  private burnLeftSec = 0;
  private burnAccum = 0;
  /** 被击退后的「无法追击」剩余秒数（使击退位移不会被追击立即抵消）。 */
  private knockbackLeftSec = 0;
  /**
   * 变体「突然加速」状态（T14-S2：如疾行种）：
   * `burstBonus` 是与 `speedMultiplier`（技能减速/定身）**互不干扰**的独立速度加成，
   * 避免加速行为把技能的减速状态覆盖掉。
   */
  private burstBonus = 0;
  private burstSpeedRatio = 0;
  private burstDurationSec = 0;
  private burstIntervalSec = 0;
  private burstLeftSec = 0;
  private burstWaitSec = 0;
  /** 序列帧动作播放器（怪物素材；null = 旧单帧素材）。 */
  private anim: SheetAnim | null = null;
  /** 本怪使用的素材 id（动作表异步就绪后用于补建动画）。 */
  private actorId = '';
  /** 远程投掷参数（远程种；null = 近战 / 贴身型）。 */
  private ranged: RangedSpec | null = null;
  /** 投掷冷却剩余（秒）。 */
  private rangedCdSec = 0;
  /** Boss 的多动作（idle / walk）播放器；非 Boss 为 null。 */
  private bossAnims: Record<string, SheetAnim> | null = null;
  private bossAction = '';
  private lastPosX = 0;
  private lastPosY = 0;

  /**
   * 由 EntityManager 取出节点后调用，按层初始化属性。
   * @param kind 敌人种类（普通怪 / 猎杀者 / Boss）
   * @param timeFactor 本层时间压力系数（文档 3.6 的 time_factor；Boss 不参与，按文档公式 3.6/3.7）
   */
  setup(
    layer: number, playerNode: Node | null, kind: EnemyKind = 'normal', timeFactor = 1,
    variant: EnemyVariant | null = null, actorId = '',
  ): void {
    const normal = dataManager.get<any>('enemies', 'normal');
    const growth = dataManager.get<any>('enemies', 'layer_growth');
    const boss = dataManager.get<any>('enemies', 'boss');
    const hunter = dataManager.get<any>('enemies', 'hunter');
    const layerHpScale = Math.pow(growth.hp_factor, layer - 1);
    const layerAtkScale = Math.pow(growth.atk_factor, layer - 1);
    // 敌方基准：普通怪「裸值」。
    //  - 本体 / 普通地图：按 enemies.json 的层数成长（文档 3.6）；
    //  - 终局·挑战地图：按文档 3.8 的递进公式覆盖（`endgameRules` 返回 0 表示沿用 3.6）。
    const eg = endgameRules.enemyScaling(gameState.getMode(), layer);
    const baseHp = eg.hp > 0 ? eg.hp : normal.base_hp * layerHpScale;
    const baseAtk = eg.atk > 0 ? eg.atk : normal.base_atk * layerAtkScale;
    if (kind === 'boss') {
      const dun = dataManager.getTable<any>('dungeon');
      const bossEvery = dun.boss_every_layers;
      // 第 N 轮 Boss：第 bossEvery×N 层（第 5 层为第 1 轮，第 10 层为第 2 轮……）
      const bossIndex = Math.max(1, Math.floor(layer / bossEvery));
      // Boss 与普通怪同比例成长（文档 3.6 的 boss 倍率，作用在「当层普通怪裸值」上）
      this.maxHp = baseHp * (boss.base_hp / normal.base_hp) * Math.pow(boss.boss_hp_factor, bossIndex - 1);
      this.atk = baseAtk * (boss.base_atk / normal.base_atk) * Math.pow(boss.boss_atk_factor, bossIndex - 1);
      this.speedPx = boss.move_speed_px;
    } else if (kind === 'hunter') {
      // 精英按普通怪基准乘 enemies.hunter 倍率（文档 3.6）
      this.maxHp = baseHp * hunter.hp_multiplier * timeFactor;
      this.atk = baseAtk * hunter.atk_multiplier * timeFactor;
      this.speedPx = normal.move_speed_px * hunter.speed_multiplier;
    } else {
      this.maxHp = baseHp * timeFactor;
      this.atk = baseAtk * timeFactor;
      this.speedPx = normal.move_speed_px;
    }
    // 变体修正（T14-S2：普通怪的"种类"差异 —— 数值倍率 / 速度 / 体积 / 颜色与透明度 / 特殊行为）
    this.ranged = null;
    this.rangedCdSec = 0;
    if (variant && kind === 'normal') {
      this.maxHp *= variant.hpRatio;
      this.atk *= variant.atkRatio;
      this.speedPx *= variant.speedRatio;
      // 远程投掷种：保持距离 + 周期投掷（用户口径：远程投掷种）
      this.ranged = variant.ranged ?? null;
      this.rangedCdSec = this.ranged ? this.ranged.cooldownMs / 1000 : 0;
    }
    // 显示大小同样取自配置（16px 美术在 1280x720 下过小）
    let renderScale = kind === 'hunter' ? hunter.render_scale : (kind === 'boss' ? boss.render_scale : normal.render_scale);
    if (variant && kind === 'normal') {
      renderScale *= variant.renderRatio;
    }
    // 素材体型差异（actors.json）：普通怪用 monsters.<id>.scale（熊大而慢、蝙蝠小而快）；
    // Boss 用 bosses.<id>.scale 做**归一化**（Boss 素材帧 48~82px，不归一会出现巨无霸 / 迷你怪）
    if (actorId) {
      renderScale *= kind === 'boss' ? actorSheets.bossScale(actorId) : actorSheets.monsterScale(actorId);
    }
    this.node.setScale(renderScale, renderScale, 1);
    this.hp = this.maxHp;
    this.playerNode = playerNode;
    this.kind = kind;
    this.baseColor = variant && variant.color
      ? new Color(variant.color[0], variant.color[1], variant.color[2], 255)
      : (kind === 'hunter' ? HUNTER_COLOR : NORMAL_COLOR);
    this.chaseEnabled = true;
    this.speedMultiplier = 1;
    this.burstBonus = 0;
    this.burstLeftSec = 0;
    this.burstWaitSec = variant && variant.burstIntervalMs > 0 ? variant.burstIntervalMs / 1000 : 0;
    this.burstSpeedRatio = variant ? variant.burstSpeedRatio : 0;
    this.burstDurationSec = variant ? variant.burstMs / 1000 : 0;
    this.burstIntervalSec = variant && variant.burstIntervalMs > 0 ? variant.burstIntervalMs / 1000 : 0;
    this.statusToken += 1; // 池复用：让上一世的减速/定身到期回调失效
    this.burnDps = 0;
    this.burnLeftSec = 0;
    this.burnAccum = 0;
    this.knockbackLeftSec = 0;
    // 供 combat / 节奏系统读取的轻量标记（不新增模块间实例引用）
    (this.node as any).__isBoss = kind === 'boss';
    (this.node as any).__kind = kind;
    (this.node as any).__layer = layer;
    (this.node as any).__variantId = variant ? variant.id : '';
    (this.node as any).__actorId = actorId;
    this.actorId = actorId;
    // 序列帧动作（actorId → actors.json 的 monsters 表）：有动画则每帧推进，否则沿用旧单帧素材
    this.anim = null;
    this.bossAnims = null;
    this.bossAction = '';
    if (actorId) {
      this.buildAnims(actorId);
    }
    const sp = this.node.getComponent(Sprite);
    if (sp) sp.color = this.baseColor;
    // 半透明类变体：用 UIOpacity 表现（池复用时必须复位为 255）
    const opacity = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
    opacity.opacity = variant && kind === 'normal' ? variant.alpha : 255;
  }

  /** 敌人种类（供上层判断精英/Boss 表现与掉落）。 */
  getKind(): EnemyKind { return this.kind; }

  /** 常态颜色（Boss 行为组件预警染色后还原用）。 */
  getBaseColor(): Color { return this.baseColor; }

  /** 开关常规追击（Boss 技能期间由 BossBehavior 调用，文档 2.5）。 */
  setChaseEnabled(enabled: boolean): void {
    this.chaseEnabled = enabled;
  }

  /** 设置移速倍率（1 = 原始速度；0 表示定身，供技能 root 使用）。 */
  setSpeedMultiplier(multiplier: number): void {
    this.speedMultiplier = multiplier >= 0 ? multiplier : 1;
  }

  /**
   * 施加临时速度状态（技能效果：`slow` 减速 / `root` 定身）。
   * 在 durationSec 内移速 = 原始 × speedScale，到期自动恢复；
   * 用令牌保证「后施加的状态」不被先前的到期回调覆盖。
   */
  applyStatus(speedScale: number, durationSec: number): void {
    const token = ++this.statusToken;
    this.setSpeedMultiplier(speedScale);
    if (durationSec <= 0) {
      return;
    }
    timer.after(durationSec, () => {
      if (token !== this.statusToken || !this.node.isValid) {
        return; // 已被更新的状态接管 / 节点已回收
      }
      this.setSpeedMultiplier(1);
    });
  }

  /**
   * 施加持续伤害（Buff「灼烧」）：同时取「较强者」与「较长者」，
   * 避免高频命中把 DOT 叠成爆炸伤害，同时保证持续覆盖。
   */
  applyBurn(dpsPerSec: number, durationSec: number): void {
    if (dpsPerSec <= 0 || durationSec <= 0) {
      return;
    }
    this.burnDps = Math.max(this.burnDps, dpsPerSec);
    this.burnLeftSec = Math.max(this.burnLeftSec, durationSec);
    // 表现：进入灼烧状态即染色（受击闪色进行中时不覆盖，闪色结束会回到「常态色」逻辑）
    if (this.flashTimerId === 0) {
      const sp = this.node.getComponent(Sprite);
      if (sp) {
        sp.color = BURN_COLOR;
      }
    }
  }

  /** 非受击闪色时的应有颜色：灼烧中为橙色，否则为常态色（含猎杀者精英色）。 */
  private colorWhenIdle(): Color {
    return this.burnLeftSec > 0 ? BURN_COLOR : this.baseColor;
  }

  /** 灼烧结算：按秒累计，凑满 1 点才结算一次（避免逐帧发伤害与飘字）。 */
  private tickBurn(dt: number): void {
    if (this.burnLeftSec <= 0) {
      return;
    }
    const step = Math.min(dt, MAX_DT_SEC);
    this.burnLeftSec -= step;
    this.burnAccum += this.burnDps * step;
    if (this.burnLeftSec <= 0) {
      // 灼烧结束：恢复常态色（受击闪色进行中则交给闪色回调统一恢复）
      if (this.flashTimerId === 0) {
        const sp = this.node.getComponent(Sprite);
        if (sp) {
          sp.color = this.baseColor;
        }
      }
    }
    if (this.burnAccum < 1) {
      return;
    }
    const dmg = Math.floor(this.burnAccum);
    this.burnAccum -= dmg;
    // 先取坐标：结算可能导致死亡回收，之后不再读节点
    const wx = this.node.position.x;
    const wy = this.node.position.y;
    this.takeDamage(dmg);
    eventBus.emit(EventNames.on_damage_dealt, wx, wy, dmg);
  }

  /**
   * 施加击退（技能「水柱」等）：沿指定方向一次性平移一段距离，撞墙时贴墙滑行/停止。
   * 只做一次位移，不改变后续追击行为；Boss 是否免疫由调用方按配置决定。
   */
  applyKnockback(dirX: number, dirY: number, distancePx: number, lockSec: number): void {
    if (distancePx <= 0) {
      return;
    }
    const len = Math.hypot(dirX, dirY);
    if (len <= 0) {
      return;
    }
    const p = this.node.position;
    const moved = resolveWalkableMove(
      p.x, p.y, p.x + (dirX / len) * distancePx, p.y + (dirY / len) * distancePx, this.getHitRadiusPx(),
    );
    this.node.setPosition(moved.x, moved.y, p.z);
    // 关键：击退后必须短暂中断追击，否则敌人下一帧就自己走回来了（视觉上等于没有击退）
    this.knockbackLeftSec = Math.max(this.knockbackLeftSec, lockSec);
  }

  /** 受击（amount 由 combat 计算后传入）。 */
  takeDamage(amount: number): void {
    // 亡语保护：已死亡的敌人不再重复扣血 / 重复广播死亡事件。
    // （此前没有这道判断，任何"在同一帧被多次结算"的场景都会重复发 on_enemy_died ⇒ 重复发奖/重复特效）
    if (this.hp <= 0) {
      return;
    }
    this.hp -= amount;
    this.playHitFlash();
    if (this.hp <= 0) {
      // 附带死亡瞬间的世界根坐标：表现层无需在节点回收后再取位置
      const wp = this.node.position;
      eventBus.emit(EventNames.on_enemy_died, this.node, wp.x, wp.y);
    }
  }

  /**
   * 命中半径（px）：由精灵实际尺寸 × 显示缩放推导，不硬编码各敌人体积。
   * ⚠️ 缩放取 `Math.abs`：Boss 会按朝向做**水平翻转**（`scale.x` 为负），取绝对值才不会算出负半径。
   */
  getHitRadiusPx(): number {
    const ut = this.node.getComponent(UITransform);
    if (!ut) {
      return 0;
    }
    const w = ut.contentSize.width;
    const h = ut.contentSize.height;
    return Math.max(w, h) * Math.abs(this.node.scale.x) * 0.5;
  }

  /** 受击闪色（时长取自 balance.combat.hit_flash_ms）。 */
  private playHitFlash(): void {
    const sp = this.node.getComponent(Sprite);
    if (!sp) {
      return;
    }
    sp.color = HIT_FLASH_COLOR;
    if (this.flashTimerId) {
      timer.cancel(this.flashTimerId);
    }
    const ms = dataManager.get<any>('balance', 'combat').hit_flash_ms;
    this.flashTimerId = timer.after(ms / 1000, () => {
      this.flashTimerId = 0;
      const s = this.node.getComponent(Sprite);
      if (s) {
        s.color = this.colorWhenIdle(); // 还原：灼烧中保持橙色，否则常态色（猎杀者保持精英色）
      }
    });
  }

  getAtk(): number {
    return this.atk;
  }

  /**
   * 按素材 id 构建动画（`kind` 决定形态）：
   *  - 普通怪 / 精英：单张动作表（idle 循环）；
   *  - **Boss**：`idle` + `walk` 两个动作，运行中按"是否在移动"自动切换（用户要求：Boss 有行动序列帧）。
   * @returns 是否构建成功（素材未就绪 / 缺失时为 false，调用方可稍后重试）
   */
  private buildAnims(actorId: string): boolean {
    if (this.kind === 'boss') {
      const idle = actorSheets.bossAnim(actorId, 'idle');
      if (!idle) {
        return false;
      }
      const walk = actorSheets.bossAnim(actorId, 'walk') ?? idle;
      // 攻击动作（大招 / 冲锋蓄力时播放；配了才有）
      const attack = actorSheets.bossAnim(actorId, 'attack');
      idle.reset(false);
      this.bossAnims = attack ? { idle, walk, attack } : { idle, walk };
      this.bossAction = 'idle';
      this.anim = idle;
      const p = this.node.position;
      this.lastPosX = p.x;
      this.lastPosY = p.y;
    } else {
      const anim = actorSheets.monsterAnim(actorId);
      if (!anim) {
        return false;
      }
      anim.reset(true); // 随机相位：同屏同素材的怪不会"整齐划一"
      this.anim = anim;
    }
    const frame = this.anim.frame;
    if (frame) {
      // Sprite 由本组件兜底创建：此前它只由 EntityManager.applySprite 动态添加，
      // 一旦"有动作表就跳过 applySprite"，就会**没有任何 Sprite 组件** ⇒ 实体完全不可见。
      this.ensureSprite().spriteFrame = frame;
    }
    return true;
  }

  /** 取得（必要时创建）精灵组件；Sprite 由本组件兜底创建，不依赖外部调用顺序。 */
  private ensureSprite(): Sprite {
    let sp = this.node.getComponent(Sprite);
    if (!sp) {
      sp = this.node.addComponent(Sprite);
      sp.sizeMode = Sprite.SizeMode.RAW;
    }
    return sp;
  }

  /**
   * 推进序列帧动画（只在实际换帧时写 SpriteFrame）。
   * Boss 走 `tickBossAnim`（idle / walk 按移动状态切换）。
   */
  private tickAnim(dt: number): void {
    if (this.bossAnims) {
      this.tickBossAnim(dt);
      return;
    }
    if (!this.anim) {
      // 素材异步加载：批量建怪时可能尚未就绪，就绪后补建一次（避免这一只怪永远停留在兜底图）
      if (this.actorId && actorSheets.isLoaded) {
        if (!this.buildAnims(this.actorId)) {
          this.actorId = ''; // 素材确实缺失：不再重试
        }
      }
      return;
    }
    const frame = this.anim.tick(Math.min(dt, MAX_DT_SEC));
    if (!frame) {
      return;
    }
    const sp = this.ensureSprite();
    if (sp.spriteFrame !== frame) {
      sp.spriteFrame = frame;
    }
  }

  /**
   * Boss 多动作推进：按"本帧是否发生位移"在 `idle` / `walk` 之间切换。
   * 阈值 0.4px/帧 ≈ 24px/s（Boss 移速 70px/s，静止时为 0），足以稳定区分走 / 站。
   */
  /**
   * 播放指定 Boss 动作（由 `BossBehavior` 在**大招预警 / 冲锋蓄力**时调用）。
   * 播完后自动交回 idle / walk 的移动判定（`tickBossAnim` 会检测 `done`）。
   */
  playBossAction(action: string): void {
    const anims = this.bossAnims;
    const anim = anims ? anims[action] : null;
    if (!anim) {
      return;
    }
    anim.reset(false);
    this.anim = anim;
    this.bossAction = action;
    const frame = anim.frame;
    if (frame) {
      const sp = this.ensureSprite();
      if (sp.spriteFrame !== frame) {
        sp.spriteFrame = frame;
      }
    }
  }

  private tickBossAnim(dt: number): void {
    const step = Math.min(dt, MAX_DT_SEC);
    const p = this.node.position;
    const movedPx = Math.hypot(p.x - this.lastPosX, p.y - this.lastPosY);
    this.lastPosX = p.x;
    this.lastPosY = p.y;
    const anims = this.bossAnims;
    if (!anims) {
      return;
    }
    // 攻击动作优先播完（不被打断成 idle / walk）
    if (this.bossAction === 'attack') {
      const f = this.anim ? this.anim.tick(step) : null;
      if (f) {
        const sp = this.ensureSprite();
        if (sp.spriteFrame !== f) {
          sp.spriteFrame = f;
        }
      }
      if (this.anim && this.anim.done) {
        this.bossAction = ''; // 播完 → 交回 idle / walk
      }
      return;
    }
    // 双阈值滞回（进入 walk 需 >0.8px/帧，回落需 <0.2px/帧）：
    // 单阈值时贴墙滑行会让动作在阈值附近反复切换，观感像"抖动 / 打转"
    const want = movedPx > (this.bossAction === 'walk' ? 0.2 : 0.8) ? 'walk' : 'idle';
    if (want !== this.bossAction && anims[want]) {
      this.bossAction = want;
      anims[want].reset(false);
      this.anim = anims[want];
    }
    const frame = this.anim ? this.anim.tick(step) : null;
    if (frame) {
      const sp = this.ensureSprite();
      if (sp.spriteFrame !== frame) {
        sp.spriteFrame = frame;
      }
    }
  }

  /**
   * 变体「突然加速 / 忽快忽慢」逐帧推进（如巨兽种：慢走一阵、猛冲一阵）。
   * 用独立的 `burstBonus` 叠加，不写入 `speedMultiplier`，因此不会与技能的减速/定身状态互相覆盖。
   */
  private tickVariantBurst(dt: number): void {
    if (this.burstIntervalSec <= 0 || this.burstSpeedRatio <= 1) {
      return;
    }
    const step = Math.min(dt, MAX_DT_SEC);
    if (this.burstLeftSec > 0) {
      this.burstLeftSec -= step;
      if (this.burstLeftSec <= 0) {
        this.burstBonus = 0; // 加速结束，恢复常态
      }
      return;
    }
    this.burstWaitSec -= step;
    if (this.burstWaitSec <= 0) {
      this.burstWaitSec = this.burstIntervalSec;
      this.burstLeftSec = this.burstDurationSec;
      this.burstBonus = this.burstSpeedRatio - 1;
    }
  }

  update(dt: number): void {
    if (!this.playerNode) return;
    if (gameState.isPaused()) return; // 升级选卡等待中冻结玩法层
    this.tickBurn(dt); // 灼烧：与追击/冲锋状态无关，先结算
    this.tickVariantBurst(dt); // 变体「突然加速 / 忽快忽慢」：独立的临时速度加成
    this.tickAnim(dt); // 怪物序列帧动画
    // 击退硬直：期间不追击（位移已由 applyKnockback 施加，追击会立刻把它抵消）
    if (this.knockbackLeftSec > 0) {
      this.knockbackLeftSec -= Math.min(dt, MAX_DT_SEC);
      return;
    }
    if (!this.chaseEnabled) return; // Boss 冲锋中：位移交由 BossBehavior 接管
    // 脱困：Boss 冲锋 / 地宫窄缝可能把实体留在不可行走处；起点一旦非法，
    // resolveWalkableMove 会永远返回原地 ⇒ 观感像「Boss 卡在墙边原地打转 / 抖」（用户反馈）
    {
      const cur = this.node.position;
      const fixed = nudgeToWalkable(cur.x, cur.y, this.getHitRadiusPx());
      if (fixed.moved) {
        this.node.setPosition(fixed.x, fixed.y, cur.z);
      }
    }
    const wp = this.node.position;
    const pp = this.playerNode.position;
    const dx = pp.x - wp.x;
    const dy = pp.y - wp.y;
    const d = Math.max(1e-6, Math.hypot(dx, dy));
    // 远程投掷种：保持期望距离 + 周期投掷（不参与贴身追击）
    if (this.ranged) {
      this.tickRanged(dx / d, dy / d, d, dt);
      return;
    }
    if (d > 1) {
      this.setFacingDir(dx); // Boss：朝向跟随水平移动方向（素材只有朝右，朝左时镜像）
      const step = this.speedPx * this.speedMultiplier * (1 + this.burstBonus) * Math.min(dt, MAX_DT_SEC);
      // 可行走区域限制：敌人同样不能穿墙（贴墙滑行）
      const moved = resolveWalkableMove(
        wp.x, wp.y, wp.x + (dx / d) * step, wp.y + (dy / d) * step, this.getHitRadiusPx(),
      );
      this.node.setPosition(moved.x, moved.y, wp.z);
    }
  }

  /**
   * 设置水平朝向（**仅对有动作表的 Boss 生效**）：`dirX < 0` 时水平镜像。
   *
   * 为什么需要：Boss 素材（如红鱿鱼 / 武士）只画了**一个朝向**，
   * 向左冲锋 / 向左攻击时若不镜像，看起来就是"倒着走"（用户反馈过）。
   * 普通怪不做翻转（小图基本左右对称，且翻转会干扰体积判定）。
   *
   * 安全：`getHitRadiusPx()` 已改为取 `|scale.x|`，翻转不会算出负半径。
   */
  setFacingDir(dirX: number): void {
    if (!this.bossAnims || Math.abs(dirX) < 1e-3) {
      return; // 非 Boss，或几乎垂直移动（保持当前朝向，避免抖动）
    }
    const cur = this.node.scale;
    const mag = Math.abs(cur.x) || 1;
    const want = dirX < 0 ? -mag : mag;
    if (cur.x !== want) {
      this.node.setScale(want, cur.y, cur.z);
    }
  }

  /**
   * 远程投掷种（用户口径）：**保持期望距离**并周期性向玩家投掷。
   *  - 距离控制：近于 `keep_distance_px` 后退、远于 `max_range_px` 靠近、中间停住（不贴身）；
   *  - 投掷：冷却到且玩家在射程内 → 发射**慢速**弹（不追踪，走位即可躲）。
   */
  private tickRanged(dirX: number, dirY: number, dist: number, dt: number): void {
    const cfg = this.ranged;
    if (!cfg) {
      return;
    }
    const step = Math.min(dt, MAX_DT_SEC);
    // 1) 投掷
    this.rangedCdSec -= step;
    if (this.rangedCdSec <= 0 && dist <= cfg.maxRangePx) {
      this.rangedCdSec = cfg.cooldownMs / 1000;
      const p = this.node.position;
      const r = this.getHitRadiusPx();
      const damage = damageFormula.enemyDamage(this.atk * cfg.damageRatio);
      fireEnemyBullet(
        p.x + dirX * r, p.y + dirY * r, dirX, dirY,
        cfg.speedPx, cfg.radiusPx, cfg.lifeMs / 1000, damage,
      );
    }
    // 2) 距离控制
    const want = dist < cfg.keepDistancePx ? -1 : (dist > cfg.maxRangePx ? 1 : 0);
    if (want === 0) {
      return;
    }
    const move = this.speedPx * this.speedMultiplier * step * want;
    const p = this.node.position;
    const moved = resolveWalkableMove(
      p.x, p.y, p.x + dirX * move, p.y + dirY * move, this.getHitRadiusPx(),
    );
    this.node.setPosition(moved.x, moved.y, p.z);
  }
}

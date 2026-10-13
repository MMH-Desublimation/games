import { Node } from 'cc';
import { dataManager } from '../data/DataManager';
import { gameState } from '../core/GameState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { MAX_DT_SEC } from '../core/Timer';
import { ticker } from '../core/Ticker';
import { MathUtils } from '../utils/MathUtils';
import { Random } from '../utils/Random';
import { entityManagerRef } from '../entities/EntityManager';
import { Enemy } from '../entities/Enemy';
import { Player, playerRef } from '../entities/Player';
import { damageFormula } from './DamageFormula';
import { BulletSpec, fireBullet } from './Bullet';
import { skillSystem } from './SkillSystem';

/**
 * 技能型 / 环境型行为 Buff 系统（插入项 T12-S3 / 本轮重构）。
 *
 * ## 技能型 Buff（`buffs.json` 的 `type: "skill_behavior"`）
 * 用户裁决：**固定间隔自动释放**、形态按技能各自定、**独立携带槽位**（不占用行为型槽位）。
 * **重复获得同一 Buff 即升级**（等级 = 携带层数），每一级的参数写在数据的 `levels[]` 里。
 *
 * | 技能 | kind | 机制 |
 * |---|---|---|
 * | 剑气斩 | `cs_slash` | 朝最近敌人方向、稍远距离的**矩形 AOE** 挥砍（升级：攻速 / 宽度 / 伤害） |
 * | 旋风斩 | `cs_whirl` | 以自身为中心的**圆形斩击**（升级：攻速 / 半径 / 伤害） |
 * | 狂斩 | `cs_frenzy` | 近身**多段高速**连斩（升级：伤害 / 段数 / 攻速），高风险高收益 |
 * | 爆弹 | `cs_bomb` | 朝最近目标投掷炸弹，命中或射程尽头**爆开 AOE**（升级：攻速 / 伤害 / 范围） |
 * | 喷火 | `cs_flame` | 朝最近目标方向喷出**持续火焰**（多段伤害 + 烧伤）（升级：伤害 / 攻速 / 范围 / 烧伤时长） |
 * | 冰暴 | `cs_ice` | 以自身为中心向外**一圈冰暴**（伤害 + 减速）（升级：伤害 / 攻速 / 减速） |
 * | 水柱 | `cs_water` | 朝最近敌人发出**并列水柱**（伤害 + 对非 Boss 轻微击退）（升级：伤害 / 数量 / 攻速） |
 * | 护盾 | `cs_shield` | 为自身生成限时护盾，按百分比减伤（升级：减伤幅度（≤50%）/ 持续） |
 *
 * **口径（用户明确）**：所有技能型 Buff **不触发命中附加效果**（冰缓 / 灼烧 / 连锁），
 * 避免一次范围技触发连锁扩散而强度失控；喷火的「烧伤」是它自带的机制，不受此限制。
 *
 * ## 环境型行为 Buff
 * 减速光环 `aura_slow`（范围内持续减速）、疾影 `kill_reset_dash`（击杀即结束技能 1 冷却）。
 *
 * 规则（宪法 6.5 / 6.7 / 6.10 / 6.13）：数值全部来自配置；特效一律走 `on_fx` 事件由表现层播放
 * （资源缺失时表现层静默降级，本系统不依赖美术资源）；逐帧逻辑走 Ticker 并随暂停 / 结算冻结。
 */
/**
 * 判定去重口径（用户明确）：**每个技能对每个单位在每次释放中只判定一次**。
 * 特效可以持续播放（几秒），但敌人的受伤判定不会因为"反复被扫到"而重复结算；
 * 因此每次 `castXxx` 都创建一份命中名单传入判定函数。
 */
type HitList = Node[];

/**
 * 水柱推进体（**投射物语义**，用户口径）：
 * 从玩家处沿方向推进到射程尽头，沿途对「本帧扫过的新条带」结算伤害（每敌人每释放一次），
 * 而不是一按就覆盖整片矩形。`x/y` 为当前**波面前缘**位置。
 */
interface WaterWave {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  /** 垂直于推进方向的单位向量（横向并排的水柱沿它展开）。 */
  perpX: number;
  perpY: number;
  traveledPx: number;
  rangePx: number;
  /** 单根水柱的宽度（横向墙总宽 = count × widthPx）。 */
  widthPx: number;
  count: number;
  speedPx: number;
  damageRatio: number;
  knockbackPx: number;
  fx: string;
  /** 距离上一排水柱特效的时间累计（按 `fxWaterStepMs` 节奏补排）。 */
  fxStepAccumSec: number;
  hitList: HitList;
}

/** 狂斩的多段连斩。 */
interface PendingCombo {
  hitsLeft: number;
  timerSec: number;
  intervalSec: number;
  radiusPx: number;
  ratio: number;
  fx: string;
}

/** 技能型 Buff 的运行时参数（等级取自携带层数，参数取自 levels[level-1]）。 */
interface SkillRuntime {
  id: string;
  name: string;
  kind: string;
  fx: string;
  level: number;
  intervalSec: number;
  countdownSec: number;
  damageRatio: number;
  rangePx: number;
  widthPx: number;
  radiusPx: number;
  hits: number;
  hitIntervalSec: number;
  explodeRadiusPx: number;
  radiusScale: number;
  tickSec: number;
  durationSec: number;
  burnDpsRatio: number;
  burnMs: number;
  slowRatio: number;
  slowMs: number;
  count: number;
  knockbackPx: number;
  reduction: number;
  /** 水柱推进速度（px/s；0 = 用全局默认）。 */
  speedPx: number;
}

class BehaviorSkillSystem {
  private skills: SkillRuntime[] = [];
  private readonly combos: PendingCombo[] = [];
  /** 正在推进的水柱（投射物语义）。 */
  private readonly waves: WaterWave[] = [];
  private rng = new Random((Date.now() >>> 0) || 1);
  private auraAccumSec = 0;
  /** 减速光环刷新间隔（秒，来自 balance.buff.aura_refresh_s）。 */
  private auraRefreshSec = 0.4;
  /** 击退后的「无法追击」时长（秒，来自 balance.combat.knockback_lock_ms）。 */
  private knockbackLockSec = 0.22;
  /** 护盾剩余时间（秒）与当前生效的减伤比例。 */
  private shieldRemainingSec = 0;
  /** 携带技能型 Buff 的「id:等级」签名，用于判断是否需要重建运行时。 */
  private signature = '';
  private dirty = true;
  /** 近战类特效的「交叠次数」（balance.skill_fx）：同一技能一次释放播几次特效，提升辨识度。 */
  private fxSlashCount = 7;
  private fxWhirlCount = 3;
  private fxIceCount = 5;
  /** 喷火沿方向分几段火焰；水柱每几毫秒补一排柱（形成推进的水柱墙）。 */
  private fxFlameSegments = 3;
  private fxWaterStepMs = 90;
  /** 水柱推进速度（px/s）。 */
  private waterSpeedPx = 430;
  /** 自愈计时（见 tick）。 */
  private selfCheckAccumSec = 0;

  constructor() {
    eventBus.on(EventNames.on_config_loaded, this.onConfigLoaded, this);
    eventBus.on(EventNames.on_run_start, this.onRunStart, this);
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);
    eventBus.on(EventNames.on_buff_selected, this.onBuffSelected, this);
    // ⚠️ **续玩时必须重建**（用户实测：「记录存档重进后，疾影效果消失（击杀重置技能1冷却）」）。
    //
    // 数据流：`MetaState.currentRun.buffs` → `GameState.restoreRun()` 直接填好 `gameState.buffs`
    // → `BuffSystem.onRunResume()` 重放数值效果。技能型 Buff（`skill_behavior`）**不走系数通道**，
    // 它的生效**完全依赖本类从 `gameState.getBuffs()` 重建**，而本类原先只订阅 `on_buff_selected` ——
    // 一旦重放路径没有触发该事件（或事件早于状态就位），技能型 Buff 就永远不会被装配。
    // 这里直接订阅 `on_run_resume` 并置脏 ⇒ **不依赖上游是否广播**，续玩必定重建一次。
    eventBus.on(EventNames.on_run_resume, this.onRunResume, this);
    eventBus.on(EventNames.on_enemy_died, this.onEnemyDied, this);
    ticker.add(this.tick);
  }

  private onConfigLoaded(): void {
    const buff = dataManager.get<any>('balance', 'buff');
    if (buff && buff.aura_refresh_s > 0) {
      this.auraRefreshSec = buff.aura_refresh_s;
    }
    const combat = dataManager.get<any>('balance', 'combat');
    if (combat && combat.knockback_lock_ms > 0) {
      this.knockbackLockSec = combat.knockback_lock_ms / 1000;
    }
    // 特效交叠次数（表现参数，配置驱动；缺失时用字段默认值）
    const skfx = dataManager.isLoaded('balance')
      ? (dataManager.getTable<any>('balance').skill_fx ?? {}) : {};
    if (skfx.slash_count > 0) this.fxSlashCount = skfx.slash_count;
    if (skfx.whirl_count > 0) this.fxWhirlCount = skfx.whirl_count;
    if (skfx.ice_count > 0) this.fxIceCount = skfx.ice_count;
    if (skfx.flame_segments > 0) this.fxFlameSegments = skfx.flame_segments;
    if (skfx.water_step_ms > 0) this.fxWaterStepMs = skfx.water_step_ms;
    if (skfx.water_speed_px > 0) this.waterSpeedPx = skfx.water_speed_px;
    this.rng = new Random((Date.now() >>> 0) || 1);
  }

  private onRunStart(): void {
    this.resetAll();
    this.syncSkills();
  }

  private onRunEnd(): void {
    this.resetAll();
  }

  /**
   * 携带 Buff 变化。**只有技能型 Buff 的变化才重建运行时**：
   * 属性 / 行为类选卡若也置脏，会把所有技能型 Buff 的倒计时一起重置，
   * 表现为「捡了半天没看到技能、过很久才突然放一次」。
   */
  /**
   * 续玩：存档里的技能型 Buff 已由 `GameState.restoreRun()` 填进 `gameState.buffs`，
   * 这里只需**置脏**，下一帧 `rebuild()` 会按 `carried()` 重新装配（含「疾影」这类技能型效果）。
   */
  private onRunResume(): void {
    this.dirty = true;
    console.log(`[BehaviorSkillSystem] 续玩：按存档重建技能型 Buff（共 ${gameState.getBuffs().length} 条携带）`);
  }

  private onBuffSelected(id?: string): void {
    if (typeof id !== 'string' || !dataManager.isLoaded('buffs')) {
      this.dirty = true;
      return;
    }
    const def = dataManager.getTable<any[]>('buffs').find((b) => b.id === id);
    if (!def || def.type !== 'skill_behavior') {
      return;
    }
    this.dirty = true;
  }

  private resetAll(): void {
    this.skills = [];
    this.combos.length = 0;
    this.waves.length = 0;
    this.auraAccumSec = 0;
    this.shieldRemainingSec = 0;
    this.signature = '';
    this.dirty = true;
    gameState.setShieldRatio(0);
  }

  // —— 携带列表与等级 ——

  /** 携带的技能型 Buff（去重，保留首次携带顺序；出现次数 = 等级）。 */
  private carried(): { id: string; level: number }[] {
    const ids: string[] = [];
    const list: { id: string; level: number }[] = [];
    for (const id of gameState.getBuffs()) {
      if (ids.indexOf(id) >= 0) {
        continue;
      }
      ids.push(id);
      list.push({ id, level: gameState.getBuffLevel(id) });
    }
    const all = dataManager.isLoaded('buffs') ? dataManager.getTable<any[]>('buffs') : [];
    return list.filter((it) => {
      const def = all.find((b) => b.id === it.id);
      return !!def && def.type === 'skill_behavior';
    });
  }

  private syncSkills(): void {
    if (!dataManager.isLoaded('buffs')) {
      return;
    }
    const carried = this.carried();
    const sig = carried.map((c) => `${c.id}:${c.level}`).join('|');
    if (!this.dirty && sig === this.signature) {
      return;
    }
    const changed = sig !== this.signature;
    this.dirty = false;
    this.signature = sig;
    const all = dataManager.getTable<any[]>('buffs');
    const prev = new Map<string, SkillRuntime>();
    for (const s of this.skills) {
      prev.set(s.id, s);
    }
    const next: SkillRuntime[] = [];
    const fresh: string[] = [];
    for (const c of carried) {
      const def = all.find((b) => b.id === c.id);
      if (!def) {
        continue;
      }
      const rt = this.buildRuntime(def, c.level);
      const old = prev.get(c.id);
      if (old && old.level === rt.level) {
        rt.countdownSec = old.countdownSec; // 未变动的技能**保留进度**，避免每次选卡都重新计时
      } else {
        rt.countdownSec = 0; // 新获得 / 升级：**立即释放一次**（用户口径：捡到就要看到效果）
        fresh.push(`${rt.name}Lv${rt.level}`);
      }
      next.push(rt);
    }
    this.skills = next;
    if (changed && this.skills.length > 0) {
      console.log(`[BehaviorSkill] 技能型 Buff：`
        + this.skills.map((s) => `${s.name}Lv${s.level}`).join(' / ')
        + (fresh.length > 0 ? `（立即释放：${fresh.join(' / ')}）` : ''));
    }
  }

  /** 按等级取该级参数（levels[level-1]；越界自动收敛到最高级）。 */
  private buildRuntime(def: any, level: number): SkillRuntime {
    const levels: any[] = Array.isArray(def.levels) ? def.levels : [];
    const idx = Math.max(0, Math.min(levels.length - 1, level - 1));
    const L: any = levels[idx] ?? {};
    const kind = def.effects && def.effects[0] ? def.effects[0].kind : '';
    const intervalSec = (L.interval_ms ?? 0) / 1000;
    return {
      id: def.id,
      name: def.name,
      kind,
      fx: def.fx ?? '',
      level,
      intervalSec,
      countdownSec: intervalSec,
      damageRatio: L.damage_ratio ?? 0,
      rangePx: L.range_px ?? 0,
      widthPx: L.width_px ?? 0,
      radiusPx: L.radius_px ?? 0,
      hits: L.hits ?? 1,
      hitIntervalSec: (L.hit_interval_ms ?? 0) / 1000,
      explodeRadiusPx: L.explode_radius_px ?? 0,
      radiusScale: L.radius_scale ?? 1,
      tickSec: (L.tick_ms ?? 0) / 1000,
      durationSec: (L.duration_ms ?? 0) / 1000,
      burnDpsRatio: L.burn_dps_ratio ?? 0,
      burnMs: L.burn_ms ?? 0,
      slowRatio: L.slow_ratio ?? 0,
      slowMs: L.slow_ms ?? 0,
      count: L.count ?? 1,
      knockbackPx: L.knockback_px ?? 0,
      reduction: L.damage_reduction ?? 0,
      speedPx: L.speed_px ?? 0,
    };
  }

  // —— 逐帧 ——

  private tick = (dt: number): void => {
    if (!gameState.isRunActive() || gameState.isPaused() || !gameState.isAlive()) {
      return; // 暂停 / 结算 / 死亡：整体冻结
    }
    const step = Math.min(dt, MAX_DT_SEC);
    // 自愈：携带上限替换（移除 + 新增，长度可能不变）不会广播任何事件，
    // 因此每 0.5s 强制对齐一次（syncSkills 内部会保留未变化技能的倒计时，不会重置节奏）。
    this.selfCheckAccumSec += step;
    if (this.selfCheckAccumSec >= 0.5) {
      this.selfCheckAccumSec = 0;
      this.dirty = true;
    }
    if (this.dirty) {
      this.syncSkills();
    }
    this.tickWaves(step);
    this.tickCombos(step);
    this.tickShield(step);
    this.tickAura(step);
    for (let i = 0; i < this.skills.length; i++) {
      const s = this.skills[i];
      s.countdownSec -= step;
      if (s.countdownSec <= 0) {
        s.countdownSec = Math.max(0.05, s.intervalSec); // 固定间隔自动释放
        this.castSkill(s);
      }
    }
  };

  /**
   * 水柱推进（投射物语义）：
   * 波面前缘沿方向推进，**沿途逐段结算**（本帧扫过的一小段），命中过的敌人不再结算（每次释放一次）；
   * 同时按固定节奏在前缘补一排竖直水柱特效，形成「从角色处一路推向敌人」的水柱墙。
   */
  private tickWaves(step: number): void {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      const advance = w.speedPx * step;
      this.damageWaveStrip(w, advance); // 先结算「上一位置 → 新位置」这段
      w.x += w.dirX * advance;
      w.y += w.dirY * advance;
      w.traveledPx += advance;
      // 视觉：定时补一排柱（首帧立即播，保证「按下去就有」）
      w.fxStepAccumSec += step;
      if (w.fxStepAccumSec >= this.fxWaterStepMs / 1000) {
        w.fxStepAccumSec = 0;
        this.playWaterWall(w);
      }
      if (w.traveledPx >= w.rangePx) {
        this.waves.splice(i, 1);
      }
    }
  }

  /** 水柱：本帧扫过的一段（前缘 vs 上一位置之间的条带）内的一次性判定。 */
  private damageWaveStrip(w: WaterWave, advancePx: number): void {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    if (enemies.length === 0 || w.damageRatio <= 0) {
      return;
    }
    const halfWall = w.count * w.widthPx * 0.5;
    const damage = this.skillDamage(w.damageRatio);
    for (const e of enemies) {
      if (w.hitList.indexOf(e) >= 0) {
        continue;
      }
      const enemy = e.getComponent(Enemy);
      if (!enemy) {
        continue;
      }
      const rx = e.position.x - w.x;
      const ry = e.position.y - w.y;
      const r = enemy.getHitRadiusPx();
      const along = rx * w.dirX + ry * w.dirY;
      if (along < -r || along > advancePx + r) {
        continue;
      }
      const lateral = Math.abs(rx * w.perpX + ry * w.perpY);
      if (lateral > halfWall + r) {
        continue;
      }
      enemy.takeDamage(damage);
      eventBus.emit(EventNames.on_damage_dealt, e.position.x, e.position.y, damage);
      w.hitList.push(e);
      if (w.knockbackPx > 0 && enemy.getKind() !== 'boss') {
        enemy.applyKnockback(w.dirX, w.dirY, w.knockbackPx, this.knockbackLockSec);
      }
    }
  }

  /** 在前缘画一排**竖直**水柱（角度 0，不随方向旋转），横向并排覆盖 count × widthPx。 */
  private playWaterWall(w: WaterWave): void {
    const sizePx = w.widthPx * 2.2;
    for (let i = 0; i < w.count; i++) {
      const off = (i - (w.count - 1) / 2) * w.widthPx;
      this.playFx(w.fx, w.x + w.perpX * off, w.y + w.perpY * off, 0, false, 0.5, sizePx);
    }
  }

  private tickCombos(step: number): void {
    for (let i = this.combos.length - 1; i >= 0; i--) {
      const c = this.combos[i];
      c.timerSec -= step;
      if (c.timerSec > 0) {
        continue;
      }
      const player = playerRef;
      if (player) {
        const p = player.position;
        // 每段独立判定（段内不重复命中同一敌人）；段间可再次命中，符合「连斩」设计
        this.damageCircle(p.x, p.y, c.radiusPx, c.ratio, this.newHitList());
        // 每段特效时长略长于段间隔，使连续斩击在画面上交叠（用户要求：不要一闪而过）
        // 尺寸按实际近身半径出（radius*2），使动画与命中范围一致
        this.playFx(c.fx, p.x, p.y, this.rng.range(0, 360), true,
          Math.max(0.3, c.intervalSec * 1.8), c.radiusPx * 2);
      }
      c.hitsLeft -= 1;
      c.timerSec = c.intervalSec;
      if (c.hitsLeft <= 0) {
        this.combos.splice(i, 1);
      }
    }
  }

  /** 护盾倒计时（到点清除减伤）。 */
  private tickShield(step: number): void {
    if (this.shieldRemainingSec <= 0) {
      return;
    }
    this.shieldRemainingSec -= step;
    if (this.shieldRemainingSec <= 0) {
      this.shieldRemainingSec = 0;
      gameState.setShieldRatio(0);
      console.log('[BehaviorSkill] 护盾结束');
    }
  }

  // —— 技能释放 ——

  private castSkill(s: SkillRuntime): void {
    const player = playerRef;
    if (!player) {
      return;
    }
    switch (s.kind) {
      case 'cs_slash':
        this.castSlash(s, player);
        break;
      case 'cs_whirl':
        this.castWhirl(s, player);
        break;
      case 'cs_frenzy':
        this.castFrenzy(s, player);
        break;
      case 'cs_bomb':
        this.castBomb(s, player);
        break;
      case 'cs_flame':
        this.castFlame(s, player);
        break;
      case 'cs_ice':
        this.castIce(s, player);
        break;
      case 'cs_water':
        this.castWater(s, player);
        break;
      case 'cs_shield':
        this.castShield(s, player);
        break;
      default:
        break;
    }
  }

  /** 剑气斩：朝（移动 / 面朝）方向的稍远矩形 AOE；矩形内**交叠多次斩击**以提升辨识度。 */
  private castSlash(s: SkillRuntime, player: Node): void {
    const dir = this.aimDir(player);
    const p = player.position;
    // 判定：整条矩形一次结算（每敌人一次，见 HitList 口径）
    this.damageRect(p.x, p.y, dir.x, dir.y, s.rangePx, s.widthPx, s.damageRatio, this.newHitList());
    // 视觉：沿矩形铺开多次弧形斩击（位置 / 角度随机、时长错开），而不是"只闪一格"
    const count = Math.max(1, Math.round(this.fxSlashCount));
    const baseAngle = this.angleDeg(dir);
    // 尺寸按矩形宽度出（刀弧铺满走廊宽度），与判定宽度一致
    const sizePx = Math.max(s.widthPx * 1.3, 70);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const side = (this.rng.next() - 0.5) * s.widthPx * 0.8;
      const x = p.x + dir.x * s.rangePx * t - dir.y * side;
      const y = p.y + dir.y * s.rangePx * t + dir.x * side;
      const ang = baseAngle + (this.rng.next() - 0.5) * 70;
      this.playFx(s.fx, x, y, ang, false, 0.5 + this.rng.next() * 0.35, sizePx);
    }
  }

  /** 旋风斩：以自身为中心的圆形斩击；多圈交叠 + 随机起始角度。 */
  private castWhirl(s: SkillRuntime, player: Node): void {
    const p = player.position;
    const hits = this.damageCircle(p.x, p.y, s.radiusPx, s.damageRatio, this.newHitList());
    const count = Math.max(1, Math.round(this.fxWhirlCount));
    // 尺寸按圆形作用直径出（+ 逐圈轻微放大，形成层次），与判定半径一致
    for (let i = 0; i < count; i++) {
      this.playFx(s.fx, p.x, p.y, this.rng.range(0, 360), true,
        0.45 + i * 0.12, s.radiusPx * 2 * (0.9 + i * 0.06));
    }
    if (hits > 0) {
      console.log(`[BehaviorSkill] 旋风斩 Lv${s.level} 命中 ${hits}`);
    }
  }

  /** 狂斩：近身多段高速连斩（每段独立结算，段数 / 间隔 / 半径均来自配置）。 */
  private castFrenzy(s: SkillRuntime, _player: Node): void {
    this.combos.push({
      hitsLeft: Math.max(1, Math.round(s.hits)),
      timerSec: 0,
      intervalSec: Math.max(0.01, s.hitIntervalSec),
      radiusPx: s.rangePx,
      ratio: s.damageRatio,
      fx: s.fx,
    });
    console.log(`[BehaviorSkill] 狂斩 Lv${s.level}：${Math.round(s.hits)} 段 × ${s.damageRatio}`);
  }

  /** 爆弹：朝方向投掷炸弹（命中或射程尽头爆开）；射程 / 爆开尺寸均按配置，属远程技能。 */
  private castBomb(s: SkillRuntime, player: Node): void {
    const dir = this.aimDir(player);
    const p = player.position;
    const speed = dataManager.get<any>('balance', 'combat').bullet_speed_px_per_sec;
    const spec: BulletSpec = {
      damage: this.skillDamage(s.damageRatio),
      lifestealRatio: gameState.getStats().lifestealRatio,
      pierceCount: 0,
      explodeRadiusPx: s.explodeRadiusPx,
      explodeDamageRatio: 1,
      radiusScale: s.radiusScale,
      explodeOnExpire: true,
      fxOnHit: s.fx,
      // 爆炸特效直径 = 实际爆开直径（动画与作用范围一致）
      fxTargetPx: s.explodeRadiusPx * 2,
      // 飞行射程由配置给出：lifeMs = 射程 / 弹速（0 = 用子弹默认寿命）
      lifeMs: s.rangePx > 0 && speed > 0 ? (s.rangePx / speed) * 1000 : 0,
    };
    fireBullet(p.x, p.y, dir.x, dir.y, spec);
  }

  /**
   * 喷火：朝方向喷出持续火焰。
   * 判定：范围内**一次伤害**（每敌人一次）+ 烧伤；视觉：沿方向分多段火焰并持续播放到技能结束，
   * 使"喷火"看起来是一条持续的火舌（用户要求：远程类要反复播放而非一瞬间）。
   */
  private castFlame(s: SkillRuntime, player: Node): void {
    const dir = this.aimDir(player);
    const p = player.position;
    const hitNodes = this.newHitList();
    this.damageRect(p.x, p.y, dir.x, dir.y, s.rangePx, s.widthPx, s.damageRatio, hitNodes);
    if (s.burnDpsRatio > 0 && s.burnMs > 0) {
      const burnDps = gameState.getStats().atk * s.burnDpsRatio;
      for (const n of hitNodes) {
        n.getComponent(Enemy)?.applyBurn(burnDps, s.burnMs / 1000);
      }
    }
    const segs = Math.max(1, Math.round(this.fxFlameSegments));
    const total = Math.max(0.4, s.durationSec);
    const angle = this.angleDeg(dir);
    // 每段火焰尺寸 = 该段的长度与宽度里的较大者（动画覆盖范围与判定一致）
    const sizePx = Math.max(s.widthPx, s.rangePx / segs) * 1.15;
    for (let i = 0; i < segs; i++) {
      // 越远的段出现越晚（t 偏移），形成「火舌逐段喷出」
      const t = (i + 0.5) / segs;
      const x = p.x + dir.x * s.rangePx * t;
      const y = p.y + dir.y * s.rangePx * t;
      this.playFx(s.fx, x, y, angle, false, Math.max(0.35, total - i * 0.12), sizePx);
    }
  }

  /** 冰暴：以自身为中心向外一圈冰暴（一次伤害 + 减速）；视觉上在圆周方向交叠多枚冰暴。 */
  private castIce(s: SkillRuntime, player: Node): void {
    const p = player.position;
    const hitNodes = this.newHitList();
    const hits = this.damageCircle(p.x, p.y, s.radiusPx, s.damageRatio, hitNodes);
    for (const n of hitNodes) {
      n.getComponent(Enemy)?.applyStatus(Math.max(0, 1 - s.slowRatio), s.slowMs / 1000);
    }
    const count = Math.max(1, Math.round(this.fxIceCount));
    // 每枚冰暴尺寸 = 0.8 × 半径；摆放半径 0.3~0.7 × 半径，使整体外沿 ≈ 作用半径（动画与范围一致）
    const sizePx = s.radiusPx * 0.8;
    for (let i = 0; i < count; i++) {
      const ang = (360 / count) * i + this.rng.range(-15, 15);
      const rad = s.radiusPx * (0.3 + this.rng.next() * 0.4);
      const x = p.x + Math.cos((ang * Math.PI) / 180) * rad;
      const y = p.y + Math.sin((ang * Math.PI) / 180) * rad;
      this.playFx(s.fx, x, y, ang, false, 0.6 + this.rng.next() * 0.4, sizePx);
    }
    if (hits > 0) {
      console.log(`[BehaviorSkill] 冰暴 Lv${s.level} 命中 ${hits}（减速 ${Math.round(s.slowRatio * 100)}%）`);
    }
  }

  /**
   * 水柱：**投射物语义**（用户口径）——从玩家处发出，沿方向推进到射程尽头，
   * 沿途碰到敌人逐个结算（每敌人每释放一次），而不是一按就覆盖整片矩形。
   *
   * 形态：`count` 根**竖直**水柱（角度固定 0，不随方向旋转）在波面前缘**横向并排**，
   * 随波面前推进，形成「一排竖直水柱从角色出发推向敌人」的观感。
   */
  private castWater(s: SkillRuntime, player: Node): void {
    const dir = this.aimDir(player);
    const p = player.position;
    const count = Math.max(1, Math.round(s.count));
    this.waves.push({
      x: p.x, y: p.y,
      dirX: dir.x, dirY: dir.y,
      perpX: -dir.y, perpY: dir.x,
      traveledPx: 0,
      rangePx: Math.max(1, s.rangePx),
      widthPx: s.widthPx,
      count,
      speedPx: s.speedPx > 0 ? s.speedPx : this.waterSpeedPx,
      damageRatio: s.damageRatio,
      knockbackPx: s.knockbackPx,
      fx: s.fx,
      fxStepAccumSec: 999, // 首帧立即播一排（按下去就有反馈）
      hitList: this.newHitList(),
    });
    console.log(`[BehaviorSkill] 水柱 Lv${s.level}：${count} 根 · 射程 ${s.rangePx.toFixed(0)}px`
      + ` · 速度 ${Math.round(s.speedPx > 0 ? s.speedPx : this.waterSpeedPx)}px/s`);
  }

  /** 护盾：为自身生成限时减伤护盾。 */
  private castShield(s: SkillRuntime, player: Node): void {
    gameState.setShieldRatio(s.reduction);
    this.shieldRemainingSec = s.durationSec;
    const p = player.position;
    // 护盾特效跟随自身，并持续整个护盾时长（便于看清"护盾还在"）；尺寸按角色体型大小
    this.playFx(s.fx, p.x, p.y, 0, true, Math.max(0.8, s.durationSec), 96);
    console.log(`[BehaviorSkill] 护盾 Lv${s.level}：减伤 ${Math.round(s.reduction * 100)}%，`
      + `持续 ${s.durationSec.toFixed(1)}s`);
  }

  // —— 环境型行为 Buff ——

  private tickAura(step: number): void {
    const ratio = gameState.getBuffBonus('aura_slow');
    const rangePx = gameState.getBuffBonus('aura_slow.range_px');
    if (ratio <= 0 || rangePx <= 0) {
      return;
    }
    this.auraAccumSec += step;
    if (this.auraAccumSec < this.auraRefreshSec) {
      return;
    }
    this.auraAccumSec = 0;
    const player = playerRef;
    if (!player) {
      return;
    }
    const p = player.position;
    const rSq = rangePx * rangePx;
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    for (const e of enemies) {
      const enemy = e.getComponent(Enemy);
      if (!enemy || MathUtils.distSq(p.x, p.y, e.position.x, e.position.y) > rSq) {
        continue;
      }
      enemy.applyStatus(Math.max(0, 1 - ratio), this.auraRefreshSec * 2);
    }
  }

  // —— 只读快照（供 HUD 显示，表现层按帧节流读取；与 Minimap 同模式）——

  /** 技能型 Buff 的等级与「下一发剩余秒数」。 */
  getStatus(): { name: string; level: number; remainSec: number }[] {
    const out: { name: string; level: number; remainSec: number }[] = [];
    for (let i = 0; i < this.skills.length; i++) {
      const s = this.skills[i];
      out.push({ name: s.name, level: s.level, remainSec: Math.max(0, s.countdownSec) });
    }
    return out;
  }

  /** 护盾剩余秒数（0 = 无护盾）。 */
  getShieldRemainSec(): number {
    return this.shieldRemainingSec;
  }

  private onEnemyDied(): void {
    if (gameState.getBuffBonus('kill_reset_dash') <= 0) {
      return;
    }
    if (skillSystem.resetCooldown(1)) {
      console.log('[BehaviorSkill] 疾影：技能 1 冷却已重置');
    }
  }

  // —— 范围判定 / 工具 ——

  /** 一次释放的命中名单（同时作为去重集合与结果集合）。 */
  private newHitList(): HitList {
    return [];
  }

  /**
   * 圆形范围伤害。
   * @param hitList 本次释放的命中名单：已在名单中的敌人不再结算（每次释放每单位只判定一次）
   */
  private damageCircle(
    xPx: number, yPx: number, radiusPx: number, ratio: number, hitList: HitList,
  ): number {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    if (enemies.length === 0 || ratio <= 0) {
      return 0;
    }
    const damage = this.skillDamage(ratio);
    const rSq = radiusPx * radiusPx;
    let hits = 0;
    for (const e of enemies) {
      if (hitList.indexOf(e) >= 0) {
        continue;
      }
      const enemy = e.getComponent(Enemy);
      if (!enemy || MathUtils.distSq(xPx, yPx, e.position.x, e.position.y) > rSq) {
        continue;
      }
      enemy.takeDamage(damage);
      eventBus.emit(EventNames.on_damage_dealt, e.position.x, e.position.y, damage);
      hitList.push(e);
      hits++;
    }
    return hits;
  }

  /**
   * 矩形范围伤害（沿方向长 len、宽 width，用「投影 + 垂距」判定，避免坐标旋转）。
   * @param hitList 本次释放的命中名单（去重）
   * @param knockbackPx > 0 且目标非 Boss 时，朝方向轻微击退
   */
  private damageRect(
    xPx: number, yPx: number, dirX: number, dirY: number, lenPx: number, widthPx: number,
    ratio: number, hitList: HitList, knockbackPx = 0,
  ): number {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    if (enemies.length === 0 || ratio <= 0) {
      return 0;
    }
    const damage = this.skillDamage(ratio);
    const halfW = widthPx * 0.5;
    let hits = 0;
    for (const e of enemies) {
      if (hitList.indexOf(e) >= 0) {
        continue;
      }
      const enemy = e.getComponent(Enemy);
      if (!enemy) {
        continue;
      }
      const dx = e.position.x - xPx;
      const dy = e.position.y - yPx;
      const along = dx * dirX + dy * dirY;
      const r = enemy.getHitRadiusPx();
      if (along < -r || along > lenPx + r) {
        continue;
      }
      const perp = Math.abs(-dx * dirY + dy * dirX);
      if (perp > halfW + r) {
        continue;
      }
      enemy.takeDamage(damage);
      eventBus.emit(EventNames.on_damage_dealt, e.position.x, e.position.y, damage);
      hitList.push(e);
      hits++;
      if (knockbackPx > 0 && enemy.getKind() !== 'boss') {
        enemy.applyKnockback(dirX, dirY, knockbackPx, this.knockbackLockSec);
      }
    }
    return hits;
  }

  /** 朝最近敌人（无可选目标时用面朝方向）。 */
  private aimDir(player: Node): { x: number; y: number } {
    const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
    const p = player.position;
    let target: Node | null = null;
    let bestSq = Infinity;
    for (const e of enemies) {
      const sq = MathUtils.distSq(p.x, p.y, e.position.x, e.position.y);
      if (sq < bestSq) {
        bestSq = sq;
        target = e;
      }
    }
    let dx = 0;
    let dy = 0;
    if (target) {
      dx = target.position.x - p.x;
      dy = target.position.y - p.y;
    }
    if (dx === 0 && dy === 0) {
      const facing = player.getComponent(Player)?.getFacingDir();
      dx = facing ? facing.x : 1;
      dy = facing ? facing.y : 0;
      if (dx === 0 && dy === 0) {
        dx = 1;
      }
    }
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  private angleDeg(dir: { x: number; y: number }): number {
    return (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  }

  /**
   * 播放特效（资源缺失由表现层降级；本系统不依赖美术资源）。
   * @param totalSec 可选：覆盖在场时长（远程 / 持续类技能据此"反复播放直到结束"）
   * @param targetPx 可选：**特效目标世界尺寸**（最长边，px）。
   *   表现层据此自动推算缩放（`targetPx / 帧最长边`），
   *   从而让「动画看起来多大」与「实际作用范围」一致 —— 修正此前动画尺寸与实际命中范围不符的问题。
   */
  private playFx(
    key: string, xPx: number, yPx: number, angleDeg: number, follow: boolean,
    totalSec?: number, targetPx?: number,
  ): void {
    if (!key) {
      return;
    }
    eventBus.emit(EventNames.on_fx, key, xPx, yPx, angleDeg, follow, totalSec, targetPx);
  }

  private skillDamage(ratio: number): number {
    return damageFormula.playerDamage(gameState.getStats(), gameState.getClassId(), this.rng, ratio);
  }
}

export const behaviorSkillSystem = new BehaviorSkillSystem();

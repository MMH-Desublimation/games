import { dataManager } from '../data/DataManager';
import { Random } from '../utils/Random';

/**
 * 敌人变体（entities 纯规则层，T14-S2「怪物种类与威胁度递增」）。
 *
 * 目的（文档 2.4 / 用户口径）：随层数逐步解锁**不同威胁度的敌人种类**，提升刷怪的变化与爽感。
 * 本模块只负责"按层取可用变体 + 加权随机"，**不含任何游戏数值**（全部读 `enemy_variants.json`，宪法 6.7），
 * 具体数值修正与行为由 `entities/Enemy` 消费。
 *
 * 变体仍是普通怪（`kind = normal`）：掉落、击杀统计、击杀回血等既有逻辑不受影响，
 * 差异体现在「数值倍率 / 颜色与透明度 / 特殊行为（如周期性突然加速）」。
 */
export interface EnemyVariant {
  id: string;
  name: string;
  /** 使用的怪物动作表 id（`actors.json` 的 monsters 键；空 = 用默认素材）。 */
  sheet: string;
  /** 解锁层数（含）：低于该层的关卡不会出现。 */
  minLayer: number;
  /** 抽取权重（与 `base_weight` 一同参与加权；落在基准区间即"普通怪"）。 */
  weight: number;
  hpRatio: number;
  atkRatio: number;
  speedRatio: number;
  renderRatio: number;
  /** 常态色（RGB 0~255）；null = 用种类默认色。 */
  color: [number, number, number] | null;
  /** 不透明度 0~255。 */
  alpha: number;
  /** 周期性「突然加速」：速度倍率 / 持续毫秒 / 间隔毫秒；<= 1 表示无此行为。 */
  burstSpeedRatio: number;
  burstMs: number;
  burstIntervalMs: number;
  /**
   * 远程投掷参数（远程种专属；null = 近战/贴身型）。
   * 行为：**保持期望距离**（太近后退、太远靠近）并按冷却向玩家投掷慢速弹（可走位躲避）。
   */
  ranged: RangedSpec | null;
}

/** 远程投掷参数（`enemy_variants.json` 的 `ranged` 段）。 */
export interface RangedSpec {
  cooldownMs: number;
  speedPx: number;
  radiusPx: number;
  lifeMs: number;
  /** 投掷伤害倍率（× 该怪 ATK）。 */
  damageRatio: number;
  /** 期望保持的距离：近于此则后退。 */
  keepDistancePx: number;
  /** 最大开火 / 追击距离：远于此则靠近。 */
  maxRangePx: number;
}

class EnemyVariants {
  private table(): any {
    return dataManager.isLoaded('enemy_variants') ? dataManager.getTable<any>('enemy_variants') : null;
  }

  private parse(raw: any): EnemyVariant | null {
    if (!raw || !raw.id) {
      return null;
    }
    const color = Array.isArray(raw.color) && raw.color.length >= 3
      ? [raw.color[0], raw.color[1], raw.color[2]] as [number, number, number]
      : null;
    return {
      id: String(raw.id),
      name: String(raw.name ?? raw.id),
      sheet: typeof raw.sheet === 'string' ? raw.sheet : '',
      minLayer: Math.max(1, Math.floor(raw.min_layer ?? 1)),
      weight: raw.weight > 0 ? raw.weight : 1,
      hpRatio: raw.hp_ratio > 0 ? raw.hp_ratio : 1,
      atkRatio: raw.atk_ratio > 0 ? raw.atk_ratio : 1,
      speedRatio: raw.speed_ratio > 0 ? raw.speed_ratio : 1,
      renderRatio: raw.render_ratio > 0 ? raw.render_ratio : 1,
      color,
      alpha: typeof raw.alpha === 'number' ? Math.max(0, Math.min(255, Math.round(raw.alpha))) : 255,
      burstSpeedRatio: raw.burst_speed_ratio > 1 ? raw.burst_speed_ratio : 0,
      burstMs: raw.burst_ms > 0 ? raw.burst_ms : 0,
      burstIntervalMs: raw.burst_interval_ms > 0 ? raw.burst_interval_ms : 0,
      ranged: raw.ranged && raw.ranged.cooldown_ms > 0
        ? {
          cooldownMs: raw.ranged.cooldown_ms,
          speedPx: raw.ranged.speed_px > 0 ? raw.ranged.speed_px : 250,
          radiusPx: raw.ranged.radius_px > 0 ? raw.ranged.radius_px : 10,
          lifeMs: raw.ranged.life_ms > 0 ? raw.ranged.life_ms : 2600,
          damageRatio: raw.ranged.damage_ratio > 0 ? raw.ranged.damage_ratio : 1,
          keepDistancePx: raw.ranged.keep_distance_px > 0 ? raw.ranged.keep_distance_px : 220,
          maxRangePx: raw.ranged.max_range_px > 0 ? raw.ranged.max_range_px : 480,
        }
        : null,
    };
  }

  /** 某层已解锁的变体（供日志核对与调试）。 */
  unlocked(layer: number): EnemyVariant[] {
    const t = this.table();
    if (!t || !Array.isArray(t.variants)) {
      return [];
    }
    return t.variants
      .map((raw: any) => this.parse(raw))
      .filter((v: EnemyVariant | null): v is EnemyVariant => !!v && layer >= v.minLayer);
  }

  /** 默认怪物素材 id（`enemy_variants.default_sheet`；无变体时使用）。 */
  defaultSheet(): string {
    const t = this.table();
    return t && typeof t.default_sheet === 'string' ? t.default_sheet : '';
  }

  /** 按 id 取变体（池复用 / 续玩恢复时用）。 */
  byId(id: string): EnemyVariant | null {
    const t = this.table();
    if (!t || !Array.isArray(t.variants)) {
      return null;
    }
    for (const raw of t.variants) {
      const v = this.parse(raw);
      if (v && v.id === id) {
        return v;
      }
    }
    return null;
  }

  /**
   * 生成时按层抽取变体：`base_weight` 与各已解锁变体的权重一同参与加权随机，
   * 落在基准区间 → 返回 null（普通怪）。层数越高，解锁的种类越多（威胁度递增）。
   */
  pick(layer: number, rng: Random): EnemyVariant | null {
    const t = this.table();
    if (!t) {
      return null;
    }
    const base = t.base_weight > 0 ? t.base_weight : 1;
    const usable = this.unlocked(layer);
    if (usable.length === 0) {
      return null;
    }
    let total = base;
    for (const v of usable) {
      total += v.weight;
    }
    let r = rng.next() * total;
    for (const v of usable) {
      r -= v.weight;
      if (r <= 0) {
        return v;
      }
    }
    return null;
  }
}

export const enemyVariants = new EnemyVariants();

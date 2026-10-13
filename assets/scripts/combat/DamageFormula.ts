import { dataManager } from '../data/DataManager';
import { Random } from '../utils/Random';
import { gameState, PlayerStats } from '../core/GameState';
import { MathUtils } from '../utils/MathUtils';

/**
 * 伤害公式（纯函数，无引擎依赖）。规则见文档 3.4。
 *
 * 最终伤害 = stats.atk × 职业系数 × 技能倍率 × 暴击系数
 * 其中「基础攻击 + 加成型」「百分比加成」已在 GameState.recompute 中结算进 stats.atk，
 * 本类只负责：按攻击类型取职业系数、暴击判定、总倍率上限（max_total_dmg_multiplier × 基础攻击）。
 */
class DamageFormula {
  /** 玩家单次伤害（普攻 multiplier=1；技能传技能倍率）。 */
  playerDamage(stats: Readonly<PlayerStats>, classId: string, rng: Random, multiplier = 1): number {
    const c = dataManager.get<any>('characters', classId);
    const classCoeff = c.attack_type === 'ranged' ? c.ranged_coeff : c.melee_coeff;
    const crit = rng.next() < stats.critRate;
    const critMult = crit ? stats.critDmg : 1;
    // 伤害增幅 = 局外养成的流派增幅 + 技能临时增幅（如猎手专注的 damage_up）
    const amp = 1 + gameState.getBonus(c.amp_kind ?? '') + gameState.getBonus('damage_up');
    const raw = stats.atk * classCoeff * multiplier * critMult * amp;
    // 总伤上限：balance.damage.max_total_dmg_multiplier × 角色基础攻击（防止无限叠倍率破坏平衡）
    const cap = c.base_atk * dataManager.get<any>('balance', 'damage').max_total_dmg_multiplier;
    return Math.floor(MathUtils.clamp(raw, 0, cap));
  }

  /** 敌人伤害（取整）。 */
  enemyDamage(enemyAtk: number): number {
    return Math.floor(enemyAtk);
  }
}

export const damageFormula = new DamageFormula();

import { Node } from 'cc';
import { gameState } from '../core/GameState';
import { eventBus } from '../core/EventBus';
import { EventNames } from '../core/EventNames';
import { MathUtils } from '../utils/MathUtils';
import { Random } from '../utils/Random';
import { entityManagerRef } from '../entities/EntityManager';
import { Enemy } from '../entities/Enemy';

/**
 * 命中附加效果（combat）：把行为型 Buff 的「冰缓 / 灼烧 / 连锁」挂到**所有命中出口**上
 * （远程子弹命中、近战挥砍命中共用同一实现，保证两种攻击类型表现一致）。
 *
 * 数值全部取自局内 Buff 系数通道（`getBuffBonus`），本文件不持有任何游戏数值（宪法 6.7）。
 * 效果清单（buffs.json 的 behavior 类）：
 *  - `freeze_on_hit`：按 `chance` 概率冻结（`duration_ms` 后自动恢复）；
 *  - `burn`：按玩家攻击力的 `ratio` 施加持续伤害（`duration_ms`）；
 *  - `chain`：向范围内最近的其他敌人追加一次 `ratio` 衰减伤害。
 */
export function applyOnHitEffects(
  enemy: Enemy, node: Node, xPx: number, yPx: number, baseDamage: number, rng: Random,
): void {
  // 冰缓：概率冻结（speedScale 0 = 定身，applyStatus 到期自动恢复）
  const freezeChance = gameState.getBuffBonus('freeze_on_hit.chance');
  const freezeMs = gameState.getBuffBonus('freeze_on_hit.duration_ms');
  if (freezeChance > 0 && freezeMs > 0 && rng.chance(freezeChance)) {
    enemy.applyStatus(0, freezeMs / 1000);
  }

  // 灼烧：按玩家攻击力比例持续掉血（同一次命中只刷新，不叠乘）
  // 注意：灼烧的倍率字段是数据里的 `dps_ratio`（登记为 `burn.dps_ratio`），不是裸 kind
  const burnDpsRatio = gameState.getBuffBonus('burn.dps_ratio');
  const burnMs = gameState.getBuffBonus('burn.duration_ms');
  if (burnDpsRatio > 0 && burnMs > 0) {
    enemy.applyBurn(gameState.getStats().atk * burnDpsRatio, burnMs / 1000);
  }

  // 连锁：向最近的另一个敌人追加一次衰减伤害（不递归连锁，避免一次命中打穿全屏）
  if (gameState.getBuffBonus('chain') <= 0) {
    return;
  }
  const chainRatio = gameState.getBuffBonus('chain.ratio');
  const chainRangePx = gameState.getBuffBonus('chain.range_px');
  if (chainRatio <= 0 || chainRangePx <= 0) {
    return;
  }
  const target = findChainTarget(node, xPx, yPx, chainRangePx);
  if (!target) {
    return;
  }
  const dmg = Math.max(1, Math.floor(baseDamage * chainRatio));
  target.enemy.takeDamage(dmg);
  eventBus.emit(EventNames.on_damage_dealt, target.node.position.x, target.node.position.y, dmg);
}

/** 连锁目标：距命中点最近、且在连锁范围内、且不是被命中者自身。 */
function findChainTarget(
  source: Node, xPx: number, yPx: number, rangePx: number,
): { node: Node; enemy: Enemy } | null {
  const enemies = entityManagerRef ? entityManagerRef.getEnemies() : [];
  let bestNode: Node | null = null;
  let bestEnemy: Enemy | null = null;
  let bestSq = rangePx * rangePx;
  for (const e of enemies) {
    if (e === source) {
      continue;
    }
    const enemy = e.getComponent(Enemy);
    if (!enemy) {
      continue;
    }
    const sq = MathUtils.distSq(xPx, yPx, e.position.x, e.position.y);
    if (sq <= bestSq) {
      bestSq = sq;
      bestNode = e;
      bestEnemy = enemy;
    }
  }
  return bestNode && bestEnemy ? { node: bestNode, enemy: bestEnemy } : null;
}

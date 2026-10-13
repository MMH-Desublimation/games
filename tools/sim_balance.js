/**
 * 数值模拟脚本（tools，配合文档 3.11「防止数值失控」）。
 *
 * 目的：估算「玩家输出成长」与「敌方 HP 成长」的对比，回答两个问题：
 *   1) 本体（默认 25 层）在当前曲线下会在第几层卡死？
 *   2) 换成「轮次制」敌方曲线、或提高百分比上限 / 局外养成后，能否 25 层不卡死？
 *
 * 用法：
 *   node tools/sim_balance.js                       # 现状 + 满级局外 + 理想选卡
 *   node tools/sim_balance.js --layer=1.07 --round=1.4 --rounds=5   # 轮次制曲线
 *   node tools/sim_balance.js --cap=7               # 百分比上限改为 700%
 *   node tools/sim_balance.js --meta=0 --strategy=random            # 零局外 + 随机选卡
 *
 * 参数（全部可选）：
 *   --layers=25      本体层数
 *   --layer=1.30     层内 HP 成长（现状取 enemies.layer_growth.hp_factor）
 *   --round=1        轮次跳升倍率（1 = 关闭轮次制）
 *   --rounds=5       轮数（层数 ÷ 轮数 = 每轮层数）
 *   --cap=3          百分比加成上限（balance.damage.percent_buff_cap）
 *   --stack=3        单个属性 Buff 的叠加上限（balance.buff.stat_stack_max）
 *   --meta=1         局外养成比例（0 = 新档，1 = 满级）
 *   --strategy=greedy|random   选卡策略（greedy = 优先攻击向，代表上界）
 *   --skill=1.6      技能输出折算系数（普攻 DPS × 该系数 ≈ 总输出）
 *   --kills=<倍率>   每层击杀数倍率（默认 1）
 *
 * 判据（卡死）：
 *   普通怪击杀耗时 > 1.5s，或 Boss 击杀耗时 > 60s（可调 --tkill / --tboss）。
 * 退出码：0 = 全程不卡死；1 = 存在卡死层（便于 CI/人工核对）。
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'assets', 'resources', 'config');
const load = (n) => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, n + '.json'), 'utf8'));

function argOf(name, dft) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dft;
}
function strArg(name, dft) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dft;
}

const balance = load('balance');
const characters = load('characters');
const enemies = load('enemies');
const meta = load('meta');
const expCurve = load('exp_curve');
const buffs = load('buffs');
const dungeon = load('dungeon');
const endgame = load('endgame');

const baseMode = endgame.modes.base;
const LAYERS = argOf('layers', baseMode.max_layers);
// 默认直接采用本体配置的轮次制参数（`--layer` / `--round` 可覆盖做假设对比）
const LAYER_FACTOR = argOf('layer', baseMode.hp_factor_per_layer ?? enemies.layer_growth.hp_factor);
const ROUND_FACTOR = argOf('round', baseMode.hp_factor_per_round ?? 1);
const ROUNDS = Math.max(1, argOf('rounds', Math.round(baseMode.max_layers / (baseMode.round_layers || 5))));
// 未启用轮次制（round = 1）时，整局视为一轮，层内每层都成长（即现状曲线）
const LAYERS_PER_ROUND = ROUND_FACTOR > 1
  ? Math.max(1, Math.round(LAYERS / ROUNDS))
  : LAYERS;
const CAP = argOf('cap', balance.damage.percent_buff_cap);
const STACK = Math.max(1, argOf('stack', balance.buff.stat_stack_max));
const META_RATIO = Math.min(1, Math.max(0, argOf('meta', 1)));
const STRATEGY = strArg('strategy', 'greedy');
// 技能 / 技能型 Buff 的输出折算（技能型数值强化后估计为 2.6；可用 --skill 覆盖做敏感性分析）
const SKILL_SHARE = argOf('skill', 2.6);
const KILLS_SCALE = argOf('kills', 1);
// 单次伤害硬上限（balance.damage.max_total_dmg_multiplier，基数为角色基础攻击）
const DMG_CAP_MULT = argOf('dmgcap', balance.damage.max_total_dmg_multiplier);
const TKILL = argOf('tkill', 1.5);
const TBOSS = argOf('tboss', 60);
const CLASS = strArg('class', 'warrior');

const cls = characters[CLASS];
const melee = cls.attack_type !== 'ranged';

/** 局外养成（按 meta.json 的 per_level × max_level × 比例）。 */
function metaBonus(kind, unit) {
  let total = 0;
  for (const it of meta) {
    if (it.enabled === false || !it.effect || it.effect.kind !== kind) continue;
    const lv = Math.round((it.max_level || 0) * META_RATIO);
    total += (it.effect.per_level || 0) * lv;
  }
  return total;
}

/** 敌方普通怪 HP（含轮次制）。 */
function enemyHp(layer) {
  const roundIdx = Math.floor((layer - 1) / LAYERS_PER_ROUND);
  const inRound = (layer - 1) % LAYERS_PER_ROUND;
  return enemies.normal.base_hp * Math.pow(ROUND_FACTOR, roundIdx) * Math.pow(LAYER_FACTOR, inRound);
}

/** 敌人经验（exp_curve：enemy_base_exp × layer_exp_factor^(layer-1)）。 */
function enemyExp(layer) {
  return Math.floor(expCurve.enemy_base_exp * Math.pow(expCurve.layer_exp_factor, layer - 1));
}

/** 每层击杀数估算（dungeon 配置：每房数量随层增长，按房间数与覆盖率折算）。 */
function killsPerLayer(layer) {
  const rooms = (dungeon.rooms.min + dungeon.rooms.max) / 2;
  const perRoom = dungeon.spawn.normal_per_room + dungeon.spawn.enemy_count_growth * (layer - 1);
  const concurrent = Math.min(dungeon.spawn.max_concurrent, perRoom * rooms * 0.35);
  return Math.round(concurrent * KILLS_SCALE);
}

const ATK_BUFFS = ['atk_up_2', 'atk_up_1', 'crit_dmg_up', 'atk_speed_up', 'crit_rate_up'];
/** 技能 / 行为类（间接提升输出：技能伤害、冷却、以及周期性技能型 Buff）。 */
const SKILL_BUFFS = buffs
  .filter((b) => (b.type === 'skill' || b.type === 'skill_behavior') && b.id !== 's1_duration_up')
  .map((b) => b.id);
const statPool = buffs.filter((b) => b.type === 'stat' && b.effects && b.effects[0]
  && ['atk_up', 'atk_speed_up', 'crit_rate_up', 'crit_dmg_up', 'max_hp_up'].includes(b.effects[0].kind));

/** 统计：技能类选卡次数（用于折算持续成长）。 */
let skillPicks = 0;

/** 选卡：greedy 优先攻击向 → 其次技能向；random 按权重随机。 */
function pick(stacks) {
  if (STRATEGY === 'greedy') {
    for (const id of ATK_BUFFS) {
      const cur = stacks.get(id) || 0;
      if (cur < STACK) {
        stacks.set(id, cur + 1);
        return;
      }
    }
    for (const id of SKILL_BUFFS) {
      const b = buffs.find((x) => x.id === id);
      if (!b) continue;
      const maxLv = Array.isArray(b.levels) ? b.levels.length : STACK;
      const cur = stacks.get(id) || 0;
      if (cur < maxLv) {
        stacks.set(id, cur + 1);
        skillPicks += 1;
        return;
      }
    }
  }
  const pool = statPool.filter((b) => (stacks.get(b.id) || 0) < STACK);
  if (pool.length === 0) return;
  const total = pool.reduce((s, b) => s + (b.weight || 1), 0);
  let r = Math.random() * total;
  for (const b of pool) {
    r -= b.weight || 1;
    if (r <= 0) {
      stacks.set(b.id, (stacks.get(b.id) || 0) + 1);
      return;
    }
  }
}

const pctOf = (stacks, kind) => {
  let sum = 0;
  for (const [id, n] of stacks) {
    const b = buffs.find((x) => x.id === id);
    if (b && b.effects[0].kind === kind) sum += (b.effects[0].ratio || 0) * n;
  }
  return Math.min(sum, CAP);
};

/**
 * 玩家 DPS（与 GameState.recompute + DamageFormula 同口径）。
 *
 * 关键：`DamageFormula` 有**单次伤害硬上限** `角色基础攻击 × balance.damage.max_total_dmg_multiplier`，
 * 且基数是「角色基础攻击」（不含局外加成）——因此后期 atk / 暴伤成长会被截断，必须建模，否则高估 DPS。
 */
function playerDps(stacks) {
  const baseAtk = cls.base_atk + metaBonus('atk_up', 'flat') * META_RATIO;
  const atk = baseAtk * (1 + pctOf(stacks, 'atk_up'));
  const atkSpeed = Math.min(
    (cls.atk_speed + metaBonus('atk_speed_up', 'ratio') * META_RATIO) * (1 + pctOf(stacks, 'atk_speed_up')),
    balance.attr_cap.atk_speed,
  );
  const critRate = Math.min(
    cls.crit_rate + metaBonus('crit_rate_up', 'ratio') * META_RATIO + pctOf(stacks, 'crit_rate_up'),
    balance.attr_cap.crit_rate,
  );
  const critDmg = cls.crit_dmg + metaBonus('crit_dmg_up', 'ratio') * META_RATIO + pctOf(stacks, 'crit_dmg_up');
  const coeff = melee ? cls.melee_coeff : cls.ranged_coeff;
  const hitCap = cls.base_atk * DMG_CAP_MULT;
  const normalHit = Math.min(atk * coeff, hitCap);
  const critHit = Math.min(atk * coeff * critDmg, hitCap);
  const capped = atk * coeff * critDmg > hitCap;
  const basic = atkSpeed * ((1 - critRate) * normalHit + critRate * critHit);
  // 技能 / 技能型 Buff 的输出折算：随技能类选卡线性提升（上限 3.0×，避免高估）
  const share = Math.min(3.0, SKILL_SHARE + 0.04 * skillPicks);
  return { atk, atkSpeed, critRate, critDmg, hitCap, capped, basic, total: basic * share, share };
}

// —— 主循环：逐层推进 ——
const stacks = new Map();
let level = 1;
let exp = 0;
let picks = 0;
const rows = [];
let firstStuck = 0;

for (let layer = 1; layer <= LAYERS; layer++) {
  // 先按当前等级输出战力（玩家进入该层时的状态）
  const dps = playerDps(stacks);
  const hp = enemyHp(layer);
  const killSec = hp / dps.total;
  const roundIdx = Math.floor((layer - 1) / LAYERS_PER_ROUND) + 1;
  const isBoss = layer % dungeon.boss_every_layers === 0;
  // Boss：以「当层普通怪 HP × boss 相对倍数」派生（与 Enemy.setup 同口径）
  const bossRatio = (enemies.boss.base_hp / enemies.normal.base_hp)
    * Math.pow(enemies.boss.boss_hp_factor, Math.max(0, Math.floor(layer / dungeon.boss_every_layers) - 1));
  const bossHp = hp * bossRatio;
  const bossSec = bossHp / dps.total;
  const stuck = killSec > TKILL || (isBoss && bossSec > TBOSS);
  if (stuck && !firstStuck) firstStuck = layer;
  rows.push({
    layer, roundIdx, level, kills: killsPerLayer(layer), atk: dps.atk, dps: dps.total,
    share: dps.share, hp, killSec, isBoss, bossSec, stuck,
  });

  // 结算本层经验 → 升级 → 选卡
  exp += killsPerLayer(layer) * enemyExp(layer) * (1 + 0);
  while (exp >= Math.floor(expCurve.base_exp * Math.pow(expCurve.exp_growth, level - 1))) {
    exp -= Math.floor(expCurve.base_exp * Math.pow(expCurve.exp_growth, level - 1));
    level += 1;
    pick(stacks, 1);
    picks += 1;
  }
}

// —— 输出 ——
console.log('=== 数值模拟（本体） ===');
console.log(`职业 ${CLASS}（${melee ? '近战' : '远程'}）｜层数 ${LAYERS}｜层内×${LAYER_FACTOR.toFixed(3)}`
  + `${ROUND_FACTOR > 1 ? ` ｜轮次×${ROUND_FACTOR}（每轮 ${LAYERS_PER_ROUND} 层）` : '｜无轮次制'}`
  + ` ｜百分比上限 ${(CAP * 100).toFixed(0)}%｜叠加 ${STACK} 层｜局外 ${(META_RATIO * 100).toFixed(0)}%`
  + ` ｜选卡 ${STRATEGY}｜技能折算 ×${SKILL_SHARE}`);
console.log('');
console.log('层  轮  等级   玩家ATK    总DPS  技折   敌HP    击杀(s)   Boss(s)');
for (const r of rows) {
  console.log(
    String(r.layer).padStart(2) + '  '
    + String(r.roundIdx).padStart(2) + '  '
    + String(r.level).padStart(4) + '  '
    + r.atk.toFixed(1).padStart(8) + '  '
    + r.dps.toFixed(0).padStart(8) + '  '
    + r.share.toFixed(2).padStart(5) + ' '
    + r.hp.toFixed(0).padStart(8) + '  '
    + r.killSec.toFixed(2).padStart(6) + (r.killSec > TKILL ? '!' : ' ') + '  '
    + r.bossSec.toFixed(1).padStart(7) + (r.isBoss && r.bossSec > TBOSS ? '!' : ' '),
  );
}
console.log('');
const lastDps = playerDps(stacks);
console.log(`累计选卡次数：${picks}（对应等级 ${level}）`);
console.log(`单次伤害硬上限：${lastDps.hitCap.toFixed(0)}（= 角色基础攻击 ${cls.base_atk} × ${DMG_CAP_MULT}）`
  + `${lastDps.capped ? ' ← **暴击伤害已被截断**（成长被上限吃掉）' : ''}`);
console.log(`卡死判据：普通怪 > ${TKILL}s 或 Boss > ${TBOSS}s`);
console.log(firstStuck
  ? `结论：**首个卡死层 = 第 ${firstStuck} 层**（第 ${LAYERS} 层目标未达成）`
  : `结论：**全程不卡死**（${LAYERS} 层内每层普通怪击杀 ≤ ${TKILL}s、Boss ≤ ${TBOSS}s）`);
process.exit(firstStuck ? 1 : 0);

/**
 * 数值校验脚本（项目宪法 3.11 / 文档3）。
 * 校验 resources/config/*.json：非负、曲线单调、倍率不超上限、字段完整、引用完整。
 * 用法：node tools/validate_configs.js
 * 退出码：0 通过，1 存在错误。
 */
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'assets', 'resources', 'config');
const TABLES = ['balance', 'characters', 'skills', 'buffs', 'enemies', 'dungeon', 'meta', 'exp_curve', 'fx', 'endgame', 'enemy_variants', 'actors', 'boss_ultimates', 'audio'];
const TABLE_COUNT_HINT = TABLES.length;

const errors = [];
const warn = [];
function fail(msg) { errors.push(msg); }
function note(msg) { warn.push(msg); }

function load(name) {
  const p = path.join(CONFIG_DIR, name + '.json');
  if (!fs.existsSync(p)) { fail(`缺少配置表: ${name}.json`); return null; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { fail(`配置表解析失败 ${name}.json: ${e.message}`); return null; }
}

/** 递归检查所有数值 >= 0。 */
function checkNonNegative(obj, pathStr) {
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) fail(`非有限数值 @ ${pathStr}`);
    else if (obj < 0) fail(`数值为负 @ ${pathStr} = ${obj}`);
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => checkNonNegative(v, `${pathStr}[${i}]`));
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) checkNonNegative(obj[k], `${pathStr}.${k}`);
  }
}

// —— 加载全部表 ——
const T = {};
for (const t of TABLES) T[t] = load(t);
const haveAll = Object.values(T).every(v => v !== null);
if (!haveAll) { report(); process.exit(1); }

// —— 1. 非负 ——
for (const t of TABLES) checkNonNegative(T[t], t);

// —— 2. 曲线单调 / 增长因子 >= 1 ——
const ec = T.exp_curve;
if (!(ec.base_exp > 0)) fail('exp_curve.base_exp 必须 > 0');
if (!(ec.exp_growth >= 1)) fail('exp_curve.exp_growth 必须 >= 1（经验曲线单调）');
if (!(ec.enemy_base_exp > 0)) fail('exp_curve.enemy_base_exp 必须 > 0');
if (!(ec.layer_exp_factor >= 1)) fail('exp_curve.layer_exp_factor 必须 >= 1（经验随层单调）');

// 终局模式定义（endgame.json：文档 2.6 双模式 + 文档 3.8 递进公式，唯一来源）
const MODES = ['base', 'normal', 'challenge'];
if (!(T.endgame && T.endgame.modes)) {
  fail('endgame.modes 缺失（本体 / 普通地图 / 挑战地图的模式定义）');
} else {
  for (const m of MODES) {
    const cfg = T.endgame.modes[m];
    if (!cfg) { fail(`endgame.modes.${m} 缺失`); continue; }
    if (!cfg.name) fail(`endgame.modes.${m}.name 缺失`);
    if (cfg.unlimited !== true && !(Number.isInteger(cfg.max_layers) && cfg.max_layers >= 1)) {
      fail(`endgame.modes.${m}.max_layers 必须为 >= 1 的整数（unlimited 为 true 时可为 0）`);
    }
    if (!(cfg.reward_growth >= 1)) fail(`endgame.modes.${m}.reward_growth 必须 >= 1（收益曲线不可负增长）`);
    if (typeof cfg.soft_cap !== 'boolean') fail(`endgame.modes.${m}.soft_cap 必须为布尔值`);
    if (!(cfg.fail_keep_ratio > 0 && cfg.fail_keep_ratio <= 1)) {
      fail(`endgame.modes.${m}.fail_keep_ratio 必须在 (0,1] 区间`);
    }
  }
  // 本体必须有限层且以 Boss 收尾；终局两模式必须无限（文档 2.6）
  if (T.endgame.modes.base.unlimited === true) {
    fail('endgame.modes.base 必须为有限层（本体需要通关判定以解锁终局）');
  } else if (Number.isInteger(T.endgame.modes.base.max_layers)
    && T.endgame.modes.base.max_layers % T.dungeon.boss_every_layers !== 0) {
    fail(`endgame.modes.base.max_layers(${T.endgame.modes.base.max_layers}) 必须是`
      + ` dungeon.boss_every_layers(${T.dungeon.boss_every_layers}) 的整数倍（本体应以 Boss 收尾）`);
  }
  for (const m of ['normal', 'challenge']) {
    if (T.endgame.modes[m] && T.endgame.modes[m].unlimited !== true) {
      fail(`endgame.modes.${m} 应为无限层（文档 2.6：层数无上限）`);
    }
  }
  // 挑战地图公式参数（文档 3.8：HP = 100×1.18^层数×(1+0.02×层数)、ATK = 10×1.10^层数、收益 ×1.12^层数）
  const cmp = T.endgame.modes.challenge ?? {};
  if (cmp.difficulty !== 'challenge_formula') {
    fail('endgame.modes.challenge.difficulty 必须为 challenge_formula（递进公式模式）');
  }
  for (const f of ['enemy_hp_base', 'enemy_hp_growth', 'enemy_atk_base', 'enemy_atk_growth']) {
    if (!(cmp[f] > 0)) fail(`endgame.modes.challenge.${f} 必须 > 0（递进公式参数）`);
  }
  if (!(cmp.enemy_hp_layer_bonus >= 0)) fail('endgame.modes.challenge.enemy_hp_layer_bonus 必须 >= 0');
  // 收益递进必须有硬上限（宪法 6.9：所有百分比倍率设上限，防指数膨胀）
  if (!(cmp.max_reward_factor > 0)) {
    fail('endgame.modes.challenge.max_reward_factor 必须 > 0（单层收益倍率的硬上限）');
  } else if (cmp.reward_growth > 1) {
    const layersToCap = Math.log(cmp.max_reward_factor) / Math.log(cmp.reward_growth);
    note(`终局·挑战：收益倍率上限 ${cmp.max_reward_factor}×，约在第 ${layersToCap.toFixed(0)} 层触顶`);
  }
  if (cmp.fail_keep_ratio !== 0.5) {
    note(`endgame.modes.challenge.fail_keep_ratio = ${cmp.fail_keep_ratio}（文档 2.6 为 50%，改动请确认）`);
  }
  // 卡关点推算（文档 3.8 设计目标：20–30 层开始卡关），便于试玩核对
  const stall = Array.isArray(T.endgame.stall_target_layers) ? T.endgame.stall_target_layers : [];
  if (stall.length === 2) {
    const hpAt = (L) => cmp.enemy_hp_base * Math.pow(cmp.enemy_hp_growth, L)
      * (1 + cmp.enemy_hp_layer_bonus * L);
    note(`终局·挑战：卡关目标 ${stall[0]}–${stall[1]} 层（敌方 HP ${hpAt(stall[0]).toFixed(0)} → ${hpAt(stall[1]).toFixed(0)}）`);
  }
  note(`本体：${T.endgame.modes.base.max_layers} 层，每 ${T.dungeon.boss_every_layers} 层一个 Boss`
    + `（共 ${T.endgame.modes.base.max_layers / T.dungeon.boss_every_layers} 个 Boss，通关后解锁终局）`);

  // 轮次制曲线参数（本体 / 普通地图，方案 A：轮内缓增 + 轮间跳升，取代每层 ×layer_growth 的指数曲线）
  for (const m of ['base', 'normal']) {
    const cfg = T.endgame.modes[m] ?? {};
    if (cfg.difficulty !== 'round_formula') continue;
    if (!(Number.isInteger(cfg.round_layers) && cfg.round_layers >= 1)) {
      fail(`endgame.modes.${m}.round_layers 必须为 >= 1 的整数（每轮层数）`);
    }
    for (const f of ['hp_factor_per_layer', 'atk_factor_per_layer', 'hp_factor_per_round', 'atk_factor_per_round']) {
      if (!(cfg[f] >= 1)) fail(`endgame.modes.${m}.${f} 必须 >= 1（成长因子不可负增长）`);
    }
  }
  // 本体末层敌方 HP 总倍率（与旧曲线的对比），用于核对「25 层不卡死」目标
  const bcfg = T.endgame.modes.base ?? {};
  if (bcfg.difficulty === 'round_formula' && Number.isInteger(bcfg.round_layers)) {
    const hpScaleAt = (L) => {
      const r = Math.floor((L - 1) / bcfg.round_layers);
      const i = (L - 1) % bcfg.round_layers;
      return Math.pow(bcfg.hp_factor_per_round, r) * Math.pow(bcfg.hp_factor_per_layer, i);
    };
    const L = bcfg.max_layers;
    const oldScale = Math.pow(T.enemies.layer_growth.hp_factor, L - 1);
    note(`本体曲线（第 ${L} 层 HP 倍率）：轮次制 ×${hpScaleAt(L).toFixed(1)}`
      + `（旧「每层 ×${T.enemies.layer_growth.hp_factor}」= ×${oldScale.toFixed(0)}）`);
    note(`本体节奏：${Math.round(L / bcfg.round_layers)} 轮 × ${bcfg.round_layers} 层，每轮末层为 Boss`);
  }
  // 成长上限与「实际可达百分比」的关系：避免把上限当成成长瓶颈（实测结论见交接 v1.21）
  const atkPoolRatio = (T.buffs || []).reduce((sum, b) => {
    if (b.type !== 'stat' || !b.effects || !b.effects[0] || b.effects[0].kind !== 'atk_up') return sum;
    return sum + (b.effects[0].ratio || 0);
  }, 0);
  const stackMax = (T.balance.buff && T.balance.buff.stat_stack_max) || 1;
  const reachable = atkPoolRatio * stackMax;
  const pctCap = T.balance.damage.percent_buff_cap;
  note(`局内成长：单项攻击加成最多叠 ${stackMax} 层 → 可达 +${(reachable * 100).toFixed(0)}%`
    + `；百分比硬上限 +${(pctCap * 100).toFixed(0)}%`
    + (reachable < pctCap ? '（上限为预留空间，真正的瓶颈是「叠加层数」）' : '（已达上限）'));
  if (T.endgame.unlock && T.endgame.unlock.require_base_clear === false) {
    note('endgame.unlock.require_base_clear = false：终局免通关直接可选（**仅限开发期验收**，正式发布前请置回 true）');
  }
}

const eg = T.enemies.layer_growth;
if (!(eg.hp_factor >= 1)) fail('enemies.layer_growth.hp_factor 必须 >= 1');
if (!(eg.atk_factor >= 1)) fail('enemies.layer_growth.atk_factor 必须 >= 1');
const boss = T.enemies.boss;
if (!(boss.boss_hp_factor >= 1)) fail('enemies.boss.boss_hp_factor 必须 >= 1');
if (!(boss.boss_atk_factor >= 1)) fail('enemies.boss.boss_atk_factor 必须 >= 1');

// 行走图切帧参数与显示缩放（enemies.normal / enemies.boss）
for (const key of ['normal', 'boss']) {
  const e = T.enemies[key];
  for (const f of ['sheet_cols', 'sheet_rows', 'sheet_col', 'sheet_row', 'render_scale']) {
    if (e[f] === undefined) fail(`enemies.${key} 缺少字段 ${f}`);
  }
  if (e.render_scale !== undefined && !(e.render_scale > 0)) {
    fail(`enemies.${key}.render_scale 必须 > 0`);
  }
  if (e.sheet_cols !== undefined && !(Number.isInteger(e.sheet_cols) && e.sheet_cols >= 1)) {
    fail(`enemies.${key}.sheet_cols 必须为 >= 1 的整数`);
  }
  if (e.sheet_rows !== undefined && !(Number.isInteger(e.sheet_rows) && e.sheet_rows >= 1)) {
    fail(`enemies.${key}.sheet_rows 必须为 >= 1 的整数`);
  }
  if (e.sheet_cols >= 1 && e.sheet_col !== undefined && !(e.sheet_col >= 0 && e.sheet_col < e.sheet_cols)) {
    fail(`enemies.${key}.sheet_col 必须在 [0, sheet_cols) 内`);
  }
  if (e.sheet_rows >= 1 && e.sheet_row !== undefined && !(e.sheet_row >= 0 && e.sheet_row < e.sheet_rows)) {
    fail(`enemies.${key}.sheet_row 必须在 [0, sheet_rows) 内`);
  }
}

// —— 3. 倍率硬上限（文档3.3/3.4）——
/**
 * 护栏常量：文档 3.3 原值 `单次伤害倍率 ≤ 30×`；**用户裁决（2026-10-13）放宽到 60×** ——
 * 因为实测「单次伤害上限 = 角色基础攻击 × 30」在满局外时会吃掉约 34% 的后期输出
 * （`tools/sim_balance.js --dmgcap=30|60` 可直接复现），与「提升成长上限 / 本体 25 层可通关」的目标冲突。
 */
const MAX_TOTAL_DMG_MULTIPLIER_LIMIT = 60;
const dmg = T.balance.damage;
if (!(dmg.max_total_dmg_multiplier <= MAX_TOTAL_DMG_MULTIPLIER_LIMIT)) {
  fail(`damage.max_total_dmg_multiplier 超过硬上限 ${MAX_TOTAL_DMG_MULTIPLIER_LIMIT}（当前 ${dmg.max_total_dmg_multiplier}）`);
}
if (!(dmg.percent_buff_cap <= 30)) fail(`damage.percent_buff_cap 超过硬上限 30（当前 ${dmg.percent_buff_cap}）`);
const cap = T.balance.attr_cap;
if (cap.crit_rate > 1) fail(`attr_cap.crit_rate 超过 1（当前 ${cap.crit_rate}）`);
if (cap.atk_speed > 5) fail(`attr_cap.atk_speed 超过 5（当前 ${cap.atk_speed}）`);
if (cap.move_speed_px > 400) fail(`attr_cap.move_speed_px 超过 400（当前 ${cap.move_speed_px}）`);
if (cap.pickup_range_px > 300) fail(`attr_cap.pickup_range_px 超过 300（当前 ${cap.pickup_range_px}）`);

  // 技能冷却：缩减上限 + 按槽位的最低冷却（v1.43；用户口径：技能2 满配也不得低于 15s）
  const cdCfg = T.balance.skill_common ?? {};
  if (!(cdCfg.cd_down_cap >= 0 && cdCfg.cd_down_cap < 1)) {
    fail(`balance.skill_common.cd_down_cap 必须在 [0, 1)（当前 ${cdCfg.cd_down_cap}）`);
  }
  for (const f of ['slot1_min_cd_ms', 'slot2_min_cd_ms']) {
    if (!(cdCfg[f] > 0)) fail(`balance.skill_common.${f} 必须 > 0（当前 ${cdCfg[f]}）`);
  }
  if (cdCfg.slot2_min_cd_ms < cdCfg.slot1_min_cd_ms) {
    fail('balance.skill_common：技能2 的最低冷却不应低于技能1');
  }
  // 交叉校验：每个技能2 在满配缩减后的实际冷却，必须 ≥ 配置的最低冷却
  const slot2MinSec = cdCfg.slot2_min_cd_ms / 1000;
  for (const sk of (T.skills ?? [])) {
    if (sk.slot !== 2) continue;
    const raw = (sk.cooldown_ms / 1000) * (1 - cdCfg.cd_down_cap);
    note(`技能冷却：${sk.class_id}/${sk.name} 槽2 满配后 ${Math.max(slot2MinSec, raw).toFixed(1)}s`
      + `（下限 ${slot2MinSec}s）`);
  }
if (cap.hp_regen_per_sec_ratio > 1) fail(`attr_cap.hp_regen_per_sec_ratio 超过 1（当前 ${cap.hp_regen_per_sec_ratio}）`);
const buffCfg = T.balance.buff;
if (!(buffCfg && buffCfg.offer_count >= 1)) fail('balance.buff.offer_count 必须 >= 1');
if (!(buffCfg && Number.isInteger(buffCfg.carry_slots_base) && buffCfg.carry_slots_base >= 1)) {
  fail('balance.buff.carry_slots_base 必须为 >= 1 的整数（行为型 Buff 的同时携带上限基数）');
}
const combatCfg = T.balance.combat;
if (!(combatCfg && combatCfg.knockback_lock_ms > 0)) {
  fail('balance.combat.knockback_lock_ms 必须 > 0（击退后中断追击的时长；为 0 会导致击退不可见）');
}
if (!(combatCfg && combatCfg.contact_interval_ms > 0)) fail('balance.combat.contact_interval_ms 必须 > 0');
if (!(combatCfg && combatCfg.contact_dist_px > 0)) fail('balance.combat.contact_dist_px 必须 > 0');
for (const f of ['bullet_speed_px_per_sec', 'bullet_radius_px', 'bullet_life_ms',
  'hit_flash_ms', 'hit_effect_ms', 'death_effect_ms', 'damage_text_ms', 'hp_regen_interval_ms',
  'extra_projectile_spread_deg']) {
  if (!(combatCfg && combatCfg[f] > 0)) fail(`balance.combat.${f} 必须 > 0`);
}

// 层内风险递增三机制参数（文档 3.7：时间压力 / 猎杀者 / 收益软上限 + 提前离开奖励）
const tp = T.balance.time_pressure;
if (!(tp && tp.interval_s > 0)) fail('balance.time_pressure.interval_s 必须 > 0');
if (!(tp && tp.step_ratio >= 0)) fail('balance.time_pressure.step_ratio 必须 >= 0');
if (!(tp && tp.max >= 1)) fail('balance.time_pressure.max 必须 >= 1（时间压力硬上限）');

const sc = T.balance.reward_softcap;
if (!(sc && sc.interval_s > 0)) fail('balance.reward_softcap.interval_s 必须 > 0');
if (!(sc && sc.decay_ratio >= 0)) fail('balance.reward_softcap.decay_ratio 必须 >= 0');
if (!(sc && sc.min_ratio > 0 && sc.min_ratio <= 1)) fail('balance.reward_softcap.min_ratio 必须在 (0,1]（文档 3.7 最低保留比例）');

const el = T.balance.early_leave_bonus;
if (!(el && el.bonus_per_interval >= 0)) fail('balance.early_leave_bonus.bonus_per_interval 必须 >= 0');
if (!(el && el.cap >= 1)) fail('balance.early_leave_bonus.cap 必须 >= 1');
if (!(el && el.recommended_layer_s > 0)) fail('balance.early_leave_bonus.recommended_layer_s 必须 > 0（每层推荐时长 = 提前离开奖励窗口）');
if (el && tp && el.cap > 1 + el.bonus_per_interval * Math.floor(el.recommended_layer_s / tp.interval_s)) {
  note('balance.early_leave_bonus.cap 高于「停留 0 秒」可达上限，实际不会触顶（建议 cap = 1 + bonus_per_interval × ⌊recommended_layer_s / interval_s⌋）');
}

const hu = T.balance.hunter;
if (!(hu && hu.first_delay_s > 0)) fail('balance.hunter.first_delay_s 必须 > 0');
if (!(hu && hu.interval_base_s > 0)) fail('balance.hunter.interval_base_s 必须 > 0');
if (!(hu && hu.interval_min_s > 0)) fail('balance.hunter.interval_min_s 必须 > 0');
if (hu && hu.interval_min_s > hu.interval_base_s) fail('balance.hunter.interval_min_s 必须 <= interval_base_s（间隔只可递减）');

// 精英（猎杀者）数值字段（文档 3.6）
const hunterCfg = T.enemies.hunter;
for (const f of ['hp_multiplier', 'atk_multiplier', 'speed_multiplier', 'render_scale']) {
  if (!(hunterCfg && hunterCfg[f] > 0)) fail(`enemies.hunter.${f} 必须 > 0`);
}
for (const f of ['exp', 'gold']) {
  if (!(hunterCfg && hunterCfg[f] >= 0)) fail(`enemies.hunter.${f} 必须 >= 0`);
}

// Boss 独立行为参数：冷却 / 范围 / 倍率必须全部来自配置（文档 2.5）
const BOSS_BEHAVIOR_FIELDS = [
  // 冲锋
  'charge_cooldown_ms', 'charge_windup_ms', 'charge_speed_px_per_sec',
  'charge_distance_px', 'charge_width_px', 'charge_damage_multiplier', 'charge_recover_ms',
  // 短时加速
  'haste_speed_multiplier', 'haste_duration_ms', 'haste_cooldown_ms',
  // 跳砸（危险范围预警）
  'slam_cooldown_ms', 'slam_windup_ms', 'slam_range_px', 'slam_radius_max_px',
  'slam_radius_boss_multiplier', 'slam_damage_multiplier', 'slam_recover_ms',
  // 慢速远程弹
  'bolt_cooldown_ms', 'bolt_cooldown_min_ms', 'bolt_speed_px_per_sec', 'bolt_radius_px',
  'bolt_life_ms', 'bolt_damage_multiplier', 'bolt_count_base', 'bolt_spread_deg',
];
for (const f of BOSS_BEHAVIOR_FIELDS) {
  if (!(boss && boss[f] > 0)) fail(`enemies.boss.${f} 必须 > 0（Boss 行为参数）`);
}
for (const f of ['charge_damage_multiplier', 'slam_damage_multiplier', 'bolt_damage_multiplier']) {
  if (boss && boss[f] > dmg.max_total_dmg_multiplier) {
    fail(`enemies.boss.${f} 超过总伤害倍率硬上限 ${dmg.max_total_dmg_multiplier}`);
  }
}
if (boss && boss.haste_speed_multiplier !== undefined && !(boss.haste_speed_multiplier >= 1)) {
  fail('enemies.boss.haste_speed_multiplier 必须 >= 1（加速不得减速）');
}
if (boss && boss.bolt_cooldown_min_ms > boss.bolt_cooldown_ms) {
  fail('enemies.boss.bolt_cooldown_min_ms 必须 <= bolt_cooldown_ms（远程冷却只可递减）');
}
if (boss && !(boss.bolt_cooldown_decay_ratio >= 0 && boss.bolt_cooldown_decay_ratio < 1)) {
  fail('enemies.boss.bolt_cooldown_decay_ratio 必须在 [0,1)（越难的 Boss 远程越密集）');
}
if (boss && !Number.isInteger(boss.bolt_count_base)) fail('enemies.boss.bolt_count_base 必须为整数');
if (boss && !(Number.isInteger(boss.bolt_count_per_index) && boss.bolt_count_per_index >= 0)) {
  fail('enemies.boss.bolt_count_per_index 必须为 >= 0 的整数');
}
// 「慢弹速可规避」：远程弹速必须慢于最慢职业的移速
// 「跳砸必可走出」：危险半径硬上限 <= 最慢职业在预警期内单方向移动距离 × 0.8 安全系数
if (boss) {
  const slowestMove = Math.min(...Object.keys(T.characters).map((cid) => T.characters[cid].move_speed_px));
  if (!(boss.bolt_speed_px_per_sec < slowestMove)) {
    fail(`enemies.boss.bolt_speed_px_per_sec 必须小于最慢职业移速 ${slowestMove}（否则无法走位规避）`);
  }
  if (boss.slam_windup_ms > 0) {
    const escapePx = slowestMove * (boss.slam_windup_ms / 1000) * 0.8;
    if (!(boss.slam_radius_max_px <= escapePx)) {
      fail(`enemies.boss.slam_radius_max_px 过大：必须 <= ${escapePx.toFixed(0)}`
        + `（最慢职业移速 ${slowestMove} × 预警 ${(boss.slam_windup_ms / 1000).toFixed(2)}s × 0.8），否则玩家走不出危险范围`);
    }
  }
}

// —— 6. 技能表（skills.json：3 职业 × 2 槽，cast_type 共 4 种）——
const CAST_TYPES = ['dash', 'instant', 'channel', 'buff'];
/** 技能效果 kind 白名单：拼错 kind 会导致效果静默失效，必须在校验期拦住。 */
const EFFECT_KINDS = [
  'invuln', 'move_slow', 'root', 'slow', 'immune_ranged', 'arrow_burst',
  'atk_speed_up', 'damage_up', 'width_up', 'extra_projectile',
];

// 技能通用参数（冲刺「卡住」判定阈值；系统侧不再硬编码）
const skillCommon = T.balance.skill_common;
if (!(skillCommon && skillCommon.dash_stuck_ratio > 0 && skillCommon.dash_stuck_ratio < 1)) {
  fail('balance.skill_common.dash_stuck_ratio 必须在 (0,1) 之间（单帧位移低于「速度×ratio」视为推不动）');
}
if (!(skillCommon && skillCommon.dash_stuck_sec > 0)) {
  fail('balance.skill_common.dash_stuck_sec 必须 > 0（连续推不动的时长上限，超过才收招）');
}
const skillsCfg = Array.isArray(T.skills) ? T.skills : [];
if (skillsCfg.length === 0) fail('skills.json 必须是非空数组');
const seenSkillIds = new Set();
for (const s of skillsCfg) {
  if (!s.id) { fail('skills 存在无 id 条目'); continue; }
  if (seenSkillIds.has(s.id)) fail(`skills 存在重复 id: ${s.id}`);
  seenSkillIds.add(s.id);
  if (!s.name) fail(`skills.${s.id} 缺少 name`);
  if (!Object.keys(T.characters).includes(s.class_id)) {
    fail(`skills.${s.id}.class_id 不是已配置职业: ${s.class_id}`);
  }
  if (s.slot !== 1 && s.slot !== 2) fail(`skills.${s.id}.slot 必须是 1 或 2`);
  if (!(s.cooldown_ms > 0)) fail(`skills.${s.id}.cooldown_ms 必须 > 0`);
  if (!CAST_TYPES.includes(s.cast_type)) {
    fail(`skills.${s.id}.cast_type 非法: ${s.cast_type}（应为 ${CAST_TYPES.join(' / ')}）`);
  }
  if (s.cast_type === 'dash') {
    if (!(s.dash_distance_px > 0)) fail(`skills.${s.id}.dash_distance_px 必须 > 0（冲刺距离）`);
    if (!(s.dash_speed_px > 0)) fail(`skills.${s.id}.dash_speed_px 必须 > 0（冲刺速度）`);
  }
  if (s.cast_type === 'channel') {
    if (!(s.duration_ms > 0)) fail(`skills.${s.id}.duration_ms 必须 > 0（引导持续时长）`);
    if (!(s.tick_ms > 0)) fail(`skills.${s.id}.tick_ms 必须 > 0（每段伤害间隔，缺失会导致引导无伤害）`);
    if (s.tick_ms > s.duration_ms) fail(`skills.${s.id}.tick_ms 不应大于 duration_ms`);
  }
  if (s.cast_type === 'buff' && !(s.duration_ms > 0)) {
    fail(`skills.${s.id}.duration_ms 必须 > 0（增幅持续时长）`);
  }
  // 散布特效（可选）：引导类必杀技的"乱闪"氛围，字段缺失/为 0 会导致不播或一闪而过
  if (s.fx_scatter !== undefined) {
    const sc = s.fx_scatter;
    for (const f of ['count', 'size_px', 'interval_ms', 'spread_px', 'duration_ms']) {
      if (!(sc && sc[f] > 0)) fail(`skills.${s.id}.fx_scatter.${f} 必须 > 0`);
    }
    if (!s.fx) fail(`skills.${s.id} 配置了 fx_scatter 但缺少 fx（散布特效无 key 可用）`);
    if (sc && sc.duration_ms < 400) {
      note(`skills.${s.id}.fx_scatter.duration_ms = ${sc.duration_ms}（过短会一闪而过，建议 ≥ 600）`);
    }
  }
  if (!Array.isArray(s.effects)) fail(`skills.${s.id} 缺少 effects 数组`);
  // 技能总伤害倍率不得超过全局硬上限（引导按段数累加）
  if (typeof s.damage_ratio === 'number') {
    const ticks = s.cast_type === 'channel' && s.tick_ms > 0
      ? Math.max(1, Math.floor(s.duration_ms / s.tick_ms)) : 1;
    const total = s.damage_ratio * ticks;
    if (total > dmg.max_total_dmg_multiplier) {
      fail(`skills.${s.id} 总伤害倍率 ${total.toFixed(2)}（每段 ${s.damage_ratio} × ${ticks} 段）`
        + ` 超过硬上限 ${dmg.max_total_dmg_multiplier}`);
    }
  }
  for (const e of (s.effects || [])) {
    if (!e || !e.kind) { fail(`skills.${s.id} 存在缺少 kind 的效果`); continue; }
    if (!EFFECT_KINDS.includes(e.kind)) {
      fail(`skills.${s.id} 存在未知效果 kind: ${e.kind}（可用：${EFFECT_KINDS.join(' / ')}）`);
    }
  }
}
// 每个职业的两个技能槽都必须有技能（否则技能栏出现空格子）
for (const cid of Object.keys(T.characters)) {
  for (const slot of [1, 2]) {
    if (!skillsCfg.some((s) => s.class_id === cid && s.slot === slot)) {
      fail(`skills 缺少 ${cid} 的槽 ${slot} 技能`);
    }
  }
}

// 技能冷却是「乘算降幅」且系统侧有 90% 硬上限：配置满级降幅不得超过该上限
const skillCdMeta = (T.meta || []).filter((m) => m.effect && m.effect.kind === 'skill_cd_down');
for (const m of skillCdMeta) {
  const total = (m.effect.per_level || 0) * (m.max_level || 0);
  if (total > 0.9) {
    fail(`meta.${m.id} 满级冷却降幅 ${(total * 100).toFixed(0)}% 超过技能系统硬上限 90%`);
  }
}
// 提示（非错误）：技能 1 / 2 的冷却与持续时间的「初始 → 满级」推算，便于试玩与数值策划核对
for (const slot of [1, 2]) {
  const list = skillsCfg.filter((s) => s.slot === slot);
  if (list.length === 0) continue;
  const cdMeta = (T.meta || []).find((m) => m.id === `skill${slot}_cd`);
  const durMeta = (T.meta || []).find((m) => m.id === `skill${slot}_duration`);
  const cdDown = cdMeta ? (cdMeta.effect.per_level || 0) * (cdMeta.max_level || 0) : 0;
  const durUp = durMeta ? (durMeta.effect.per_level || 0) * (durMeta.max_level || 0) : 0;
  const cdSec = list[0].cooldown_ms / 1000;
  const durSec = list[0].duration_ms ? list[0].duration_ms / 1000 : 0;
  note(`技能${slot}「${list.map((s) => s.name).join(' / ')}」：冷却 ${cdSec.toFixed(1)}s → 满级 `
    + `${(cdSec * (1 - Math.min(0.9, cdDown))).toFixed(1)}s`
    + (durSec > 0 ? `；持续 ${durSec.toFixed(1)}s → 满级 ${(durSec * (1 + durUp)).toFixed(1)}s` : '；无持续时长'));
}

// —— 7. 局内 Buff 表（buffs.json：stat / skill / behavior 三类）——
/**
 * 非属性效果 kind 白名单（属性类的 kind 由 GameState 的 STAT_KIND_MAP 覆盖）。
 * 说明：Buff 效果统一登记到 GameState 的系数通道，消费方按 kind 读取；
 * 拼错 kind 会导致「选了 Buff 却完全没效果」，因此必须在校验期拦住。
 */
const NON_STAT_BUFF_KINDS = [
  'bullet_pierce', 'bullet_bounce', 'chain', 'bullet_size_up', 'bullet_speed_up',
  'skill_range_up', 'thorns', 'freeze_on_hit', 'extra_projectile', 'aura_slow', 'burn',
  'kill_reset_dash', 'exp_attract', 'revive_once',
  'skill_cd_down', 'skill_dmg_up', 'skill_duration_up', 'all_skill_dmg_up',
  // 技能型 Buff（type = skill_behavior）：固定间隔自动释放
  'cs_slash', 'cs_whirl', 'cs_frenzy', 'cs_bomb', 'cs_flame', 'cs_ice', 'cs_water', 'cs_shield',
];
const STAT_KINDS = ['atk_up', 'atk_speed_up', 'max_hp_up', 'crit_rate_up', 'crit_dmg_up',
  'move_speed_up', 'pickup_range_up', 'hp_regen_up', 'exp_gain_up', 'gold_gain_up', 'lifesteal_up'];
const BUFF_TYPES = ['stat', 'skill', 'behavior', 'skill_behavior'];
const buffsCfg = Array.isArray(T.buffs) ? T.buffs : [];
if (buffsCfg.length === 0) fail('buffs.json 必须是非空数组');
const seenBuffIds = new Set();
for (const b of buffsCfg) {
  if (!b.id) { fail('buffs 存在无 id 条目'); continue; }
  if (seenBuffIds.has(b.id)) fail(`buffs 存在重复 id: ${b.id}`);
  seenBuffIds.add(b.id);
  if (!b.name) fail(`buffs.${b.id} 缺少 name`);
  if (!BUFF_TYPES.includes(b.type)) {
    fail(`buffs.${b.id}.type 非法: ${b.type}（应为 ${BUFF_TYPES.join(' / ')}）`);
  }
  if (!(typeof b.weight === 'number' && b.weight > 0)) fail(`buffs.${b.id}.weight 必须 > 0`);
  if (b.max_stack !== undefined && !(b.max_stack >= 1)) fail(`buffs.${b.id}.max_stack 必须 >= 1`);
  if (!Array.isArray(b.effects) || b.effects.length === 0) fail(`buffs.${b.id} 缺少 effects`);
  for (const e of (b.effects || [])) {
    if (!e || !e.kind) { fail(`buffs.${b.id} 存在缺少 kind 的效果`); continue; }
    if (!STAT_KINDS.includes(e.kind) && !NON_STAT_BUFF_KINDS.includes(e.kind)) {
      fail(`buffs.${b.id} 存在未知效果 kind: ${e.kind}（属性类需在 STAT_KIND_MAP，非属性类需在效果白名单）`);
    }
    if (e.slot !== undefined && e.slot !== 1 && e.slot !== 2) {
      fail(`buffs.${b.id}.effects[].slot 只能是 1 或 2`);
    }
    if (STAT_KINDS.includes(e.kind) && typeof e.ratio !== 'number') {
      fail(`buffs.${b.id} 的属性类效果 ${e.kind} 需要 ratio`);
    }
  }
  // 技能型 Buff（周期释放 + 逐级升级）：以 levels 数组描述每一级参数
  if (b.type === 'skill_behavior') {
    if (!Array.isArray(b.levels) || b.levels.length === 0) {
      fail(`buffs.${b.id}.levels 必须是非空数组（每级一行参数；重复获得同一 Buff 即升级）`);
    }
    if (typeof b.fx !== 'string' || b.fx.length === 0) {
      fail(`buffs.${b.id}.fx 必须指定美术效果 key（见 fx.json）`);
    }
    const mbKind = b.effects && b.effects[0] ? b.effects[0].kind : '';
    const levels = Array.isArray(b.levels) ? b.levels : [];
    let prevInterval = Infinity;
    for (let i = 0; i < levels.length; i++) {
      const L = levels[i];
      const at = `buffs.${b.id}.levels[${i}]`;
      if (!(L.interval_ms > 0)) fail(`${at}.interval_ms 必须 > 0`);
      if (L.interval_ms > prevInterval) {
        fail(`${at}.interval_ms 应随等级递减（升级即提升攻速）`);
      }
      prevInterval = L.interval_ms;
      if (mbKind === 'cs_shield') {
        if (!(L.duration_ms > 0)) fail(`${at}.duration_ms 必须 > 0（护盾持续时间）`);
        if (!(L.damage_reduction > 0 && L.damage_reduction <= 0.5)) {
          fail(`${at}.damage_reduction 必须在 (0, 0.5] 区间（用户口径：最高不超过 50%）`);
        }
      } else if (!(L.damage_ratio > 0)) {
        fail(`${at}.damage_ratio 必须 > 0`);
      }
      // 各机制的必填参数（缺失会导致机制静默不生效）
      const need = {
        cs_slash: ['range_px', 'width_px'],
        cs_whirl: ['radius_px'],
        cs_frenzy: ['hits', 'range_px', 'hit_interval_ms'],
        // 爆弹是远程投射物：射程必须显式配置（否则退化为职业默认寿命，远程性质不成立）
        cs_bomb: ['range_px', 'explode_radius_px'],
        cs_flame: ['range_px', 'width_px', 'tick_ms', 'duration_ms', 'burn_dps_ratio', 'burn_ms'],
        cs_ice: ['radius_px', 'slow_ratio', 'slow_ms'],
        // 水柱是远程投射物：需推进速度（speed_px）与并排根数（count）
        cs_water: ['count', 'range_px', 'width_px', 'speed_px', 'knockback_px'],
      }[mbKind];
      for (const f of (need || [])) {
        if (!(L[f] > 0)) fail(`${at}.${f} 必须 > 0（${mbKind} 的机制参数）`);
      }
    }
  }
}

// 远程技能射程对照（提示，非错误）：远程应显著大于近战（剑气斩），否则"远程性质"不成立
{
  const first = (id) => {
    const b = buffsCfg.find((x) => x.id === id);
    return b && Array.isArray(b.levels) && b.levels[0] ? b.levels[0] : null;
  };
  const melee = first('bh_slash');
  const rows = [['近战·剑气斩', melee], ['远程·爆弹', first('bh_bomb')], ['远程·喷火', first('bh_flame')],
    ['远程·水柱', first('bh_water')], ['范围·冰暴(半径)', first('bh_ice')]];
  for (const [label, L] of rows) {
    if (!L) continue;
    const dist = L.range_px ?? L.radius_px ?? 0;
    const warn = melee && melee.range_px && dist && label.indexOf('近战') < 0
      && dist <= melee.range_px * 1.3;
    note(`${label}：射程/半径 ${dist}px`
      + (warn ? '  ← 注意：与近战剑气斩接近，远程性质不明显' : ''));
  }
}

// 「技能型 Buff」独立携带槽位（用户裁决：不占用行为型槽位）
const buffSlotsCfg = T.balance.buff;
if (!(buffSlotsCfg && Number.isInteger(buffSlotsCfg.behavior_skill_slots)
  && buffSlotsCfg.behavior_skill_slots >= 1)) {
  fail('balance.buff.behavior_skill_slots 必须为 >= 1 的整数（技能型 Buff 独立携带上限）');
}
if (!(buffSlotsCfg && buffSlotsCfg.aura_refresh_s > 0)) {
  fail('balance.buff.aura_refresh_s 必须 > 0（减速光环的刷新间隔，秒）');
}
// 属性 / 技能类强化：不占槽位但受叠加上限约束（用户裁决）
if (!(buffSlotsCfg && Number.isInteger(buffSlotsCfg.stat_stack_max) && buffSlotsCfg.stat_stack_max >= 1)) {
  fail('balance.buff.stat_stack_max 必须为 >= 1 的整数（属性/技能类强化的叠加上限）');
}
// 槽位基数与上限（用户口径：行为型 4→最多 7、技能型 3→最多 6）
if (!(buffSlotsCfg && Number.isInteger(buffSlotsCfg.carry_slots_base) && buffSlotsCfg.carry_slots_base >= 1)) {
  fail('balance.buff.carry_slots_base 必须为 >= 1 的整数（行为型携带槽基数）');
}
if (!(buffSlotsCfg && Number.isInteger(buffSlotsCfg.carry_slots_max)
  && buffSlotsCfg.carry_slots_max >= buffSlotsCfg.carry_slots_base)) {
  fail('balance.buff.carry_slots_max 必须为 >= carry_slots_base 的整数（行为型携带槽上限）');
}
if (!(buffSlotsCfg && Number.isInteger(buffSlotsCfg.behavior_skill_slots_max)
  && buffSlotsCfg.behavior_skill_slots_max >= buffSlotsCfg.behavior_skill_slots)) {
  fail('balance.buff.behavior_skill_slots_max 必须为 >= behavior_skill_slots 的整数（技能型槽位上限）');
}
// 解锁项的值不得超过配置上限，否则升到上限后仍显示可购买
for (const m of (T.meta || [])) {
  if (!m.effect || typeof m.effect.value !== 'number') {
    continue;
  }
  if (m.effect.kind === 'buff_slot' && m.effect.value > buffSlotsCfg.carry_slots_max) {
    fail(`meta.${m.id} 的槽位值 ${m.effect.value} 超过 balance.buff.carry_slots_max`);
  }
  if (m.effect.kind === 'behavior_skill_slot' && m.effect.value > buffSlotsCfg.behavior_skill_slots_max) {
    fail(`meta.${m.id} 的槽位值 ${m.effect.value} 超过 balance.buff.behavior_skill_slots_max`);
  }
}
if (!(T.balance.combat && T.balance.combat.bounce_retarget_range_px > 0)) {
  fail('balance.combat.bounce_retarget_range_px 必须 > 0（弹射重新索敌的距离上限）');
}

// —— 8. 特效表（fx.json：序列帧几何与播放参数）——
const fxCfg = Array.isArray(T.fx) ? T.fx : [];
if (fxCfg.length === 0) fail('fx.json 必须是非空数组');
const seenFxKeys = new Set();
for (const f of fxCfg) {
  if (!f.key) { fail('fx 存在无 key 条目'); continue; }
  if (seenFxKeys.has(f.key)) fail(`fx 存在重复 key: ${f.key}`);
  seenFxKeys.add(f.key);
  if (!f.name) fail(`fx.${f.key} 缺少 name`);
  if (!f.path) fail(`fx.${f.key} 缺少 path（resources 下的序列帧目录）`);
  for (const k of ['frame_w', 'frame_h', 'frames', 'frame_ms', 'anim_repeat', 'scale']) {
    if (!(f[k] > 0)) fail(`fx.${f.key}.${k} 必须 > 0`);
  }
  if (!(f.hold_ms >= 0)) fail(`fx.${f.key}.hold_ms 必须 >= 0（末帧停留毫秒，0 = 不停留）`);
  if (typeof f.follow !== 'boolean') fail(`fx.${f.key}.follow 必须为布尔值`);
}
// 特效交叠次数（近战多刀 / 冰暴多枚 / 喷火分段 / 水柱分波）：缺失会导致"只闪一下看不出是什么"
const skillFx = T.balance.skill_fx;
for (const k of ['slash_count', 'whirl_count', 'ice_count', 'flame_segments', 'water_step_ms', 'water_speed_px']) {
  if (!(skillFx && skillFx[k] > 0)) fail(`balance.skill_fx.${k} 必须 > 0（特效交叠 / 水柱推进参数）`);
}
// 技能型 Buff 引用的特效 key 必须存在，否则技能"有数值没表现"
for (const b of buffsCfg) {
  if (b.type === 'skill_behavior' && b.fx && !seenFxKeys.has(b.fx)) {
    fail(`buffs.${b.id}.fx 引用了不存在的特效 key: ${b.fx}`);
  }
}
// 职业普攻特效（characters.attack_fx，可选）：配了就必须存在（如战士普攻的"双重切割"）
for (const cid of Object.keys(T.characters)) {
  const fx = T.characters[cid].attack_fx;
  if (fx && !seenFxKeys.has(fx)) {
    fail(`characters.${cid}.attack_fx 引用了不存在的特效 key: ${fx}`);
  }
  if (T.characters[cid].attack_type === 'melee' && !fx) {
    note(`characters.${cid} 是近战职业但未配置 attack_fx：普攻没有任何表现`);
  }
}

// 演员表（actors.json）：路径 + 帧网格合法性；且变体引用的 sheet 必须存在
{
  const ac = T.actors ?? {};
  const checkSheet = (label, s, needPath = true) => {
    if (!s) return false;
    if (needPath) {
      if (typeof s.path !== 'string' || !s.path) { fail(`actors.${label}.path 缺失`); return false; }
      if (/[\u4e00-\u9fa5\s]/.test(s.path)) fail(`actors.${label}.path 含中文或空格，Cocos 资源路径必须为英文：${s.path}`);
    }
    for (const f of ['frame_w', 'frame_h', 'cols', 'rows', 'frames', 'frame_ms']) {
      if (!(s[f] > 0)) fail(`actors.${label}.${f} 必须 > 0`);
    }
    const axis = s.axis ?? 'row';
    if (axis !== 'row' && axis !== 'col') fail(`actors.${label}.axis 只能是 'row'（行内连续帧）或 'col'（列内连续帧）`);
    // 帧数容量：row 方向 = (rows-row)×cols 行优先；col 方向 = (cols-col)×rows 列优先
    const capacity = axis === 'row'
      ? ((s.rows ?? 1) - (s.row ?? 0)) * (s.cols ?? 1)
      : ((s.cols ?? 1) - (s.col ?? 0)) * (s.rows ?? 1);
    if (s.frames > capacity) {
      fail(`actors.${label}.frames(${s.frames}) 超过可用帧数 ${capacity}（axis=${axis}）`);
    }
    if (!(s.row >= 0 && s.row < s.rows)) fail(`actors.${label}.row 必须在 [0, rows) 内`);
    if (!(s.col >= 0 && s.col < s.cols)) fail(`actors.${label}.col 必须在 [0, cols) 内`);
    return true;
  };
  // 玩家：职业 → 行走图（各自颜色，靠素材区分而不是染色）+ 各动作网格/节奏
  const classSheet = ac.player?.class_sheet ?? {};
  const classIds = Object.keys(T.characters);
  for (const cid of classIds) {
    if (!classSheet[cid]) fail(`actors.player.class_sheet 缺少职业 ${cid} 的行走图路径`);
  }
  for (const cid of Object.keys(classSheet)) {
    if (!T.characters[cid]) fail(`actors.player.class_sheet.${cid} 不是有效职业`);
  }
  const playerActions = ['idle', 'walk'];
  for (const a of playerActions) {
    if (!ac.player?.[a]) fail(`actors.player.${a} 缺失（角色必须有待机 / 行走动作）`);
    else checkSheet(`player.${a}`, ac.player[a], false);
  }
  for (const a of ['attack', 'hit', 'roll', 'roll_fallback']) {
    if (ac.player?.[a]) checkSheet(`player.${a}`, ac.player[a], a === 'roll_fallback');
  }
  const monsters = ac.monsters ?? {};
  for (const id of Object.keys(monsters)) checkSheet(`monsters.${id}.sheet`, monsters[id].sheet);
  for (const id of Object.keys(ac.bosses ?? {})) {
    for (const a of Object.keys(ac.bosses[id])) {
      if (a.startsWith('_') || a === 'scale') continue;
      checkSheet(`bosses.${id}.${a}`, ac.bosses[id][a]);
    }
    const sc = ac.bosses[id].scale;
    if (sc !== undefined && !(sc > 0)) fail(`actors.bosses.${id}.scale 必须 > 0（素材归一化系数）`);
  }
  // Boss 素材轮换（enemies.boss.actors，用户裁决：5 个 Boss 按轮次登场后循环）
  {
    const bossActors = T.enemies?.boss?.actors;
    if (!Array.isArray(bossActors) || bossActors.length === 0) {
      fail('enemies.boss.actors 不能为空（Boss 素材轮换表）');
    } else {
      for (const id of bossActors) {
        if (!ac.bosses?.[id]) {
          fail(`enemies.boss.actors 引用了未定义的 Boss 素材：${id}`);
        } else if (!ac.bosses[id].idle) {
          fail(`actors.bosses.${id}.idle 缺失（Boss 必须有待机动作）`);
        }
      }
      note(`Boss 素材轮换：${bossActors.join(' → ')}（打满一轮后循环）`);
    }
  }
  note(`演员表：职业 ${Object.keys(classSheet).length} 个（各自行走图）· 怪物素材 ${Object.keys(monsters).length} 种 · Boss ${Object.keys(ac.bosses ?? {}).length} 个`);
  // 变体引用的 sheet 必须真实存在（否则该变体退回默认素材，外观与设计不符）
  for (const v of (T.enemy_variants?.variants ?? [])) {
    if (v.sheet && !monsters[v.sheet]) {
      fail(`enemy_variants.${v.id}.sheet 指向不存在的怪物素材: ${v.sheet}（actors.json 未定义）`);
    }
  }
}

// 音频（audio.json，阶段 5 音效接入）
{
  const au = T.audio ?? {};
  const master = au.master ?? {};
  if (!(master.bgm_volume > 0 && master.bgm_volume <= 1)) fail('audio.master.bgm_volume 必须在 (0,1]');
  if (!(master.sfx_volume > 0 && master.sfx_volume <= 1)) fail('audio.master.sfx_volume 必须在 (0,1]');
  // 用户口径：BGM 音量必须**明显低于**音效，否则"只能听到背景音乐"
  if (master.bgm_volume > master.sfx_volume * 0.5) {
    fail(`audio.master.bgm_volume(${master.bgm_volume}) 必须 ≤ sfx_volume 的一半（BGM 要明显更轻）`);
  }
  const checkPaths = (list, label) => {
    const ids = [];
    for (const d of (Array.isArray(list) ? list : [])) {
      if (!d.id) { fail(`audio.${label}[].id 缺失`); continue; }
      if (ids.indexOf(d.id) >= 0) fail(`audio.${label} 存在重复 id：${d.id}`);
      ids.push(d.id);
      if (typeof d.path !== 'string' || !d.path) fail(`audio.${label}.${d.id}.path 缺失`);
      else if (/[\u4e00-\u9fa5\s]/.test(d.path)) fail(`audio.${label}.${d.id}.path 含中文或空格：${d.path}`);
      const vol = d.volume !== undefined ? d.volume : d.volume_scale;
      if (!(vol > 0 && vol <= 1)) fail(`audio.${label}.${d.id} 音量必须在 (0,1]`);
    }
    return ids;
  };
  const bgmIds = checkPaths(au.bgm, 'bgm');
  const sfxIds = checkPaths(au.sfx, 'sfx');
  if (!au.run_bgm || bgmIds.indexOf(au.run_bgm) < 0) {
    fail(`audio.run_bgm 必须是已定义的 BGM id（当前：${au.run_bgm}）`);
  }
  note(`音频：BGM ${bgmIds.length} 首（音量 ${master.bgm_volume}）× 音效 ${sfxIds.length} 个（音量 ${master.sfx_volume}）；升级不配音效（用户裁决）`);
}

// Boss 专属大招（boss_ultimates.json，T14-S2b 切片二）：长蓄力 → 生效 → 收招
{
  const bu = T.boss_ultimates ?? {};
  const kinds = ['water_line', 'shockwave', 'delayed_bombs', 'flame_line', 'ring_burst'];
  const need = {
    water_line: ['range_px', 'width_px', 'tick_ms', 'duration_ms', 'damage_ratio'],
    shockwave: ['radius_px', 'knockback_px'],
    delayed_bombs: ['count', 'radius_px', 'delay_ms', 'damage_ratio', 'min_gap_px', 'spread_px'],
    flame_line: ['range_px', 'width_px', 'tick_ms', 'duration_ms', 'damage_ratio', 'burn_dps_ratio', 'burn_ms'],
    ring_burst: ['count', 'speed_px', 'bullet_radius_px', 'life_ms', 'damage_ratio'],
  };
  let ultCount = 0;
  let baseOnly = 0;
  for (const key of Object.keys(bu)) {
    if (key.startsWith('_')) continue;
    const u = bu[key];
    if (u === null) {
      baseOnly++;
      continue; // 该 Boss 只用统一基座（蓄力冲刺 / 跳砸 / 慢速远程 / 加速）
    }
    if (!T.actors.bosses?.[key]) fail(`boss_ultimates.${key} 不是已定义的 Boss 素材（actors.bosses）`);
    if (kinds.indexOf(u.kind) < 0) {
      fail(`boss_ultimates.${key}.kind 无效：${u.kind}（可选 ${kinds.join(' / ')}）`);
      continue;
    }
    for (const f of ['cooldown_ms', 'windup_ms', 'recover_ms']) {
      if (!(u[f] > 0)) fail(`boss_ultimates.${key}.${f} 必须 > 0`);
    }
    for (const f of need[u.kind]) {
      if (!(u[f] > 0)) fail(`boss_ultimates.${key}.${f} 必须 > 0（${u.kind} 的机制参数）`);
    }
    // 用户口径：持续判定每次间隔 0.3–0.5s、总持续 1.5–3s（用户口径已改为 2–3s，兼容早期 1–2s 配置）
    if (u.tick_ms !== undefined && (u.tick_ms < 300 || u.tick_ms > 500)) {
      fail(`boss_ultimates.${key}.tick_ms 应为 300–500（每次判定 0.3–0.5s），当前 ${u.tick_ms}`);
    }
    if (u.duration_ms !== undefined && (u.duration_ms < 1500 || u.duration_ms > 3000)) {
      fail(`boss_ultimates.${key}.duration_ms 应为 1500–3000（持续 1.5–3s；用户口径 2–3s），当前 ${u.duration_ms}`);
    }
    ultCount++;
  }
  note(`Boss 专属大招：${ultCount} 个已配置 · ${baseOnly} 个只用统一基座`);
}

// 敌人变体表（enemy_variants.json，T14-S2）：随层解锁的怪物种类
{
  const ev = T.enemy_variants ?? {};
  if (!(ev.base_weight > 0)) fail('enemy_variants.base_weight 必须 > 0（普通怪的基准权重）');
  const variants = Array.isArray(ev.variants) ? ev.variants : [];
  if (variants.length === 0) fail('enemy_variants.variants 必须是非空数组');
  const seenVariant = new Set();
  let prevMin = 0;
  for (const v of variants) {
    if (!v.id) { fail('enemy_variants 存在无 id 条目'); continue; }
    if (seenVariant.has(v.id)) fail(`enemy_variants 存在重复 id: ${v.id}`);
    seenVariant.add(v.id);
    if (!v.name) fail(`enemy_variants.${v.id} 缺少 name`);
    if (!(Number.isInteger(v.min_layer) && v.min_layer >= 1)) {
      fail(`enemy_variants.${v.id}.min_layer 必须为 >= 1 的整数（解锁层数）`);
    }
    if (!(v.weight > 0)) fail(`enemy_variants.${v.id}.weight 必须 > 0`);
    // 远程投掷种（ranged）：参数必须齐备，且"保持距离"要小于射程（否则永远拉开不了距离）
    if (v.ranged) {
      for (const f of ['cooldown_ms', 'speed_px', 'radius_px', 'life_ms', 'damage_ratio', 'keep_distance_px', 'max_range_px']) {
        if (!(v.ranged[f] > 0)) fail(`enemy_variants.${v.id}.ranged.${f} 必须 > 0`);
      }
      if (v.ranged.keep_distance_px >= v.ranged.max_range_px) {
        fail(`enemy_variants.${v.id}.ranged.keep_distance_px 必须 < max_range_px（否则无法拉开距离）`);
      }
    }
    for (const f of ['hp_ratio', 'atk_ratio', 'speed_ratio', 'render_ratio']) {
      if (f === 'render_ratio' && v[f] === undefined) continue;
      if (!(v[f] > 0)) fail(`enemy_variants.${v.id}.${f} 必须 > 0`);
    }
    if (v.alpha !== undefined && !(v.alpha >= 0 && v.alpha <= 255)) {
      fail(`enemy_variants.${v.id}.alpha 必须在 [0,255]`);
    }
    if (v.color !== undefined) {
      if (!Array.isArray(v.color) || v.color.length < 3
        || v.color.some((c) => !(c >= 0 && c <= 255))) {
        fail(`enemy_variants.${v.id}.color 必须是 3 个 [0,255] 的整数`);
      }
    }
    // 「突然加速」三件套：配了就必须成套，否则行为不生效
    const hasBurst = v.burst_speed_ratio !== undefined || v.burst_ms !== undefined
      || v.burst_interval_ms !== undefined;
    if (hasBurst) {
      if (!(v.burst_speed_ratio > 1)) fail(`enemy_variants.${v.id}.burst_speed_ratio 必须 > 1`);
      if (!(v.burst_ms > 0)) fail(`enemy_variants.${v.id}.burst_ms 必须 > 0`);
      if (!(v.burst_interval_ms > v.burst_ms)) {
        fail(`enemy_variants.${v.id}.burst_interval_ms 必须大于 burst_ms（否则加速不会间断）`);
      }
    }
    if (v.min_layer < prevMin) {
      note(`enemy_variants.${v.id}.min_layer(${v.min_layer}) 小于前一条，建议按威胁度递增排列`);
    }
    prevMin = v.min_layer;
  }
  if (variants.length > 0) {
    const rows = variants.map((v) => `${v.name}(${v.min_layer} 层起)`).join(' → ');
    note(`敌人变体按层解锁：${rows}`);
  }
}

// 玩家技能（skills.json）同样必须有特效：否则按 J/K 看不出"释放了"（实测反馈）
for (const s of (Array.isArray(T.skills) ? T.skills : [])) {
  if (!s.fx) {
    note(`skills.${s.id}（${s.name}）未配置 fx：释放时没有任何特效反馈`);
  } else if (!seenFxKeys.has(s.fx)) {
    fail(`skills.${s.id}.fx 引用了不存在的特效 key: ${s.fx}`);
  }
}

// 性能预算与池化预分配（文档 4.9 / 4.5）
const perfCfg = T.balance.performance;
for (const f of ['max_enemy_count', 'max_bullet_count', 'max_float_text', 'max_effect_count',
  'max_enemy_bullet_count', 'max_danger_zone_count']) {
  if (!(perfCfg && perfCfg[f] > 0)) fail(`balance.performance.${f} 必须 > 0`);
}
for (const [pre, max] of [['preload_bullet', 'max_bullet_count'], ['preload_float_text', 'max_float_text'],
  ['preload_effect', 'max_effect_count'], ['preload_enemy_bullet', 'max_enemy_bullet_count'],
  ['preload_danger_zone', 'max_danger_zone_count']]) {
  if (!(perfCfg && perfCfg[pre] >= 0)) fail(`balance.performance.${pre} 必须 >= 0`);
  else if (perfCfg[pre] > perfCfg[max]) fail(`balance.performance.${pre} 不能超过 ${max}（预分配不得超过硬上限）`);
}
// 地宫参数完整性（阶段 2：房间图 / 走廊 / 刷怪 / 连通性，字段语义见文档 2.3）
const dg = T.dungeon;
for (const f of ['normal_per_room', 'enemy_count_growth', 'max_concurrent']) {
  if (dg.spawn[f] === undefined) fail(`dungeon.spawn 缺少字段 ${f}`);
}
if (!(dg.spawn.normal_per_room >= 1)) fail('dungeon.spawn.normal_per_room 必须 >= 1');
if (!(dg.spawn.max_concurrent >= 1)) fail('dungeon.spawn.max_concurrent 必须 >= 1');
if (!(dg.rooms && dg.rooms.min >= 1)) fail('dungeon.rooms.min 必须 >= 1');
if (!(dg.rooms.max >= dg.rooms.min)) fail('dungeon.rooms.max 必须 >= rooms.min');
if (!(dg.room_size_px.normal > 0 && dg.room_size_px.big > 0)) fail('dungeon.room_size_px.normal/big 必须 > 0');
if (!(dg.room_size_px.big >= dg.room_size_px.normal)) fail('dungeon.room_size_px.big 必须 >= normal');
if (!(dg.corridor_width_px > 0)) fail('dungeon.corridor_width_px 必须 > 0');
if (!(dg.corridor_loop_ratio >= 0 && dg.corridor_loop_ratio <= 1)) fail('dungeon.corridor_loop_ratio 必须在 [0,1]（少量环路比例）');
for (const f of ['corridor_enemies_per_corridor', 'preload_room_hops']) {
  if (!(Number.isInteger(dg.spawn[f]) && dg.spawn[f] >= 0)) fail(`dungeon.spawn.${f} 必须为 >= 0 的整数`);
}
if (!(dg.spawn.activate_radius_px > 0)) fail('dungeon.spawn.activate_radius_px 必须 > 0');
// 持续刷怪参数（用户要求：房间清空后仍会按周期补足敌人）
for (const f of ['respawn_interval_ms', 'respawn_batch_max', 'respawn_min_dist_px']) {
  if (!(dg.spawn[f] > 0)) fail(`dungeon.spawn.${f} 必须 > 0（持续刷怪参数）`);
}
if (dg.spawn.respawn_batch_max > dg.spawn.max_concurrent) {
  fail('dungeon.spawn.respawn_batch_max 不能超过 max_concurrent（同屏硬上限，文档 4.9）');
}
if (!(dg.spawn.respawn_min_dist_px < dg.spawn.activate_radius_px)) {
  fail('dungeon.spawn.respawn_min_dist_px 必须小于 activate_radius_px，否则补足的敌人无法被唤醒');
}
if (!(dg.spawn.deactivate_radius_px > dg.spawn.activate_radius_px)) fail('dungeon.spawn.deactivate_radius_px 必须 > activate_radius_px（滞回，避免抖动）');
if (!(dg.big_room_spawn_rate > 0)) fail('dungeon.big_room_spawn_rate 必须 > 0（大房间刷怪倍率）');
if (!(dg.exit_trigger_radius_px > 0)) fail('dungeon.exit_trigger_radius_px 必须 > 0（出口点触发半径）');
if (dg.exit_trigger_radius_px * 2 > dg.room_size_px.big) fail('dungeon.exit_trigger_radius_px 过大：出口点直径不应超过出口大房尺寸');
if (!(Number.isInteger(dg.boss_every_layers) && dg.boss_every_layers >= 1)) fail('dungeon.boss_every_layers 必须为 >= 1 的整数');
// 注：每局层数上限已移交 `endgame.json` 的模式定义（见前面的终局校验），避免双份真相
if (!(dg.connectivity && dg.connectivity.max_regenerate >= 0)) fail('dungeon.connectivity.max_regenerate 必须 >= 0');

// —— 4. 字段完整性 ——
const classIds = Object.keys(T.characters);
for (const cid of classIds) {
  const c = T.characters[cid];
  for (const f of ['base_hp', 'base_atk', 'atk_speed', 'move_speed_px', 'melee_coeff', 'ranged_coeff', 'render_scale', 'attack_range_px', 'amp_kind']) {
    if (c[f] === undefined) fail(`characters.${cid} 缺少字段 ${f}`);
  }
  if (c.render_scale !== undefined && !(c.render_scale > 0)) {
    fail(`characters.${cid}.render_scale 必须 > 0`);
  }
  if (c.attack_range_px !== undefined && !(c.attack_range_px > 0)) {
    fail(`characters.${cid}.attack_range_px 必须 > 0`);
  }
  // 普攻特性（文档 2.7 职业差异）：字段可选，但配了必须合法；远程职业必须至少有一种特性
  if (c.attack_explode_radius_scale !== undefined && !(c.attack_explode_radius_scale > 0)) {
    fail(`characters.${cid}.attack_explode_radius_scale 必须 > 0（相对角色显示尺寸的半径倍数）`);
  }
  if (c.attack_explode_damage_ratio !== undefined && !(c.attack_explode_damage_ratio > 0)) {
    fail(`characters.${cid}.attack_explode_damage_ratio 必须 > 0`);
  }
  if (c.attack_pierce_count !== undefined && !(Number.isInteger(c.attack_pierce_count) && c.attack_pierce_count >= 0)) {
    fail(`characters.${cid}.attack_pierce_count 必须为 >= 0 的整数`);
  }
  if (c.attack_type === 'ranged'
    && !(c.attack_pierce_count > 0) && !(c.attack_explode_radius_scale > 0)) {
    fail(`characters.${cid} 是远程职业但未配置普攻特性（attack_pierce_count 或 attack_explode_radius_scale）`);
  }
  if (c.attack_type !== 'ranged'
    && ((c.attack_pierce_count ?? 0) > 0 || (c.attack_explode_radius_scale ?? 0) > 0)) {
    note(`characters.${cid} 是近战职业（近战 AOE），配置的子弹特性不会生效`);
  }
}
for (const s of T.skills) {
  for (const f of ['id', 'class_id', 'slot', 'cooldown_ms']) {
    if (s[f] === undefined) fail(`skills 条目缺少字段 ${f} (id=${s.id})`);
  }
  if (!classIds.includes(s.class_id)) fail(`skills.${s.id} 引用不存在的职业 ${s.class_id}`);
}
for (const b of T.buffs) {
  if (!b.id) fail('buffs 存在无 id 条目');
  if (!BUFF_TYPES.includes(b.type)) fail(`buffs.${b.id} type 非法: ${b.type}`);
  if (!Array.isArray(b.effects) || b.effects.length === 0) fail(`buffs.${b.id} 缺少 effects`);
  else for (const e of b.effects) if (!e.kind) fail(`buffs.${b.id} 存在无 kind 的 effect`);
}
// —— 5. 局外养成表（meta.json：类别 / 上限 / 逐级数值 / 效果消费方）——
const META_CATEGORIES = ['attr', 'growth', 'amp', 'function', 'unlock'];
/** 已被代码消费的 effect.kind（新增机制时应同步接入或加入此表，避免出现“买了不生效”的死配置）。 */
const KNOWN_META_KINDS = [
  // 属性类：core/GameState.STAT_KIND_MAP
  'max_hp_up', 'atk_up', 'atk_speed_up', 'crit_rate_up', 'crit_dmg_up', 'move_speed_up',
  'pickup_range_up', 'lifesteal_up', 'hp_regen_up', 'exp_gain_up', 'gold_gain_up',
  // 增幅 / 成长类：伤害公式、子弹、Buff 系统
  'melee_dmg_up', 'magic_dmg_up', 'phys_dmg_up', 'bullet_pierce', 'explode_radius_up',
  'projectile_size_up', 'projectile_speed_up', 'extra_projectile', 'buff_value_up',
  // 解锁类：core/MetaState
  'unlock_class', 'buff_slot', 'behavior_skill_slot',
  // 功能类：技能系统（技能 1/2 的时长 / 冷却 / 效果 / 范围）
  'skill_duration_up', 'skill_cd_down', 'skill_effect_up', 'skill_range_up',
];
const seenMetaIds = new Set();
for (const m of T.meta) {
  if (!m.id) { fail('meta 存在无 id 条目'); continue; }
  if (seenMetaIds.has(m.id)) fail(`meta 存在重复 id: ${m.id}`);
  seenMetaIds.add(m.id);
  if (!m.name) fail(`meta.${m.id} 缺少 name`);
  if (!META_CATEGORIES.includes(m.category)) {
    fail(`meta.${m.id}.category 非法: ${m.category}（应为 ${META_CATEGORIES.join(' / ')} 之一）`);
  }
  if (m.max_level === undefined) fail(`meta.${m.id} 缺少 max_level`);
  else if (!(Number.isInteger(m.max_level) && m.max_level >= 1)) {
    fail(`meta.${m.id}.max_level 必须为 >= 1 的整数`);
  }
  if (m.price_multiplier !== undefined && !(m.price_multiplier > 0)) {
    fail(`meta.${m.id}.price_multiplier 必须 > 0`);
  }
  if (m.fixed_price !== undefined && !(m.fixed_price > 0)) {
    fail(`meta.${m.id}.fixed_price 必须 > 0（固定价，用于解锁类）`);
  }
  if (m.enabled !== undefined && typeof m.enabled !== 'boolean') {
    fail(`meta.${m.id}.enabled 必须为布尔值（false = 该项暂不启用，不展示不可购买）`);
  }
  if (!m.effect || !m.effect.kind) { fail(`meta.${m.id} 缺少 effect.kind`); continue; }
  if (m.effect.kind === 'unlock_class' && !classIds.includes(m.effect.value)) {
    fail(`meta.${m.id} 解锁不存在的职业 ${m.effect.value}`);
  }
  if (m.category !== 'unlock' && typeof m.effect.per_level !== 'number') {
    fail(`meta.${m.id} 缺少 effect.per_level（非解锁类养成必须有逐级数值）`);
  }
  if (typeof m.effect.per_level === 'number' && !(m.effect.per_level > 0)) {
    fail(`meta.${m.id}.effect.per_level 必须 > 0`);
  }
  if (!KNOWN_META_KINDS.includes(m.effect.kind)) {
    note(`meta.${m.id} 的 effect.kind「${m.effect.kind}」尚无消费方（需同步接入，否则买了不生效）`);
  }
}
if (!(typeof T.dungeon.view_zoom === 'number' && T.dungeon.view_zoom >= 0.5 && T.dungeon.view_zoom <= 3)) {
  fail('dungeon.view_zoom 必须为 0.5 ~ 3 的数值（画面缩放：> 1 放大、视野变窄）');
}

if (['auto', 'portrait', 'landscape'].indexOf(T.balance.layout_mode) < 0) {
  fail('balance.layout_mode 必须是 auto / portrait / landscape 之一（auto 按窗口宽高比自动判定）');
}

const metaPrice = T.balance.meta_price;
if (!(metaPrice && metaPrice.base_price > 0)) fail('balance.meta_price.base_price 必须 > 0');
if (!(metaPrice && metaPrice.price_growth >= 1)) fail('balance.meta_price.price_growth 必须 >= 1（价格单调递增）');
if (!(typeof T.balance.meta_start_gold === 'number' && T.balance.meta_start_gold >= 0)) {
  fail('balance.meta_start_gold 必须为 >= 0 的数值（新档初始金币）');
}
if (!(Number.isInteger(T.balance.save_slots) && T.balance.save_slots >= 1)) {
  fail('balance.save_slots 必须为 >= 1 的整数（存档槽数量）');
}
// —— 汇总 ——
function report() {
  console.log('\n=== 数值校验 ===');
  if (errors.length === 0) {
    console.log(`PASS：${TABLE_COUNT_HINT} 张配置表全部通过（${TABLES.length} 表）。`);
  } else {
    console.log(`FAIL：发现 ${errors.length} 个错误：`);
    for (const e of errors) console.log('  [E] ' + e);
  }
  if (warn.length) { console.log('提示：'); for (const w of warn) console.log('  [W] ' + w); }
}
report();
process.exit(errors.length === 0 ? 0 : 1);

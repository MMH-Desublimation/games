/**
 * 离线自检 · 存档版本迁移（**宪法 6.8**：结构变更必须 +1 version 并提供迁移函数）。
 *
 * 为什么需要它：迁移是最容易"悄悄坏掉、代价最大"的一段逻辑 —— 玩家升级版本后读不出旧档 = 直接丢进度。
 * 而 `SaveManager` 依赖 `cc.sys.localStorage`，在 Node 里跑不起来；所以迁移被抽成纯函数模块
 * `assets/scripts/save/SaveMigration.ts`（`import type` 编译后被消除，产物零依赖），本脚本：
 *   1. 用项目自带的 tsc 把 `SaveMigration.ts` 单独编译成 CommonJS；
 *   2. 用**各历史版本的样例存档**（v1 / v2 / v3 / v4 / 损坏档）逐一验证迁移结果；
 *   3. 断言迁移后**必备字段齐全**（缺一个就是"读档后界面炸"或"数据丢失"）。
 *
 * 用法：`node tools/test_save_migration.js`（退出码 1 = 有用例失败）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TSC = 'E:/Cocos Creator/Creator/3.8.7/resources/app.asar.unpacked/node_modules/typescript/bin/tsc';

// —— 1) 编译纯迁移模块到临时目录 ——
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'savemig-'));
const tsFile = path.join(ROOT, 'assets', 'scripts', 'save', 'SaveMigration.ts');

function build() {
  const args = [
    '--target', 'es2020', '--module', 'commonjs',
    '--outDir', outDir, '--skipLibCheck', '--moduleResolution', 'node',
    '--noEmitOnError', 'false',
    tsFile,
  ];
  const tscPath = fs.existsSync(TSC) ? TSC : path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tscPath, ...args], { stdio: 'pipe' });
  } catch (e) {
    // tsc 的报错走 stdout；这里**刻意忽略退出码**：
    // SaveMigration.ts 只用 `import type`（编译后消除），所以即使 tsc 因为解析不到 `cc` 类型而报错，
    // 产出的 SaveMigration.js 依然是正确、无依赖的纯函数模块 —— 只要产物存在就继续。
    const msg = `${e.stdout ?? ''}${e.stderr ?? ''}`.toString().trim();
    if (msg) {
      console.log(`  [i] tsc 有类型报错（不影响产物，已忽略）：${msg.split('\n')[0].slice(0, 160)}`);
    }
  }
}

let compiled = null;
function findCompiled(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      const hit = findCompiled(full);
      if (hit) return hit;
    } else if (name === 'SaveMigration.js') {
      return full;
    }
  }
  return null;
}

try {
  build();
  compiled = findCompiled(outDir);
} catch (e) {
  console.error('[E] 编译 SaveMigration.ts 时发生异常：', (e.message || '').toString().slice(0, 400));
  process.exit(1);
}
if (!compiled) {
  console.error('[E] 未找到编译产物 SaveMigration.js（编译器未产出文件）');
  process.exit(1);
}
// 产物必须是"零 import"的纯模块，否则说明有运行时依赖漏进来了
{
  const js = fs.readFileSync(compiled, 'utf8');
  const imports = js.split('\n').filter((l) => /require\(/.test(l));
  if (imports.length > 0) {
    console.error(`[E] 迁移模块不应有任何运行时依赖，但产物里有：${imports.map((s) => s.trim()).join(' | ')}`);
    process.exit(1);
  }
}

const mig = require(compiled);
const { SAVE_VERSION, migrateSave } = mig;

let failed = 0;
const fail = (msg) => { console.error(`  [E] ${msg}`); failed++; };
const ok = (msg) => console.log(`  [W] ${msg}`);

console.log(`目标版本 SAVE_VERSION = ${SAVE_VERSION}`);

// —— 2) 断言助手 ——
/** 迁移后「必备字段」必须齐全（缺一个 = 读档后 MetaState.loadFrom 会拿到 undefined）。 */
function assertShape(label, out) {
  if (!out || typeof out !== 'object') {
    fail(`${label}: 迁移返回空`);
    return;
  }
  if (out.version !== SAVE_VERSION) fail(`${label}: version 应为 ${SAVE_VERSION}，实际 ${out.version}`);
  const d = out.data;
  if (!d) { fail(`${label}: 缺 data`); return; }
  for (const f of ['levels', 'unlockedClasses', 'buffSlots', 'behaviorSkillSlots', 'itemSlots', 'gold']) {
    if (d.meta?.[f] === undefined) fail(`${label}: data.meta.${f} 缺失`);
  }
  for (const f of ['maxLayerCleared', 'baseCleared', 'normalBestLayer', 'challengeBestLayer', 'currentRun']) {
    if (d.progress?.[f] === undefined) fail(`${label}: data.progress.${f} 缺失`);
  }
  for (const f of ['totalRuns', 'totalKills']) {
    if (d.stats?.[f] === undefined) fail(`${label}: data.stats.${f} 缺失`);
  }
}

// —— 3) 用例 ——

// 3.1 v1：单槽时代，meta 在顶层，字段可能很旧
console.log('\n[用例 1] v1 顶层 meta（最老的档）');
{
  const out = migrateSave({
    version: 1,
    timestamp: 111,
    meta: { gold: 250, levels: { amp_hp: 3 }, unlockedClasses: ['warrior', 'mage'] },
  });
  assertShape('v1', out);
  if (out?.data?.meta?.gold !== 250) fail(`v1: gold 应保留为 250，实际 ${out?.data?.meta?.gold}`);
  if (out?.data?.meta?.levels?.amp_hp !== 3) fail('v1: levels 应保留');
  if (!Array.isArray(out?.data?.meta?.unlockedClasses) || out.data.meta.unlockedClasses.length !== 2) {
    fail('v1: unlockedClasses 应保留 2 项');
  }
  if (out?.data?.progress?.baseCleared !== false) fail('v1: baseCleared 应兜底为 false');
  if (out?.data?.progress?.currentRun !== null) fail('v1: currentRun 应兜底为 null');
  ok('v1 → v4：金币/等级/职业保留，progress/stats 兜底');
}

// 3.2 v2：顶层 meta，但缺很多字段（老玩家可能只买了金币）
console.log('\n[用例 2] v2 顶层 meta 且字段残缺');
{
  const out = migrateSave({ version: 2, timestamp: 222, meta: { gold: 10 } });
  assertShape('v2', out);
  if (out?.data?.meta?.gold !== 10) fail('v2: gold 应保留 10');
  if (!Array.isArray(out?.data?.meta?.unlockedClasses) || out.data.meta.unlockedClasses[0] !== 'warrior') {
    fail('v2: unlockedClasses 缺失时应兜底为 ["warrior"]');
  }
  if (out?.data?.meta?.buffSlots !== 0) fail('v2: buffSlots 应留 0（由 MetaState 按配置校正）');
  ok('v2 → v4：残缺字段全部兜底，未硬编码配置数值');
}

// 3.3 v3：data 结构已存在，但缺终局字段（baseCleared / normalBestLayer / challengeBestLayer）
console.log('\n[用例 3] v3 缺终局字段（本次结构升级的直接对象）');
{
  const out = migrateSave({
    version: 3,
    timestamp: 333,
    checksum: 'abc',
    data: {
      meta: { levels: {}, unlockedClasses: ['warrior'], buffSlots: 4, behaviorSkillSlots: 3, itemSlots: 0, gold: 999 },
      progress: { maxLayerCleared: 17, currentRun: null },
      stats: { totalRuns: 8, totalKills: 1234 },
    },
  });
  assertShape('v3', out);
  if (out?.data?.progress?.maxLayerCleared !== 17) fail('v3: 已有的 maxLayerCleared=17 不应被覆盖');
  if (out?.data?.progress?.baseCleared !== false) fail('v3: 缺 baseCleared 应兜底 false');
  if (out?.data?.progress?.normalBestLayer !== 0) fail('v3: 缺 normalBestLayer 应兜底 0');
  if (out?.data?.stats?.totalKills !== 1234) fail('v3: stats 应保留');
  if (out?.checksum !== 'abc') fail('v3: checksum 应保留（读档时用于校验）');
  ok('v3 → v4：终局字段补齐、既有进度与 stats 未被覆盖');
}

// 3.4 v3 且 lastRun 正在进行中（currentRun 必须**原样保留**，否则玩家续玩会丢进度）
console.log('\n[用例 4] v3 带未完成的一局（currentRun 必须保留）');
{
  const run = { classId: 'ranger', layer: 12, level: 25, hp: 40, buffs: ['a', 'b'], gold: 77 };
  const out = migrateSave({
    version: 3,
    timestamp: 444,
    data: {
      meta: { levels: {}, unlockedClasses: ['warrior', 'ranger'], buffSlots: 0, behaviorSkillSlots: 0, itemSlots: 0, gold: 0 },
      progress: { maxLayerCleared: 11, currentRun: run },
      stats: { totalRuns: 3, totalKills: 500 },
    },
  });
  assertShape('v3+run', out);
  const got = out?.data?.progress?.currentRun;
  if (!got || got.classId !== 'ranger' || got.layer !== 12 || got.gold !== 77) {
    fail(`v3+run: currentRun 应原样保留，实际 ${JSON.stringify(got)}`);
  }
  ok('v3 → v4：进行中的一局完整保留（续玩不丢进度）');
}

// 3.5 已是当前版本：应原样通过（幂等）
console.log('\n[用例 5] 当前版本 v4（幂等：再迁移一次结果不变）');
{
  const src = {
    version: 4,
    timestamp: 555,
    checksum: 'zz',
    data: {
      meta: { levels: { x: 1 }, unlockedClasses: ['warrior'], buffSlots: 7, behaviorSkillSlots: 6, itemSlots: 0, gold: 5 },
      progress: { maxLayerCleared: 25, baseCleared: true, normalBestLayer: 3, challengeBestLayer: 9, currentRun: null },
      stats: { totalRuns: 20, totalKills: 9999 },
    },
  };
  const out = migrateSave(JSON.parse(JSON.stringify(src)));
  assertShape('v4', out);
  if (out?.data?.progress?.baseCleared !== true) fail('v4: baseCleared=true 必须保留');
  if (out?.data?.progress?.challengeBestLayer !== 9) fail('v4: challengeBestLayer 必须保留');
  if (out?.data?.meta?.buffSlots !== 7) fail('v4: buffSlots=7 必须保留');
  // 幂等
  const again = migrateSave(JSON.parse(JSON.stringify(out)));
  if (JSON.stringify(again) !== JSON.stringify(out)) fail('v4: 迁移不幂等（再次迁移结果变了）');
  ok('v4：原样通过且幂等');
}

// 3.6 损坏档：必须返回 null（调用方按"档损坏"处理，而不是崩溃）
console.log('\n[用例 6] 损坏 / 不可识别的档（必须返回 null 而不是抛错）');
{
  const bad = [
    ['null', null],
    ['非对象', 'hello'],
    ['缺 version', { meta: { gold: 1 } }],
    ['version 非数字', { version: 'x', meta: {} }],
    ['v3 但缺 data', { version: 3, timestamp: 1 }],
    ['v3 但 data 缺 meta', { version: 3, timestamp: 1, data: { progress: {} } }],
    ['v9 未来版本且缺 data', { version: 9, timestamp: 1 }],
  ];
  for (const [label, input] of bad) {
    let out;
    try {
      out = migrateSave(input);
    } catch (e) {
      fail(`${label}: 抛异常了（应返回 null）：${e.message}`);
      continue;
    }
    if (out !== null) fail(`${label}: 应返回 null，实际 ${JSON.stringify(out).slice(0, 80)}`);
  }
  ok('损坏档全部安全返回 null（不抛异常）');
}

// —— 4) 汇总 ——
console.log('');
if (failed > 0) {
  console.error(`FAIL：存档迁移自检发现 ${failed} 个问题`);
  process.exit(1);
}
console.log('PASS：存档迁移自检通过（v1 / v2 / v3 / v3+续玩 / v4 幂等 / 6 类损坏档）。');

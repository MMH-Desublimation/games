/**
 * 离线自检 · 模块引用完整性（护栏脚本）。
 *
 * 背景（真实事故）：用脚本删除模块文件时，若按 `\n` 匹配而行尾是 `\r\n`，替换会**静默失败**，
 * 结果留下指向已删除文件的 `import`；浏览器端报「以 …/Boot.ts 为起点找不到模块」，脚本编译失败，
 * 场景里挂在 Boot 节点上的组件随之失效 —— 整个项目**无法启动**。
 *
 * 本脚本扫描 `assets/scripts/**\/*.ts` 中所有**相对路径 import**，逐一确认目标文件存在；
 * 有问题则退出码 1（可接入 CI / 交接自检流程）。
 *
 * 用法：`node tools/check_imports.js`
 */
const fs = require('fs');
const path = require('path');

const scriptRoot = path.join(__dirname, '..', 'assets', 'scripts');

if (!fs.existsSync(scriptRoot)) {
  console.error(`[E] 目录不存在：${scriptRoot}`);
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      walk(full);
    } else if (name.endsWith('.ts')) {
      files.push(full);
    }
  }
};
walk(scriptRoot);

const missing = [];
const re = /['"](\.[^'"]+)['"]/g;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    const abs = path.resolve(path.dirname(file), spec);
    const ok = fs.existsSync(`${abs}.ts`)
      || fs.existsSync(path.join(abs, 'index.ts'))
      || fs.existsSync(abs);
    if (!ok) {
      missing.push(`${path.relative(scriptRoot, file)} → ${spec}`);
    }
  }
}

if (missing.length > 0) {
  console.error(`FAIL：发现 ${missing.length} 处无效模块引用（会导致启动失败）：`);
  for (const item of missing) {
    console.error(`  [E] ${item}`);
  }
  process.exit(1);
}
console.log(`PASS：模块引用完整（${files.length} 个 TS 文件的相对 import 全部存在）。`);

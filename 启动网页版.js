#!/usr/bin/env node
/**
 * **地牢生存 · 网页版本地启动器**
 *
 * 用法：双击 `启动网页版.bat`，或执行 `node launcher_web.js [端口]`。
 * 本机会起一个静态服务器并**自动打开浏览器**；手机同 WiFi 可用打印出的局域网地址访问。
 *
 * 为什么需要它：浏览器对 `file://` 协议有同源限制，引擎的 `.wasm` 与资源加载会被拦下
 * （表现为黑屏）⇒ **必须经 HTTP 访问**，双击 `index.html` 是不行的。
 *
 * 自动定位产物目录：本脚本既随发行包分发（同级有 `web/`），也在仓库的 `tools/` 下
 * （对应 `../build/web-mobile/`）—— 两种布局都支持。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

/**
 * 依次尝试的产物目录（覆盖所有真实布局）：
 * 1. `web/`  —— 惯例目录名；
 * 2. 启动器**同目录**（发行包里把启动器与 `index.html` 放在一起）；
 * 3. `../build/web-mobile` —— 在仓库 `tools/` 下运行；
 * 4. **自动扫描**本目录下任一"含 `index.html` 的子目录" —— 发行包的目录名可能是中文
 *    （如 `网页版/`），不能靠固定名字去找。
 */
function findRoot() {
  const candidates = [
    path.join(__dirname, 'web'),
    __dirname,
    path.join(__dirname, '..', 'build', 'web-mobile'),
  ];
  const hit = candidates.find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (hit) {
    return hit;
  }
  try {
    for (const ent of fs.readdirSync(__dirname, { withFileTypes: true })) {
      if (!ent.isDirectory()) {
        continue;
      }
      const p = path.join(__dirname, ent.name);
      if (fs.existsSync(path.join(p, 'index.html'))) {
        return p;
      }
    }
  } catch (e) {
    /* 忽略：下面统一报错 */
  }
  return null;
}
const ROOT = findRoot();
const PORT = Number(process.argv[2]) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
  '.bin': 'application/octet-stream',
};

/** 一律禁用缓存：产物文件名固定时，浏览器强缓存会导致"改了没用"（实测踩过）。 */
const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', ...NO_CACHE });
  res.end(body);
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, '404 Not Found');
      return;
    }
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

if (!ROOT) {
  console.error('[启动器] 找不到网页版产物（尝试过：');
  for (const c of CANDIDATES) {
    console.error(`           ${c}`);
  }
  console.error('[启动器] 请先构建：powershell -File tools/build.ps1 -Platform web-mobile');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const target = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!target.startsWith(ROOT)) {
    send(res, 403, '403 Forbidden');
    return;
  }
  fs.stat(target, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(res, target);
      return;
    }
    if (!err && stat.isDirectory() && fs.existsSync(path.join(target, 'index.html'))) {
      sendFile(res, path.join(target, 'index.html'));
      return;
    }
    sendFile(res, path.join(ROOT, 'index.html')); // 其余交给入口页
  });
});

/** 端口被占用时自动顺延。 */
function listen(port, tries = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < 20) {
      listen(port + 1, tries + 1);
    } else {
      console.error('[启动器] 启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    const url = `http://localhost:${port}`;
    console.log('==================================================');
    console.log('  地牢生存 · 网页版已启动');
    console.log('==================================================');
    console.log(`  产物目录：${ROOT}`);
    console.log(`  本机打开：${url}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) {
        if (it.family === 'IPv4' && !it.internal) {
          console.log(`  手机打开（同一 WiFi）：http://${it.address}:${port}`);
        }
      }
    }
    console.log('');
    console.log('  关闭本窗口即停止服务。');
    console.log('==================================================');
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => { /* 打不开也不影响，手动访问打印的地址即可 */ });
  });
}

listen(PORT);

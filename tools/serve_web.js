#!/usr/bin/env node
/**
 * **本地静态服务器**（把 `build/web-mobile` 发布到局域网，手机浏览器直接打开测试）。
 *
 * 用法：
 * ```powershell
 * node tools/serve_web.js            # 默认 8080 端口
 * node tools/serve_web.js 9000       # 指定端口
 * ```
 * 启动后终端会打印**手机可访问的地址**（手机与电脑需在同一 WiFi）。
 *
 * 为什么需要它：手机端测试 UI 适配（竖屏布局 / 触摸 / 摇杆）时，浏览器打开的页面
 * 必须由 HTTP 提供（`file://` 下引擎的 wasm / 资源加载会被浏览器的同源策略拦下）。
 * 未安装 Android 工具链、暂时出不了 APK 时，这是**最快的真机验证途径**。
 *
 * 说明：只用 Node 内置模块，不需要 `npm install` 任何依赖。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', 'build', 'web-mobile');
const PORT = Number(process.argv[2]) || 8080;

/** 扩展名 → Content-Type（wasm / mjs 必须正确，否则引擎起不来）。 */
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

/**
 * ⚠️ **一律禁用缓存**（尤其是 `index.js` / `assets/**` 这些**文件名固定**的产物）。
 *
 * 为什么必须这样：Cocos 构建默认 `md5Cache = false` ⇒ 产物文件名不变 ⇒
 * 手机浏览器（尤其夸克/UC 这类）会**强缓存**，刷新页面也仍然跑旧代码 ——
 * 表现为"改了好几轮，问题依旧"（用户实测踩到）。
 */
const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', ...NO_CACHE });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, '404 Not Found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    send(res, 200, data, type);
  });
}

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`[serve_web] 找不到 ${ROOT}\\index.html`);
  console.error('[serve_web] 请先构建：CocosCreator.exe --project <项目> --build "platform=web-mobile"');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const target = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  // 防目录穿越：必须仍在 ROOT 之内
  if (!target.startsWith(ROOT)) {
    send(res, 403, '403 Forbidden');
    return;
  }
  fs.stat(target, (err, stat) => {
    if (!err && stat.isFile()) {
      serveFile(res, target);
      return;
    }
    // 目录请求 ⇒ 取其 index.html；其余交给入口页（单页应用）
    if (!err && stat.isDirectory()) {
      const index = path.join(target, 'index.html');
      if (fs.existsSync(index)) {
        serveFile(res, index);
        return;
      }
    }
    serveFile(res, path.join(ROOT, 'index.html'));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) {
        addrs.push(it.address);
      }
    }
  }
  console.log(`[serve_web] 已发布 ${ROOT}`);
  console.log(`[serve_web] 本机：http://localhost:${PORT}`);
  for (const a of addrs) {
    console.log(`[serve_web] 手机（同一 WiFi）：http://${a}:${PORT}`);
  }
  console.log('[serve_web] 手机上竖持打开即可验证竖屏布局；Ctrl+C 结束。');
});

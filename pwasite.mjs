// PWA pass-through: a project that already is an installable static PWA (manifest + service worker, or a strict CSP
// that forbids inline scripts) must NOT be inlined into one HTML file (that drops the manifest/sw and breaks the CSP).
// It is copied as-is to outputs/<name>/ and outputs/<name>.html becomes a tiny launcher that opens it.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const MIME = {'.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.map': 'application/json'};
const has = (root, f) => fs.existsSync(path.join(root, f));

export function detectPwaSite(root, info, isSourceHtml) {
  if (!info.hasIndex || isSourceHtml) return null;
  if (info.py || info.manage || info.php) return null;
  if (info.pkg && (info.pkg.scripts?.build || info.deps?.vite)) return null;      // a build project: the build strategy handles it
  const idx = ['index.html', 'index.htm'].map(n => path.join(root, n)).find(fs.existsSync);
  const h = fs.readFileSync(idx, 'utf8');
  const manifest = has(root, 'manifest.webmanifest') || has(root, 'manifest.json') || /rel=["']manifest["']/i.test(h);
  const sw = ['sw.js', 'service-worker.js', 'serviceworker.js'].some(f => has(root, f)) || /serviceWorker\s*\.register/.test(h);
  const m = /http-equiv=["']Content-Security-Policy["'][\s\S]*?content=(?:"([^"]*)"|'([^']*)')/i.exec(h);
  const csp = m ? (m[1] ?? m[2]) : '';
  const strictCsp = !!csp && /script-src[^;]*'self'/.test(csp) && !/script-src[^;]*'unsafe-inline'/.test(csp);
  if (!((manifest && sw) || strictCsp)) return null;
  return {manifest, sw, strictCsp};
}

export function pwaWarnings(root) {
  const w = [];
  for (const f of ['manifest.webmanifest', 'manifest.json']) {
    if (!has(root, f)) continue;
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    if (/"(start_url|scope)"\s*:\s*"\/[^"]*"/.test(t)) w.push(`${f}: start_url/scope start with "/" — on GitHub Pages sub-folders use "./"`);
  }
  for (const f of fs.readdirSync(root)) {
    if (!/\.(m?js|html?)$/i.test(f)) continue;
    const p = path.join(root, f);
    if (fs.statSync(p).size > 400000) continue;
    if (/serviceWorker\s*\.register\(\s*['"]\//.test(fs.readFileSync(p, 'utf8'))) w.push(`${f}: service worker registered with an absolute "/" path — use "./sw.js"`);
  }
  return w;
}

export const launcherHtml = name => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title><meta http-equiv="refresh" content="0;url=./${encodeURIComponent(name)}/"></head>
<body style="font:16px system-ui;padding:24px"><p>Opening <a href="./${encodeURIComponent(name)}/">${name}</a> …</p></body></html>
`;

export function copySite(root, outDir) {
  fs.rmSync(outDir, {recursive: true, force: true});
  let files = 0, bytes = 0;
  const walk = (src, dst) => {
    fs.mkdirSync(dst, {recursive: true});
    for (const e of fs.readdirSync(src, {withFileTypes: true})) {
      if (['node_modules', '.git', '.DS_Store'].includes(e.name)) continue;
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) walk(s, d);
      else if (e.isFile()) { fs.copyFileSync(s, d); files++; bytes += fs.statSync(s).size; }
    }
  };
  walk(root, outDir);
  return {files, bytes};
}

export async function serveDir(dir) {
  const base = path.resolve(dir);
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(base, p);
    if (!f.startsWith(base) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'});
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close()};
}

// Files referenced by index.html/manifest that sit next to the project folder (e.g. icons at the zip root) are pulled in too.
export function fillFromParent(root, parent, outDir) {
  if (!parent || path.resolve(parent) === path.resolve(root)) return [];
  const refs = new Set();
  for (const f of ['index.html', 'index.htm', 'manifest.webmanifest', 'manifest.json']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/["'(]\.?\/?([\w.-]+\.(?:png|svg|ico|jpe?g|webp))["')]/gi)) refs.add(m[1]);
  }
  const added = [];
  for (const n of refs) {
    if (fs.existsSync(path.join(root, n)) || !fs.existsSync(path.join(parent, n))) continue;
    fs.copyFileSync(path.join(parent, n), path.join(outDir, n)); added.push(n);
  }
  return added;
}

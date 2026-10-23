#!/usr/bin/env node
// anyhtml — any project / archive / file  ->  ONE self-contained, iPhone-friendly HTML file.
//
// Usage:  node anyhtml.mjs <input.zip|dir|file> [output.html] [--desktop]
//
// Strategy chain (first one that works wins, last one always works):
//   build     package.json project -> npm install -> build (Vite = true single file) -> inline
//   static    plain HTML/CSS/JS site (multi-page supported) -> inline everything
//   serve     backend/dev-server project (node/python/php) -> install -> run -> crawl+snapshot pages
//   explorer  anything else -> embedded file explorer/viewer (md, csv, json, code, images, pdf ...)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';
import * as cheerio from 'cheerio';
import * as esbuild from 'esbuild';
import {serverToBrowser} from './server2browser.mjs';
import {detectPwaSite, pwaWarnings, launcherHtml, copySite, serveDir, fillFromParent} from './pwasite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTES = [];
const note = (...a) => { const s = a.join(' '); NOTES.push(s); console.log('•', s.length > 400 ? s.slice(0, 400) + '…' : s); };
const MAX_ASSET = 30 * 1024 * 1024;
const VIRT = 'http://anyhtml.local/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter(a => a.startsWith('--')));
const POS = ARGS.filter(a => !a.startsWith('--'));

const MIME = {html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain', csv: 'text/csv',
  wasm: 'application/wasm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', pdf: 'application/pdf',
  xml: 'application/xml', md: 'text/markdown'};
const mimeOf = f => MIME[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream';
const dataUri = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;
const read = f => fs.readFileSync(f, 'utf8');
const exists = f => fs.existsSync(f);
const posix = p => p.split(path.sep).join('/');
const safeScript = s => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const safeStyle = s => s.replace(/<\/style/gi, '<\\/style');
const jsonForHtml = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const WIN = process.platform === 'win32';
const PY = WIN ? 'python' : 'python3';
function sh(cmd, {cwd, env, timeout = 20 * 60 * 1000, allowFail = false} = {}) {
  note('$', cmd);
  const r = spawnSync(cmd, {shell: true, cwd, env: {...process.env, ...env}, encoding: 'utf8', timeout, maxBuffer: 1 << 28});
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !allowFail) throw new Error(`command failed (${r.status}): ${cmd}\n${out.slice(-1800)}`);
  return {ok: r.status === 0, out};
}

/* ───────────────────────── input handling ───────────────────────── */

function extractInput(input, dest) {
  fs.mkdirSync(dest, {recursive: true});
  const st = fs.statSync(input);
  if (st.isDirectory()) { fs.cpSync(input, dest, {recursive: true}); return; }
  const buf = fs.readFileSync(input);
  const name = path.basename(input).toLowerCase();
  const looksZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b && !/\.(docx|xlsx|pptx|epub|jar|apk|odt|ods|odp)$/.test(name);
  if (looksZip) {
    const destR = path.resolve(dest);
    const files = unzipSync(new Uint8Array(buf));
    for (const [n, data] of Object.entries(files)) {
      if (n.endsWith('/') || n.startsWith('__MACOSX/') || path.basename(n) === '.DS_Store') continue;
      const t = path.resolve(dest, n);
      if (!t.startsWith(destR + path.sep)) continue; // zip-slip guard
      fs.mkdirSync(path.dirname(t), {recursive: true});
      fs.writeFileSync(t, data);
    }
    return;
  }
  if (/\.(tar\.gz|tgz|tar|tar\.bz2|tar\.xz)$/.test(name)) {
    const r = spawnSync('tar', ['-xf', input, '-C', dest]);
    if (r.status === 0) return;
  }
  fs.copyFileSync(input, path.join(dest, path.basename(input)));
}

const SKIP = new Set(['node_modules', '.git', '__MACOSX', '.venv', 'venv', '__pycache__', '.next', '.cache']);
const listDir = d => fs.readdirSync(d, {withFileTypes: true}).filter(e => !SKIP.has(e.name) && e.name !== '.DS_Store');
const MARKS = ['package.json', 'index.html', 'index.htm', 'requirements.txt', 'app.py', 'main.py', 'manage.py', 'index.php'];

function findRoot(dir) {
  let cur = dir;
  for (;;) {
    const es = listDir(cur);
    if (es.length === 1 && es[0].isDirectory()) cur = path.join(cur, es[0].name); else break;
  }
  if (MARKS.some(m => exists(path.join(cur, m)))) return cur;
  const q = [[cur, 0]];
  while (q.length) {
    const [d, l] = q.shift();
    for (const e of listDir(d)) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (MARKS.some(m => exists(path.join(p, m)))) return p;
      if (l < 2) q.push([p, l + 1]);
    }
  }
  return cur;
}

function walk(root, limit = 5000) {
  const out = [];
  (function rec(d) {
    for (const e of listDir(d)) {
      if (out.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p); else if (e.isFile()) out.push(p);
    }
  })(root);
  return out;
}

function detect(root) {
  const has = f => exists(path.join(root, f));
  let pkg = null;
  if (has('package.json')) { try { pkg = JSON.parse(read(path.join(root, 'package.json'))); } catch { note('package.json unreadable'); } }
  const htmls = walk(root, 3000).filter(f => /\.html?$/i.test(f) && !/node_modules/.test(f));
  const py = ['app.py', 'main.py', 'server.py', 'run.py', 'wsgi.py', 'application.py'].find(has);
  return {pkg, deps: {...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {})}, htmls, hasIndex: has('index.html') || has('index.htm'),
    py, manage: has('manage.py'), php: has('index.php') || walk(root, 500).some(f => f.endsWith('.php'))};
}

const sourceHtml = (root) => {
  const f = ['index.html', 'index.htm'].map(n => path.join(root, n)).find(exists);
  return !!f && /<script[^>]+src=["'][^"']+\.(tsx?|jsx|vue|svelte)["']/i.test(read(f));
};

/* ───────────────────────── HTML inliner ───────────────────────── */

const netCache = new Map();
async function netFetch(url) {
  if (netCache.has(url)) return netCache.get(url);
  let res = null;
  try {
    const r = await fetch(url, {headers: {'user-agent': UA, accept: '*/*'}, signal: AbortSignal.timeout(25000), redirect: 'follow'});
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      res = {buf, mime: (r.headers.get('content-type') || '').split(';')[0] || mimeOf(new URL(url).pathname), url: r.url || url};
    }
  } catch (e) { note('network fetch failed:', url, String(e.message || e)); }
  netCache.set(url, res);
  return res;
}

function dirFetcher(root, net = true) {
  const rootR = path.resolve(root);
  const virtOrigin = new URL(VIRT).origin;
  return async function get(ref, base) {
    let u;
    try { u = new URL(String(ref).trim(), base); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    if (u.origin === virtOrigin) {
      let rel; try { rel = decodeURIComponent(u.pathname); } catch { rel = u.pathname; }
      const p = path.resolve(rootR, rel.replace(/^\/+/, ''));
      if (!p.startsWith(rootR) || !exists(p) || !fs.statSync(p).isFile()) return null;
      return {buf: fs.readFileSync(p), mime: mimeOf(p), url: u.href.split('#')[0], file: p};
    }
    return net ? netFetch(u.href.split('#')[0]) : null;
  };
}

async function inlineCss(css, base, get, depth = 0) {
  const imps = [...css.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?([^;]*);/g)];
  for (const m of imps) {
    const r = depth < 8 ? await get(m[2], base) : null;
    if (!r) continue;
    let inner = await inlineCss(r.buf.toString('utf8'), r.url, get, depth + 1);
    if (m[3].trim()) inner = `@media ${m[3].trim()}{${inner}}`;
    css = css.replace(m[0], () => inner);
  }
  const RE = /url\(\s*(['"]?)(?!data:|#|about:|blob:)([^'")]+?)\1\s*\)/g;
  const seen = new Map();
  for (const m of css.matchAll(RE)) {
    if (seen.has(m[2])) continue;
    const r = await get(m[2], base);
    seen.set(m[2], r && r.buf.length < MAX_ASSET ? dataUri(r.buf, r.mime) : null);
  }
  return css.replace(RE, (m, q, ref) => seen.get(ref) ? `url("${seen.get(ref)}")` : m);
}

const ASSET_RE = /(["'`])((?:\.{0,2}\/)*[\w\-.~@%+\/]+\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp3|wav|ogg|mp4|webm|json|txt|csv|glb|gltf|bin|wasm|pdf)(?:\?[\w=.&-]*)?)\1/gi;
function replaceAssetStrings(code, fileDir, roots) {
  roots = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map(r => path.resolve(r));
  return code.replace(ASSET_RE, (m, q, ref) => {
    const clean = ref.split('?')[0];
    const stripped = clean.replace(/^(\.{0,2}\/)+/, '');
    const cands = [];
    if (!clean.startsWith('/')) cands.push([path.resolve(fileDir, clean), roots[0]]);
    for (const r of roots) { cands.push([path.join(r, stripped), r]); cands.push([path.join(r, 'public', stripped), r]); }
    for (const [c, r] of cands) {
      const p = path.resolve(c);
      if (p.startsWith(r + path.sep) && exists(p) && fs.statSync(p).isFile() && fs.statSync(p).size < MAX_ASSET)
        return q + dataUri(fs.readFileSync(p), mimeOf(p)) + q;
    }
    return m;
  });
}

async function bundleModule(file, root) {
  try {
    const out = await esbuild.build({
      entryPoints: [file], bundle: true, format: 'esm', write: false, minifyWhitespace: true, logLevel: 'silent', target: 'es2020',
      plugins: [{name: 'anyhtml-resolve', setup(b) {
        b.onResolve({filter: /^https?:/}, a => ({path: a.path, external: true}));
        b.onResolve({filter: /^\//}, a => { if (a.path.startsWith('//')) return {path: 'https:' + a.path, external: true}; const p = path.join(root, a.path); return exists(p) ? {path: p} : {path: a.path, external: true}; });
      }}],
    });
    return out.outputFiles[0].text;
  } catch (e) { note('esbuild bundle skipped:', path.basename(file), String(e.message).split('\n')[0]); return null; }
}

async function inlineHtml(html, pageUrl, get, {root, extraRoots = []} = {}) {
  const $ = cheerio.load(html);
  const bh = $('base[href]').attr('href');
  if (bh) { try { pageUrl = new URL(bh, pageUrl).href; } catch {} }
  $('base').remove();
  const late = [];

  for (const el of $('link[rel~="stylesheet"][href]').toArray()) {
    const href = $(el).attr('href');
    const r = await get(href, pageUrl);
    if (!r) { note('stylesheet not inlined:', href); continue; }
    const st = $('<style></style>');
    if ($(el).attr('media')) st.attr('media', $(el).attr('media'));
    st.text(safeStyle(await inlineCss(r.buf.toString('utf8'), r.url, get)));
    $(el).replaceWith(st);
  }
  for (const el of $('style').toArray()) {
    const t = $(el).text();
    if (/url\(|@import/.test(t)) $(el).text(safeStyle(await inlineCss(t, pageUrl, get)));
  }
  for (const el of $('[style*="url("]').toArray()) {
    const v = $(el).attr('style');
    const inl = await inlineCss(`x{${v}}`, pageUrl, get);
    $(el).attr('style', inl.slice(2, -1));
  }

  for (const el of $('script[src]').toArray()) {
    const $el = $(el), src = $el.attr('src');
    const type = ($el.attr('type') || '').toLowerCase();
    const r = await get(src, pageUrl);
    if (!r) { note('script not inlined:', src); continue; }
    let code = null;
    if (type === 'module' && r.file && root) code = await bundleModule(r.file, root);
    if (code == null) code = r.buf.toString('utf8');
    if (r.file && root) code = replaceAssetStrings(code, path.dirname(r.file), [root, ...extraRoots]);
    const s = $('<script></script>');
    if (type) s.attr('type', type);
    if ($el.attr('nomodule') !== undefined) s.attr('nomodule', '');
    s.text(safeScript(code));
    const classicDeferred = type !== 'module' && ($el.attr('defer') !== undefined || $el.attr('async') !== undefined);
    if (classicDeferred) { late.push(s); $el.remove(); } else $el.replaceWith(s);
  }
  // inline <script type="module"> that imports local files (./state.js …): bundle it, and refuse to ship a dead page if imports can't be resolved
  if (root) for (const el of $('script[type="module"]:not([src])').toArray()) {
    const t = $(el).text();
    if (!/\bimport\b|\bexport\b/.test(t)) continue;
    let dir = root;
    try { const u = new URL(pageUrl); if (u.origin === new URL(VIRT).origin) dir = path.join(root, path.dirname(decodeURIComponent(u.pathname)).replace(/^\/+/, '')); } catch {}
    try {
      const out = await esbuild.build({
        stdin: {contents: t, resolveDir: dir, sourcefile: 'inline-module.js', loader: 'js'},
        bundle: true, format: 'esm', write: false, minifyWhitespace: true, logLevel: 'silent', target: 'es2020',
        plugins: [{name: 'anyhtml-resolve', setup(b) {
          b.onResolve({filter: /^https?:/}, a => ({path: a.path, external: true}));
          b.onResolve({filter: /^\//}, a => { if (a.path.startsWith('//')) return {path: 'https:' + a.path, external: true}; const p = path.join(root, a.path); return exists(p) ? {path: p} : {path: a.path, external: true}; });
        }}],
      });
      $(el).text(safeScript(out.outputFiles[0].text));
    } catch (e) {
      const msg = String(e.message).split('\n').slice(0, 3).join(' ');
      if (/Could not resolve|No matching export/.test(msg)) throw new Error('inline module imports missing files (' + msg + ') – the project is incomplete, upload the whole folder/zip');
      note('inline module bundle skipped:', msg);
    }
  }
  if (root) for (const el of $('script:not([src])').toArray()) {
    const t = $(el).text();
    if (t.length > 20 && !/application\/(ld\+)?json/.test($(el).attr('type') || '')) $(el).text(safeScript(replaceAssetStrings(t, root, [root, ...extraRoots])));
  }
  for (const s of late) $('body').append(s);

  const one = async (el, attr) => {
    const v = $(el).attr(attr);
    if (!v || /^(data:|#|about:|javascript:|blob:)/i.test(v)) return;
    const r = await get(v, pageUrl);
    if (r && r.buf.length < MAX_ASSET) $(el).attr(attr, dataUri(r.buf, r.mime));
    else if (!r) note('asset not inlined:', v.slice(0, 120));
  };
  const SEL = [['img', 'src'], ['source', 'src'], ['video', 'poster'], ['video', 'src'], ['audio', 'src'], ['track', 'src'], ['input[type=image]', 'src'],
    ['image', 'href'], ['image', 'xlink:href'], ['embed', 'src'], ['object', 'data'],
    ['link[rel~="icon"]', 'href'], ['link[rel~="apple-touch-icon"]', 'href'], ['link[rel~="mask-icon"]', 'href']];
  for (const [sel, attr] of SEL) for (const el of $(sel).toArray()) await one(el, attr);
  for (const el of $('img[srcset],source[srcset]').toArray()) {
    const parts = $(el).attr('srcset').split(',').map(s => s.trim()).filter(Boolean);
    const outp = [];
    for (const p of parts) {
      const [u, ...d] = p.split(/\s+/);
      const r = await get(u, pageUrl);
      outp.push((r && r.buf.length < MAX_ASSET ? dataUri(r.buf, r.mime) : u) + (d.length ? ' ' + d.join(' ') : ''));
    }
    $(el).attr('srcset', outp.join(', '));
  }
  $('link[rel~="preload"],link[rel~="modulepreload"],link[rel~="prefetch"],link[rel~="prerender"],link[rel~="preconnect"],link[rel~="dns-prefetch"],link[rel~="manifest"]').remove();
  return $.html();
}

/* ───────────────── mobile polish + multi-page shell ───────────────── */

function mobilize(html, title) {
  if (FLAGS.has('--no-mobile')) return html;
  const $ = cheerio.load(html);
  if (!$('head').length) return html;
  if (!$('meta[charset]').length) $('head').prepend('<meta charset="utf-8">');
  const vp = $('meta[name="viewport"]');
  if (!vp.length) $('head').append('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
  else if (!/viewport-fit/.test(vp.attr('content') || '')) vp.attr('content', (vp.attr('content') || 'width=device-width, initial-scale=1') + ', viewport-fit=cover');
  if (!$('meta[name="apple-mobile-web-app-capable"]').length) $('head').append('<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">');
  if (!$('title').length && title) $('head').append(`<title>${title.replace(/</g, '&lt;')}</title>`);
  if (!$('style[data-anyhtml]').length) $('head').append('<style data-anyhtml>html{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}</style>');
  return $.html();
}

const normKey = p => p.replace(/\\/g, '/').split(/[?#]/)[0].replace(/^\/+|\/+$/g, '').replace(/\.html?$/i, '').replace(/(^|\/)index$/i, '');

function bundleHtml(pages, entryKey, title) {
  const data = jsonForHtml({entry: entryKey, pages});
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<title>${title.replace(/</g, '&lt;')}</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100vh;height:100dvh;display:block;background:#fff}</style></head>
<body><iframe id="f" title="page"></iframe>
<script id="d" type="application/json">${data}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('d').textContent),P=D.pages,f=document.getElementById('f'),cur=null;
function norm(p){return p.replace(/\\\\/g,'/').split(/[?#]/)[0].replace(/^\\/+|\\/+$/g,'').replace(/\\.html?$/i,'').replace(/(^|\\/)index$/i,'')}
function go(key,hash,push){var pg=P[key];if(!pg)return;cur=key;f.srcdoc=pg.html;f._hash=hash||'';if(push)location.hash='#!/'+key+(hash?'#'+hash:'');}
function fromHash(){var h=location.hash.replace(/^#!\\//,'');var i=h.indexOf('#');var k=i>=0?h.slice(0,i):h;return P[k]?{k:k,h:i>=0?h.slice(i+1):''}:{k:D.entry,h:''}}
f.addEventListener('load',function(){
  var d=f.contentDocument;if(!d)return;
  if(f._hash){try{var el=d.getElementById(f._hash);el&&el.scrollIntoView()}catch(e){}}
  d.addEventListener('click',function(e){
    var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;
    var h=a.getAttribute('href');if(!h||/^(mailto:|tel:|javascript:|sms:)/i.test(h))return;
    if(h.charAt(0)==='#')return;
    var u;try{u=new URL(h,'http://x/'+(P[cur].url||''))}catch(_){return}
    if(u.origin!=='http://x'){a.target='_blank';a.rel='noopener';return}
    var k=norm(u.pathname);
    if(P[k]){e.preventDefault();go(k,u.hash.slice(1),true);}
  },true);
});
window.addEventListener('hashchange',function(){var r=fromHash();if(r.k!==cur)go(r.k,r.h,false)});
var r=fromHash();go(r.k,r.h,false);
})();
</script></body></html>`;
}

/* ───────────────────────── strategy: static ───────────────────────── */

async function strategyStatic(root, info, extraRoots = []) {
  const get = dirFetcher(root, !FLAGS.has('--offline'));
  const rootR = path.resolve(root);
  const all = info.htmls.map(f => posix(path.relative(rootR, f)));
  if (!all.length) throw new Error('no html files');
  const entry = ['index.html', 'index.htm'].find(n => all.includes(n)) || all.slice().sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  const find = (ref, fromRel) => {
    let u; try { u = new URL(ref, VIRT + fromRel); } catch { return null; }
    if (u.origin !== new URL(VIRT).origin) return null;
    let p; try { p = decodeURIComponent(u.pathname).replace(/^\/+/, ''); } catch { return null; }
    for (const c of [p, p + '.html', p.replace(/\/$/, '') + '/index.html', p === '' ? 'index.html' : null]) if (c && all.includes(c)) return c;
    return null;
  };
  const queue = [entry], seen = new Set([entry]), pages = {};
  while (queue.length && Object.keys(pages).length < 80) {
    const rel = queue.shift();
    const raw = read(path.join(rootR, rel));
    const $ = cheerio.load(raw);
    for (const a of $('a[href]').toArray()) {
      const t = find($(a).attr('href'), rel);
      if (t && !seen.has(t)) { seen.add(t); queue.push(t); }
    }
    pages[normKey(rel)] = {url: rel, html: mobilize(await inlineHtml(raw, VIRT + rel, get, {root: rootR, extraRoots}), path.basename(root))};
  }
  const keys = Object.keys(pages);
  note(`static: ${keys.length} page(s) inlined`);
  if (keys.length === 1) return pages[keys[0]].html;
  const title = cheerio.load(pages[normKey(entry)].html)('title').text() || path.basename(root);
  return bundleHtml(pages, normKey(entry), title);
}

/* ───────────────────────── strategy: build (node) ───────────────────────── */

function installNode(root) {
  const has = f => exists(path.join(root, f));
  const attempts = [];
  if (has('pnpm-lock.yaml')) attempts.push('npx --yes pnpm@9 install --no-frozen-lockfile');
  if (has('yarn.lock')) attempts.push('npx --yes yarn@1 install --ignore-engines');
  const flags = '--no-audit --no-fund';
  attempts.push(has('package-lock.json') ? `npm ci ${flags} --legacy-peer-deps` : `npm install ${flags} --legacy-peer-deps`);
  attempts.push(`npm install ${flags} --force`);
  let last;
  for (const c of attempts) {
    try { sh(c, {cwd: root, env: {NODE_ENV: 'development'}}); return; } catch (e) { last = e; note('install attempt failed, trying next…'); }
  }
  throw last;
}

const OUT_DIRS = ['dist-anyhtml', 'dist', 'build', 'out', '.output/public', 'public', 'www', 'docs', '_site', 'storybook-static'];
function findOutDir(root, since) {
  let best = null;
  for (const d of OUT_DIRS) {
    const p = path.join(root, d, 'index.html');
    if (exists(p) && fs.statSync(p).mtimeMs >= since - 2000) { best = path.join(root, d); break; }
  }
  return best;
}

async function inlineOutDir(outDir, extraRoots = []) {
  const info = {htmls: walk(outDir, 3000).filter(f => /\.html?$/i.test(f))};
  return strategyStatic(outDir, info, extraRoots);
}

async function strategyBuild(root, info) {
  const scripts = info.pkg.scripts || {};
  if (!scripts.build && !info.deps.vite) throw new Error('no build script');
  installNode(root);
  const started = Date.now();
  const attempts = [];
  if (info.deps.vite) {
    attempts.push(async () => {
      sh('npm install -D vite-plugin-singlefile --no-audit --no-fund --legacy-peer-deps', {cwd: root, env: {NODE_ENV: 'development'}});
      fs.writeFileSync(path.join(root, 'vite.config.anyhtml.mjs'), `import {mergeConfig, loadConfigFromFile} from 'vite';
import {viteSingleFile} from 'vite-plugin-singlefile';
const loaded = await loadConfigFromFile({command: 'build', mode: 'production'}, undefined, process.cwd());
export default mergeConfig(loaded?.config ?? {}, {
  base: './',
  plugins: [viteSingleFile()],
  build: {outDir: 'dist-anyhtml', emptyOutDir: true, assetsInlineLimit: 100000000, cssCodeSplit: false, chunkSizeWarningLimit: 100000},
});
`);
      sh('npx vite build --config vite.config.anyhtml.mjs', {cwd: root, env: {NODE_ENV: 'production'}});
      const out = path.join(root, 'dist-anyhtml');
      if (!exists(path.join(out, 'index.html'))) throw new Error('vite single-file output missing');
      note('build: vite single-file bundle');
      return inlineOutDir(out, [root]);
    });
    attempts.push(async () => {
      sh('npx vite build --base ./', {cwd: root, env: {NODE_ENV: 'production'}});
      const out = findOutDir(root, started); if (!out) throw new Error('no vite output');
      return inlineOutDir(out, [root]);
    });
  }
  if (scripts.build) attempts.push(async () => {
    sh('npm run build', {cwd: root, env: {NODE_ENV: 'production', PUBLIC_URL: '.', BASE_URL: './', GENERATE_SOURCEMAP: 'false'}});
    const out = findOutDir(root, started); if (!out) throw new Error('build finished but no output folder with index.html found');
    return inlineOutDir(out, [root]);
  });
  let last;
  for (const a of attempts) { try { return await a(); } catch (e) { last = e; note('build attempt failed:', String(e.message).split('\n')[0]); } }
  throw last;
}

/* ───────────────────────── strategy: serve + snapshot ───────────────────────── */

function servePlan(root, info) {
  const has = f => exists(path.join(root, f));
  const setup = [];
  if (info.pkg) {
    const s = info.pkg.scripts || {};
    let run = null;
    if (s.start) { run = () => 'npm start'; }
    else if (s.dev) { run = () => info.deps.vite ? 'npm run dev -- --host 127.0.0.1' : 'npm run dev'; }
    else { const f = ['server.js', 'index.js', 'app.js', 'server.mjs', 'src/server.js', 'src/index.js'].find(has); if (f) run = () => `node ${f}`; }
    if (run) return {node: true, setup: [], run, buildFirst: !!(s.build && s.start)};
  }
  if (info.manage) return {setup: [{cmd: `${PY} -m pip install -r requirements.txt --break-system-packages -q || ${PY} -m pip install -r requirements.txt -q`}], run: P => `${PY} manage.py runserver 127.0.0.1:${P} --noreload`};
  if (info.py) {
    const t = read(path.join(root, info.py));
    if (has('requirements.txt')) setup.push({cmd: `${PY} -m pip install -r requirements.txt --break-system-packages -q || ${PY} -m pip install -r requirements.txt -q`});
    const mod = info.py.replace(/\.py$/, '');
    if (/FastAPI\(/.test(t)) { setup.push({cmd: `${PY} -m pip install uvicorn --break-system-packages -q || ${PY} -m pip install uvicorn -q`}); return {setup, run: P => `${PY} -m uvicorn ${mod}:app --host 127.0.0.1 --port ${P}`}; }
    if (/Flask\(/.test(t) && !/\.run\(/.test(t)) return {setup, run: P => `${PY} -m flask --app ${info.py} run --port ${P}`};
    return {setup, run: () => `${PY} ${info.py}`};
  }
  if (info.php) return {setup: [{cmd: WIN ? 'php -v' : 'command -v php >/dev/null || (sudo apt-get update -y -q && sudo apt-get install -y -q php-cli)'}], run: P => `php -S 127.0.0.1:${P}`};
  return null;
}

async function launchBrowser() {
  const pw = await import('playwright-core');
  const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const winCands = pf.flatMap(b => [b + '\\Google\\Chrome\\Application\\chrome.exe', b + '\\Microsoft\\Edge\\Application\\msedge.exe']);
  const cands = [process.env.CHROME_PATH, undefined, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ...winCands];
  let installed = false;
  for (let i = 0; i < cands.length; i++) {
    if (i > 0 && cands[i] !== undefined && !exists(cands[i])) continue;
    if (i === 0 && !cands[i]) continue;
    try { return await pw.chromium.launch({executablePath: cands[i], args: ['--no-sandbox']}); } catch (e) {
      if (cands[i] === undefined && !installed) {
        installed = true;
        sh(`npx playwright-core install ${WIN ? '' : '--with-deps '}chromium`, {cwd: HERE, allowFail: true});
        try { return await pw.chromium.launch({args: ['--no-sandbox']}); } catch {}
      }
    }
  }
  throw new Error('no usable Chromium for snapshotting');
}

async function crawl(base, maxPages = 40) {
  const browser = await launchBrowser();
  const mobile = !FLAGS.has('--desktop');
  const ctx = await browser.newContext(mobile
    ? {viewport: {width: 440, height: 956}, deviceScaleFactor: 2, isMobile: true, hasTouch: true}
    : {viewport: {width: 1366, height: 900}});
  const store = new Map();
  ctx.on('response', async res => {
    try {
      if (res.status() >= 400) return;
      const u = res.url().split('#')[0];
      if (u.startsWith('data:')) return;
      store.set(u, {buf: await res.body(), mime: (res.headers()['content-type'] || '').split(';')[0]});
    } catch {}
  });
  const origin = new URL(base).origin;
  const queue = [{url: base, depth: 0}], seen = new Set([normKey(new URL(base).pathname)]), pages = {};
  while (queue.length && Object.keys(pages).length < maxPages) {
    const {url, depth} = queue.shift();
    const page = await ctx.newPage();
    try {
      await page.goto(url, {waitUntil: 'networkidle', timeout: 30000}).catch(async () => { await page.waitForTimeout(1500); });
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight && y < 20000; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
        window.scrollTo(0, 0);
      }).catch(() => {});
      await page.waitForTimeout(400);
      const snap = await page.evaluate(() => {
        const c = document.documentElement.cloneNode(true);
        c.querySelectorAll('script,noscript,link[rel=modulepreload]').forEach(e => e.remove());
        c.querySelectorAll('img[loading]').forEach(e => e.removeAttribute('loading'));
        return {html: '<!doctype html>' + c.outerHTML, links: [...document.querySelectorAll('a[href]')].map(a => a.href), url: location.href};
      });
      const u = new URL(snap.url);
      pages[normKey(u.pathname)] = {url: u.pathname, pageUrl: snap.url, html: snap.html};
      if (depth < 4) for (const l of snap.links) {
        let lu; try { lu = new URL(l); } catch { continue; }
        if (lu.origin !== origin || /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|ico|css|js|json|xml|txt)$/i.test(lu.pathname)) continue;
        const k = normKey(lu.pathname);
        if (!seen.has(k)) { seen.add(k); queue.push({url: lu.origin + lu.pathname + lu.search, depth: depth + 1}); }
      }
    } catch (e) { note('crawl page failed:', url, String(e.message).split('\n')[0]); }
    await page.close();
  }
  const getStore = async (ref, b) => {
    let u; try { u = new URL(String(ref).trim(), b); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const k = u.href.split('#')[0];
    const hit = store.get(k);
    if (hit) return {buf: hit.buf, mime: hit.mime || mimeOf(u.pathname), url: k};
    return netFetch(k);
  };
  const out = {};
  for (const [k, p] of Object.entries(pages)) out[k] = {url: p.url, html: mobilize(await inlineHtml(p.html, p.pageUrl, getStore), k || 'home')};
  await browser.close();
  return out;
}

async function strategyServe(root, info) {
  const plan = servePlan(root, info);
  if (!plan) throw new Error('no runnable server found');
  if (plan.node) { installNode(root); if (plan.buildFirst) sh('npm run build', {cwd: root, allowFail: true}); }
  for (const s of plan.setup) sh(s.cmd, {cwd: root, allowFail: true});
  const PORT = 4100 + Math.floor(Math.random() * 400);
  let logs = '';
  const child = spawn(plan.run(PORT), {shell: true, windowsHide: true, cwd: root, detached: !WIN, env: {...process.env, PORT: String(PORT), HOST: '127.0.0.1', BROWSER: 'none'}});
  let exited = false;
  child.on('exit', () => { exited = true; });
  const onData = d => { logs += d.toString(); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const kill = () => { try { if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); else process.kill(-child.pid, 'SIGKILL'); } catch {} };
  try {
    note('serve: starting', plan.run(PORT));
    let base = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 120000 && !base) {
      const fromLogs = [...logs.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g)].map(m => +m[1]);
      for (const p of [...new Set([...fromLogs, PORT, 3000, 5000, 8000, 8080, 5173, 4173, 4200, 8501])]) {
        try {
          const r = await fetch(`http://127.0.0.1:${p}/`, {signal: AbortSignal.timeout(2500)});
          if (r.status < 500) { base = `http://127.0.0.1:${p}/`; break; }
        } catch {}
      }
      if (!base) { if (exited) throw new Error('server exited early:\n' + logs.slice(-1200)); await new Promise(r => setTimeout(r, 1500)); }
    }
    if (!base) throw new Error('server did not answer on any port:\n' + logs.slice(-1200));
    note('serve: up at', base);
    const pages = await crawl(base);
    const keys = Object.keys(pages);
    if (!keys.length) throw new Error('crawl produced no pages');
    note(`serve: snapshot of ${keys.length} page(s) (scripts removed; forms/backend calls are static)`);
    if (keys.length === 1) return pages[keys[0]].html;
    const entry = pages[''] ? '' : keys[0];
    const title = cheerio.load(pages[entry].html)('title').text() || path.basename(root);
    return bundleHtml(pages, entry, title);
  } finally { kill(); }
}

/* ───────────────────────── strategy: explorer ───────────────────────── */

const TEXT_EXT = new Set('txt md markdown csv tsv json jsonl yml yaml toml ini cfg conf env log xml html htm css scss less js mjs cjs jsx ts tsx vue svelte py rb php java kt go rs c h cpp hpp cs swift sh bash zsh bat ps1 sql graphql lock gitignore dockerfile makefile r jl lua pl ipynb svg tex rst'.split(' '));
const isTextBuf = b => { const n = Math.min(b.length, 4096); for (let i = 0; i < n; i++) if (b[i] === 0) return false; return true; };

async function strategyExplorer(root, info, ctx = {}) {
  const files = walk(root, 600);
  const rootR = path.resolve(root);
  let total = 0;
  const items = [];
  for (const f of files) {
    const rel = posix(path.relative(rootR, f));
    const st = fs.statSync(f);
    const ext = path.extname(f).slice(1).toLowerCase();
    const it = {path: rel, size: st.size, mime: mimeOf(f), ext};
    const base = path.basename(f).toLowerCase();
    if ((TEXT_EXT.has(ext) || TEXT_EXT.has(base) || !ext) && st.size < 20e6) {
      const b = fs.readFileSync(f);
      if (isTextBuf(b)) { it.kind = 'text'; it.text = b.slice(0, 600e3).toString('utf8'); it.truncated = b.length > 600e3; items.push(it); total += it.text.length; continue; }
    }
    if (/^(png|jpe?g|gif|webp|avif|ico|bmp|svg)$/.test(ext)) it.kind = 'image';
    else if (ext === 'pdf') it.kind = 'pdf';
    else if (/^(mp3|wav|ogg|m4a)$/.test(ext)) it.kind = 'audio';
    else if (/^(mp4|webm|mov)$/.test(ext)) it.kind = 'video';
    else it.kind = 'binary';
    if (it.kind !== 'binary' && st.size < 8e6 && total < 40e6) { it.b64 = fs.readFileSync(f).toString('base64'); total += it.b64.length; }
    items.push(it);
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  const report = {path: '⟡ گزارش تبدیل.txt', size: 0, kind: 'text', ext: 'txt', mime: 'text/plain', text: NOTES.join('\n') + '\n\nاین پروژه به‌صورت صفحه اجرایی تبدیل نشد، پس محتوایش در یک مرورگر فایل نمایش داده می‌شود.'};
  const pick = ctx.select || items.find(i => /^readme(\.md)?$/i.test(i.path)) || items.find(i => i.kind === 'text') || items[0];
  const data = {title: path.basename(root), files: [report, ...items], select: pick ? pick.path : report.path};
  const tpl = read(path.join(HERE, 'explorer.tpl.html'));
  const markedPath = path.join(HERE, 'node_modules/marked/lib/marked.umd.js');
  const marked = exists(markedPath) ? read(markedPath) : 'window.marked={parse:function(t){return "<pre>"+t.replace(/</g,"&lt;")+"</pre>"}}';
  return tpl.replace('__TITLE__', () => data.title.replace(/</g, '&lt;')).replace('__DATA__', () => jsonForHtml(data)).replace('/*__MARKED__*/', () => safeScript(marked));
}

/* ───────────────────────── main ───────────────────────── */


/* ───────────────────────── verify: open the result in Chromium and look for real problems ───────────────────────── */
async function verifyHtml(html, opts = {}) {
  if (FLAGS.has('--no-verify')) return {skipped: true};
  let browser;
  try { browser = await launchBrowser(); } catch (e) { note('verify skipped (no browser):', String(e.message || e).split('\n')[0]); return {skipped: true}; }
  const tmp = path.join(os.tmpdir(), `anyhtml-verify-${Date.now()}.html`);
  const fatal = [], warn = new Set(), hosts = new Set();
  try {
    if (!opts.url) fs.writeFileSync(tmp, html);
    const ctx = await browser.newContext({viewport: {width: 440, height: 956}});
    const page = await ctx.newPage();
    page.on('pageerror', e => fatal.push('JS error: ' + String(e.message || e).split('\n')[0].slice(0, 200)));
    page.on('console', m => { if (m.type() === 'error') warn.add('console: ' + m.text().slice(0, 160)); });
    page.on('requestfailed', r => { const u = r.url(); if (!/^(data|blob):/.test(u)) warn.add('request failed: ' + u.slice(0, 140)); });
    page.on('request', r => { try { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1') hosts.add(u.host); } catch {} });
    const {pathToFileURL} = await import('node:url');
    await page.goto(opts.url || pathToFileURL(tmp).href, {waitUntil: 'load', timeout: 30000});
    await page.waitForTimeout(2500);
    const b = await page.evaluate(() => ({t: (document.body?.innerText || '').trim().length, c: document.querySelectorAll('canvas,svg,img,video,iframe').length}));
    if (b.t < 2 && b.c === 0) fatal.push('blank page (no visible content)');
  } catch (e) { fatal.push('could not load: ' + String(e.message || e).split('\n')[0].slice(0, 200)); }
  finally { try { await browser.close(); } catch {} try { fs.rmSync(tmp, {force: true}); } catch {} }
  note(`verify: ${fatal.length ? 'PROBLEMS' : 'OK'}`);
  for (const x of fatal) note('  ✗', x);
  for (const x of [...warn].slice(0, 8)) note('  !', x);
  note(hosts.size ? `  needs internet at run time: ${[...hosts].join(', ')}` : '  self-contained: no external requests');
  return {ok: !fatal.length, problems: fatal, hosts: [...hosts]};
}


let OUT_FILE = null;
async function strategyPwaSite(root) {
  for (const w of pwaWarnings(root)) note('pwa: WARNING', w);
  note('pwa: installable static site → copied as-is (not inlined), so manifest, service worker and CSP keep working');
  return launcherHtml(path.basename(OUT_FILE).replace(/\.html$/i, ''));
}
async function verifyPwa(root) {
  const srv = await serveDir(root);
  try { return await verifyHtml(null, {url: srv.url}); } finally { srv.close(); }
}

async function main() {
  if (!POS[0]) { console.error('usage: anyhtml.mjs <input.zip|dir|file> [output.html] [--desktop] [--offline] [--no-mobile]'); process.exit(2); }
  const input = path.resolve(POS[0]);
  const stem = path.basename(input).replace(/\.tar\.(gz|bz2|xz)$/i, '').replace(/\.[^.]+$/, '');
  const outFile = path.resolve(POS[1] || path.join(path.dirname(input), stem + '.html'));
  OUT_FILE = outFile;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'anyhtml-'));
  const srcDir = path.join(work, 'src');
  extractInput(input, srcDir);
  const root = findRoot(srcDir);
  // Express+Gemini apps: move /api/* into the browser first, so the normal build strategy yields a working single file
  if (!FLAGS.has('--no-browser-server')) { try { serverToBrowser(root, note); } catch (e) { note('server2browser skipped:', String(e.message || e).split('\n')[0]); } }
  const info = detect(root);
  note('root:', posix(path.relative(srcDir, root)) || '.', '| package.json:', !!info.pkg, '| html files:', info.htmls.length, '| py:', info.py || info.manage || '-', '| php:', info.php);

  const chain = [];
  const staticOk = info.htmls.length > 0 && !sourceHtml(root);
  const serverish = !!(info.py || info.manage || info.php || (info.pkg && (info.pkg.scripts?.start || info.pkg.scripts?.dev)));
  if (info.pkg && (info.pkg.scripts?.build || info.deps.vite)) chain.push(['build', strategyBuild]);
  // html files without a root index.html next to a server (templates!) are not a static site: run it first
  if (staticOk && (info.hasIndex || !serverish)) chain.push(['static', strategyStatic]);
  if (info.pkg || info.py || info.manage || info.php) chain.push(['serve', strategyServe]);
  if (staticOk && !chain.some(c => c[0] === 'static')) chain.push(['static', strategyStatic]);
  chain.push(['explorer', strategyExplorer]);
  const pwa = FLAGS.has('--no-pwa') ? null : detectPwaSite(root, info, sourceHtml(root));
  if (pwa) { note('pwa signals:', Object.entries(pwa).filter(([, v]) => v).map(([k]) => k).join(', ')); chain.unshift(['pwa', strategyPwaSite]); }

  let html = null, used = null, first = null;
  for (const [name, fn] of chain) {
    try {
      note(`── strategy: ${name}`);
      // a verified-broken result is kept as a candidate; the explorer never replaces a real build
      if (name === 'explorer' && first) { html = first.html; used = first.name + ' (verify warnings)'; break; }
      const h = await fn(root, info);
      if (name !== 'explorer') {
        const v = name === 'pwa' ? await verifyPwa(root) : await verifyHtml(h);
        if (!v.skipped && !v.ok) { note(`verify: "${name}" output looks broken, trying the next strategy`); if (!first) first = {html: h, name}; continue; }
      }
      html = h; used = name;
      break;
    } catch (e) { note(`strategy ${name} failed:`, String(e.message || e).split('\n').slice(0, 6).join(' | ')); }
  }
  fs.mkdirSync(path.dirname(outFile), {recursive: true});
  if (used && used.startsWith('pwa')) { const outDir = outFile.replace(/\.html$/i, ''); const r = copySite(root, outDir); const extra = fillFromParent(root, path.dirname(root) !== path.dirname(srcDir) && root !== srcDir ? path.dirname(root) : null, outDir); if (extra.length) note('pwa: also copied from the zip root:', extra.join(', ')); note(`pwa: ${r.files} files (${(r.bytes / 1048576).toFixed(2)} MB) → ${outDir} — open <pages-url>/outputs/${path.basename(outDir)}/ and Add to Home Screen`); }
  fs.writeFileSync(outFile, html);
  note(`DONE via "${used}" → ${outFile} (${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB)`);
  fs.writeFileSync(outFile.replace(/\.html$/i, '') + '.report.txt', NOTES.join('\n') + '\n');
  try { fs.rmSync(work, {recursive: true, force: true}); } catch {}
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });

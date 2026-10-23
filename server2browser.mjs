// Server-to-browser: an Express project (optionally using @google/genai) becomes a pure frontend.
// Routes run inside the browser via a mini-express shim; fs/path/crypto get browser shims;
// process.env.* values come from a ⚙︎ settings dialog (localStorage). No backend, no npm at run time.
// CLI: node server2browser.mjs <project-dir>      (anyhtml.mjs calls it automatically before the build strategies)
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSET = /(['"])(\/[^'"\n]+\.(?:png|jpe?g|gif|webp|svg|avif|mp4|webm|mp3|wav))\1/g;
const SKIP_ENV = new Set(['PORT', 'NODE_ENV', 'HOST', 'DISABLE_HMR', 'APP_URL', 'GEMINI_API_KEY']);
const UNSUPPORTED = ['child_process', 'net', 'http', 'https', 'http2', 'os', 'stream', 'zlib', 'worker_threads', 'cluster', 'dgram', 'dns', 'tls',
  'better-sqlite3', 'sqlite3', 'sqlite', 'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'redis', 'ioredis', 'ws', 'socket.io', 'nodemailer', 'multer', 'sharp', 'puppeteer', 'playwright'];
const SHIMS = ['express-shim.ts', 'install.ts', 'fs-shim.ts', 'fs-promises-shim.ts', 'path-shim.ts', 'crypto-shim.ts'];
const posix = p => p.split(path.sep).join('/');

export function transformServer(src, toAsset = () => null, rewriteRel = x => x) {
  let s = src;
  // server-relative imports (e.g. './src/utils/x') must point at the same files from the new location
  s = s.replace(/(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, a, q, spec) => `${a}${q}${rewriteRel(spec)}${q}`);
  const cut = (from, to) => { const a = s.indexOf(from); if (a < 0) return false; const b = s.indexOf(to, a + from.length); s = s.slice(0, a) + (b < 0 ? '' : s.slice(b)); return true; };
  const rmFn = name => {
    const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(s);
    if (!m) return false;
    let i = s.indexOf('{', m.index + m[0].length), d = 0;
    if (i < 0) return false;
    for (; i < s.length; i++) { const c = s[i]; if (c === '{') d++; else if (c === '}' && --d === 0) { i++; break; } }
    s = s.slice(0, m.index) + s.slice(i);
    return true;
  };
  const app = (/^(?:const|let|var)\s+(\w+)\s*=\s*express\(\)/m.exec(s) || [])[1];
  if (!app) throw new Error('no `const app = express()` found');
  const hasGem = /@google\/genai/.test(s);

  s = s.replace(/^import express[^\n]*\n/m, "import express, { Request, Response } from './express-shim';\n")
    .replace(/^import dotenv from ['"]dotenv['"];?\n/m, '').replace(/^import ['"]dotenv\/config['"];?\n/m, '').replace(/^dotenv\.config\([^)]*\);?\n/m, '')
    .replace(/^import \{[^}]*\bfileURLToPath\b[^}]*\} from ['"](?:node:)?url['"];?\n/m, '')
    .replace(/^const __filename[^\n]*\n/m, '').replace(/^const __dirname[^\n]*\n/m, '').replace(/^const port\s*=[^\n]*\n/m, '')
    .replace(/from (['"])(?:node:)?path\1/g, "from './path-shim'")
    .replace(/from (['"])(?:node:)?fs\/promises\1/g, "from './fs-promises-shim'")
    .replace(/from (['"])(?:node:)?fs\1/g, "from './fs-shim'")
    .replace(/from (['"])(?:node:)?crypto\1/g, "from './crypto-shim'");

  // never start a real server: drop startServer() and its call, keep every route registration
  if (!rmFn('startServer')) cut('// Setup Vite middleware', '// ====');
  if (/^(?:await\s+)?startServer\(\);?[ \t]*$/m.test(s)) s = s.replace(/^(?:await\s+)?startServer\(\);?[ \t]*$/m, '');
  else s = s.replace(/^(?:await\s+)?startServer\(\)[\s\S]{0,400}?\n\}\);[ \t]*$/m, '');

  // Gemini: allow a custom Base URL (gateway/proxy) without touching the app's own code
  if (hasGem) s = s.replace(/^import \{([^}]*)\} from (['"])@google\/genai\2;?\n/m, (m, names) => {
    if (!/\bGoogleGenAI\b/.test(names)) return m;
    return `import { ${names.replace(/\bGoogleGenAI\b/, 'GoogleGenAI as __G')} } from '@google/genai';\n` +
      `class GoogleGenAI extends __G { constructor(o: any) { let b = ''; try { b = localStorage.getItem('forge_gemini_base') || ''; } catch {} super(b ? { ...o, httpOptions: { ...(o?.httpOptions || {}), baseUrl: b } } : o); } }\n`;
  });

  const imports = [];
  s = s.replace(ASSET, (m, q, p) => {
    const rel = toAsset(p); if (!rel) return m;
    let i = imports.indexOf(rel); if (i < 0) { imports.push(rel); i = imports.length - 1; }
    return '__asset' + i;
  });
  const keys = [...new Set([...s.matchAll(/process\.env\.([A-Za-z_]\w*)/g), ...s.matchAll(/process\.env\[['"]([A-Za-z_]\w*)['"]\]/g)].map(m => m[1]))].filter(k => !SKIP_ENV.has(k));
  const bad = UNSUPPORTED.filter(n => new RegExp(`from ['"](?:node:)?${n.replace('.', '\\.')}['"]`).test(s));

  const pre = [
    ...imports.map((rel, i) => `import __asset${i} from '${rel}';`),
    `const __dirname = '/'; const __filename = '/server.ts'; const port = 3000;`,
    `const process: any = { env: new Proxy({} as any, { get: (_t: any, k: any) => { try { return localStorage.getItem('forge_env_' + String(k)) ?? undefined; } catch { return undefined; } } }), cwd: () => '/', platform: 'browser', argv: [], version: 'v22', versions: {}, on() {}, exit() {} };`,
  ];
  return {
    code: pre.join('\n') + '\n' + s + `\nexport const __envKeys: string[] = ${JSON.stringify(keys)};\nexport const __hasGemini = ${hasGem};\nexport { ${app} as __app };\n`,
    keys, hasGem, bad,
  };
}

export function serverToBrowser(root, note = console.log) {
  const f = ['server.ts', 'server.js', 'server.mjs', 'server.mts', 'src/server.ts', 'src/server.js'].map(c => path.join(root, c)).find(fs.existsSync);
  if (!f) return false;
  const src = fs.readFileSync(f, 'utf8');
  if (!/from ['"]express['"]/.test(src) || !/\b\w+\.(?:get|post|put|delete|patch|all)\(\s*['"]\//.test(src)) return false;
  const entry = ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.js', 'main.tsx', 'main.jsx'].map(c => path.join(root, c)).find(fs.existsSync);
  if (!entry) return false;
  const dir = path.join(path.dirname(entry), 'server-browser');
  fs.mkdirSync(dir, {recursive: true});
  const toAsset = p => {
    const file = path.join(root, p);
    if (!fs.existsSync(file)) return null;
    const rel = posix(path.relative(dir, file));
    return rel.startsWith('.') ? rel : './' + rel;
  };
  const rewriteRel = spec => {
    let rel = posix(path.relative(dir, path.resolve(path.dirname(f), spec)));
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
  };
  const r = transformServer(src, toAsset, rewriteRel);
  fs.writeFileSync(path.join(dir, 'server.ts'), r.code);
  for (const n of SHIMS) fs.copyFileSync(path.join(HERE, 's2b-' + n), path.join(dir, n));
  const e = fs.readFileSync(entry, 'utf8');
  if (!e.includes('server-browser/install')) fs.writeFileSync(entry, `import './server-browser/install';\n` + e);
  note('server2browser: Express server →', posix(path.relative(root, dir)), `(routes run in the browser${r.hasGem ? '; Gemini' : ''}${r.keys.length ? '; settings: ' + r.keys.join(', ') : ''})`);
  if (r.bad.length) note('server2browser: WARNING these server modules cannot run in a browser:', r.bad.join(', '));
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ok = serverToBrowser(path.resolve(process.argv[2] || '.'));
  console.log(ok ? 'converted' : 'not an Express project with routes (nothing changed)');
}

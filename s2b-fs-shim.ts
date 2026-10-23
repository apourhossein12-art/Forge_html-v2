// Virtual filesystem for browser-run servers: in memory, persisted to localStorage (text files; binary as base64).
import { resolve } from './path-shim';
type F = { t: 's' | 'b'; v: string };
const KEY = 'forge_fs_v1';
let files: Record<string, F> = {};
const dirs = new Set<string>(['/']);
try { const raw = localStorage.getItem(KEY); if (raw) files = JSON.parse(raw); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(files)); } catch {} };
const P = (p: any) => resolve(String(p));
const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
const b64 = (u: Uint8Array) => { let s = ''; u.forEach(c => { s += String.fromCharCode(c); }); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const parents = (p: string) => { let d = p; while (d !== '/' && d.includes('/')) { d = d.slice(0, d.lastIndexOf('/')) || '/'; dirs.add(d); } };
const under = (d: string) => (d === '/' ? '/' : d + '/');
const isDir = (p: string) => dirs.has(p) || Object.keys(files).some(k => k.startsWith(under(p)));
const enc = (o: any) => (typeof o === 'string' ? o : o && o.encoding) || undefined;

export const existsSync = (p: any) => { const x = P(p); return !!files[x] || isDir(x); };
export const readFileSync = (p: any, o?: any): any => {
  const x = P(p), f = files[x];
  if (!f) throw enoent(x);
  if (f.t === 's') return f.v;
  const u = unb64(f.v);
  return enc(o) ? new TextDecoder().decode(u) : u;
};
export const writeFileSync = (p: any, data: any) => {
  const x = P(p); parents(x);
  files[x] = typeof data === 'string' ? { t: 's', v: data }
    : data instanceof Uint8Array ? { t: 'b', v: b64(data) }
    : data instanceof ArrayBuffer ? { t: 'b', v: b64(new Uint8Array(data)) }
    : { t: 's', v: String(data) };
  save();
};
export const appendFileSync = (p: any, data: any) => { const x = P(p); writeFileSync(x, (files[x]?.t === 's' ? files[x].v : '') + String(data)); };
export const mkdirSync = (p: any) => { const x = P(p); dirs.add(x); parents(x); };
export const readdirSync = (d: any): string[] => {
  const x = P(d), pre = under(x), names = new Set<string>();
  if (!isDir(x)) throw enoent(x);
  for (const k of Object.keys(files)) if (k.startsWith(pre)) names.add(k.slice(pre.length).split('/')[0]);
  for (const k of dirs) if (k !== x && k.startsWith(pre)) names.add(k.slice(pre.length).split('/')[0]);
  return [...names].sort();
};
export const statSync = (p: any) => {
  const x = P(p), f = files[x];
  if (f) return { isFile: () => true, isDirectory: () => false, size: f.v.length, mtimeMs: Date.now() };
  if (isDir(x)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: Date.now() };
  throw enoent(x);
};
export const rmSync = (p: any, o: any = {}) => {
  const x = P(p); let hit = false;
  if (files[x]) { delete files[x]; hit = true; }
  for (const k of Object.keys(files)) if (k.startsWith(under(x))) { delete files[k]; hit = true; }
  dirs.delete(x);
  if (!hit && !o.force) throw enoent(x);
  save();
};
export const unlinkSync = (p: any) => rmSync(p);
export const renameSync = (a: any, b: any) => { const f = files[P(a)]; if (!f) throw enoent(P(a)); writeFileSync(b, f.t === 's' ? f.v : unb64(f.v)); delete files[P(a)]; save(); };
export const copyFileSync = (a: any, b: any) => { const f = files[P(a)]; if (!f) throw enoent(P(a)); writeFileSync(b, f.t === 's' ? f.v : unb64(f.v)); };
const pr = (fn: (...a: any[]) => any) => async (...a: any[]) => fn(...a);
export const promises = {
  readFile: pr(readFileSync), writeFile: pr(writeFileSync), appendFile: pr(appendFileSync), mkdir: pr(mkdirSync),
  readdir: pr(readdirSync), stat: pr(statSync), rm: pr(rmSync), unlink: pr(unlinkSync), rename: pr(renameSync),
  copyFile: pr(copyFileSync), access: async (p: any) => { if (!existsSync(p)) throw enoent(P(p)); },
};
const cb = (fn: (...a: any[]) => any) => (...a: any[]) => { const done = a.pop(); try { done(null, fn(...a)); } catch (e) { done(e); } };
export const readFile = cb(readFileSync), writeFile = cb(writeFileSync), appendFile = cb(appendFileSync), readdir = cb(readdirSync), stat = cb(statSync), mkdir = cb(mkdirSync), unlink = cb(unlinkSync);
export default { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, rmSync, unlinkSync, renameSync, copyFileSync, promises, readFile, writeFile, appendFile, readdir, stat, mkdir, unlink };

const norm = (p: string) => {
  const abs = p.startsWith('/'); const out: string[] = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(s);
  }
  const r = (abs ? '/' : '') + out.join('/');
  return r || (abs ? '/' : '.');
};
export const sep = '/';
export const normalize = norm;
export const join = (...a: string[]) => norm(a.filter(Boolean).join('/'));
export const resolve = (...a: string[]) => {
  let r = '';
  for (let i = a.length - 1; i >= 0 && !r.startsWith('/'); i--) if (a[i]) r = a[i] + (r ? '/' + r : '');
  return norm(r.startsWith('/') ? r : '/' + r);
};
export const isAbsolute = (p: string) => p.startsWith('/');
export const dirname = (p: string) => { const n = norm(p); const i = n.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : n.slice(0, i); };
export const basename = (p: string, ext?: string) => { let b = norm(p).split('/').pop() || ''; if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; };
export const extname = (p: string) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
export const relative = (from: string, to: string) => {
  const a = resolve(from).split('/').filter(Boolean), b = resolve(to).split('/').filter(Boolean);
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
};
const path: any = { sep, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative };
path.posix = path;
export default path;

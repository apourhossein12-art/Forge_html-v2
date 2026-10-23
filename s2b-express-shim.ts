// In-browser Express stand-in: use/get/post/put/delete/patch/all, :params, Router(), middleware chain,
// req.body/query/params, res.status/json/send/end/redirect/set. Not supported: streaming/SSE, websockets, templating.
type H = (req: any, res: any, next: (e?: any) => void) => any;
export type Request = any;
export type Response = any;
type Route = { method: string; pattern: string; re: RegExp; keys: string[]; fns: H[]; catchAll: boolean };
type MW = { prefix: string; fn: H };

const compile = (p: string) => {
  const keys: string[] = [];
  const src = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:([A-Za-z_]\w*)/g, (_m, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp('^' + src + '/?$'), keys };
};

function makeApp(isRouter: boolean) {
  const routes: Route[] = [];
  const mw: MW[] = [];
  const add = (method: string, pattern: string, fns: H[]) => {
    const { re, keys } = compile(pattern);
    routes.push({ method, pattern, re, keys, fns, catchAll: pattern === '*' || pattern === '/*' || pattern === '(.*)' });
  };
  const app: any = {
    __router: isRouter, _routes: routes, _mw: mw,
    use(a: any, ...rest: any[]) {
      if (typeof a === 'string') {
        const r = rest[0];
        if (r && r.__router) {
          for (const x of r._routes as Route[]) add(x.method, (a + x.pattern).replace(/\/+/g, '/'), x.fns);
          for (const x of r._mw as MW[]) mw.push({ prefix: (a + x.prefix).replace(/\/+/g, '/'), fn: x.fn });
        } else for (const fn of rest) mw.push({ prefix: a, fn });
      } else if (a && a.__router) {
        for (const x of a._routes as Route[]) add(x.method, x.pattern, x.fns);
        for (const x of a._mw as MW[]) mw.push(x);
      } else for (const fn of [a, ...rest]) mw.push({ prefix: '/', fn });
      return app;
    },
    listen() { return { close() {} }; },
    set() { return app; }, enable() { return app; }, disable() { return app; }, engine() { return app; },
    has(method: string, path: string) {
      return routes.some(r => !r.catchAll && (r.method === method || r.method === 'ALL') && r.re.test(path));
    },
    async handle(method: string, path: string, body: any = {}, query: any = {}) {
      let status = 200, out: any, done = false;
      const headers: Record<string, string> = {};
      const req: any = { method, path, url: path, originalUrl: path, body, query, params: {}, headers: {}, ip: 'local', socket: { remoteAddress: 'local' }, get: () => undefined, header: () => undefined };
      const res: any = {
        status(c: number) { status = c; return res; },
        sendStatus(c: number) { status = c; out = String(c); done = true; return res; },
        json(o: any) { out = o; done = true; return res; },
        send(o: any) { out = o; done = true; return res; },
        end(o?: any) { out = o; done = true; return res; },
        redirect(a: any, b?: any) { status = typeof a === 'number' ? a : 302; headers.Location = String(typeof a === 'number' ? b : a); done = true; return res; },
        set(k: any, v?: any) { if (typeof k === 'string') headers[k] = String(v); return res; },
        type() { return res; }, cookie() { return res; }, sendFile() { done = true; return res; }, render() { done = true; return res; },
        get() { return undefined; },
      };
      res.setHeader = res.header = res.set;
      const result = () => ({ status, body: out, headers });
      const run = async (fns: H[]): Promise<boolean> => {
        for (const fn of fns) {
          if (done) return false;
          let nexted = false, err: any;
          await fn(req, res, (e?: any) => { nexted = true; err = e; });
          if (err) throw err;
          if (!nexted) return false;
        }
        return !done;
      };
      try {
        for (const m of mw) { if (!path.startsWith(m.prefix)) continue; if (!(await run([m.fn]))) return result(); }
        const r = routes.find(x => !x.catchAll && (x.method === method || x.method === 'ALL') && x.re.test(path));
        if (!r) return { status: 404, body: { error: 'Not found' }, headers };
        const mm = r.re.exec(path)!;
        r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(mm[i + 1]); });
        await run(r.fns);
      } catch (e: any) {
        console.error('forge express-shim:', e);
        return { status: 500, body: { error: String(e?.message || e) }, headers };
      }
      return result();
    },
  };
  for (const m of ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head']) {
    app[m] = (p: any, ...fns: any[]) => {
      if (m === 'get' && !fns.length) return undefined; // app.get('setting')
      add(m.toUpperCase(), p, fns.flat() as H[]);
      return app;
    };
  }
  return app;
}

function express() { return makeApp(false); }
express.Router = () => makeApp(true);
const noop = () => (_q: any, _s: any, n: () => void) => n();
express.json = noop; express.urlencoded = noop; express.static = noop; express.raw = noop; express.text = noop;
export default express;

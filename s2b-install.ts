import { __app, __envKeys, __hasGemini } from './server';

const get = (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const set = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {} };

// Same-origin requests that match a route of the in-browser server are answered locally; everything else goes to the network.
const orig = window.fetch.bind(window);
window.fetch = async (input: any, init?: any) => {
  try {
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, location.href);
    if (u.origin === location.origin) {
      const method = String(init?.method || (isReq ? input.method : 'GET')).toUpperCase();
      let p = '';
      for (let i = u.pathname.indexOf('/'); i >= 0; i = u.pathname.indexOf('/', i + 1)) {
        const cand = u.pathname.slice(i);
        if (__app.has(method, cand)) { p = cand; break; }
      }
      if (p) {
        const raw: any = init?.body ?? (isReq ? await input.clone().text() : undefined);
        let body: any = {};
        if (typeof raw === 'string' && raw) { try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); } }
        const r = await __app.handle(method, p, body, Object.fromEntries(u.searchParams));
        const isObj = r.body !== null && typeof r.body === 'object';
        const empty = r.body === undefined || [101, 204, 205, 304].includes(r.status);
        return new Response(empty ? null : isObj ? JSON.stringify(r.body) : String(r.body), {
          status: r.status, headers: { 'Content-Type': isObj ? 'application/json' : 'text/html; charset=utf-8', ...(r.headers || {}) },
        });
      }
    }
  } catch (e) { console.error('forge shim', e); }
  return orig(input, init);
};

// Settings: keys and values the server code reads from process.env (stored only on this device)
const fields: [string, string][] = [];
if (__hasGemini) fields.push(['forge_env_GEMINI_API_KEY', 'GEMINI_API_KEY'], ['forge_gemini_base', 'Base URL (اختیاری)']);
for (const k of __envKeys) fields.push(['forge_env_' + k, k]);

function ui() {
  if (!fields.length) return;
  const b = document.createElement('button');
  b.textContent = '⚙︎';
  b.setAttribute('aria-label', 'تنظیمات');
  b.style.cssText = 'position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:99999;width:44px;height:44px;border-radius:50%;border:1px solid #334;background:#111827;color:#fff;font-size:20px';
  b.onclick = () => {
    const w = document.createElement('div');
    w.dir = 'rtl';
    w.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#000a;display:flex;align-items:center;justify-content:center;padding:16px';
    const box = document.createElement('div');
    box.style.cssText = 'background:#111827;color:#fff;border:1px solid #334;border-radius:16px;padding:16px;width:100%;max-width:420px;max-height:90vh;overflow:auto;font:14px system-ui';
    box.innerHTML = '<b>تنظیمات</b><p style="opacity:.7;margin:8px 0">مقادیر فقط روی همین دستگاه ذخیره می‌شوند. بعد از ذخیره صفحه دوباره بارگذاری می‌شود.</p>';
    const inputs: [string, HTMLInputElement][] = [];
    for (const [k, label] of fields) {
      const i = document.createElement('input');
      i.placeholder = label; i.dir = 'ltr'; i.value = get(k);
      i.style.cssText = 'width:100%;padding:10px;margin:4px 0;border-radius:8px;border:1px solid #334;background:#0b0f19;color:#fff';
      box.appendChild(i); inputs.push([k, i]);
    }
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:8px';
    const save = document.createElement('button'), close = document.createElement('button');
    save.textContent = 'ذخیره'; close.textContent = 'بستن';
    save.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:0;background:#6366f1;color:#fff';
    close.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:1px solid #334;background:none;color:#fff';
    close.onclick = () => w.remove();
    save.onclick = () => { for (const [k, i] of inputs) set(k, i.value.trim()); location.reload(); };
    row.append(save, close); box.appendChild(row); w.appendChild(box); document.body.appendChild(w);
  };
  document.body.appendChild(b);
}
if (document.body) ui(); else addEventListener('DOMContentLoaded', ui);

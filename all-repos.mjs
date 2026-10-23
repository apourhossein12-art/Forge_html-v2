#!/usr/bin/env node
// all-repos.mjs — download every GitHub repo of an account as a zip and convert each one to a single HTML with anyhtml.mjs
// Works on Windows, macOS and Linux (Node 18+).
//
//   node all-repos.mjs --user alirezassezar1-svg            public repos
//   set GITHUB_TOKEN=github_pat_...   (or export on Linux/macOS)
//   node all-repos.mjs                                       all repos you own, private included
//
// options: --user NAME  --out DIR (default all-out)  --only a,b  --skip a,b  --forks  --archived  --limit N  --force
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = n => args.includes('--' + n);
const API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const OUT = path.resolve(opt('out', 'all-out'));
const only = (opt('only', '') || '').split(',').filter(Boolean).map(s => s.toLowerCase());
const skip = (opt('skip', '') || '').split(',').filter(Boolean).map(s => s.toLowerCase());
const limit = +opt('limit', 0) || Infinity;
const user = opt('user', '');

const headers = {'User-Agent': 'anyhtml-all-repos', Accept: 'application/vnd.github+json', ...(TOKEN ? {Authorization: `Bearer ${TOKEN}`} : {})};
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const log = (...a) => console.log(...a);

async function listRepos() {
  const all = [];
  for (let page = 1; page < 50; page++) {
    const url = user && !TOKEN
      ? `${API}/users/${user}/repos?per_page=100&page=${page}`
      : TOKEN && !user
        ? `${API}/user/repos?per_page=100&page=${page}&affiliation=owner`
        : `${API}/users/${user}/repos?per_page=100&page=${page}`;
    const r = await fetch(url, {headers});
    if (!r.ok) throw new Error(`GitHub API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const part = await r.json();
    all.push(...part);
    if (part.length < 100) break;
  }
  return all;
}

async function download(repo, dest) {
  const r = await fetch(`${API}/repos/${repo.full_name}/zipball`, {headers, redirect: 'follow'});
  if (!r.ok) throw new Error(`zipball ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

const safe = s => s.replace(/[^\w.\-]+/g, '_');

async function main() {
  if (!user && !TOKEN) { console.error('Give --user NAME (public repos) or set GITHUB_TOKEN (all your repos).'); process.exit(2); }
  fs.mkdirSync(path.join(OUT, '_zips'), {recursive: true});
  let repos = await listRepos();
  repos = repos.filter(r => (flag('forks') || !r.fork) && (flag('archived') || !r.archived))
    .filter(r => !only.length || only.includes(r.name.toLowerCase()))
    .filter(r => !skip.includes(r.name.toLowerCase())).slice(0, limit);
  log(`${repos.length} repo(s) to convert → ${OUT}`);

  const results = [];
  for (const [i, repo] of repos.entries()) {
    const name = safe(repo.name), zip = path.join(OUT, '_zips', name + '.zip'), out = path.join(OUT, name + '.html');
    const res = {name: repo.name, private: !!repo.private, desc: repo.description || '', html: name + '.html'};
    log(`[${i + 1}/${repos.length}] ${repo.full_name}`);
    try {
      if (flag('force') || !fs.existsSync(out)) {
        await download(repo, zip);
        const r = spawnSync(process.execPath, [path.join(HERE, 'anyhtml.mjs'), zip, out], {encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 1 << 28, shell: false});
        const text = (r.stdout || '') + (r.stderr || '');
        const m = text.match(/DONE via "(\w+)".*\(([\d.]+) MB\)/);
        if (r.status !== 0 || !m || !fs.existsSync(out)) throw new Error(text.split('\n').slice(-6).join(' | ') || 'converter failed');
        res.how = m[1]; res.mb = m[2];
      } else { res.how = 'cached'; res.mb = (fs.statSync(out).size / 1048576).toFixed(2); }
      res.ok = true;
    } catch (e) { res.ok = false; res.error = String(e.message || e).slice(0, 400); log('   FAILED:', res.error); }
    if (res.ok) log(`   ok via ${res.how} (${res.mb} MB)`);
    results.push(res);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  }

  const rows = results.map(r => r.ok
    ? `<a class="r" href="${esc(r.html)}"><b>${esc(r.name)}</b>${r.private ? '<i>private</i>' : ''}<small>${esc(r.desc)}</small><em>${esc(r.how)} · ${esc(r.mb)} MB</em></a>`
    : `<div class="r bad"><b>${esc(r.name)}</b><small>${esc(r.error)}</small></div>`).join('\n');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repos</title><style>body{margin:0;padding:16px;font:15px/1.6 system-ui,Tahoma;background:#0b0d12;color:#e6e9f0}h1{font-size:18px}.r{display:block;padding:12px 14px;margin:8px 0;border:1px solid #232836;border-radius:12px;background:#12151c;color:inherit;text-decoration:none}.r b{direction:ltr;display:inline-block}.r i{margin-inline-start:8px;font-size:11px;color:#f4b860}.r small,.r em{display:block;color:#8b93a7;font-size:12px}.bad{border-color:#ff7185}</style><h1>${results.filter(r => r.ok).length} / ${results.length}</h1>\n${rows}</html>`);
  log(`done. open ${path.join(OUT, 'index.html')}  (${results.filter(r => !r.ok).length} failed)`);
}
main().catch(e => { console.error(e.message || e); process.exit(1); });

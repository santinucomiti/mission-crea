// node hl-batch.mjs <companies|slugs> <ids.json> <out.json> — parcourt des pages LinkedIn dans le Brave headless (9333), avec pause.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [mode, inPath, outPath] = process.argv.slice(2);
const items = JSON.parse(readFileSync(inPath, 'utf8'));
const out = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
const cookies = JSON.parse(readFileSync(new URL('./li-cookies.json', import.meta.url), 'utf8')).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires: c.expires }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Network.enable'); await send('Network.setCookies', { cookies });
await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
await send('Page.enable');

const EXTRACT = {
  companies: `(() => { const a = document.querySelector('a[data-control-name="visit_company_website"]'); return JSON.stringify({ url: location.href, site: a ? a.href : '', nom: (document.title || '').replace(/ \\| Sales Navigator$/, ''), login: /Identifiant|S.identifier|Sign in/.test(document.body.innerText.slice(0, 1500)) }); })()`,
  slugs: `(() => JSON.stringify({ url: location.href, nom: (document.querySelector('main h2, main h1')?.innerText || '').trim(), login: /Identifiant|S.identifier|Sign in/.test(document.body.innerText.slice(0, 1500)) }))()`,
};
let n = 0, stop = false;
for (const it of items) {
  const key = it.key;
  if (out[key]) continue;
  await send('Page.navigate', { url: it.url });
  await sleep(mode === 'companies' ? 7000 : 6000);
  let r = {};
  try { r = JSON.parse(await ev(EXTRACT[mode]) || '{}'); } catch { r = {}; }
  if (r.login) { console.error('session LinkedIn perdue (page de connexion) — arrêt'); stop = true; break; }
  out[key] = { ...r, at: new Date().toISOString() };
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  n++;
  console.error(`${n}/${items.length} ${key} → ${mode === 'companies' ? r.site || '(pas de site)' : r.url}`);
  await sleep(3000 + Math.random() * 4000);
}
ws.close(); await fetch('http://127.0.0.1:9333/json/close/' + t.id);
console.error(stop ? 'ARRÊT' : `✔ terminé : ${n} pages`);

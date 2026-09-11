// node scrape-list.mjs <out.json> — parcourt toutes les pages de la liste Sales Navigator ouverte dans Brave (9222)
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
const t = tabs.find((x) => x.type === 'page' && x.url.includes('sales/lists/people/7502738444884856833'));
if (!t) { console.error('onglet liste introuvable'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + JSON.stringify(r.result.exceptionDetails.exception));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXTRACT = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  return JSON.stringify({
    page: norm(document.querySelector('nav[aria-label*="agination"] [aria-current], nav[aria-label*="agination"] .active, nav[aria-label*="agination"] [class*="selected"]')?.innerText),
    rows: [...document.querySelectorAll('tr[data-row-id]')].map((r) => {
      const td = r.querySelectorAll('td');
      const img = r.querySelector('img[data-anonymize="headshot-photo"]')?.src || '';
      return {
        id: (r.dataset.rowId.match(/\\((ACwAA[^,]+)/) || [])[1],
        nomComplet: norm(r.querySelector('[data-anonymize="person-name"]')?.innerText),
        degre: norm(r.querySelector('.list-lead-detail__degree-badge [aria-hidden]')?.innerText),
        titre: norm(r.querySelector('[data-anonymize="job-title"]')?.innerText),
        entreprise: norm(r.querySelector('[data-anonymize="company-name"]')?.innerText),
        entrepriseUrl: r.querySelector('a[href*="/sales/company/"]')?.href.replace(/\\?.*$/, '') || '',
        localisation: norm(td[2]?.innerText),
        interaction: norm(td[4]?.innerText),
        ajout: norm(td[5]?.innerText),
        photoUrl: img.startsWith('http') ? img : '',
      };
    }),
  });
})()`;

const all = new Map();
for (let page = 1; page <= 30; page++) {
  await ev(`new Promise((r) => { const t = setInterval(() => { if (document.querySelectorAll('tr[data-row-id]').length) { clearInterval(t); r(1); } }, 200); setTimeout(() => { clearInterval(t); r(0); }, 15000); })`);
  const { rows } = JSON.parse(await ev(EXTRACT));
  const firstId = rows[0]?.id;
  for (const r of rows) if (r.id) all.set(r.id, r);
  console.log(`page ${page}: ${rows.length} lignes (total ${all.size})`);
  const clicked = await ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label*="agination"] button')].find((x) => /Suivant|Next/i.test(x.innerText)); if (!b || b.disabled) return false; b.click(); return true; })()`);
  if (!clicked) break;
  const changed = await ev(`new Promise((r) => { const t = setInterval(() => { const f = document.querySelector('tr[data-row-id]'); if (f && !f.dataset.rowId.includes(${JSON.stringify(firstId)})) { clearInterval(t); r(true); } }, 250); setTimeout(() => { clearInterval(t); r(false); }, 15000); })`);
  if (!changed) { console.log('page suivante non chargée, arrêt'); break; }
  await sleep(800 + Math.random() * 700);
}
writeFileSync(out, JSON.stringify([...all.values()], null, 1));
console.log('écrit', out, all.size);
ws.close();

// Récupère les cookies LinkedIn de la session Brave de l'utilisateur (CDP 9222) → li-cookies.json (local, 600)
import { writeFileSync, chmodSync } from 'node:fs';
const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
const t = tabs.find((x) => x.type === 'page' && x.url.includes('linkedin.com'));
if (!t) { console.error('aucun onglet LinkedIn ouvert'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const res = await send('Network.getCookies', { urls: ['https://www.linkedin.com/', 'https://linkedin.com/'] });
const cookies = (res.result?.cookies || []).filter((c) => /linkedin\.com$/.test(c.domain));
writeFileSync('li-cookies.json', JSON.stringify(cookies));
chmodSync('li-cookies.json', 0o600);
console.log('cookies LinkedIn :', cookies.length, '| li_at :', cookies.some((c) => c.name === 'li_at') ? 'oui' : 'non', '| JSESSIONID :', cookies.some((c) => c.name === 'JSESSIONID') ? 'oui' : 'non');
ws.close();

// node shot-tab.mjs <url-substring> <out.png> — capture d'un onglet déjà ouvert dans le Brave de l'utilisateur (port 9222)
import { writeFileSync } from 'node:fs';
const [sub, out] = process.argv.slice(2);
const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
const t = tabs.find((x) => x.type === 'page' && x.url.includes(sub));
if (!t) { console.error('onglet introuvable'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('ok', out);
ws.close();

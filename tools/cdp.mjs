// usage: node cdp.mjs <url-substring> <js-expression-file-or-inline>
const [,, match, ...rest] = process.argv;
const expr = rest.join(' ');
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const t = targets.find(x => x.type === 'page' && x.url.includes(match));
if (!t) { console.error('no tab matching', match, targets.filter(x=>x.type==='page').map(x=>x.url)); process.exit(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params={}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({id:i, method, params})); });
const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
if (res.result?.exceptionDetails) console.error('EXC', JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails, null, 1));
const v = res.result?.result?.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
ws.close();

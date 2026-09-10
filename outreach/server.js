import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertProspects, updateProspect } from './db.js';
import { parseCsv, mapRow, fromLeadInfo } from './csv.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3500);
// OUTREACH_USERS="Santinu:motdepasse,Eva:motdepasse,Rémi:motdepasse" — le mot de passe identifie la personne.
const USERS = (process.env.OUTREACH_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const i = s.indexOf(':'); return { name: s.slice(0, i).trim(), password: s.slice(i + 1) }; })
  .filter((u) => u.name && u.password);
const SECRET = process.env.OUTREACH_SECRET;
const DB_PATH = resolve(ROOT, process.env.DB_PATH || './data/outreach.sqlite');
const MAX_BODY = 20 * 1024 * 1024;

if (!USERS.length || !SECRET) {
  console.error('OUTREACH_USERS et OUTREACH_SECRET sont requis (voir .env.example)');
  process.exit(1);
}

const db = openDb(DB_PATH);
const sign = (name) => createHmac('sha256', SECRET).update('outreach-session-v2:' + name).digest('hex');
// Jeton longue durée pour l'extension navigateur (Authorization: Bearer <prénom>.<mac>).
const signToken = (name) => createHmac('sha256', SECRET).update('outreach-token-v1:' + name).digest('hex');
const loginAttempts = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

function verifyCredential(value, signer) {
  const i = value.lastIndexOf('.');
  if (i < 1) return null;
  const name = decodeURIComponent(value.slice(0, i));
  const mac = value.slice(i + 1);
  const expected = signer(name);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return USERS.some((u) => u.name === name) ? name : null;
}

// Retourne le prénom de la personne connectée (cookie de session ou jeton extension), ou null.
function sessionUser(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return verifyCredential(auth.slice(7).trim(), signToken);
  return verifyCredential(cookies(req).outreach_session || '', sign);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body trop volumineux')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(req, res, urlPath) {
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 404, { error: 'introuvable' });
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(data);
  } catch {
    if (extname(rel)) return json(res, 404, { error: 'introuvable' });
    const index = await readFile(join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
    res.end(index);
  }
}

async function api(req, res, url) {
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method;

  if (path === '/login' && method === 'POST') {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
    const attempts = loginAttempts.get(ip) || { n: 0, until: 0 };
    if (Date.now() < attempts.until) return json(res, 429, { error: 'Trop d’essais, réessaie dans une minute.' });
    const { password } = await readJson(req);
    const user = typeof password === 'string' && USERS.find((u) =>
      u.password.length === password.length && timingSafeEqual(Buffer.from(password), Buffer.from(u.password)));
    if (!user) {
      attempts.n++;
      if (attempts.n >= 5) { attempts.n = 0; attempts.until = Date.now() + 60_000; }
      loginAttempts.set(ip, attempts);
      return json(res, 401, { error: 'Mot de passe incorrect.' });
    }
    loginAttempts.delete(ip);
    const secure = (req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
    const cookie = encodeURIComponent(user.name) + '.' + sign(user.name);
    res.setHeader('set-cookie', `outreach_session=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${secure}`);
    return json(res, 200, { ok: true, who: user.name });
  }

  if (path === '/logout' && method === 'POST') {
    res.setHeader('set-cookie', 'outreach_session=; Path=/; HttpOnly; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  const who = sessionUser(req);
  if (!who) return json(res, 401, { error: 'non connecté' });

  if (path === '/me' && method === 'GET') {
    return json(res, 200, {
      who,
      people: db.prepare('SELECT name, color FROM people ORDER BY position').all(),
    });
  }

  if (path === '/token' && method === 'GET') {
    return json(res, 200, { who, token: encodeURIComponent(who) + '.' + signToken(who) });
  }

  // ---- synchro extension ----
  if (path === '/sync/status' && method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200);
    const out = {};
    if (ids.length) {
      const rows = db.prepare(`SELECT id, contacte, contacte_par, contacte_le, contact_par, relance_le, notes FROM prospects WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      for (const r of rows) out[r.id] = { ...r, notes: r.notes ? r.notes.slice(0, 120) : '' };
    }
    return json(res, 200, { who, status: out });
  }
  if (path === '/sync/upsert' && method === 'POST') {
    const { leads } = await readJson(req);
    const rows = (Array.isArray(leads) ? leads : []).map(fromLeadInfo).filter(Boolean).slice(0, 200);
    if (!rows.length) return json(res, 400, { error: 'aucun prospect exploitable' });
    return json(res, 200, upsertProspects(db, rows, 'extension'));
  }
  if (path === '/sync/contacted' && method === 'POST') {
    const { id, lead } = await readJson(req);
    if (!id) return json(res, 400, { error: 'id requis' });
    if (!db.prepare('SELECT 1 FROM prospects WHERE id = ?').get(id)) {
      const row = fromLeadInfo(lead);
      if (!row || row.id !== id) return json(res, 404, { error: 'prospect inconnu du CRM' });
      upsertProspects(db, [row], 'extension');
    }
    const patch = { contacte: true };
    const current = db.prepare('SELECT contact_par FROM prospects WHERE id = ?').get(id);
    if (!current.contact_par) patch.contact_par = who;
    return json(res, 200, updateProspect(db, id, patch, who));
  }

  if (path === '/prospects' && method === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM prospects ORDER BY updated_at DESC LIMIT 5000').all());
  }

  let m;
  if ((m = path.match(/^\/prospects\/([^/]+)$/)) && method === 'PATCH') {
    const patch = await readJson(req);
    try {
      const row = updateProspect(db, decodeURIComponent(m[1]), patch, who);
      return row ? json(res, 200, row) : json(res, 404, { error: 'prospect introuvable' });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (path === '/import' && method === 'POST') {
    const text = await readBody(req);
    const filename = url.searchParams.get('filename') || 'import.csv';
    const rows = parseCsv(text).map(mapRow).filter(Boolean);
    if (!rows.length) return json(res, 400, { error: 'Aucun prospect reconnu dans ce fichier (colonnes attendues : celles du CSV Sales Navigator).' });
    const result = upsertProspects(db, rows, filename);
    return json(res, 200, { ...result, parsed: rows.length });
  }

  if (path === '/templates' && method === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM templates ORDER BY id').all());
  }
  if (path === '/templates' && method === 'POST') {
    const { nom, corps } = await readJson(req);
    if (!nom || !corps) return json(res, 400, { error: 'nom et corps requis' });
    const r = db.prepare('INSERT INTO templates(nom, corps, updated_at) VALUES (?, ?, ?)').run(nom, corps, new Date().toISOString());
    return json(res, 200, db.prepare('SELECT * FROM templates WHERE id = ?').get(r.lastInsertRowid));
  }
  if ((m = path.match(/^\/templates\/(\d+)$/)) && method === 'PUT') {
    const { nom, corps } = await readJson(req);
    if (!nom || !corps) return json(res, 400, { error: 'nom et corps requis' });
    db.prepare('UPDATE templates SET nom = ?, corps = ?, updated_at = ? WHERE id = ?').run(nom, corps, new Date().toISOString(), Number(m[1]));
    return json(res, 200, db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(m[1])));
  }
  if ((m = path.match(/^\/templates\/(\d+)$/)) && method === 'DELETE') {
    db.prepare('DELETE FROM templates WHERE id = ?').run(Number(m[1]));
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'route inconnue' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`outreach prêt sur http://127.0.0.1:${PORT} (db: ${DB_PATH})`));

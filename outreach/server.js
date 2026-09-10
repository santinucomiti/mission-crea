import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertProspects, updateProspect } from './db.js';
import { parseCsv, mapRow } from './csv.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3500);
const PASSWORD = process.env.OUTREACH_PASSWORD;
const SECRET = process.env.OUTREACH_SECRET;
const DB_PATH = resolve(ROOT, process.env.DB_PATH || './data/outreach.sqlite');
const MAX_BODY = 20 * 1024 * 1024;

if (!PASSWORD || !SECRET) {
  console.error('OUTREACH_PASSWORD et OUTREACH_SECRET sont requis (voir .env.example)');
  process.exit(1);
}

const db = openDb(DB_PATH);
const sessionToken = createHmac('sha256', SECRET).update('outreach-session-v1').digest('hex');
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

function isAuthed(req) {
  const c = cookies(req).outreach_session || '';
  return c.length === sessionToken.length && timingSafeEqual(Buffer.from(c), Buffer.from(sessionToken));
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

const who = (req) => decodeURIComponent(req.headers['x-who'] || '') || 'inconnu';

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
    const ok = typeof password === 'string' && password.length === PASSWORD.length
      && timingSafeEqual(Buffer.from(password), Buffer.from(PASSWORD));
    if (!ok) {
      attempts.n++;
      if (attempts.n >= 5) { attempts.n = 0; attempts.until = Date.now() + 60_000; }
      loginAttempts.set(ip, attempts);
      return json(res, 401, { error: 'Mot de passe incorrect.' });
    }
    loginAttempts.delete(ip);
    const secure = (req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
    res.setHeader('set-cookie', `outreach_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${secure}`);
    return json(res, 200, { ok: true });
  }

  if (path === '/logout' && method === 'POST') {
    res.setHeader('set-cookie', 'outreach_session=; Path=/; HttpOnly; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (!isAuthed(req)) return json(res, 401, { error: 'non connecté' });

  if (path === '/me' && method === 'GET') {
    return json(res, 200, {
      people: db.prepare('SELECT name, color FROM people ORDER BY position').all(),
    });
  }

  if (path === '/prospects' && method === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM prospects ORDER BY updated_at DESC LIMIT 5000').all());
  }

  let m;
  if ((m = path.match(/^\/prospects\/([^/]+)$/)) && method === 'PATCH') {
    const patch = await readJson(req);
    try {
      const row = updateProspect(db, decodeURIComponent(m[1]), patch, who(req));
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

import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertProspects, updateProspect, markContactedByNames, findByProfile, normName, withZone, zoneOf, upsertCompany, fixName, isTruncatedName } from './db.js';
import { unlink } from 'node:fs/promises';
import { parseCsv, mapRow, fromLeadInfo } from './csv.js';
import { syncNotion, notionEnabled } from './notion.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3500);
// OUTREACH_USERS="Santinu:motdepasse,Eva:motdepasse,Rémi:motdepasse" — le mot de passe identifie la personne.
const USERS = (process.env.OUTREACH_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const i = s.indexOf(':'); return { name: s.slice(0, i).trim(), password: s.slice(i + 1) }; })
  .filter((u) => u.name && u.password);
const SECRET = process.env.OUTREACH_SECRET;
// OUTREACH_READONLY="Fabrice" — comptes qui voient tout mais ne modifient rien (encadrant, relecteur).
const READONLY = new Set((process.env.OUTREACH_READONLY || '').split(',').map((s) => s.trim()).filter(Boolean));
const DB_PATH = resolve(ROOT, process.env.DB_PATH || './data/outreach.sqlite');
const FILES_DIR = resolve(ROOT, process.env.FILES_DIR || './data/files');
const PHOTOS_DIR = resolve(ROOT, process.env.PHOTOS_DIR || './data/photos');
const MAX_BODY = 20 * 1024 * 1024;
const MAX_FILE = Number(process.env.MAX_FILE_MB || 500) * 1024 * 1024;

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

const safeName = (name) => basename(name || 'fichier').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 150) || 'fichier';

// Seuls les enregistrements sont acceptés. Un .mp4 (vidéo de visio) est gardé tel quel mais
// seule sa piste audio est lue dans l'app.
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.webm', '.flac', '.mp4', '.m4b', '.mov']);
const isRecording = (filename, mime) => AUDIO_EXT.has(extname(filename).toLowerCase()) || /^audio\//.test(mime || '') || mime === 'video/mp4';

// Upload : le corps de la requête est écrit tel quel sur le disque (pas de multipart, pas de buffer mémoire).
async function saveUpload(req, prospectId, filename, who) {
  const id = randomUUID();
  const dir = join(FILES_DIR, prospectId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, id + extname(filename).toLowerCase().slice(0, 10));
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > MAX_FILE) req.destroy(new Error('fichier trop volumineux')); });
  try {
    await pipeline(req, createWriteStream(path));
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  }
  const row = { id, prospect_id: prospectId, filename, mime: req.headers['content-type'] || 'application/octet-stream', size, uploaded_by: who, uploaded_at: new Date().toISOString() };
  db.prepare('INSERT INTO files(id, prospect_id, filename, mime, size, uploaded_by, uploaded_at) VALUES (@id, @prospect_id, @filename, @mime, @size, @uploaded_by, @uploaded_at)').run(row);
  return row;
}

function filePath(row) {
  return join(FILES_DIR, row.prospect_id, row.id + extname(row.filename).toLowerCase().slice(0, 10));
}

// Lecture avec Range (nécessaire pour avancer/reculer dans un audio).
async function sendFile(req, res, row) {
  const path = filePath(row);
  const { size } = await stat(path);
  const headers = {
    'content-type': row.mime || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    'cache-control': 'private, max-age=3600',
  };
  const range = (req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return pipeline(createReadStream(path, { start, end }), res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  return pipeline(createReadStream(path), res);
}

// Photos de profil servies depuis notre domaine : les URL media.licdn.com expirent et les
// bloqueurs (Brave) les cachent quand elles sont chargées directement. Copie locale au premier accès.
const photoFailures = new Map();
const photoFile = (id) => join(PHOTOS_DIR, id.replace(/[^A-Za-z0-9_-]/g, '_') + '.jpg');
async function sendPhoto(res, prospect) {
  const file = photoFile(prospect.id);
  let ok = await stat(file).then(() => true, () => false);
  if (!ok) {
    if ((photoFailures.get(prospect.id) || 0) > Date.now()) return json(res, 404, { error: 'photo indisponible' });
    try {
      const r = await fetch(prospect.photo_url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) throw new Error('HTTP ' + r.status);
      await mkdir(PHOTOS_DIR, { recursive: true });
      await pipeline(r.body, createWriteStream(file));
      ok = true;
    } catch {
      await rm(file, { force: true });
      photoFailures.set(prospect.id, Date.now() + 3600_000);
      return json(res, 404, { error: 'photo indisponible' });
    }
  }
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=604800' });
  return pipeline(createReadStream(file), res);
}

// ---- lecture d'un profil LinkedIn public (sans extension) ----
const cleanLinkedinUrl = (u) => { const m = String(u || '').trim().match(/linkedin\.com\/in\/([^/?#\s]+)/i); return m ? 'https://www.linkedin.com/in/' + decodeURIComponent(m[1]) : ''; };
// Lieu tel que LinkedIn l'affiche : « Lyon et périphérie », « Paris, Île-de-France, France », « Greater London Area ».
const LOC_RE = /^(?:[\p{Lu}][\p{L}' .-]{1,40}(?:,\s*[\p{L}' .-]{2,40}){1,3}|[\p{Lu}][\p{L}' .-]{1,40} (?:et périphérie|Area|Metropolitan Area)|Greater [\p{L}' .-]{2,40}(?: Area)?)$/u;
const isLoc = (l) => l.length < 70 && !/[.!?]$/.test(l) && LOC_RE.test(l);
// Sortie « Markdown Content » du lecteur r.jina.ai pour un profil public : titre « Nom - Poste | LinkedIn », puis le corps.
function parseLinkedinPublic(text) {
  const title = (text.match(/^Title:\s*(.+)$/m) || [])[1] || '';
  const [nomComplet, ...rest] = title.replace(/\s*\|\s*LinkedIn\s*$/i, '').split(' - ');
  const headline = rest.join(' - ').trim();
  const body = text.replace(/^[\s\S]*?Markdown Content:\s*/m, '');
  const lines = body.split('\n').map((l) => l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>]/g, '').trim()).filter(Boolean);
  const localisation = lines.slice(0, 60).find((l) => isLoc(l) && !/LinkedIn|profile|connections|followers|abonnés|relations/i.test(l)) || '';
  const entreprise = (headline.match(/(?:\s(?:at|chez|@)\s|\s[-–|·]\s)([^|@]+?)$/i) || [])[1]?.trim() || '';
  const iAbout = lines.findIndex((l) => /^(About|À propos|Infos)$/i.test(l));
  const aPropos = iAbout > -1 ? lines.slice(iAbout + 1, iAbout + 12).filter((l) => !/^(Experience|Expérience|Education|Formation)$/i.test(l)).join(' ').slice(0, 1500) : '';
  const photoUrl = (text.match(/https:\/\/media\.licdn\.com\/dms\/image\/[^\s)"]+/) || [])[0] || '';
  const contexte = lines.filter((l) => !/^(Skip to main content|Top Content|People|Learning|Jobs|Games|Join now|Sign in)$/i.test(l)).join('\n').slice(0, 60000);
  return { nomComplet: (nomComplet || '').trim(), titre: headline, entreprise, localisation, aPropos, photoUrl, contexte };
}
// Texte collé depuis la page LinkedIn (Ctrl+A, Ctrl+C sur le profil, toutes langues FR/EN) : on repère le nom,
// le poste (headline), le lieu, la section « Infos / About » et la première expérience.
const NAV_RE = /^(Accueil|Home|Réseau|My Network|Emplois|Jobs|Messagerie|Messaging|Notifications|Vous|Me|Pour les entreprises|For Business|Premium|Rechercher|Search|Skip to main content|Passer au contenu principal|Se connecter|Sign in|S’inscrire|Join now|Plus|More|Message|Se connecter|Connect|Suivre|Follow|Ouvrir|Open to|Coordonnées|Contact info|Modifier|Edit)$/i;
const COUNT_RE = /(relations?|connections?|abonnés|followers|contacts? en commun|mutual connections?)/i;
const SECTION_RE = /^(Infos|À propos|About|Expérience|Experience|Formation|Education|Activité|Activity|Compétences|Skills|Licences et certifications|Licenses & certifications|Recommandations|Recommendations|Langues|Languages|Centres d’intérêt|Interests|Projets|Projects|Publications|Bénévolat|Volunteering|Sélection|Featured|Services)$/i;
function parseLinkedinPasted(text, nomComplet) {
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && !NAV_RE.test(l));
  let i = nomComplet ? lines.findIndex((l) => l.toLowerCase() === nomComplet.toLowerCase()) : -1;
  if (i < 0) {
    // Le nom : première ligne de 2 à 5 mots capitalisés, suivie de près par la ligne « X relations »
    const iCount = lines.findIndex((l) => COUNT_RE.test(l) && l.length < 60);
    const window = lines.slice(Math.max(0, iCount - 12), iCount > 0 ? iCount : 40);
    const cand = window.find((l) => /^[\p{Lu}][\p{L}'’.-]+(?: [\p{L}'’.-]+){1,4}$/u.test(l) && !LOC_RE.test(l) && l.length < 60);
    if (cand) { nomComplet = cand.replace(/\s+(MBA|CISSP|CISM|PhD|Dr\.?)$/i, '').trim(); i = lines.indexOf(cand); }
  }
  const after = i > -1 ? lines.slice(i + 1, i + 14) : lines.slice(0, 30);
  const iStop = after.findIndex((l) => COUNT_RE.test(l) || SECTION_RE.test(l));   // « 500+ relations » ou 1re section : fin de l'en-tête
  const head = iStop > -1 ? after.slice(0, iStop) : after.slice(0, 6);
  const localisation = head.find((l) => isLoc(l)) || after.find((l) => isLoc(l) && !COUNT_RE.test(l)) || '';
  const titre = head.find((l) => l !== localisation && l.length > 3 && l.length < 200 && !/^\d/.test(l) && !/^(Voir|See|Il y a|ago)/i.test(l)) || '';
  let entreprise = (titre.match(/(?:\s(?:at|chez|@)\s|\s[-–|·]\s)([^|@]+?)$/i) || [])[1]?.trim() || '';
  const iExp = lines.findIndex((l) => /^(Expérience|Experience)$/i.test(l));
  if (iExp > -1) {
    // Bloc expérience : [poste] [entreprise · Temps plein] [dates] … ; on prend la ligne qui suit le 1er poste.
    const exp = lines.slice(iExp + 1, iExp + 8).filter((l) => !/^(Voir|See|Afficher|Show)/i.test(l));
    // La ligne qui suit le 1er intitulé de poste est l'entreprise (« Acme Ltd · Temps plein »).
    const firstCompany = (exp[1] || '').replace(/\s*·.*$/, '').trim();
    if (!entreprise && firstCompany && !/\d{4}/.test(firstCompany)) entreprise = firstCompany;
  }
  const iAbout = lines.findIndex((l) => /^(Infos|À propos|About)$/i.test(l));
  let aPropos = '';
  if (iAbout > -1) {
    const out = [];
    for (const l of lines.slice(iAbout + 1, iAbout + 30)) { if (SECTION_RE.test(l)) break; if (/^…?\s*(plus|more|voir plus|see more)$/i.test(l)) continue; out.push(l); }
    aPropos = out.join(' ').slice(0, 1500);
  }
  return { nomComplet: nomComplet || '', titre, entreprise, localisation, aPropos };
}

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
  let m; // captures des routes paramétrées (déclaré ici : les routes matrice l'utilisent avant les routes fichiers)
  const readOnly = READONLY.has(who);
  if (readOnly && method !== 'GET' && path !== '/logout') return json(res, 403, { error: 'compte en lecture seule : aucune modification possible' });

  if (path === '/me' && method === 'GET') {
    return json(res, 200, {
      who, readOnly,
      people: db.prepare('SELECT name, color FROM people ORDER BY position').all(),
    });
  }

  // Synchro Notion (entretiens réalisés, deux sens) — à la demande ; aussi toutes les 10 min.
  if (path === '/notion/status' && method === 'GET') {
    return json(res, 200, { enabled: notionEnabled(), running: notionState.running, last: notionState.last });
  }
  if (path === '/notion/sync' && method === 'POST') {
    if (!notionEnabled()) return json(res, 400, { error: 'Notion non configuré (NOTION_TOKEN / NOTION_DB_ID)' });
    if (notionState.running) return json(res, 409, { error: 'synchronisation déjà en cours' });
    return json(res, 200, await runNotionSync(who));
  }
  if (path === '/token' && method === 'GET') {
    return json(res, 200, { who, token: encodeURIComponent(who) + '.' + signToken(who) });
  }

  // ---- synchro extension ----
  // Page linkedin.com/in/… : retrouve la fiche et y enregistre le contexte du profil (texte).
  // Page compte Sales Navigator : site web de l'entreprise → domaine pour l'enrichissement e-mail.
  if (path === '/sync/company' && method === 'POST') {
    const b = await readJson(req);
    const entrepriseUrl = String(b.entrepriseUrl || '').replace(/[?#].*$/, '').replace(/\/$/, '');
    if (!/\/sales\/company\/\d+$/.test(entrepriseUrl)) return json(res, 400, { error: 'entrepriseUrl invalide' });
    const domaine = upsertCompany(db, { entrepriseUrl, nom: b.nom, site: b.site });
    const n = db.prepare('SELECT COUNT(*) AS n FROM prospects WHERE entreprise_url = ?').get(entrepriseUrl).n;
    return json(res, 200, { ok: true, domaine, prospects: n });
  }
  // Nom complet retrouvé pour des fiches au nom masqué : [{id, nomComplet, linkedinUrl}]
  if (path === '/sync/names' && method === 'POST') {
    const { items } = await readJson(req);
    let fixed = 0;
    for (const it of Array.isArray(items) ? items.slice(0, 500) : []) {
      if (it.id && it.nomComplet && fixName(db, it.id, it.nomComplet)) fixed++;
      if (it.id && it.linkedinUrl) db.prepare("UPDATE prospects SET linkedin_url = COALESCE(NULLIF(linkedin_url, ''), ?) WHERE id = ?").run(String(it.linkedinUrl).replace(/[?#].*$/, ''), it.id);
    }
    return json(res, 200, { fixed });
  }
  if (path === '/sync/profile' && method === 'POST') {
    const b = await readJson(req);
    const url = String(b.url || '').replace(/[?#].*$/, '').replace(/\/$/, '');
    const nomComplet = String(b.nomComplet || '').trim();
    let row = findByProfile(db, { url, memberId: b.memberId, nomComplet });
    if (!row && b.create && nomComplet) {
      const [prenom, ...rest] = nomComplet.split(/\s+/);
      const id = 'in-' + (url.match(/\/in\/([^/]+)/)?.[1] || normName(nomComplet).replace(/ /g, '-')).slice(0, 80);
      const now = new Date().toISOString();
      db.prepare(`INSERT OR IGNORE INTO prospects (id, prenom, nom, nom_complet, nom_norm, titre, localisation, linkedin_url, source_file, imported_at, updated_at)
        VALUES (@id, @prenom, @nom, @nomComplet, @norm, @titre, @localisation, @url, 'linkedin', @now, @now)`)
        .run({ id, prenom, nom: rest.join(' '), nomComplet, norm: normName(nomComplet), titre: b.titre || '', localisation: b.localisation || '', url, now });
      row = db.prepare('SELECT * FROM prospects WHERE id = ?').get(id);
    }
    if (!row) return json(res, 404, { found: false });
    if (b.slugNom && isTruncatedName(row.nom)) fixName(db, row.id, b.slugNom);
    const now = new Date().toISOString();
    db.prepare(`UPDATE prospects SET linkedin_url = COALESCE(NULLIF(linkedin_url, ''), @url),
      titre = CASE WHEN titre IS NULL OR titre = '' THEN @titre ELSE titre END,
      localisation = CASE WHEN localisation IS NULL OR localisation = '' THEN @localisation ELSE localisation END,
      contexte_linkedin = @contexte, contexte_maj = @now, updated_at = @now WHERE id = @id`)
      .run({ id: row.id, url: url || null, titre: b.titre || '', localisation: b.localisation || '', contexte: String(b.contexte || '').slice(0, 60000), now });
    // Photo de la page /in/ : remplace l'URL (celles de LinkedIn expirent) et la copie locale si elle n'a pas encore réussi.
    if (/^https:\/\/media\.licdn\.com\//.test(b.photoUrl || '')) {
      db.prepare('UPDATE prospects SET photo_url = ? WHERE id = ?').run(b.photoUrl, row.id);
      if (!row.photo_url || photoFailures.has(row.id)) { photoFailures.delete(row.id); await unlink(photoFile(row.id)).catch(() => {}); }
    }
    return json(res, 200, { found: true, ...db.prepare('SELECT id, nom_complet, contacte, contacte_le, interviewe, interviewe_le, notes FROM prospects WHERE id = ?').get(row.id) });
  }

  if (path === '/sync/status' && method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200);
    const out = {};
    if (ids.length) {
      const rows = db.prepare(`SELECT id, contacte, contacte_par, contacte_le, interviewe, interviewe_le, relance_le, notes FROM prospects WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
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
    return json(res, 200, updateProspect(db, id, { contacte: true }, who));
  }

  // ---- ajout d'un prospect depuis un lien LinkedIn (sans extension) ----
  // Le profil public est lu via un service de rendu (r.jina.ai) : LinkedIn répond 999 à toute requête directe
  // depuis un serveur. Marche pour les profils publics ; sinon l'interface propose de coller le texte de la page.
  if (path === '/linkedin/preview' && method === 'POST') {
    const b = await readJson(req);
    const url = cleanLinkedinUrl(b.url);
    if (!url) return json(res, 400, { error: 'lien LinkedIn invalide (attendu : https://www.linkedin.com/in/…)' });
    try {
      const r = await fetch('https://r.jina.ai/' + url, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(15_000) });
      const text = await r.text();
      const head = text.slice(0, 3000);
      if (!r.ok || /returned error 999|^Title:\s*(Sign Up|Sign In|LinkedIn Login)?\s*\|?\s*LinkedIn\s*$/mi.test(head) || /Agree & Join LinkedIn|authwall/i.test(head) || !/^Title:\s*\S.+\|\s*LinkedIn/m.test(head)) {
        return json(res, 200, { found: false, reason: r.ok ? 'LinkedIn refuse la lecture automatique de ce profil (mur de connexion)' : `lecteur indisponible (HTTP ${r.status})` });
      }
      const parsed = parseLinkedinPublic(text);
      if (!parsed.nomComplet) return json(res, 200, { found: false, reason: 'page lue mais nom introuvable' });
      const existing = findByProfile(db, { url, nomComplet: parsed.nomComplet });
      return json(res, 200, { found: true, url, ...parsed, existingId: existing?.id || null, existingName: existing?.nom_complet || null });
    } catch (e) {
      return json(res, 200, { found: false, reason: /abort|timeout/i.test(e.message) ? 'délai dépassé (30 s)' : e.message });
    }
  }
  if (path === '/linkedin/parse' && method === 'POST') {
    const b = await readJson(req);
    const texte = String(b.texte || '').trim();
    if (!texte) return json(res, 400, { error: 'texte requis' });
    return json(res, 200, parseLinkedinPasted(texte, String(b.nomComplet || '')));
  }
  if (path === '/prospects/from-linkedin' && method === 'POST') {
    const b = await readJson(req);
    const url = cleanLinkedinUrl(b.url);
    const nomComplet = String(b.nomComplet || '').trim();
    if (!url) return json(res, 400, { error: 'lien LinkedIn invalide' });
    if (!nomComplet) return json(res, 400, { error: 'nom complet requis' });
    // Texte collé (Ctrl+A / Ctrl+C sur le profil) : on en extrait ce qui manque, comme le fait l'extension.
    const pasted = String(b.texteColle || '').trim();
    const fromPaste = pasted ? parseLinkedinPasted(pasted, nomComplet) : {};
    const titre = String(b.titre || fromPaste.titre || '').trim();
    const entreprise = String(b.entreprise || fromPaste.entreprise || '').trim();
    const localisation = String(b.localisation || fromPaste.localisation || '').trim();
    const aPropos = String(b.aPropos || fromPaste.aPropos || '').trim();
    const contexte = String(b.contexte || pasted || '').slice(0, 60000);
    let row = findByProfile(db, { url, nomComplet });
    const now = new Date().toISOString();
    let created = false;
    if (!row) {
      const [prenom, ...rest] = nomComplet.split(/\s+/);
      const id = 'in-' + (url.match(/\/in\/([^/]+)/)?.[1] || normName(nomComplet).replace(/ /g, '-')).slice(0, 80);
      db.prepare(`INSERT OR IGNORE INTO prospects (id, prenom, nom, nom_complet, nom_norm, titre, entreprise, localisation, a_propos, linkedin_url, contact_par, source_file, imported_at, updated_at)
        VALUES (@id, @prenom, @nom, @nomComplet, @norm, @titre, @entreprise, @localisation, @aPropos, @url, @who, 'lien-linkedin', @now, @now)`)
        .run({ id, prenom, nom: rest.join(' '), nomComplet, norm: normName(nomComplet), titre, entreprise, localisation, aPropos, url, who, now });
      row = db.prepare('SELECT * FROM prospects WHERE id = ?').get(id);
      created = !!row;
      if (!row) return json(res, 500, { error: 'création impossible' });
    }
    db.prepare(`UPDATE prospects SET linkedin_url = COALESCE(NULLIF(linkedin_url, ''), @url),
      titre = CASE WHEN titre IS NULL OR titre = '' THEN @titre ELSE titre END,
      entreprise = CASE WHEN entreprise IS NULL OR entreprise = '' THEN @entreprise ELSE entreprise END,
      localisation = CASE WHEN localisation IS NULL OR localisation = '' THEN @localisation ELSE localisation END,
      a_propos = CASE WHEN a_propos IS NULL OR a_propos = '' THEN @aPropos ELSE a_propos END,
      contexte_linkedin = CASE WHEN @contexte <> '' THEN @contexte ELSE contexte_linkedin END,
      contexte_maj = CASE WHEN @contexte <> '' THEN @now ELSE contexte_maj END, updated_at = @now WHERE id = @id`)
      .run({ id: row.id, url, titre, entreprise, localisation, aPropos, contexte, now });
    if (/^https:\/\/media\.licdn\.com\//.test(b.photoUrl || '')) {
      db.prepare('UPDATE prospects SET photo_url = ? WHERE id = ?').run(b.photoUrl, row.id);
      photoFailures.delete(row.id); await unlink(photoFile(row.id)).catch(() => {});
    }
    const full = withZone(db.prepare('SELECT p.*, e.domaine FROM prospects p LEFT JOIN entreprises e ON e.entreprise_url = p.entreprise_url WHERE p.id = ?').get(row.id));
    return json(res, 200, { created, prospect: full });
  }

  // ---- matrice du problème / des opportunités ----
  if (path === '/matrice' && method === 'GET') {
    const axes = db.prepare('SELECT * FROM matrice_axes ORDER BY position, id').all();
    return json(res, 200, {
      profils: axes.filter((a) => a.axe === 'profil'),
      problemes: axes.filter((a) => a.axe === 'probleme'),
      cases: db.prepare('SELECT * FROM matrice_cases').all(),
      insights: db.prepare(`SELECT i.*, p.nom_complet, p.entreprise, p.titre AS prospect_titre, f.filename
        FROM insights i LEFT JOIN prospects p ON p.id = i.prospect_id LEFT JOIN files f ON f.id = i.file_id
        ORDER BY i.force DESC, i.id`).all(),
      interviewes: db.prepare(`SELECT p.id, p.nom_complet, p.entreprise, (SELECT f.id FROM files f JOIN transcripts t ON t.file_id = f.id WHERE f.prospect_id = p.id ORDER BY f.uploaded_at DESC LIMIT 1) AS file_id
        FROM prospects p WHERE p.interviewe = 1 OR EXISTS (SELECT 1 FROM files f WHERE f.prospect_id = p.id) ORDER BY p.nom_complet COLLATE NOCASE`).all(),
    });
  }
  if (path === '/matrice/axes' && method === 'POST') {
    const b = await readJson(req);
    if (!['profil', 'probleme'].includes(b.axe) || !String(b.nom || '').trim()) return json(res, 400, { error: 'axe (profil|probleme) et nom requis' });
    const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM matrice_axes WHERE axe = ?').get(b.axe)).p;
    const r = db.prepare('INSERT INTO matrice_axes (axe, nom, description, position, cree_le) VALUES (?, ?, ?, ?, ?)').run(b.axe, String(b.nom).trim(), String(b.description || ''), pos, new Date().toISOString());
    return json(res, 200, db.prepare('SELECT * FROM matrice_axes WHERE id = ?').get(r.lastInsertRowid));
  }
  if ((m = path.match(/^\/matrice\/axes\/(\d+)$/)) && method === 'PATCH') {
    const b = await readJson(req);
    const cur = db.prepare('SELECT * FROM matrice_axes WHERE id = ?').get(Number(m[1]));
    if (!cur) return json(res, 404, { error: 'axe introuvable' });
    db.prepare('UPDATE matrice_axes SET nom = ?, description = ?, position = ? WHERE id = ?')
      .run(String(b.nom ?? cur.nom).trim() || cur.nom, String(b.description ?? cur.description ?? ''), Number.isFinite(Number(b.position)) ? Number(b.position) : cur.position, cur.id);
    return json(res, 200, db.prepare('SELECT * FROM matrice_axes WHERE id = ?').get(cur.id));
  }
  if ((m = path.match(/^\/matrice\/axes\/(\d+)$/)) && method === 'DELETE') {
    const n = db.prepare('SELECT COUNT(*) AS n FROM insights WHERE profil_id = ? OR probleme_id = ?').get(Number(m[1]), Number(m[1])).n;
    db.prepare('DELETE FROM matrice_axes WHERE id = ?').run(Number(m[1]));
    return json(res, 200, { ok: true, insightsDeclasses: n });
  }
  if ((m = path.match(/^\/matrice\/cases\/(\d+)\/(\d+)$/)) && method === 'PUT') {
    const b = await readJson(req);
    const score = (v) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.min(5, Math.round(Number(v)))));
    db.prepare(`INSERT INTO matrice_cases (profil_id, probleme_id, attractivite, accessibilite, commentaire, maj, maj_par) VALUES (@p, @q, @a, @b, @c, @now, @who)
      ON CONFLICT(profil_id, probleme_id) DO UPDATE SET attractivite = excluded.attractivite, accessibilite = excluded.accessibilite, commentaire = excluded.commentaire, maj = excluded.maj, maj_par = excluded.maj_par`)
      .run({ p: Number(m[1]), q: Number(m[2]), a: score(b.attractivite), b: score(b.accessibilite), c: String(b.commentaire || ''), now: new Date().toISOString(), who });
    return json(res, 200, db.prepare('SELECT * FROM matrice_cases WHERE profil_id = ? AND probleme_id = ?').get(Number(m[1]), Number(m[2])));
  }
  if (path === '/insights' && method === 'POST') {
    const b = await readJson(req);
    const texte = String(b.texte || '').trim();
    if (!texte) return json(res, 400, { error: 'texte requis' });
    const r = db.prepare(`INSERT INTO insights (texte, verbatim, type, theme, force, prospect_id, file_id, t_debut, profil_id, probleme_id, source, statut, cree_par, cree_le)
      VALUES (@texte, @verbatim, @type, @theme, @force, @prospect_id, @file_id, @t_debut, @profil_id, @probleme_id, @source, @statut, @who, @now)`).run({
      texte, verbatim: String(b.verbatim || ''), type: String(b.type || ''), theme: String(b.theme || ''), force: b.force == null || b.force === '' ? null : Math.max(0, Math.min(5, Number(b.force))),
      prospect_id: b.prospect_id || null, file_id: b.file_id || null, t_debut: b.t_debut == null ? null : Number(b.t_debut),
      profil_id: b.profil_id ? Number(b.profil_id) : null, probleme_id: b.probleme_id ? Number(b.probleme_id) : null,
      source: ['interview', 'marche', 'ia'].includes(b.source) ? b.source : 'interview', statut: ['proposé', 'validé', 'rejeté'].includes(b.statut) ? b.statut : 'proposé', who, now: new Date().toISOString() });
    return json(res, 200, db.prepare('SELECT * FROM insights WHERE id = ?').get(r.lastInsertRowid));
  }
  if ((m = path.match(/^\/insights\/(\d+)$/)) && method === 'PATCH') {
    const b = await readJson(req);
    const cur = db.prepare('SELECT * FROM insights WHERE id = ?').get(Number(m[1]));
    if (!cur) return json(res, 404, { error: 'insight introuvable' });
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    db.prepare(`UPDATE insights SET texte = @texte, verbatim = @verbatim, type = @type, theme = @theme, force = @force, profil_id = @profil_id, probleme_id = @probleme_id, statut = @statut, prospect_id = @prospect_id, file_id = @file_id, t_debut = @t_debut, maj = @now WHERE id = @id`).run({
      id: cur.id, texte: has('texte') ? String(b.texte).trim() || cur.texte : cur.texte, verbatim: has('verbatim') ? String(b.verbatim) : cur.verbatim, type: has('type') ? String(b.type) : cur.type, theme: has('theme') ? String(b.theme) : cur.theme,
      force: has('force') ? (b.force == null || b.force === '' ? null : Math.max(0, Math.min(5, Number(b.force)))) : cur.force,
      profil_id: has('profil_id') ? (b.profil_id ? Number(b.profil_id) : null) : cur.profil_id, probleme_id: has('probleme_id') ? (b.probleme_id ? Number(b.probleme_id) : null) : cur.probleme_id,
      statut: has('statut') && ['proposé', 'validé', 'rejeté'].includes(b.statut) ? b.statut : cur.statut,
      prospect_id: has('prospect_id') ? (b.prospect_id || null) : cur.prospect_id, file_id: has('file_id') ? (b.file_id || null) : cur.file_id, t_debut: has('t_debut') ? (b.t_debut == null ? null : Number(b.t_debut)) : cur.t_debut, now: new Date().toISOString() });
    return json(res, 200, db.prepare('SELECT * FROM insights WHERE id = ?').get(cur.id));
  }
  if ((m = path.match(/^\/insights\/(\d+)$/)) && method === 'DELETE') {
    db.prepare('DELETE FROM insights WHERE id = ?').run(Number(m[1]));
    return json(res, 200, { ok: true });
  }

  if (path === '/export.csv' && method === 'GET') {
    const rows = db.prepare(`
      SELECT p.*, e.domaine, (SELECT COUNT(*) FROM files f WHERE f.prospect_id = p.id) AS nb_fichiers
      FROM prospects p LEFT JOIN entreprises e ON e.entreprise_url = p.entreprise_url ORDER BY p.nom_complet COLLATE NOCASE`).all().map(withZone);
    const cols = [
      ['nom_complet', 'Nom complet'], ['prenom', 'Prénom'], ['nom', 'Nom'], ['titre', 'Titre'], ['entreprise', 'Entreprise'],
      ['localisation', 'Localisation'], ['domaine', 'Domaine'], ['pays_calc', 'Pays'], ['zone_calc', 'Zone'], ['degre', 'Degré'],
      ['contacte', 'Contacté'], ['contacte_le', 'Contacté le'],
      ['interviewe', 'Interviewé'], ['interviewe_le', 'Interviewé le'],
      ['relance_le', 'Relance le'], ['notes', 'Notes'], ['nb_fichiers', 'Fichiers'],
      ['email', 'E-mail'], ['email_confiance', 'Confiance e-mail'], ['email_statut', 'Statut e-mail'], ['email_note', 'Note e-mail'],
      ['relations_communes', 'Relations en commun'], ['anciennete_poste', 'Ancienneté poste'],
      ['anciennete_entreprise', 'Ancienneté entreprise'], ['derniere_activite', 'Dernière activité'],
      ['a_propos', 'À propos'], ['contexte_linkedin', 'Profil LinkedIn'], ['profil_url', 'URL Sales Navigator'], ['linkedin_url', 'URL LinkedIn'],
      ['entreprise_url', 'URL entreprise'], ['imported_at', 'Importé le'], ['source_file', 'Source'],
    ];
    const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const fmt = (k, v) => (k === 'zone_calc' ? ({ FR: 'France', INT: 'International' }[v] || '') : k === 'contacte' || k === 'interviewe' ? (v ? 'oui' : 'non') : /_le$|_at$/.test(k) ? (v || '').slice(0, 10) : v);
    const lines = [cols.map(([, h]) => cell(h)).join(';'), ...rows.map((r) => cols.map(([k]) => cell(fmt(k, r[k]))).join(';'))];
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="outreach-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    });
    return res.end('﻿' + lines.join('\r\n'));
  }

  if (path === '/prospects' && method === 'GET') {
    return json(res, 200, db.prepare('SELECT p.*, e.domaine FROM prospects p LEFT JOIN entreprises e ON e.entreprise_url = p.entreprise_url ORDER BY p.updated_at DESC LIMIT 5000').all().map(withZone));
  }

  if ((m = path.match(/^\/prospects\/([^/]+)$/)) && method === 'PATCH') {
    const patch = await readJson(req);
    try {
      const row = withZone(updateProspect(db, decodeURIComponent(m[1]), patch, who) || {});
      return row ? json(res, 200, row) : json(res, 404, { error: 'prospect introuvable' });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // ---- fichiers (audio, documents) rattachés à un prospect ----
  // Transcript synchronisé d'un enregistrement : {text, segments:[{start,end,text,words:[{w,s,e,p}]}], model, language}
  if ((m = path.match(/^\/files\/([^/]+)\/transcript$/)) && method === 'GET') {
    const row = db.prepare('SELECT * FROM transcripts WHERE file_id = ?').get(m[1]);
    if (!row) return json(res, 404, { error: 'pas de transcript' });
    return json(res, 200, { ...row, segments: JSON.parse(row.segments) });
  }
  if ((m = path.match(/^\/files\/([^/]+)\/transcript$/)) && method === 'PUT') {
    if (!db.prepare('SELECT 1 FROM files WHERE id = ?').get(m[1])) return json(res, 404, { error: 'fichier introuvable' });
    const b = await readJson(req);
    if (!Array.isArray(b.segments) || !b.segments.length) return json(res, 400, { error: 'segments requis' });
    const segments = b.segments.map((s) => ({ start: +s.start, end: +s.end, text: String(s.text || ''), words: (s.words || []).map((w) => ({ w: String(w.w || ''), s: +w.s, e: +w.e, p: +w.p || 0 })) }));
    const text = b.text || segments.map((s) => s.text).join('\n');
    db.prepare(`INSERT INTO transcripts(file_id, text, segments, model, language, created_at) VALUES (@id, @text, @segments, @model, @language, @now)
      ON CONFLICT(file_id) DO UPDATE SET text = excluded.text, segments = excluded.segments, model = excluded.model, language = excluded.language, created_at = excluded.created_at`)
      .run({ id: m[1], text, segments: JSON.stringify(segments), model: b.model || null, language: b.language || null, now: new Date().toISOString() });
    return json(res, 200, { ok: true, segments: segments.length });
  }
  if ((m = path.match(/^\/prospects\/([^/]+)\/files$/)) && method === 'GET') {
    return json(res, 200, db.prepare('SELECT f.*, (t.file_id IS NOT NULL) AS has_transcript FROM files f LEFT JOIN transcripts t ON t.file_id = f.id WHERE f.prospect_id = ? ORDER BY f.uploaded_at DESC').all(decodeURIComponent(m[1])));
  }
  if ((m = path.match(/^\/prospects\/([^/]+)\/files$/)) && method === 'POST') {
    const prospectId = decodeURIComponent(m[1]);
    if (!db.prepare('SELECT 1 FROM prospects WHERE id = ?').get(prospectId)) return json(res, 404, { error: 'prospect introuvable' });
    const filename = safeName(url.searchParams.get('filename'));
    if (!isRecording(filename, req.headers['content-type'])) {
      req.resume();
      return json(res, 415, { error: 'seuls les enregistrements audio sont acceptés (.mp3, .m4a, .wav, .mp4…)' });
    }
    try {
      const row = await saveUpload(req, prospectId, filename, who);
      // Un enregistrement déposé = entretien réalisé.
      updateProspect(db, prospectId, { interviewe: true }, who);
      return json(res, 200, row);
    } catch (e) {
      return json(res, 413, { error: e.message });
    }
  }
  if ((m = path.match(/^\/files\/([^/]+)$/)) && method === 'GET') {
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(m[1]);
    if (!row) return json(res, 404, { error: 'fichier introuvable' });
    return sendFile(req, res, row);
  }
  if ((m = path.match(/^\/photo\/([^/]+)$/)) && method === 'GET') {
    const row = db.prepare('SELECT id, photo_url FROM prospects WHERE id = ?').get(decodeURIComponent(m[1]));
    if (!row?.photo_url) return json(res, 404, { error: 'pas de photo' });
    return sendPhoto(res, row);
  }
  if ((m = path.match(/^\/files\/([^/]+)$/)) && method === 'DELETE') {
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(m[1]);
    if (!row) return json(res, 404, { error: 'fichier introuvable' });
    await rm(filePath(row), { force: true });
    db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    return json(res, 200, { ok: true });
  }

  if (path === '/import/names' && method === 'POST') {
    const { text } = await readJson(req);
    const names = String(text || '').split(/\r?\n/).map((l) => l.replace(/^[\s\-*•\d.)]+/, '').replace(/[;,\t].*$/, '').trim()).filter(Boolean);
    if (!names.length) return json(res, 400, { error: 'aucun nom' });
    return json(res, 200, markContactedByNames(db, names.slice(0, 2000), who));
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

const notionState = { running: false, last: null };
async function runNotionSync(who) {
  notionState.running = true;
  try {
    const report = await syncNotion(db, { token: process.env.NOTION_TOKEN, dbId: process.env.NOTION_DB_ID, crmUrl: (process.env.NOTION_CRM_URL || 'https://missioncrea.clippingatlas.com').replace(/\/$/, ''), who, log: (l) => console.log('[notion]', l) });
    notionState.last = { at: new Date().toISOString(), who, ...report };
  } catch (e) {
    console.error('[notion]', e);
    notionState.last = { at: new Date().toISOString(), who, errors: [e.message] };
  } finally { notionState.running = false; }
  return notionState.last;
}
if (notionEnabled()) {
  setTimeout(() => runNotionSync('auto'), 30_000);
  setInterval(() => { if (!notionState.running) runNotionSync('auto'); }, 10 * 60_000);
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

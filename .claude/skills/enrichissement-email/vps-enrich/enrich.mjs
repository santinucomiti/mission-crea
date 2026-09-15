#!/usr/bin/env node
// Enrichissement e-mail « low-hanging fruits » — entreprise par entreprise, sans coût récurrent.
//
//   node enrich.mjs entree.csv sortie.csv [options]
//
//   --state fichier.json     état persistant (domaines résolus, patterns, vérifications) — défaut : ./enrich-state.json
//   --verify                 vérifie via MyEmailVerifier (MYEMAILVERIFIER_KEY) dans la limite du quota
//   --max-verify N           vérifications maximum pour cette exécution (défaut 100 ; avec plusieurs clés : 100 × nombre de clés)
//   --no-search              ne cherche pas le domaine sur le web (utilise seulement la colonne domaine)
//   --only-domains           s'arrête après la résolution des domaines et la récolte des témoins
//   --hunter                 utilise Hunter (HUNTER_API_KEY) pour la recherche par domaine (pattern + témoins)
//   --concurrency N          entreprises traitées en parallèle (défaut 5) ; la recherche web reste sérialisée
//   --no-github              ne cherche pas de témoins dans les commits GitHub (GITHUB_TOKEN conseillé : 5 000 req/h au lieu de 60)
//
// Entrée : CSV (; ou ,) avec prenom, nom, entreprise, et optionnellement domaine, id, linkedin_url, poste, pays.
// Sortie : le CSV d'entrée + domaine, email, pattern, source_pattern, nb_temoins, catch_all, verifie, confiance, note.
// Node ≥ 20, aucune dépendance.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Clés : variables d'environnement, ou fichier .env à côté du script / dans le dossier du skill (jamais commité).
for (const envPath of [join(dirname(fileURLToPath(import.meta.url)), '.env'), join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), '.env']) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : def; };
const [inputPath, outputPath] = args.filter((a, i) => !a.startsWith('--') && !['--state', '--max-verify', '--concurrency'].includes(args[i - 1]));
if (!inputPath || !outputPath) { console.error('usage : node enrich.mjs entree.csv sortie.csv [--state s.json] [--verify] [--max-verify N] [--no-search] [--hunter]'); process.exit(1); }
const STATE_PATH = opt('--state', './enrich-state.json');
const MAX_VERIFY = Number(opt('--max-verify', 0)) || 0;
const DO_VERIFY = flag('--verify');
const USE_HUNTER = flag('--hunter');
const NO_SEARCH = flag('--no-search');
const NO_GITHUB = flag('--no-github');
const REFRESH_WITNESSES = flag('--refresh-witnesses'); // re-récolte site/github/web et fusionne avec les témoins persistants
const CONCURRENCY = Math.max(1, Number(opt('--concurrency', 5)) || 5);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
// Une clé par membre de l'équipe (chacun son compte) : MYEMAILVERIFIER_KEYS="clé1,clé2" ou MYEMAILVERIFIER_KEY.
const MEV_KEYS = [...new Set(((process.env.MYEMAILVERIFIER_KEYS || '') + ',' + (process.env.MYEMAILVERIFIER_KEY || '')).split(',').map((k) => k.trim()).filter(Boolean))];
const MEV_KEY = MEV_KEYS[0] || '';
const MEV_DAILY = Number(process.env.MYEMAILVERIFIER_DAILY || 100);
const MAX_VERIFY_EFFECTIVE = () => MAX_VERIFY || MEV_DAILY * Math.max(1, MEV_KEYS.length);
const HUNTER_KEY = process.env.HUNTER_API_KEY || '';

const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));
// Délai garanti sur une promesse : un serveur qui envoie les en-têtes puis bloque le corps ne doit jamais suspendre le run.
const withDeadline = (p, ms, what) => { let t; const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('délai dépassé : ' + what)), ms); }); return Promise.race([p, guard]).finally(() => clearTimeout(t)); };
const today = () => new Date().toISOString().slice(0, 10);

// ---------- CSV ----------
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const nl = text.indexOf('\n');
  const first = text.slice(0, nl > -1 ? nl : text.length);
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}
const csvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
function writeCsv(path, rows, columns) {
  const lines = [columns.map(csvCell).join(';'), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(';'))];
  writeFileSync(path, '﻿' + lines.join('\n'));
}
// Colonnes d'entrée tolérantes (Prénom / prenom / first_name…).
function col(row, ...names) {
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((k) => k.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') === n);
    if (k && row[k]) return row[k];
  }
  return '';
}

// ---------- Normalisation des noms (§5.3) ----------
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').trim();
// Titres et diplômes collés au nom sur LinkedIn (« Ferguson MBA », « Smith CISSP, CISM ») : on les retire.
// Liste étendue (UK/FR) : ordres professionnels (FCIIS/MCIIS/ACIIS, FSyI/MSyI/ASyI — « FSyl » est une coquille fréquente),
// certifications cyber/IT, diplômes, distinctions. Ne jamais y mettre un mot qui peut être un nom de famille.
const CREDENTIALS = /\b(mba|emba|msc|beng|bsc|ba|ma|mphil|dphil|phd|dr|prof|llb|llm|pgd|pgdip|cissp(?:-issap|-issep|-issmp)?|cism|cisa|crisc|ccsp|ccsk|cismp|cdpse|cipp\/?[a-z]?|cipt|cipm|fip|ceh|chfi|oscp|osce|oswe|gcih|gsec|gpen|gcfa|giac|cgeit|pmp|prince2|itil|togaf|sabsa|fbcs|mbcs|citp|miet|fiet|fciis|mciis|aciis|fsyi|msyi|asyi|fsyl|msyl|fcips|mcips|ccie|ccna|ccnp|cipd|fcipd|mcipd|miod|fcmi|mcmi|cmgr|acma|cgma|fca|aca|acca|cbe|obe|mbe|frsa|ciso|ceo|cto|coo|cfo|cio|jr|sr|ii|iii|iv)\b/gi;
const stripCredentials = (s) => (s || '').replace(/[,(].*$/, '').replace(CREDENTIALS, ' ').replace(/\s+/g, ' ').trim();
// « Sarah L. » : nom masqué par Sales Navigator hors réseau → impossible de générer une adresse.
const truncatedSurname = (nom) => /^[A-Za-zÀ-ÿ]\.?$/.test((nom || '').trim());
const PARTICLES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'van', 'von', 'der', 'den', 'di', 'da', 'del', 'della', 'dos', 'das', 'el', 'al', 'ben', 'bin', 'mac', 'mc', 'st', 'saint', 'y', 'e', 'd', 'l']);
function nameVariants(s) {
  const tokens = norm(s).split(/[\s-]+/).filter(Boolean);
  if (!tokens.length) return [];
  const noParticles = tokens.filter((t) => !PARTICLES.has(t));
  const v = new Set();
  v.add(noParticles.join('') || tokens.join(''));
  v.add(tokens.join(''));
  v.add(noParticles.join('-') || tokens.join('-'));
  if (noParticles.length > 1) { v.add(noParticles[noParticles.length - 1]); v.add(noParticles[0]); }
  return [...v].filter(Boolean);
}
const PATTERNS = {
  'prenom.nom': (p, n) => `${p}.${n}`,
  'prenom': (p) => p,
  'pnom': (p, n) => `${p[0]}${n}`,
  'prenomnom': (p, n) => `${p}${n}`,
  'prenom_nom': (p, n) => `${p}_${n}`,
  'nom.prenom': (p, n) => `${n}.${p}`,
  'p.nom': (p, n) => `${p[0]}.${n}`,
  'nom': (p, n) => n,
  'prenom-nom': (p, n) => `${p}-${n}`,
  'nomp': (p, n) => `${n}${p[0]}`,
};
const HUNTER_PATTERNS = { '{first}.{last}': 'prenom.nom', '{first}': 'prenom', '{f}{last}': 'pnom', '{first}{last}': 'prenomnom', '{first}_{last}': 'prenom_nom', '{last}.{first}': 'nom.prenom', '{f}.{last}': 'p.nom', '{last}': 'nom', '{first}-{last}': 'prenom-nom', '{last}{f}': 'nomp' };
// Toutes les adresses locales possibles d'une personne pour un pattern (variantes de noms composés / particules).
function candidates(person, pattern) {
  const out = new Set();
  for (const p of person.prenoms) for (const n of person.noms) { const c = PATTERNS[pattern](p, n); if (c && c.length >= 2) out.add(c); }
  return [...out];
}
// Adresse principale = première variante (nom sans particules, prénom composé soudé).
const primary = (person, pattern) => candidates(person, pattern)[0];
// Témoin persistant (site, github, sondage, vérification…) : jamais deux fois le même local-part.
const addWitness = (d, local, source, name) => { d.witnesses = d.witnesses || []; if (local && !d.witnesses.some((w) => w.local === local)) d.witnesses.push({ local, source, name: name || '' }); };
// Forme du local-part → pattern probable quand on ne connaît pas le nom du témoin.
function shapePattern(local) {
  if (/^[a-z]\.[a-z]{2,}$/.test(local)) return 'p.nom';
  if (/^[a-z]{2,}\.[a-z]{2,}$/.test(local)) return 'prenom.nom';
  if (/^[a-z]{2,}_[a-z]{2,}$/.test(local)) return 'prenom_nom';
  if (/^[a-z]{2,}-[a-z]{2,}$/.test(local)) return 'prenom-nom';
  return null; // soudé ou prénom seul : ambigu sans le nom
}

// ---------- Concurrence ----------
function semaphore(n) {
  let active = 0; const queue = [];
  const next = () => { if (active < n && queue.length) { active++; queue.shift()(); } };
  return async (fn) => { await new Promise((r) => { queue.push(r); next(); }); try { return await fn(); } finally { active--; next(); } };
}
const webSearchSlot = semaphore(1); // DuckDuckGo : une requête à la fois, espacée
const verifySlot = semaphore(1); // le vérificateur greylist davantage quand on l'appelle en parallèle
const githubSlot = semaphore(1);
async function mapPool(items, n, fn) { const run = semaphore(n); return Promise.all(items.map((it) => run(() => fn(it)))); }

// ---------- Réseau ----------
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
// ENRICH_HTTP_CACHE=<dossier> : réponses rejouées à l'identique (bench déterministe, sites non re-sollicités). Les échecs sont aussi mémorisés.
const HTTP_CACHE = process.env.ENRICH_HTTP_CACHE || '';
const RETRY_FAILED = !!process.env.ENRICH_HTTP_RETRY_FAILED; // re-tente les échecs mémorisés (quand la façon d'appeler change)
// En-têtes d'un vrai navigateur : plusieurs sites (Schroders, Telegraph, Ageas…) renvoient 403 à un client « nu ».
const BROWSER_HEADERS = { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-GB,en;q=0.9,fr;q=0.8', 'upgrade-insecure-requests': '1', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1' };
async function get(url, { timeout = 10000, max = 600_000 } = {}) {
  const file = HTTP_CACHE ? join(HTTP_CACHE, createHash('sha1').update(url).digest('hex') + '.json') : '';
  if (file && existsSync(file)) { const c = JSON.parse(readFileSync(file, 'utf8')); if (!(RETRY_FAILED && (c.error || c.status >= 400))) { if (c.error) throw new Error(c.error); return c; } }
  let out;
  try {
    const r = await withDeadline(fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(timeout) }), timeout + 3000, url);
    out = { status: r.status, url: r.url, text: (await withDeadline(r.text(), timeout + 3000, url + ' (corps)')).slice(0, max) };
  } catch (e) { if (!file) throw e; out = { status: 599, url, text: '', error: e.message }; }
  if (file) { mkdirSync(HTTP_CACHE, { recursive: true }); writeFileSync(file, JSON.stringify(out)); }
  if (out.error) throw new Error(out.error);
  return out;
}
const DIRECTORIES = /linkedin\.|pappers|societe\.com|pagesjaunes|facebook|wikipedia|infogreffe|verif\.com|kompass|indeed|glassdoor|welcometothejungle|crunchbase|bloomberg|zoominfo|rocketreach|\bx\.com|twitter|youtube|instagram|annuaire|manageo|europages|dnb\.com|apollo\.io|lusha|kaspr|trustpilot|tiktok|pinterest|amazon\.|leboncoin|societeinfo|score3|b-reputation|dirigeant|opencorporates|companieshouse|northdata|ellisphere|creditsafe|owler|signalhire|xing\.com|glassdoor|jobteaser|hellowork|apec\.fr|duckduckgo|google\.|bing\.com/i;
const PUBLIC_DOMAINS = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|orange|wanadoo|free|sfr|laposte|bbox|numericable|neuf|protonmail|proton|gmx|web|mail|yandex|zoho)\.(com|fr|net|org|me|de|co\.uk|ch|be)$/i;
const GENERIC_LOCAL = /^(contact|info|infos|hello|bonjour|rh|hr|jobs?|job|recrutement|recruiting|careers?|talent|press|presse|media|sales|commercial|support|help|admin|webmaster|noreply|no-reply|nepasrepondre|dpo|privacy|rgpd|gdpr|legal|juridique|compliance|marketing|communication|com|team|office|security|abuse|postmaster|hostmaster|newsletter|partenariat|partners?|invest(or|isseurs)?|ir|billing|facturation|compta|accounting|finance|service|services|clients?|customer|welcome|accueil|direction|secretariat|reception|order|orders|shop|store|emploi|candidature|stage|alternance|formation|events?|evenements?|ventes?|export|achat|achats|qualite|it|informatique|dsi|sav|urgence|urgences|bureau|paris|lyon|france|uk|us|eu|europe|global|corporate|group|groupe|holding|dev|tech|api|test|demo|example|exemple|mail|email|e-mail|firstname|lastname|prenom|nom|name|user|username|votre|your|you|me|moi)(-[a-z]+)?$/i;
// Cloudflare « email-protection » : adresse encodée en hexadécimal XOR (data-cfemail) pour échapper aux robots.
const decodeCfEmail = (html) => [...html.matchAll(/data-cfemail=["']([0-9a-f]{6,})["']/gi)].map((m) => { const h = m[1]; const k = parseInt(h.slice(0, 2), 16); let o = ''; for (let i = 2; i < h.length; i += 2) o += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ k); return o; }).join(' ');
const EMAIL_RE = (domain) => new RegExp('([a-z0-9._%+-]+)\\s*(?:@|\\(at\\)|\\[at\\]|&#64;|%40)\\s*' + domain.replace(/\./g, '\\s*(?:\\.|\\(dot\\)|\\[dot\\])\\s*') + '(?![a-z0-9.-])', 'gi');

async function hasMx(domain) {
  try { const mx = await resolveMx(domain); return mx.length > 0; } catch { return false; }
}
async function finalHost(domain) {
  for (const scheme of ['https://', 'http://']) {
    try { const r = await fetch(scheme + domain, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) }); return new URL(r.url).hostname.replace(/^www\./, ''); } catch { /* essai suivant */ }
  }
  return domain;
}
const cleanDomain = (s) => (s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');

// Résultats DuckDuckGo (HTML) → URLs. Sérialisé et espacé pour ne pas déclencher le captcha.
async function ddg(query) {
  return webSearchSlot(async () => {
    await jitter(900, 1700);
    const { text } = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeout: 12000 });
    if (/anomaly|captcha|challenge/i.test(text) && !/result__a/.test(text)) throw new Error('DuckDuckGo bloque (captcha) — réessayer plus tard ou --no-search');
    return [...text.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/g)].map((m) => m[1])
      .map((h) => (h.includes('uddg=') ? decodeURIComponent(h.split('uddg=')[1].split('&')[0]) : h));
  });
}
// Bing (HTML) en secours quand DuckDuckGo bloque. Les liens sont des redirections « /ck/a?…&u=a1<base64url> ».
async function bing(query) {
  return webSearchSlot(async () => {
    await jitter(900, 1700);
    const { text } = await get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&FORM=QBLH`, { timeout: 12000 });
    const out = [];
    for (const block of text.split('<li class="b_algo"').slice(1)) {
      const u = block.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
      if (u) { try { out.push(Buffer.from(u[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); continue; } catch { /* base64 invalide */ } }
      const direct = block.match(/<h2><a[^>]+href="(https?:[^"]+)"/) || block.match(/aria-label="([a-z0-9.-]+\.[a-z]{2,})"/i);
      if (direct) out.push(direct[1].startsWith('http') ? direct[1] : 'https://' + direct[1]);
    }
    return out;
  });
}
async function webSearch(query, L) {
  try { return await ddg(query); } catch (e) { L('  duckduckgo :', e.message, '→ bing'); }
  try { return await bing(query); } catch (e) { L('  bing :', e.message); }
  return [];
}
// Annuaire d'entreprises → domaine, sans clé (Clearbit Autocomplete). Bien plus fiable qu'un moteur
// de recherche pour les noms courts / homonymes ; on exige que le nom renvoyé ressemble au nôtre.
async function clearbitDomain(entreprise, L) {
  try {
    const r = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(entreprise)}`, { signal: AbortSignal.timeout(8000) });
    const list = r.ok ? await r.json() : [];
    const want = norm(entreprise).replace(/\b(plc|ltd|limited|llc|inc|sas|sa|sarl|gmbh|group|groupe|holdings?)\b/g, '').replace(/\s+/g, '');
    for (const c of list) {
      const got = norm(c.name).replace(/\b(plc|ltd|limited|llc|inc|sas|sa|sarl|gmbh|group|groupe|holdings?)\b/g, '').replace(/\s+/g, '');
      if (got === want || got.startsWith(want) || want.startsWith(got)) return c.domain;
    }
    if (list.length) L(`  clearbit propose ${list[0].name} (${list[0].domain}) — nom trop différent, ignoré`);
  } catch (e) { L('  clearbit :', e.message); }
  return '';
}
async function searchDomain(entreprise, L) {
  const cb = await clearbitDomain(entreprise, L);
  if (cb) return cb;
  for (const u of await webSearch(`${entreprise} official website`, L)) {
    try { const host = new URL(u).hostname.replace(/^www\./, ''); if (!DIRECTORIES.test(host) && !PUBLIC_DOMAINS.test(host)) return host; } catch { /* lien non exploitable */ }
  }
  return '';
}
// Pages tierces qui citent des adresses du domaine (communiqués, PDF, offres d'emploi, annuaires pro).
async function webWitnesses(domain, L) {
  const found = new Map();
  try {
    const urls = (await webSearch(`"@${domain}"`, L)).filter((u) => { try { const h = new URL(u).hostname; return !/duckduckgo|linkedin\.|facebook|twitter|x\.com/i.test(h); } catch { return false; } }).slice(0, 5);
    await mapPool(urls, 3, async (u) => {
      try {
        const { text } = await get(u, { timeout: 8000, max: 500_000 });
        for (const m of text.matchAll(EMAIL_RE(domain))) { const local = m[1].toLowerCase(); if (local.length >= 2 && local.length <= 40 && !GENERIC_LOCAL.test(local) && !found.has(local)) found.set(local, 'web:' + new URL(u).hostname); }
      } catch { /* page inaccessible */ }
    });
  } catch (e) { L('  recherche « @domaine » impossible :', e.message); }
  return [...found].map(([local, source]) => ({ local, source, name: '' }));
}

// Commits publics de l'organisation GitHub de l'entreprise (« git log --format=%ae »).
let githubRemaining = Infinity;
async function gh(path) {
  if (githubRemaining < 3) return null;
  return githubSlot(async () => {
    const r = await fetch('https://api.github.com' + path, { headers: { 'user-agent': 'mission-crea-enrich', accept: 'application/vnd.github+json', ...(GITHUB_TOKEN ? { authorization: 'Bearer ' + GITHUB_TOKEN } : {}) }, signal: AbortSignal.timeout(15000) });
    const rem = Number(r.headers.get('x-ratelimit-remaining')); if (!Number.isNaN(rem)) githubRemaining = rem;
    if (r.status === 403 || r.status === 429) { githubRemaining = 0; return null; }
    if (!r.ok) return null;
    return r.json();
  });
}
async function githubWitnesses(domain, entreprise, L) {
  const found = new Map();
  try {
    const root = domain.split('.')[0];
    const seen = new Set();
    const candidates = [];
    for (const q of [root, norm(entreprise).replace(/\s+/g, ' ')]) {
      if (!q || q.length < 3) continue;
      const res = await gh(`/search/users?q=${encodeURIComponent(q)}+type:org&per_page=5`);
      for (const it of res?.items || []) if (!seen.has(it.login)) { seen.add(it.login); candidates.push(it.login); }
    }
    const rootN = root.replace(/[^a-z0-9]/g, '');
    const entN = norm(entreprise).replace(/[^a-z0-9]/g, '');
    let org = null;
    for (const login of candidates.slice(0, 4)) {
      const o = await gh(`/orgs/${login}`);
      if (!o) continue;
      const loginN = login.toLowerCase().replace(/[^a-z0-9]/g, '');
      const blog = (o.blog || '').toLowerCase();
      if (blog.includes(domain) || (o.email || '').endsWith('@' + domain) || loginN === rootN || loginN === entN) { org = o; break; }
    }
    if (!org) return [];
    const repos = (await gh(`/orgs/${org.login}/repos?sort=pushed&per_page=6&type=public`)) || [];
    for (const repo of repos) {
      const commits = (await gh(`/repos/${org.login}/${repo.name}/commits?per_page=100`)) || [];
      for (const c of commits) {
        const email = (c.commit?.author?.email || '').toLowerCase();
        if (!email.endsWith('@' + domain)) continue;
        const local = email.split('@')[0];
        if (!GENERIC_LOCAL.test(local) && !/noreply|no-reply|bot|ci@|deploy|jenkins|github|actions/.test(local) && !found.has(local)) found.set(local, { source: 'github:' + org.login, name: c.commit.author.name || '' });
      }
      if (found.size >= 6) break;
    }
  } catch (e) { L('  github :', e.message); }
  return [...found].map(([local, v]) => ({ local, source: v.source, name: v.name }));
}

const SITE_PAGES = ['/', '/contact', '/contact-us', '/nous-contacter', '/mentions-legales', '/legal', '/legal-notice', '/imprint', '/impressum', '/about', '/about-us', '/a-propos', '/qui-sommes-nous', '/equipe', '/team', '/our-team', '/careers', '/carrieres', '/recrutement', '/jobs', '/privacy', '/politique-de-confidentialite', '/presse', '/press',
  // H2a — pages où les sociétés UK publient un contact nominatif : direction, gouvernance, mentions légales, déclarations réglementaires.
  '/contacts', '/get-in-touch', '/people', '/our-people', '/leadership', '/leadership-team', '/management', '/management-team', '/senior-management', '/board', '/our-board',
  '/about/team', '/about/leadership', '/about-us/team', '/about-us/leadership', '/company', '/company/team', '/who-we-are',
  '/news', '/press-releases', '/media', '/media-centre', '/newsroom', '/blog', '/investors', '/investor-relations', '/governance',
  '/privacy-policy', '/privacy-notice', '/terms', '/terms-and-conditions', '/cookie-policy', '/accessibility', '/modern-slavery-statement', '/modern-slavery', '/gender-pay-gap', '/whistleblowing', '/complaints', '/vacancies'];
async function siteWitnesses(domain) {
  const found = new Map(); // local -> page
  // H2b/H4 — découverte de liens internes depuis toutes les pages fixes (accueil, contact, about…), puis visite des pages
  // découvertes (1 niveau) : les vrais chemins contact / équipe / légal / presse varient et échappent à une liste fixe.
  const KEY = /(contact|team|people|leadership|management|board|about|legal|privacy|press|media|news|career|governance|impressum|mentions|equipe|direction|presse|recrut|who-we-are|our-|modern-slavery|gender-pay|complaints|whistleblow)/i;
  const pages = new Set(SITE_PAGES); const fetched = new Set(); const CAP = SITE_PAGES.length + 40;
  const collect = (text) => {
    for (const m of text.matchAll(/href=["']([^"'#?\s]+)/gi)) {
      try {
        const u = new URL(m[1], 'https://' + domain + '/');
        if (u.hostname.replace(/^www\./, '') !== domain) continue;
        const path = (u.pathname.replace(/\/+$/, '') || '/').slice(0, 120);
        if (/\.(pdf|jpe?g|png|gif|svg|css|js|ico|xml|zip|mp4|webp)$/i.test(path)) continue;
        if (KEY.test(path) && pages.size < CAP) pages.add(path);
      } catch { /* lien non exploitable */ }
    }
  };
  const visit = (list, discover) => mapPool(list, 6, async (p) => {
    if (fetched.has(p)) return; fetched.add(p);
    try {
      let res = null; // H5 — repli www. puis http:// quand la racine https refuse ou échoue
      for (const base of ['https://' + domain, 'https://www.' + domain, 'http://' + domain]) {
        try { const r = await get(base + p, { timeout: 6000, max: 400_000 }); if (r.status < 400) { res = r; break; } } catch { /* variante suivante */ }
      }
      if (!res) return;
      const { text } = res;
      for (const m of (text + ' ' + decodeCfEmail(text)).matchAll(EMAIL_RE(domain))) { // H6 — adresses protégées par Cloudflare rendues lisibles
        const local = m[1].toLowerCase();
        if (local.length < 2 || local.length > 40 || GENERIC_LOCAL.test(local) || /^[0-9a-f]{16,}$/.test(local)) continue;
        if (!found.has(local)) found.set(local, p);
      }
      if (discover) collect(text);
    } catch { /* page absente ou lente */ }
  });
  await visit([...pages], true);                                  // pages fixes, en récoltant leurs liens
  await visit([...pages].filter((p) => !fetched.has(p)), false);  // pages découvertes (1 niveau)
  return [...found].map(([local, page]) => ({ local, source: 'site' + page, name: '' }));
}

async function hunterDomain(domain, L = log) {
  if (!HUNTER_KEY) return null;
  try {
    const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=20&api_key=${HUNTER_KEY}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (!r.ok) { L('  hunter :', j.errors?.[0]?.details || r.status); return null; }
    const d = j.data || {};
    return {
      pattern: HUNTER_PATTERNS[d.pattern] || null,
      witnesses: (d.emails || []).filter((e) => e.value && !GENERIC_LOCAL.test(e.value.split('@')[0]))
        .map((e) => ({ local: e.value.split('@')[0].toLowerCase(), source: 'hunter', name: [e.first_name, e.last_name].filter(Boolean).join(' ') })),
    };
  } catch (e) { L('  hunter :', e.message); return null; }
}

// MyEmailVerifier — 100 vérifications gratuites par jour, la réponse porte le catch-all.
// Le format exact de la réponse (clé « Status ») est à confirmer à la première utilisation : voir le journal.
async function verifyEmail(email, key) {
  if (!key) return { status: 'unknown', raw: 'pas de clé MYEMAILVERIFIER_KEY' };
  try {
    const r = await fetch(`https://client.myemailverifier.com/verifier/validate_single/${encodeURIComponent(email)}/${key}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    // Réponse observée : {"Address","catch_all":0|1,"Status":"Valid|Invalid|Catch-all|Unknown|Greylisted",...}
    const s = String(j.Status || j.status || '').toLowerCase();
    const status = Number(j.catch_all) === 1 || /catch/.test(s) ? 'catch_all' : /^valid/.test(s) ? 'valid' : /invalid/.test(s) ? 'invalid' : 'unknown';
    // « Greylisted. Try again in 10 minutes » : le serveur du destinataire temporise, ce n'est pas un verdict.
    const retry = status === 'unknown' && (Number(j.Greylisted) === 1 || /try again|greylist/i.test(j.Diagnosis || ''));
    return { status, retry, raw: j };
  } catch (e) { return { status: 'unknown', raw: e.message }; }
}

// ---------- État persistant ----------
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : { domains: {}, verified: {}, quota: {} };
// Écriture atomique (fichier temporaire + rename) : un arrêt brutal en pleine écriture ne peut pas corrompre l'état.
const saveState = () => { const tmp = STATE_PATH + '.tmp'; writeFileSync(tmp, JSON.stringify(state, null, 1)); renameSync(tmp, STATE_PATH); };
// Réparation ponctuelle : des domaines résolus par sondage ont vu leur statut écrasé « inconnu » par les
// reprises (bug corrigé plus bas) ; on le rétablit à partir des sondages enregistrés.
let repaired = 0;
for (const d of Object.values(state.domains || {})) {
  if (d.pattern && d.source === 'sondage' && /^inconnu/.test(d.patternStatus || '')) {
    const ok = (d.probed || []).filter((x) => x.startsWith(d.pattern) && x.endsWith(':valid')).length;
    if (ok) { d.patternStatus = ok >= 2 ? 'confirmé' : 'probable'; d.nb = ok; repaired++; }
  }
}
if (repaired) { saveState(); log(`état : ${repaired} domaine(s) résolu(s) par sondage rétabli(s) « confirmé/probable »`); }
let verifiedThisRun = 0;
// Quota par clé et par jour : on prend la première clé qui a encore de la marge.
function pickKey() {
  const day = today();
  state.quotaByKey = state.quotaByKey || {};
  for (const k of MEV_KEYS) { const id = k.slice(0, 6); const used = state.quotaByKey[day + ':' + id] || 0; if (used < MEV_DAILY) return { key: k, id }; }
  return null;
}
async function verifyOnce(email) {
  return verifySlot(() => verifyOnceInner(email));
}
const RETRY_AFTER_MS = 11 * 60 * 1000;
const UNKNOWN_TTL_MS = Number(process.env.UNKNOWN_TTL_HOURS || 48) * 3600 * 1000; // « unknown » sans greylist : re-vérifiable après 48 h (SKILL §6), 4 essais max
async function verifyOnceInner(email) {
  if (process.env.DEBUG_VERIFY) log('   [debug] verifyOnce', email, JSON.stringify(state.verified[email] || null), 'run', verifiedThisRun, 'max', MAX_VERIFY_EFFECTIVE(), 'key', !!pickKey());
  const prev = state.verified[email];
  const stale = prev && prev.status === 'unknown' && !prev.retry && (prev.tries || 0) < 4 && Date.now() - Date.parse(prev.at) > UNKNOWN_TTL_MS;
  if (prev && !stale && !(prev.retry && Date.now() - Date.parse(prev.at) > RETRY_AFTER_MS)) return prev;
  if (verifiedThisRun >= MAX_VERIFY_EFFECTIVE()) return null;
  const pk = pickKey();
  if (!pk) { log('  quota du jour épuisé sur toutes les clés'); return null; }
  const res = await verifyEmail(email, pk.key);
  // Un crédit n'est décompté que si l'API a réellement répondu : une erreur réseau n'en consomme pas.
  if (res.raw && typeof res.raw === 'object') {
    const day = today();
    state.quota[day] = (state.quota[day] || 0) + 1;
    state.quotaByKey[day + ':' + pk.id] = (state.quotaByKey[day + ':' + pk.id] || 0) + 1;
    verifiedThisRun++;
  }
  state.verified[email] = { status: res.status, at: new Date().toISOString(), tries: (prev?.tries || 0) + 1, ...(res.retry ? { retry: true } : {}) };
  if (res.retry && state.verified[email].tries >= 3) state.verified[email].retry = false; // on abandonne après 3 greylistages
  if (verifiedThisRun === 1) log('  réponse brute du vérificateur (à contrôler une fois) :', JSON.stringify(res.raw).slice(0, 300));
  saveState();
  await jitter(400, 900);
  return state.verified[email];
}

// ---------- Pipeline ----------
const input = parseCsv(readFileSync(inputPath, 'utf8'));
const people = input.map((row, i) => {
  const prenom = stripCredentials(col(row, 'prenom', 'firstname', 'first'));
  const nom = stripCredentials(col(row, 'nom', 'lastname', 'last', 'name'));
  return {
    i, row, prenom, nom,
    prenoms: nameVariants(prenom), noms: nameVariants(nom),
    entreprise: col(row, 'entreprise', 'company', 'societe', 'organisation'),
    domaine: cleanDomain(col(row, 'domaine', 'domain', 'website', 'site')),
    email: col(row, 'email', 'e-mail', 'mail'),
    out: { domaine: '', email: '', pattern: '', source_pattern: '', nb_temoins: '', catch_all: '', verifie: '', confiance: '', note: '' },
  };
});
// Priorisation (§7) : entreprises avec le plus de profils d'abord.
const groups = new Map();
for (const p of people) {
  const key = p.domaine || norm(p.entreprise);
  if (!key) { p.out.note = 'entreprise absente'; continue; }
  if (truncatedSurname(p.nom)) { p.out.note = 'nom tronqué par Sales Navigator (hors réseau) — ouvrir le profil pour le nom complet'; continue; }
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(p);
}
const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
log(`${people.length} profils, ${ordered.length} entreprises, ${CONCURRENCY} en parallèle${GITHUB_TOKEN ? ', GitHub authentifié' : NO_GITHUB ? '' : ', GitHub anonyme (60 req/h)'}. État : ${STATE_PATH}${DO_VERIFY ? ` · vérification activée (${MEV_KEYS.length} clé(s), max ${MAX_VERIFY_EFFECTIVE()})` : ''}`);

async function processCompany([key, members]) {
  const lines = []; const L = (...a) => lines.push(a.join(' '));
  try {
  const label = members[0].entreprise || key;
  L(`▶ ${label} (${members.length})`);
  // 1. Domaine
  let d = state.domains[key];
  if (!d) {
    let domain = members.find((m) => m.domaine)?.domaine || '';
    if (!domain && !NO_SEARCH) domain = await searchDomain(label, L);
    if (!domain) { d = { domain: '', stop: 'domaine introuvable' }; }
    else {
      const root = domain;
      const final = await finalHost(domain);
      // Redirection vers un sous-domaine (app.x.com) ou vers un domaine sans mail : on garde la racine si elle a des MX.
      if (final !== root && !final.endsWith('.' + root) && (await hasMx(final))) domain = final;
      if (PUBLIC_DOMAINS.test(domain)) d = { domain, stop: 'domaine grand public' };
      else if (!(await hasMx(domain))) d = { domain, stop: 'pas de MX' };
      else d = { domain, witnesses: null, pattern: null, patternStatus: '', source: '', catch_all: '' };
    }
    state.domains[key] = d; saveState();
  }
  if (d.stop) { log(`  ✗ ${d.stop}${d.domain ? ' (' + d.domain + ')' : ''}`); for (const m of members) { m.out.domaine = d.domain; m.out.note = d.stop; } return; }
  L(`  domaine : ${d.domain}`);
  for (const m of members) m.out.domaine = d.domain;
  // 2. Témoins
  if (!d.witnesses || REFRESH_WITNESSES) {
    // Les témoins non re-récoltables (sondage, vérification, profil, hunter) sont conservés ; site/github/web sont re-récoltés.
    const kept = [...(d.witnesses || [])]; // union : un témoin observé une fois reste une preuve, on ne fait qu'ajouter
    const fresh = await siteWitnesses(d.domain);
    if (!fresh.length && !NO_GITHUB) fresh.push(...await githubWitnesses(d.domain, label, L));
    if (!fresh.length && !NO_SEARCH) fresh.push(...await webWitnesses(d.domain, L));
    d.witnesses = kept;
    for (const w of fresh) addWitness(d, w.local, w.source, w.name);
    // E-mails écrits dans les profils LinkedIn (Infos, en-tête…) des personnes de la liste : témoins « profil public ».
    for (const m of members) {
      const txt = [col(m.row, 'apropos', 'about', 'contexte', 'profillinkedin', 'contextelinkedin', 'infos'), m.row.__texte || ''].join(' ');
      for (const w of txt.matchAll(EMAIL_RE(d.domain))) { const local = w[1].toLowerCase(); if (!GENERIC_LOCAL.test(local) && !d.witnesses.some((x) => x.local === local)) d.witnesses.push({ local, source: 'profil', name: `${m.prenom} ${m.nom}` }); }
    }
    if (USE_HUNTER) { const h = await hunterDomain(d.domain, L); if (h) { d.witnesses.push(...h.witnesses.filter((w) => !d.witnesses.some((x) => x.local === w.local))); if (h.pattern) d.hunterPattern = h.pattern; } }
    state.domains[key] = d; saveState();
  }
  L(`  témoins : ${d.witnesses.length ? d.witnesses.map((w) => w.local).join(', ') : 'aucun'}${d.hunterPattern ? ' · hunter → ' + d.hunterPattern : ''}`);
  if (flag('--only-domains')) return;
  // 3. Pattern (§5.2) — un témoin qui correspond à un profil de la liste = adresse observée (A) et pattern prouvé.
  const votes = {};
  const vote = (pattern, w, weight = 1) => { votes[pattern] = votes[pattern] || { n: 0, sources: [] }; votes[pattern].n += weight; votes[pattern].sources.push(w.source); };
  for (const w of d.witnesses) {
    let matched = false;
    for (const m of members) for (const pat of Object.keys(PATTERNS)) {
      if (candidates(m, pat).includes(w.local)) { matched = true; vote(pat, w, 1); m.observed = { email: w.local + '@' + d.domain, source: w.source }; }
    }
    if (matched) continue; // témoin déjà attribué à un profil de la liste : pas d'heuristique de forme
    if (w.name) { // témoin nommé (Hunter) : on compare au nom
      const [pn, ...nn] = w.name.split(' ');
      const fake = { prenoms: nameVariants(pn), noms: nameVariants(nn.join(' ')) };
      for (const pat of Object.keys(PATTERNS)) if (candidates(fake, pat).includes(w.local)) { matched = true; vote(pat, w, 1); }
    }
    if (!matched) { const sp = shapePattern(w.local); if (sp) vote(sp, w, 1); }
  }
  if (d.hunterPattern) vote(d.hunterPattern, { source: 'hunter' }, 2);
  const ranked = Object.entries(votes).sort((a, b) => b[1].n - a[1].n);
  if (!ranked.length) {
    // Aucun témoin votant : un pattern établi par sondage/vérification lors d'un run précédent est conservé
    // tel quel (sinon il était rétrogradé « inconnu » à chaque reprise → confiance C au lieu de B).
    if (!d.pattern) d.patternStatus = 'inconnu';
  }
  else {
    const [best, info] = ranked[0];
    const rivals = ranked.slice(1).filter(([, v]) => v.n >= 2);
    if (rivals.length && info.n < 2 * rivals[0][1].n) d.patternStatus = 'contradictoire';
    else { d.pattern = best; d.patternStatus = info.n >= 2 ? 'confirmé' : 'probable'; d.source = [...new Set(info.sources)].join('+'); d.nb = info.n; }
  }
  // Domaine muet : on sonde les 3 patterns les plus fréquents sur UNE personne via le vérificateur.
  // Une adresse répondue « valid » est un témoin réel ; un catch-all coupe court (rien à apprendre).
  // Sondage resté sans verdict (greylist) : on le rejoue ; verifyOnce ne rappelle l'API que si le délai est passé.
  if (DO_VERIFY && d.probed && d.probed.some((x) => /:unknown$/.test(x))) { d.probed = null; d.catch_all = ''; }
  // Sondage « vide » : le quota s'était épuisé avant le premier appel (ou le profil n'avait pas de nom
  // exploitable). Le domaine n'a donc JAMAIS été sondé — sans ceci il restait bloqué pour toujours,
  // car un tableau vide est « truthy » (310 domaines UK dans ce cas le 12/09/2026).
  if (d.probed && d.probed.length === 0) d.probed = null;
  if (!d.pattern && d.patternStatus === 'inconnu' && DO_VERIFY && MEV_KEY && !d.probed) {
    d.probedAt = new Date().toISOString();
    const m0 = members.find((m) => m.prenoms.length && m.noms.length);
    d.probed = [];
    // `prenom@` seul n'est sondé que pour une petite boîte : sur une grande, « rob@ » existe presque
    // toujours… pour quelqu'un d'autre (faux positif observé sur Schroders, Parliament).
    // Un seul pattern sondé : « prenom.nom » l'emporte dans 49 domaines sur 50 (smoke tests UK) ; les 2e/3e
    // sondages ont coûté 58 crédits pour 4 réussites. Si « prenom.nom » est invalide, on s'arrête : le résidu
    // part vers Hunter / un témoin réel, jamais vers d'autres devinettes.
    const probes = ['prenom.nom'];
    for (const pat of probes) {
      if (!m0) break;
      const email = primary(m0, pat) + '@' + d.domain;
      const v = await verifyOnce(email);
      if (!v) break;
      d.probed.push(pat + ':' + v.status);
      if (v.status === 'catch_all') { d.catch_all = 'oui'; d.patternStatus = 'inconnu (catch-all, sondage impossible)'; break; }
      if (v.status === 'unknown') { d.catch_all = 'inconnu'; d.patternStatus = 'inconnu (vérificateur muet)'; break; }
      d.catch_all = 'non';
      if (v.status === 'valid') {
        // CONTRÔLE CATCH-ALL (1 crédit, seulement quand le sondage réussit) : une adresse de même forme mais
        // qui ne peut appartenir à personne doit être REFUSÉE. Si elle est acceptée, le serveur dit oui à tout
        // et le « valid » du sondage ne prouve rien. Le drapeau du vérificateur ne suffit pas : les passerelles
        // (Mimecast, Proofpoint…) acceptent au périmètre sans que le domaine soit déclaré catch-all.
        const tok = () => 'zq' + Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6).padEnd(6, 'x');
        const ctrl = `${tok()}.${tok()}@${d.domain}`;
        const vc = await verifyOnce(ctrl);
        if (vc) {
          d.probed.push('contrôle:' + vc.status);
          if (vc.status === 'valid' || vc.status === 'catch_all') {
            d.catch_all = 'oui';
            d.patternStatus = 'inconnu (catch-all révélé par l’adresse de contrôle)';
            delete state.verified[ctrl]; // adresse fictive : ne pas la garder dans l'historique
            break;
          }
          delete state.verified[ctrl];
        }
        // Contre-épreuve sur un second profil : un seul « valid » peut être une collision de prénom.
        const m1 = members.find((m) => m !== m0 && m.prenoms.length && m.noms.length);
        let confirmed = true;
        if (m1) { const v1 = await verifyOnce(primary(m1, pat) + '@' + d.domain); if (v1) { d.probed.push(pat + '(2e):' + v1.status); confirmed = v1.status !== 'invalid'; if (v1.status === 'valid') m1.observed = { email: primary(m1, pat) + '@' + d.domain, source: 'sondage' }; } }
        if (!confirmed) { d.patternStatus = 'inconnu (sondage contredit par un 2e profil)'; break; }
        d.pattern = pat; d.patternStatus = m1 && d.probed.at(-1).endsWith(':valid') ? 'confirmé' : 'probable'; d.source = 'sondage'; d.nb = d.patternStatus === 'confirmé' ? 2 : 1; m0.observed = { email, source: 'sondage' };
        // Persistés comme témoins : au prochain run, le vote retrouve le pattern sans dépenser de crédit.
        addWitness(d, primary(m0, pat), 'sondage', `${m0.prenom} ${m0.nom}`);
        if (m1?.observed) addWitness(d, primary(m1, pat), 'sondage', `${m1.prenom} ${m1.nom}`);
        break;
      }
    }
    if (d.probed.length) log(`  sondage : ${d.probed.join(', ')}`);
    else d.probed = null; // aucun appel n'a eu lieu (quota épuisé) : le domaine reste « jamais sondé », pas « sondé à vide »
    state.domains[key] = d; saveState();
  }
  L(`  pattern : ${d.pattern || '—'} (${d.patternStatus}${d.nb ? ', ' + d.nb + ' témoin(s)' : ''})`);
  if (!d.pattern) {
    for (const m of members) { if (m.observed) { Object.assign(m.out, { email: m.observed.email, pattern: 'observé', source_pattern: m.observed.source, confiance: 'A', verifie: 'oui' }); } else m.out.note = 'pattern ' + d.patternStatus + ' — non généré'; }
    return;
  }
  // 4. Génération + 5. Catch-all (1 fois par domaine) + 6. Vérification
  for (const m of members) {
    if (m.observed) { Object.assign(m.out, { email: m.observed.email, pattern: 'observé', source_pattern: m.observed.source, nb_temoins: d.nb, confiance: 'A', verifie: 'oui' }); continue; }
    const email = m.email || (primary(m, d.pattern) ? primary(m, d.pattern) + '@' + d.domain : '');
    Object.assign(m.out, { email, pattern: d.pattern, source_pattern: d.source, nb_temoins: d.nb, verifie: 'non' });
    if (!email) m.out.note = 'nom inexploitable';
  }
  const toVerify = members.filter((m) => m.out.email && !m.observed);
  if (DO_VERIFY && toVerify.length) {
    if (!d.catch_all || d.catch_all === 'inconnu') {
      const probe = await verifyOnce(toVerify[0].out.email);
      if (probe) { d.catch_all = probe.status === 'catch_all' ? 'oui' : probe.status === 'unknown' ? 'inconnu' : 'non'; state.domains[key] = d; saveState(); }
    }
    if (d.catch_all === 'non') {
      for (const m of toVerify) {
        const v = await verifyOnce(m.out.email);
        if (!v) break;
        // Une adresse répondue « valid » est un témoin réel : persistée pour les runs suivants.
        if (v.status === 'valid') addWitness(d, m.out.email.split('@')[0], 'verif', `${m.prenom} ${m.nom}`);
      }
      state.domains[key] = d; saveState();
    }
  }
  for (const m of toVerify) {
    m.out.catch_all = d.catch_all || 'inconnu';
    const v = state.verified[m.out.email];
    m.out.verifie = v ? ({ valid: 'oui', invalid: 'non', catch_all: 'impossible', unknown: 'inconnu' })[v.status] : (d.catch_all === 'oui' ? 'impossible' : 'non');
    // Grille §6.3
    const confirmed = d.patternStatus === 'confirmé';
    if (v?.status === 'valid') m.out.confiance = 'A';
    else if (v?.status === 'invalid') m.out.confiance = 'D';
    else if (confirmed) m.out.confiance = 'B';
    else m.out.confiance = 'C';
    if (v?.status === 'unknown') m.out.note = 'vérification inconnue — retenter dans 48 h';
  }
  const conf = members.map((m) => m.out.confiance).filter(Boolean);
  L(`  → ${conf.length} adresses : ${['A', 'B', 'C', 'D'].map((c) => c + '=' + conf.filter((x) => x === c).length).join(' ')}${d.catch_all ? ' · catch-all ' + d.catch_all : ''}`);
  } finally { console.error(lines.join('\n')); }
}
await mapPool(ordered, CONCURRENCY, (c) => withDeadline(processCompany(c), 180_000, 'entreprise ' + c[0]).catch((e) => log('  ⏱ ' + e.message)));

// ---------- Sortie ----------
const inCols = Object.keys(input[0] || {});
const outCols = [...inCols, ...['domaine', 'email', 'pattern', 'source_pattern', 'nb_temoins', 'catch_all', 'verifie', 'confiance', 'note'].filter((c) => !inCols.includes(c))];
writeCsv(outputPath, people.map((p) => ({ ...p.row, ...p.out })), outCols);
const tally = (k) => people.reduce((acc, p) => { const v = p.out[k] || '—'; acc[v] = (acc[v] || 0) + 1; return acc; }, {});
log(`\n✔ ${outputPath} écrit. Confiance : ${JSON.stringify(tally('confiance'))} · vérifications aujourd'hui : ${state.quota[today()] || 0}`);

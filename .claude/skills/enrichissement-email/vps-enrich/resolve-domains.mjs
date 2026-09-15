#!/usr/bin/env node
// Résolveur de domaine d'entreprise : nom d'entreprise → site web → domaine e-mail. (Pas un résolveur DNS.)
//
//   node resolve-domains.mjs [--limit N] [--uk] [--engine brave|serper|bing|ddg|searxng] [--searxng URL] [--concurrency 3]
//                            [--out fichier.csv] [--write] [--test-known] [--db chemin.sqlite]
//
// Pour chaque entreprise sans domaine dans le CRM (nom + URL Sales Navigator) :
//   1. recherche du nom sur un moteur (une requête à la fois, espacée) → URLs candidates ;
//   2. exclusion des annuaires (LinkedIn, Companies House, Pappers, Wikipedia…) et des domaines grand public ;
//   3. ouverture de la page d'accueil et CONTRÔLE DU NOM (titre, og:site_name, h1, corps) — garde-fou anti-homonyme ;
//   4. contrôle MX (le domaine reçoit du courrier) ;
//   5. résultat par niveau : fort (nom dans le titre) / moyen (nom dans le domaine + page) / faible / aucun.
// --write : n'écrit dans `entreprises` que les niveaux fort et moyen, avec domaine_source = 'recherche'
//           (jamais par-dessus un domaine existant). Les adresses générées sur ces domaines sont plafonnées à C
//           par upsert-crm.mjs tant qu'elles ne sont pas vérifiées.
// --test-known : test à l'aveugle sur les entreprises dont le domaine est connu (page compte Sales Navigator) →
//           précision mesurée, pas supposée.

import { DatabaseSync } from 'node:sqlite';
import { resolveMx } from 'node:dns/promises';
import { writeFileSync, appendFileSync } from 'node:fs';
import { countryOf } from '/home/ubuntu/outreach/db.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const DB_PATH = opt('--db', '/home/ubuntu/outreach/data/outreach.sqlite');
const LIMIT = Number(opt('--limit', 0)) || 0;
const ONLY_UK = flag('--uk');
const ENGINE = opt('--engine', 'bing');
const SEARXNG = opt('--searxng', process.env.SEARXNG_URL || 'http://127.0.0.1:8080');
// Clés d'API (Brave Search, Serper) : variables d'environnement ou ~/enrich/.env (jamais commité).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
for (const envPath of [join(dirname(fileURLToPath(import.meta.url)), '.env')]) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
}
const BRAVE_KEY = process.env.BRAVE_API_KEY || '';
const SERPER_KEY = process.env.SERPER_API_KEY || '';
const WRITE = flag('--write');
const TEST_KNOWN = flag('--test-known');
const CONC = Math.max(1, Number(opt('--concurrency', 3)) || 3);
const OUT = opt('--out', TEST_KNOWN ? './resolved-test.csv' : './resolved-domains.csv');
const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));
const withDeadline = (p, ms, what) => { let t; const g = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('délai dépassé : ' + what)), ms); }); return Promise.race([p, g]).finally(() => clearTimeout(t)); };

// ---------- normalisation ----------
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();
// Mots qui ne distinguent pas une entreprise d'une autre : formes juridiques, génériques.
const STOP = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'corp', 'corporation', 'co', 'company', 'group', 'groupe', 'holdings', 'holding', 'uk', 'gb', 'britain', 'british', 'europe', 'european', 'international', 'global', 'services', 'service', 'solutions', 'partners', 'partnership', 'the', 'and', 'of', 'sas', 'sa', 'sarl', 'gmbh', 'ag', 'bv', 'nv', 'france', 'ltee', 'pty', 'ab', 'oy', 'as', 'spa', 'srl', 'sl', 'associates', 'consulting', 'consultants', 'technologies', 'technology', 'systems', 'ventures', 'capital', 'management']);
const sig = (name) => { const n = norm((name || '').replace(/&/g, '')); const t = n.split(' ').filter((x) => x.length >= 2 && !STOP.has(x)); return t.length ? t : n.split(' ').filter((x) => x.length >= 2); };
const DIRECTORIES = /linkedin\.|pappers|societe\.com|pagesjaunes|facebook|wikipedia|infogreffe|verif\.com|kompass|indeed|glassdoor|welcometothejungle|crunchbase|bloomberg|zoominfo|rocketreach|\bx\.com|twitter|youtube|instagram|annuaire|manageo|europages|dnb\.com|apollo\.io|lusha|kaspr|trustpilot|tiktok|pinterest|amazon\.|leboncoin|societeinfo|score3|b-reputation|dirigeant|opencorporates|companieshouse|find-and-update\.company-information|endole|companycheck|northdata|ellisphere|creditsafe|owler|signalhire|xing\.com|jobteaser|hellowork|apec\.fr|duckduckgo|google\.|bing\.com|yell\.com|192\.com|thegazette|fca\.org\.uk|register\.fca|reuters|ft\.com|theguardian|bbc\.co|telegraph\.co|cbinsights|pitchbook|craft\.co|zippia|comparably|tracxn|growjo|theorg\.com|wikidata|yahoo|marketscreener|morningstar|londonstockexchange|investing\.com/i;
const PUBLIC_DOMAINS = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|orange|wanadoo|free|sfr|laposte|bbox|protonmail|proton|gmx|web|mail|yandex|zoho)\.(com|fr|net|org|me|de|co\.uk|ch|be)$/i;
const CC2 = new Set(['co', 'org', 'ac', 'gov', 'ltd', 'plc', 'net', 'com', 'me', 'edu']);
// Faux « sites » relevés sur Sales Navigator : raccourcisseurs et pages de liens. Traités comme absents.
const SHORTENER = /^(bit\.ly|bitly\.com|linktr\.ee|tinyurl\.com|t\.co|lnkd\.in|goo\.gl|ow\.ly|rebrand\.ly|hubs\.ly|linkin\.bio|beacons\.ai)$/i;
// Domaine enregistrable : x.co.uk, y.com, z.org.uk…
function regDomain(host) {
  const p = (host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const tld = p[p.length - 1], sld = p[p.length - 2];
  return tld.length === 2 && CC2.has(sld) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

// ---------- réseau ----------
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-GB,en;q=0.9,fr;q=0.8', 'upgrade-insecure-requests': '1' };
async function get(url, timeout = 9000, max = 400_000) {
  const r = await withDeadline(fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(timeout) }), timeout + 3000, url);
  const text = (await withDeadline(r.text(), timeout + 3000, url + ' (corps)')).slice(0, max);
  return { status: r.status, url: r.url, text };
}
function semaphore(n) { let a = 0; const q = []; const next = () => { if (a < n && q.length) { a++; q.shift()(); } }; return async (fn) => { await new Promise((r) => { q.push(r); next(); }); try { return await fn(); } finally { a--; next(); } }; }
const searchSlot = semaphore(1); // un moteur = une requête à la fois, espacée
async function mapPool(items, n, fn) { const run = semaphore(n); return Promise.all(items.map((it) => run(() => fn(it)))); }

async function bing(q, mkt = 'en-GB') {
  const { text } = await get(`https://www.bing.com/search?q=${encodeURIComponent(q)}&mkt=${mkt}&setlang=en`, 12000);
  const out = [];
  for (const block of text.split(/<li class="b_algo/).slice(1)) {
    const u = block.match(/u=a1([A-Za-z0-9_-]+)/); // précédé de « &amp; » dans le HTML : pas de préfixe exigé
    if (u) { try { const d = Buffer.from(u[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); if (/^https?:\/\//.test(d)) { out.push(d); continue; } } catch { /* base64 invalide */ } }
    const cite = block.match(/<cite[^>]*>\s*(https?:\/\/[^<\s›]+)/i); // repli : URL affichée
    if (cite) out.push(cite[1]);
  }
  // Vrai blocage : page de vérification (pas de zone de résultats du tout). Un simple mot « challenge » ne compte pas.
  if (!out.length && !/id="b_results"/.test(text) && /b_captcha|verify you are human|unusual traffic/i.test(text)) throw new Error('Bing bloque (captcha)');
  return out;
}
async function ddg(q) {
  const { text } = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, 12000);
  if (/anomaly|captcha|challenge/i.test(text) && !/result__a/.test(text)) throw new Error('DuckDuckGo bloque (captcha)');
  return [...text.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/g)].map((m) => m[1]).map((h) => (h.includes('uddg=') ? decodeURIComponent(h.split('uddg=')[1].split('&')[0]) : h));
}
// Brave Search API — https://api.search.brave.com (2 000 requêtes/mois gratuites, 1/s). Officielle : pas de leurre, pas de blocage.
async function brave(q, country = 'GB') {
  if (!BRAVE_KEY) throw new Error('BRAVE_API_KEY absente (.env)');
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&country=${country}&search_lang=en`, { headers: { 'accept': 'application/json', 'x-subscription-token': BRAVE_KEY }, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) throw new Error('Brave : quota atteint (429)');
  if (!r.ok) throw new Error('Brave HTTP ' + r.status);
  return ((await r.json()).web?.results || []).map((x) => ({ url: x.url, title: x.title || '', description: x.description || '' }));
}
// Serper — résultats Google (2 500 crédits offerts, puis payant). POST JSON.
async function serper(q, country = 'gb') {
  if (!SERPER_KEY) throw new Error('SERPER_API_KEY absente (.env)');
  const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': SERPER_KEY }, body: JSON.stringify({ q, gl: country.toLowerCase(), hl: 'en', num: 10 }), signal: AbortSignal.timeout(15000) });
  if (r.status === 429 || r.status === 402) throw new Error('Serper : quota atteint (' + r.status + ')');
  if (!r.ok) throw new Error('Serper HTTP ' + r.status);
  return ((await r.json()).organic || []).map((x) => ({ url: x.link, title: x.title || '', description: x.snippet || '' }));
}
async function searxng(q) {
  const r = await fetch(`${SEARXNG}/search?q=${encodeURIComponent(q)}&format=json&language=en`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('SearXNG HTTP ' + r.status);
  return ((await r.json()).results || []).map((x) => x.url);
}
const MKT = { 'Royaume-Uni': 'en-GB', 'France': 'fr-FR', 'Irlande': 'en-IE', 'Allemagne': 'de-DE', 'Suisse': 'fr-CH', 'Belgique': 'fr-BE', 'Pays-Bas': 'nl-NL', 'Espagne': 'es-ES', 'Italie': 'it-IT', 'États-Unis': 'en-US' };
const CC = (country) => (MKT[country] || 'en-GB').split('-')[1];
const search = (q, country) => searchSlot(async () => {
  await jitter(ENGINE === 'brave' || ENGINE === 'serper' ? 1100 : 1500, ENGINE === 'brave' || ENGINE === 'serper' ? 1400 : 2600); // Brave : 1 requête/s max
  const r = await (ENGINE === 'brave' ? brave(q, CC(country)) : ENGINE === 'serper' ? serper(q, CC(country)) : ENGINE === 'searxng' ? searxng(q) : ENGINE === 'ddg' ? ddg(q) : bing(q, MKT[country] || 'en-GB'));
  return r.map((x) => (typeof x === 'string' ? { url: x, title: '', description: '' } : x));
});

async function hasMx(domain) { try { return (await resolveMx(domain)).length > 0; } catch { return false; } }

// ---------- contrôle du nom sur la page d'accueil ----------
const attr = (html, re) => { const m = html.match(re); return m ? m[1] : ''; };
function pageSignals(html) {
  const title = attr(html, /<title[^>]*>([^<]{0,300})/i);
  const site = attr(html, /property=["']og:site_name["'][^>]*content=["']([^"']{0,200})/i) || attr(html, /content=["']([^"']{0,200})["'][^>]*property=["']og:site_name["']/i);
  const h1 = attr(html, /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i).replace(/<[^>]+>/g, ' ');
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return { head: norm(title + ' ' + site + ' ' + h1), body: norm(body).slice(0, 30000), title: (title || site).trim().slice(0, 120) };
}
// 3 = fort (nom dans titre / og:site_name / h1) · 2 = moyen (nom dans le domaine + présent sur la page) · 1 = faible · 0 = aucun
function nameLevel(name, host, sg) {
  const toks = sig(name); if (!toks.length) return 0;
  const H = host.replace(/^www\./, '').replace(/[^a-z0-9]/g, '');
  const inHead = toks.filter((t) => sg.head.includes(t)).length / toks.length;
  const inBody = toks.filter((t) => sg.body.includes(t)).length / toks.length;
  const inHost = H.includes(toks.join('')) || toks.some((t) => t.length >= 4 && H.includes(t));
  if (inHead >= 0.6) return 3;
  if (inHost && (inHead > 0 || inBody >= 0.6)) return 2;
  if (inBody >= 0.8) return 1;
  return 0;
}

async function homepage(host) {
  for (const base of ['https://' + host, 'https://www.' + host, 'http://' + host]) {
    try { const r = await get(base, 8000); if (r.status < 400 && r.text.length > 200) return r; } catch { /* variante suivante */ }
  }
  return null;
}

// ---------- résolution d'une entreprise ----------
async function resolve(name, L, country) {
  const queries = [name, `${name} official website`];
  let results = [];
  for (const q of queries) {
    try { results = await search(q, country); } catch (e) { L('  recherche :', e.message); if (/bloque|quota|absente|HTTP 4\d\d/.test(e.message)) throw e; }
    if (results.length) break;
  }
  const seen = new Set(); const candidates = [];
  for (const r of results) {
    try { const h = new URL(r.url).hostname.replace(/^www\./, ''); const rd = regDomain(h); if (!rd || seen.has(rd) || DIRECTORIES.test(h) || PUBLIC_DOMAINS.test(rd)) continue; seen.add(rd); candidates.push({ rd, title: r.title || '', desc: r.description || '' }); } catch { /* URL non exploitable */ }
    if (candidates.length >= 5) break;
  }
  const full = norm(name.replace(/&/g, '')).replace(/ /g, ''); const toks = sig(name);
  const shortName = toks.join('').length <= 6; // Tide, Bud, SMS, LV=, Planet… : homonymes structurels → jamais écrit automatiquement, proposé « à vérifier »
  const uk = country === 'Royaume-Uni';
  const UKRE = /\b(united kingdom|england|scotland|wales|london|registered in england|companies house|\+44)\b|£/i;
  const RANK = [8, 5, 3, 2, 1];
  let best = null; let firstInaccessible = false;
  for (const [i, c] of candidates.entries()) {
    const page = await homepage(c.rd);
    let domain = c.rd, sg, viaSnippet = false, url = 'https://' + c.rd + '/';
    if (page) { domain = regDomain(new URL(page.url).hostname.replace(/^www\./, '')) || c.rd; sg = pageSignals(page.text); url = page.url; }
    else { if (i === 0) firstInaccessible = true; sg = { head: norm(c.title), body: norm(c.title + ' ' + c.desc), title: c.title.slice(0, 120) }; viaSnippet = true; } // site qui bloque les robots : on juge sur l'extrait du moteur
    const H = domain.replace(/[^a-z0-9]/g, '');
    let level = nameLevel(name, domain, sg);
    if (viaSnippet) level = Math.min(level, 2);
    const countrySignal = !uk || /\.uk$/.test(domain) || UKRE.test(sg.body);
    if (uk && !countrySignal) level = Math.min(level, 1); // aucun signal UK sur la page → jamais écrit automatiquement (« Pantheon » → le monument romain)
    if (shortName) level = Math.min(level, 1);
    if (firstInaccessible && i > 0 && !(level >= 3 && H.includes(full))) level = Math.min(level, 1); // le 1er résultat était injoignable : un suivant ne gagne que sans ambiguïté
    const score = level * 10 + (full.length >= 5 && H.includes(full) ? 6 : 0) + (toks.some((t) => t.length >= 4 && H.includes(t)) ? 3 : 0) + (RANK[i] || 0) + (countrySignal ? 2 : 0);
    L(`  ${domain} : niveau ${level}, score ${score}${viaSnippet ? ' (extrait moteur, page injoignable)' : ''}${uk && !countrySignal ? ', sans signal UK' : ''}${shortName ? ', nom court → à vérifier' : ''} — « ${sg.title} »`);
    if (level >= 1 && (!best || score > best.score)) best = { domaine: domain, niveau: level, score, preuve: sg.title, url };
  }
  if (best && best.niveau < 2) best.niveau = 1;
  if (best) { best.mx = (await hasMx(best.domaine)) ? 'oui' : ((await hasMx(regDomain(best.domaine))) ? 'oui' : 'non'); }
  return best;
}

// ---------- pipeline ----------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
{ const cols = new Set(db.prepare('PRAGMA table_info(entreprises)').all().map((c) => c.name)); if (!cols.has('domaine_source')) { db.exec("ALTER TABLE entreprises ADD COLUMN domaine_source TEXT"); db.exec("UPDATE entreprises SET domaine_source = 'sales-nav' WHERE domaine <> '' AND domaine_source IS NULL"); } }

let companies;
if (TEST_KNOWN) {
  companies = db.prepare(`SELECT e.entreprise_url u, COALESCE(NULLIF(e.nom, ''), (SELECT entreprise FROM prospects p WHERE p.entreprise_url = e.entreprise_url AND entreprise <> '' LIMIT 1)) nom, e.domaine connu,
    (SELECT COUNT(*) FROM prospects p WHERE p.entreprise_url = e.entreprise_url) n, (SELECT MIN(localisation) FROM prospects p WHERE p.entreprise_url = e.entreprise_url) loc FROM entreprises e WHERE e.domaine <> '' AND COALESCE(e.domaine_source, 'sales-nav') = 'sales-nav' ORDER BY n DESC`).all();
} else {
  companies = db.prepare(`SELECT p.entreprise_url u, MIN(p.entreprise) nom, COUNT(*) n, MIN(p.localisation) loc FROM prospects p
    WHERE p.entreprise_url <> '' AND p.entreprise <> '' AND p.entreprise_url NOT IN (SELECT entreprise_url FROM entreprises WHERE domaine <> '' AND domaine NOT IN ('bit.ly','bitly.com','linktr.ee','tinyurl.com','t.co','lnkd.in','goo.gl','ow.ly','rebrand.ly','hubs.ly','linkin.bio','beacons.ai'))
    GROUP BY p.entreprise_url ORDER BY n DESC, nom`).all();
  if (ONLY_UK) companies = companies.filter((c) => countryOf(c.loc) === 'Royaume-Uni');
}
// Noms qui ne désignent pas une entreprise (profil qui masque son employeur) : rien à résoudre.
const GHOST = /^(confidential|stealth( mode| startup)?|self[- ]?employed|freelance|independent|various|undisclosed|n\/a|private|none|-|unknown|retired|consultant|student)$/i;
companies = companies.filter((c) => !GHOST.test((c.nom || '').trim()));
if (LIMIT) companies = companies.slice(0, LIMIT);
log(`${companies.length} entreprises à résoudre (${ENGINE}${TEST_KNOWN ? ', test à l’aveugle sur domaines connus' : ''}${ONLY_UK ? ', UK' : ''}), ${CONC} en parallèle, recherche sérialisée. Sortie : ${OUT}`);

const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
writeFileSync(OUT, '﻿' + ['entreprise_url', 'nom', 'nb_prospects', 'domaine', 'niveau', 'mx', 'preuve_titre', 'url', ...(TEST_KNOWN ? ['domaine_connu', 'correct'] : [])].map(cell).join(';') + '\n');
const stats = { total: companies.length, fort: 0, moyen: 0, faible: 0, aucun: 0, correct: 0, faux: 0, faux_liste: [] };
let done = 0; let blocked = false;
const upd = db.prepare(`INSERT INTO entreprises(entreprise_url, nom, site, domaine, maj, domaine_source) VALUES (@u, @nom, @site, @domaine, @maj, 'recherche')
  ON CONFLICT(entreprise_url) DO UPDATE SET domaine = CASE WHEN entreprises.domaine = '' OR entreprises.domaine IS NULL OR entreprises.domaine IN ('bit.ly','bitly.com','linktr.ee','tinyurl.com','t.co','lnkd.in','goo.gl','ow.ly','rebrand.ly','hubs.ly','linkin.bio','beacons.ai') THEN excluded.domaine ELSE entreprises.domaine END,
  site = CASE WHEN entreprises.domaine = '' OR entreprises.domaine IS NULL OR entreprises.domaine IN ('bit.ly','bitly.com','linktr.ee','tinyurl.com','t.co','lnkd.in','goo.gl','ow.ly','rebrand.ly','hubs.ly','linkin.bio','beacons.ai') THEN excluded.site ELSE entreprises.site END,
  domaine_source = CASE WHEN entreprises.domaine = '' OR entreprises.domaine IS NULL OR entreprises.domaine IN ('bit.ly','bitly.com','linktr.ee','tinyurl.com','t.co','lnkd.in','goo.gl','ow.ly','rebrand.ly','hubs.ly','linkin.bio','beacons.ai') THEN 'recherche' ELSE entreprises.domaine_source END, maj = excluded.maj`);

await mapPool(companies, CONC, async (c) => {
  if (blocked) return;
  const lines = []; const L = (...a) => lines.push(a.join(' '));
  let r = null;
  try { r = await withDeadline(resolve(c.nom, L, countryOf(c.loc)), 90_000, c.nom); }
  catch (e) { L('  ✗', e.message); if (/bloque|quota|absente|HTTP 4\d\d/.test(e.message)) { blocked = true; log('ARRÊT :', e.message); } }
  const niveau = r ? ({ 3: 'fort', 2: 'moyen', 1: 'faible' })[r.niveau] : 'aucun';
  stats[niveau]++;
  let extra = [];
  if (TEST_KNOWN) { const refBad = SHORTENER.test(c.connu) || /careers|jobs/.test(c.connu); const ok = r && r.niveau >= 2 && regDomain(r.domaine) === regDomain(c.connu); if (refBad) { stats.ref_invalide = (stats.ref_invalide || 0) + 1; stats.ref_liste = (stats.ref_liste || []); stats.ref_liste.push(`${c.nom}: réf. ${c.connu} → trouvé ${r?.domaine || '—'}`); } else if (r && r.niveau >= 2) { if (ok) stats.correct++; else { const lab = (d) => regDomain(d).split('.')[0].replace(/[^a-z0-9]/g, ''); const shared = sig(c.nom).some((t) => t.length >= 4 && lab(r.domaine).includes(t) && lab(c.connu).includes(t)) || lab(r.domaine).includes(lab(c.connu)) || lab(c.connu).includes(lab(r.domaine)); if (shared) { stats.variante = (stats.variante || 0) + 1; (stats.variante_liste = stats.variante_liste || []).push(`${c.nom}: ${r.domaine} ~ ${c.connu}`); } else { stats.faux++; stats.faux_liste.push(`${c.nom}: ${r.domaine} ≠ ${c.connu}`); } } } extra = [c.connu, refBad ? 'réf. invalide' : ok ? 'oui' : (r && r.niveau >= 2 ? 'NON' : '')]; }
  appendFileSync(OUT, [c.u, c.nom, c.n, r?.domaine || '', niveau, r?.mx || '', r?.preuve || '', r?.url || '', ...extra].map(cell).join(';') + '\n');
  if (WRITE && !TEST_KNOWN && r && r.niveau >= 2 && r.mx === 'oui') upd.run({ u: c.u, nom: c.nom, site: r.url, domaine: r.domaine, maj: new Date().toISOString() });
  done++;
  log(`[${done}/${companies.length}] ${c.nom} → ${r?.domaine || '—'} (${niveau}${r?.mx ? ', MX ' + r.mx : ''})${TEST_KNOWN ? ' · connu ' + c.connu : ''}`);
  for (const l of lines) log(l);
});

log('\n===== BILAN =====');
log(`résolues fort ${stats.fort} · moyen ${stats.moyen} · faible ${stats.faible} · aucun ${stats.aucun} · sur ${stats.total}${blocked ? ' · ARRÊT : moteur bloqué' : ''}`);
if (TEST_KNOWN) {
  const acc = stats.correct + stats.faux + (stats.variante || 0);
  const valid = stats.total - (stats.ref_invalide || 0);
  log(`précision (fort+moyen, références valides) : ${stats.correct}/${acc} = ${acc ? Math.round(100 * stats.correct / acc) : 0} % · couverture : ${acc}/${valid} = ${valid ? Math.round(100 * acc / valid) : 0} % · références invalides (raccourci/carrières) : ${stats.ref_invalide || 0}`);
  log(`  dont variantes (même groupe, autre domaine) : ${stats.variante || 0} · vrais homonymes : ${stats.faux} · précision hors variantes : ${acc ? Math.round(100 * (stats.correct + (stats.variante || 0)) / acc) : 0} % · noms courts différés « à vérifier » : ${stats.faible}`);
  for (const f of stats.variante_liste || []) log('  variante :', f);
  for (const f of stats.ref_liste || []) log('  réf. invalide :', f);
  for (const f of stats.faux_liste) log('  faux :', f);
}
if (WRITE && !TEST_KNOWN) log(`écrits dans entreprises (fort+moyen avec MX) : ${stats.fort + stats.moyen}`);

#!/usr/bin/env node
// Enrichissement e-mail « low-hanging fruits » — entreprise par entreprise, sans coût récurrent.
//
//   node enrich.mjs entree.csv sortie.csv [options]
//
//   --state fichier.json     état persistant (domaines résolus, patterns, vérifications) — défaut : ./enrich-state.json
//   --verify                 vérifie via MyEmailVerifier (MYEMAILVERIFIER_KEY) dans la limite du quota
//   --max-verify N           vérifications maximum pour cette exécution (défaut 100 = quota gratuit/jour)
//   --no-search              ne cherche pas le domaine sur le web (utilise seulement la colonne domaine)
//   --only-domains           s'arrête après la résolution des domaines et la récolte des témoins
//   --hunter                 utilise Hunter (HUNTER_API_KEY) pour la recherche par domaine (pattern + témoins)
//
// Entrée : CSV (; ou ,) avec prenom, nom, entreprise, et optionnellement domaine, id, linkedin_url, poste, pays.
// Sortie : le CSV d'entrée + domaine, email, pattern, source_pattern, nb_temoins, catch_all, verifie, confiance, note.
// Node ≥ 20, aucune dépendance.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const [inputPath, outputPath] = args.filter((a, i) => !a.startsWith('--') && !['--state', '--max-verify'].includes(args[i - 1]));
if (!inputPath || !outputPath) { console.error('usage : node enrich.mjs entree.csv sortie.csv [--state s.json] [--verify] [--max-verify N] [--no-search] [--hunter]'); process.exit(1); }
const STATE_PATH = opt('--state', './enrich-state.json');
const MAX_VERIFY = Number(opt('--max-verify', 100));
const DO_VERIFY = flag('--verify');
const USE_HUNTER = flag('--hunter');
const NO_SEARCH = flag('--no-search');
const MEV_KEY = process.env.MYEMAILVERIFIER_KEY || '';
const HUNTER_KEY = process.env.HUNTER_API_KEY || '';

const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));
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
// Forme du local-part → pattern probable quand on ne connaît pas le nom du témoin.
function shapePattern(local) {
  if (/^[a-z]\.[a-z]{2,}$/.test(local)) return 'p.nom';
  if (/^[a-z]{2,}\.[a-z]{2,}$/.test(local)) return 'prenom.nom';
  if (/^[a-z]{2,}_[a-z]{2,}$/.test(local)) return 'prenom_nom';
  if (/^[a-z]{2,}-[a-z]{2,}$/.test(local)) return 'prenom-nom';
  return null; // soudé ou prénom seul : ambigu sans le nom
}

// ---------- Réseau ----------
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
async function get(url, { timeout = 10000, max = 600_000 } = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'fr,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  const text = (await r.text()).slice(0, max);
  return { status: r.status, url: r.url, text };
}
const DIRECTORIES = /linkedin\.|pappers|societe\.com|pagesjaunes|facebook|wikipedia|infogreffe|verif\.com|kompass|indeed|glassdoor|welcometothejungle|crunchbase|bloomberg|zoominfo|rocketreach|\bx\.com|twitter|youtube|instagram|annuaire|manageo|europages|dnb\.com|apollo\.io|lusha|kaspr|trustpilot|tiktok|pinterest|amazon\.|leboncoin|societeinfo|score3|b-reputation|dirigeant|opencorporates|companieshouse|northdata|ellisphere|creditsafe|owler|signalhire|xing\.com|glassdoor|jobteaser|hellowork|apec\.fr|duckduckgo|google\.|bing\.com/i;
const PUBLIC_DOMAINS = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|orange|wanadoo|free|sfr|laposte|bbox|numericable|neuf|protonmail|proton|gmx|web|mail|yandex|zoho)\.(com|fr|net|org|me|de|co\.uk|ch|be)$/i;
const GENERIC_LOCAL = /^(contact|info|infos|hello|bonjour|rh|hr|jobs?|job|recrutement|recruiting|careers?|talent|press|presse|media|sales|commercial|support|help|admin|webmaster|noreply|no-reply|nepasrepondre|dpo|privacy|rgpd|gdpr|legal|juridique|compliance|marketing|communication|com|team|office|security|abuse|postmaster|hostmaster|newsletter|partenariat|partners?|invest(or|isseurs)?|ir|billing|facturation|compta|accounting|finance|service|services|clients?|customer|welcome|accueil|direction|secretariat|reception|order|orders|shop|store|emploi|candidature|stage|alternance|formation|events?|evenements?|ventes?|export|achat|achats|qualite|it|informatique|dsi|sav|urgence|urgences|bureau|paris|lyon|france|uk|us|eu|europe|global|corporate|group|groupe|holding|dev|tech|api|test|demo|example|exemple|mail|email|e-mail|firstname|lastname|prenom|nom|name|user|username|votre|your|you|me|moi)(-[a-z]+)?$/i;
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

async function searchDomain(entreprise) {
  const q = encodeURIComponent(`${entreprise} site officiel`);
  try {
    const { text } = await get(`https://html.duckduckgo.com/html/?q=${q}`, { timeout: 12000 });
    const hrefs = [...text.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
    for (const h of hrefs) {
      const u = h.includes('uddg=') ? decodeURIComponent(h.split('uddg=')[1].split('&')[0]) : h;
      try {
        const host = new URL(u).hostname.replace(/^www\./, '');
        if (DIRECTORIES.test(host) || PUBLIC_DOMAINS.test(host)) continue;
        return host;
      } catch { /* lien non exploitable */ }
    }
  } catch (e) { log('  recherche web impossible :', e.message); }
  return '';
}

const SITE_PAGES = ['/', '/contact', '/contact-us', '/nous-contacter', '/mentions-legales', '/legal', '/legal-notice', '/imprint', '/impressum', '/about', '/about-us', '/a-propos', '/qui-sommes-nous', '/equipe', '/team', '/our-team', '/careers', '/carrieres', '/recrutement', '/jobs', '/privacy', '/politique-de-confidentialite', '/presse', '/press'];
async function siteWitnesses(domain) {
  const found = new Map(); // local -> page
  for (const p of SITE_PAGES) {
    try {
      const { status, text } = await get('https://' + domain + p, { timeout: 8000, max: 400_000 });
      if (status >= 400) continue;
      for (const m of text.matchAll(EMAIL_RE(domain))) {
        const local = m[1].toLowerCase();
        if (local.length < 2 || local.length > 40 || GENERIC_LOCAL.test(local) || /^[0-9a-f]{16,}$/.test(local)) continue;
        if (!found.has(local)) found.set(local, p);
      }
    } catch { /* page absente ou lente */ }
    await jitter(150, 400);
  }
  return [...found].map(([local, page]) => ({ local, source: 'site' + page, name: '' }));
}

async function hunterDomain(domain) {
  if (!HUNTER_KEY) return null;
  try {
    const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=20&api_key=${HUNTER_KEY}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (!r.ok) { log('  hunter :', j.errors?.[0]?.details || r.status); return null; }
    const d = j.data || {};
    return {
      pattern: HUNTER_PATTERNS[d.pattern] || null,
      witnesses: (d.emails || []).filter((e) => e.value && !GENERIC_LOCAL.test(e.value.split('@')[0]))
        .map((e) => ({ local: e.value.split('@')[0].toLowerCase(), source: 'hunter', name: [e.first_name, e.last_name].filter(Boolean).join(' ') })),
    };
  } catch (e) { log('  hunter :', e.message); return null; }
}

// MyEmailVerifier — 100 vérifications gratuites par jour, la réponse porte le catch-all.
// Le format exact de la réponse (clé « Status ») est à confirmer à la première utilisation : voir le journal.
async function verifyEmail(email) {
  if (!MEV_KEY) return { status: 'unknown', raw: 'pas de clé MYEMAILVERIFIER_KEY' };
  try {
    const r = await fetch(`https://client.myemailverifier.com/verifier/validate_single/${encodeURIComponent(email)}/${MEV_KEY}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    const s = String(j.Status || j.status || j.result || '').toLowerCase();
    const status = /catch/.test(s) ? 'catch_all' : /^valid|deliverable|ok/.test(s) ? 'valid' : /invalid|undeliverable/.test(s) ? 'invalid' : 'unknown';
    return { status, raw: j };
  } catch (e) { return { status: 'unknown', raw: e.message }; }
}

// ---------- État persistant ----------
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : { domains: {}, verified: {}, quota: {} };
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
let verifiedThisRun = 0;
async function verifyOnce(email) {
  if (state.verified[email]) return state.verified[email];
  if (verifiedThisRun >= MAX_VERIFY) return null;
  const day = today();
  state.quota[day] = (state.quota[day] || 0) + 1;
  verifiedThisRun++;
  const res = await verifyEmail(email);
  state.verified[email] = { status: res.status, at: new Date().toISOString() };
  if (verifiedThisRun === 1) log('  réponse brute du vérificateur (à contrôler une fois) :', JSON.stringify(res.raw).slice(0, 300));
  saveState();
  await jitter(300, 700);
  return state.verified[email];
}

// ---------- Pipeline ----------
const input = parseCsv(readFileSync(inputPath, 'utf8'));
const people = input.map((row, i) => {
  const prenom = col(row, 'prenom', 'firstname', 'first');
  const nom = col(row, 'nom', 'lastname', 'last', 'name');
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
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(p);
}
const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
log(`${people.length} profils, ${ordered.length} entreprises. État : ${STATE_PATH}${DO_VERIFY ? ` · vérification activée (max ${MAX_VERIFY})` : ''}`);

for (const [key, members] of ordered) {
  const label = members[0].entreprise || key;
  log(`\n▶ ${label} (${members.length})`);
  // 1. Domaine
  let d = state.domains[key];
  if (!d) {
    let domain = members.find((m) => m.domaine)?.domaine || '';
    if (!domain && !NO_SEARCH) { domain = await searchDomain(label); await jitter(800, 1600); }
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
  if (d.stop) { log(`  ✗ ${d.stop}${d.domain ? ' (' + d.domain + ')' : ''}`); for (const m of members) { m.out.domaine = d.domain; m.out.note = d.stop; } continue; }
  log(`  domaine : ${d.domain}`);
  for (const m of members) m.out.domaine = d.domain;
  // 2. Témoins
  if (!d.witnesses) {
    d.witnesses = await siteWitnesses(d.domain);
    // E-mails écrits dans les profils LinkedIn (Infos, en-tête…) des personnes de la liste : témoins « profil public ».
    for (const m of members) {
      const txt = [col(m.row, 'apropos', 'about', 'contexte', 'profillinkedin', 'contextelinkedin', 'infos'), m.row.__texte || ''].join(' ');
      for (const w of txt.matchAll(EMAIL_RE(d.domain))) { const local = w[1].toLowerCase(); if (!GENERIC_LOCAL.test(local) && !d.witnesses.some((x) => x.local === local)) d.witnesses.push({ local, source: 'profil', name: `${m.prenom} ${m.nom}` }); }
    }
    if (USE_HUNTER) { const h = await hunterDomain(d.domain); if (h) { d.witnesses.push(...h.witnesses.filter((w) => !d.witnesses.some((x) => x.local === w.local))); if (h.pattern) d.hunterPattern = h.pattern; } }
    state.domains[key] = d; saveState();
  }
  log(`  témoins : ${d.witnesses.length ? d.witnesses.map((w) => w.local).join(', ') : 'aucun'}${d.hunterPattern ? ' · hunter → ' + d.hunterPattern : ''}`);
  if (flag('--only-domains')) continue;
  // 3. Pattern (§5.2) — un témoin qui correspond à un profil de la liste = adresse observée (A) et pattern prouvé.
  const votes = {};
  const vote = (pattern, w, weight = 1) => { votes[pattern] = votes[pattern] || { n: 0, sources: [] }; votes[pattern].n += weight; votes[pattern].sources.push(w.source); };
  for (const w of d.witnesses) {
    let matched = false;
    for (const m of members) for (const pat of Object.keys(PATTERNS)) {
      if (candidates(m, pat).includes(w.local)) { matched = true; vote(pat, w, 1); m.observed = { email: w.local + '@' + d.domain, source: w.source }; }
    }
    if (matched) continue;
    if (w.name) { // témoin nommé (Hunter) : on compare au nom
      const [pn, ...nn] = w.name.split(' ');
      const fake = { prenoms: nameVariants(pn), noms: nameVariants(nn.join(' ')) };
      for (const pat of Object.keys(PATTERNS)) if (candidates(fake, pat).includes(w.local)) { matched = true; vote(pat, w, 1); }
    }
    if (!matched) { const sp = shapePattern(w.local); if (sp) vote(sp, w, 1); }
  }
  if (d.hunterPattern) vote(d.hunterPattern, { source: 'hunter' }, 2);
  const ranked = Object.entries(votes).sort((a, b) => b[1].n - a[1].n);
  if (!ranked.length) { d.patternStatus = 'inconnu'; }
  else {
    const [best, info] = ranked[0];
    const rivals = ranked.slice(1).filter(([, v]) => v.n >= 2);
    if (rivals.length && info.n < 2 * rivals[0][1].n) d.patternStatus = 'contradictoire';
    else { d.pattern = best; d.patternStatus = info.n >= 2 ? 'confirmé' : 'probable'; d.source = [...new Set(info.sources)].join('+'); d.nb = info.n; }
  }
  log(`  pattern : ${d.pattern || '—'} (${d.patternStatus}${d.nb ? ', ' + d.nb + ' témoin(s)' : ''})`);
  if (!d.pattern) {
    for (const m of members) { if (m.observed) { Object.assign(m.out, { email: m.observed.email, pattern: 'observé', source_pattern: m.observed.source, confiance: 'A', verifie: 'oui' }); } else m.out.note = 'pattern ' + d.patternStatus + ' — non généré'; }
    continue;
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
    if (!d.catch_all) {
      const probe = await verifyOnce(toVerify[0].out.email);
      if (probe) { d.catch_all = probe.status === 'catch_all' ? 'oui' : probe.status === 'unknown' ? 'inconnu' : 'non'; state.domains[key] = d; saveState(); }
    }
    if (d.catch_all === 'non') for (const m of toVerify) { const v = await verifyOnce(m.out.email); if (!v) break; }
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
  log(`  → ${conf.length} adresses : ${['A', 'B', 'C', 'D'].map((c) => c + '=' + conf.filter((x) => x === c).length).join(' ')}${d.catch_all ? ' · catch-all ' + d.catch_all : ''}`);
}

// ---------- Sortie ----------
const inCols = Object.keys(input[0] || {});
const outCols = [...inCols, ...['domaine', 'email', 'pattern', 'source_pattern', 'nb_temoins', 'catch_all', 'verifie', 'confiance', 'note'].filter((c) => !inCols.includes(c))];
writeCsv(outputPath, people.map((p) => ({ ...p.row, ...p.out })), outCols);
const tally = (k) => people.reduce((acc, p) => { const v = p.out[k] || '—'; acc[v] = (acc[v] || 0) + 1; return acc; }, {});
log(`\n✔ ${outputPath} écrit. Confiance : ${JSON.stringify(tally('confiance'))} · vérifications aujourd'hui : ${state.quota[today()] || 0}`);

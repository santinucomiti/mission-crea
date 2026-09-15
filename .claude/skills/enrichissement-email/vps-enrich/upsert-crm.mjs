#!/usr/bin/env node
// Upsert des résultats d'enrichissement e-mail dans le CRM Outreach (SQLite, ~/outreach/data/outreach.sqlite).
//
//   node upsert-crm.mjs sortie.csv [--db chemin.sqlite] [--dry-run] [--no-mark-missing]
//
// Entrée : le CSV produit par enrich.mjs (colonnes id, Prénom, Nom, Entreprise, domaine, email, pattern,
// source_pattern, nb_temoins, catch_all, verifie, confiance, note). Sortie : colonnes email_* de `prospects`.
//
// Invariant : aucune adresse douteuse n'entre dans le CRM.
//   A / B / C → adresse enregistrée avec son niveau de confiance (la légende est affichée dans le CRM).
//   D         → adresse NON conservée (le vérificateur l'a refusée), statut « non trouvé » + raison.
//   vide      → statut « non trouvé » + raison actionnable (nom masqué, domaine inconnu, catch-all…).
// Les prospects sans domaine connu sont aussi marqués « non trouvé — domaine inconnu » (--no-mark-missing pour ne pas le faire),
// afin que la liste « à traiter autrement » soit complète dans le CRM.
// Une adresse saisie à la main dans le CRM (email_source = 'manuel') n'est jamais écrasée.
// Node ≥ 22.13 (node:sqlite), aucune dépendance. Le serveur Outreach peut rester allumé (WAL).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { normName } from '/home/ubuntu/outreach/db.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const csvPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db');
if (!csvPath) { console.error('usage : node upsert-crm.mjs sortie.csv [--db chemin.sqlite] [--dry-run] [--no-mark-missing]'); process.exit(1); }
const DB_PATH = opt('--db', '/home/ubuntu/outreach/data/outreach.sqlite');
const DRY = flag('--dry-run');
const MARK_MISSING = !flag('--no-mark-missing');
const TRUST_SEARCH = flag('--trust-search-domains'); // sinon : domaine issu de la recherche + adresse non vérifiée → plafonnée à C

// ---------- schéma ----------
export const EMAIL_COLUMNS = {
  email: 'TEXT', email_confiance: 'TEXT', email_statut: 'TEXT', email_pattern: 'TEXT', email_source: 'TEXT',
  email_verifie: 'TEXT', email_catch_all: 'TEXT', email_note: 'TEXT', email_maj: 'TEXT',
};
export function migrateEmailColumns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(prospects)').all().map((c) => c.name));
  for (const [c, t] of Object.entries(EMAIL_COLUMNS)) if (!cols.has(c)) db.exec(`ALTER TABLE prospects ADD COLUMN ${c} ${t}`);
}

// ---------- CSV (RFC 4180, ; ou ,) ----------
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
const key = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function col(row, ...names) {
  const keys = Object.keys(row);
  for (const n of names) { const k = keys.find((k) => key(k) === n); if (k !== undefined && row[k] !== '') return row[k]; }
  return '';
}

// ---------- décision par ligne ----------
// Raison « non trouvé » → phrase actionnable pour l'équipe (comment l'obtenir autrement).
const REASONS = [
  [/nom tronqu/i, 'nom masqué par Sales Navigator — ouvrir le profil LinkedIn (l’extension récupère le nom complet), puis relancer l’enrichissement'],
  [/catch-all, sondage impossible/i, 'domaine catch-all sans témoin — pattern via Hunter (25/mois gratuits) ou contact LinkedIn'],
  [/vérificateur muet/i, 'vérificateur sans réponse pour ce domaine (M365 / Google) — retenter plus tard, sinon Hunter ou LinkedIn'],
  [/contredit par un 2e profil/i, 'pattern non confirmé (collision de prénom) — témoin manuel (site, communiqué) ou Hunter'],
  [/pattern inconnu|contradictoire/i, 'aucun témoin fiable sur ce domaine — Hunter (pattern du domaine), page /contact ou /equipe du site, ou à la main'],
  [/domaine introuvable/i, 'domaine inconnu — visiter la page compte Sales Navigator (extension) puis relancer l’enrichissement'],
  [/pas de MX/i, 'ce domaine ne reçoit pas d’e-mail (pas de MX) — chercher le domaine réel du groupe'],
  [/grand public/i, 'adresse grand public (gmail…) — hors périmètre, passer par LinkedIn'],
  [/vérification inconnue/i, 'vérification sans verdict — retenter dans 48 h'],
  [/nom inexploitable/i, 'nom inexploitable — corriger prénom / nom sur la fiche'],
  [/entreprise absente/i, 'entreprise absente de la fiche — compléter puis relancer'],
];
const reason = (note) => (REASONS.find(([re]) => re.test(note || '')) || [null, note || 'non trouvé'])[1];

function decide(row) {
  const email = col(row, 'email').toLowerCase();
  const conf = col(row, 'confiance').toUpperCase();
  const note = col(row, 'note');
  const base = { pattern: col(row, 'pattern'), source: col(row, 'sourcepattern'), verifie: col(row, 'verifie'), catch_all: col(row, 'catchall') };
  if (email && ['A', 'B', 'C'].includes(conf)) {
    return { ...base, statut: 'trouvé', email, confiance: conf, note: conf === 'C' ? (note || 'pattern probable (1 témoin) — volume réduit, ou re-vérifier') : note };
  }
  if (conf === 'D') {
    return { ...base, statut: 'non trouvé', email: '', confiance: 'D', verifie: 'non', note: `adresse générée (${base.pattern}) refusée par le vérificateur — non conservée ; le pattern est probablement faux pour ce profil` };
  }
  return { ...base, statut: 'non trouvé', email: '', confiance: '', note: reason(note) };
}

// ---------- exécution ----------
const rows = parseCsv(readFileSync(csvPath, 'utf8'));
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
migrateEmailColumns(db);

const byId = db.prepare('SELECT id, email_source FROM prospects WHERE id = ?');
const byName = db.prepare('SELECT id, email_source FROM prospects WHERE nom_norm = ? AND lower(entreprise) = lower(?)');
const hasSrcCol = db.prepare('PRAGMA table_info(entreprises)').all().some((c) => c.name === 'domaine_source');
const srcOf = hasSrcCol ? db.prepare('SELECT e.domaine_source s FROM prospects p LEFT JOIN entreprises e ON e.entreprise_url = p.entreprise_url WHERE p.id = ?') : null;
const upd = db.prepare(`UPDATE prospects SET email = @email, email_confiance = @confiance, email_statut = @statut, email_pattern = @pattern,
  email_source = @source, email_verifie = @verifie, email_catch_all = @catch_all, email_note = @note, email_maj = @now
  WHERE id = @id AND COALESCE(email_source, '') <> 'manuel'`);
const now = new Date().toISOString();
const stats = { lignes: rows.length, parId: 0, parNom: 0, introuvables: [], manuels: 0, statut: {}, confiance: {}, manquantsMarques: 0 };

db.exec('BEGIN');
try {
  for (const row of rows) {
    const id = col(row, 'id');
    let p = id ? byId.get(id) : null;
    if (p) stats.parId++;
    else {
      const full = [col(row, 'prenom', 'firstname'), col(row, 'nom', 'lastname')].filter(Boolean).join(' ');
      p = full ? byName.get(normName(full), col(row, 'entreprise', 'company')) : null;
      if (p) stats.parNom++;
    }
    if (!p) { stats.introuvables.push(`${col(row, 'prenom')} ${col(row, 'nom')} (${col(row, 'entreprise')})`); continue; }
    if (p.email_source === 'manuel') { stats.manuels++; continue; }
    const d = decide(row);
    // Domaine trouvé par le résolveur (recherche web) et pas confirmé par une page compte : une adresse A/B non vérifiée
    // « valid » redescend en C — le domaine peut être une variante ou un homonyme. Une adresse vérifiée reste A.
    if (!TRUST_SEARCH && srcOf && d.statut === 'trouvé' && (d.confiance === 'A' || d.confiance === 'B') && d.verifie !== 'oui' && srcOf.get(p.id)?.s === 'recherche') {
      stats.plafonnes = (stats.plafonnes || 0) + 1;
      d.confiance = 'C'; d.note = 'domaine issu de la recherche web, non confirmé — plafonné à C' + (d.note ? ' · ' + d.note : '');
    }
    stats.statut[d.statut] = (stats.statut[d.statut] || 0) + 1;
    const c = d.confiance || (d.statut === 'trouvé' ? '?' : '—');
    stats.confiance[c] = (stats.confiance[c] || 0) + 1;
    upd.run({ id: p.id, now, ...d });
  }
  if (MARK_MISSING) {
    const r = db.prepare(`UPDATE prospects SET email_statut = 'non trouvé', email_confiance = '', email = '',
      email_note = 'domaine inconnu — visiter la page compte Sales Navigator (extension) puis relancer l’enrichissement', email_maj = @now
      WHERE email_statut IS NULL AND COALESCE(email_source, '') <> 'manuel'
        AND (entreprise_url IS NULL OR entreprise_url = '' OR entreprise_url NOT IN (SELECT entreprise_url FROM entreprises WHERE domaine <> ''))`).run({ now });
    stats.manquantsMarques = r.changes;
  }
  db.exec(DRY ? 'ROLLBACK' : 'COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const tot = db.prepare(`SELECT COALESCE(email_statut, 'non enrichi') s, COUNT(*) n FROM prospects GROUP BY s`).all();
const conf = db.prepare(`SELECT COALESCE(NULLIF(email_confiance, ''), '—') c, COUNT(*) n FROM prospects WHERE email_statut = 'trouvé' GROUP BY c ORDER BY c`).all();
console.log(`${DRY ? '[essai à blanc, rien écrit] ' : ''}${stats.lignes} lignes lues → ${stats.parId} rapprochées par id, ${stats.parNom} par nom, ${stats.introuvables.length} introuvables dans le CRM, ${stats.manuels} ignorées (e-mail saisi à la main)`);
console.log('  statut écrit :', JSON.stringify(stats.statut), '· confiance :', JSON.stringify(stats.confiance));
if (MARK_MISSING) console.log(`  prospects sans domaine marqués « non trouvé — domaine inconnu » : ${stats.manquantsMarques}`);
if (stats.plafonnes) console.log(`  adresses plafonnées à C (domaine issu de la recherche, non vérifiées) : ${stats.plafonnes}`);
if (stats.introuvables.length) console.log('  introuvables :', stats.introuvables.slice(0, 10).join(' | ') + (stats.introuvables.length > 10 ? ' …' : ''));
console.log('  CRM après upsert — statut :', tot.map((r) => `${r.s}=${r.n}`).join(', '), '· confiance des trouvés :', conf.map((r) => `${r.c}=${r.n}`).join(', '));

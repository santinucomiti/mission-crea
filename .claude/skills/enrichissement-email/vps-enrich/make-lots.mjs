#!/usr/bin/env node
// Fabrique les lots de vérification pour les agents à partir d'un CSV produit par resolve-domains.mjs.
//
//   node make-lots.mjs <resolver.csv> <dossier-sortie> [--size 50] [--db chemin.sqlite]
//
// Entrée : le CSV du résolveur (entreprise_url;nom;nb_prospects;domaine;niveau;mx;preuve_titre;url).
// Sortie : dans <dossier-sortie>,
//   lot-N-differes.csv  → propositions NON écrites par le résolveur (niveau faible/aucun, ou sans MX) : l'agent doit trouver le bon domaine ;
//   lot-N-ecrits.csv    → domaines ÉCRITS par le résolveur (fort/moyen + MX) : l'agent audite.
// Colonnes des lots : nom;domaine;niveau;preuve_titre;url;nb_prospects;titres;localisation
// (« titres » et « localisation » viennent du CRM : ils lèvent les homonymes).
// Exclues : entreprises déjà « vérifié-agent » dans le CRM, noms fantômes (Confidential, Stealth, Not Specified…).
// Node ≥ 22.13 (node:sqlite), aucune dépendance.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !['--size', '--db'].includes(args[i - 1]));
const [src, outDir] = positional;
const SIZE = Math.max(5, Number(opt('--size', 50)) || 50);
const DB_PATH = opt('--db', '/home/ubuntu/outreach/data/outreach.sqlite');
if (!src || !outDir) { console.error('usage : node make-lots.mjs <resolver.csv> <dossier-sortie> [--size 50] [--db chemin.sqlite]'); process.exit(1); }

const GHOST = /^(confidential|stealth( mode| startup)?|not specified|company name \(withheld\)|n\/a|none|self[- ]employed|freelance|independent|retired|private|undisclosed|-+)$/i;

// CSV « ; » avec guillemets (RFC 4180).
function parseLine(l, header) {
  const out = []; let f = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ';') { out.push(f); f = ''; } else f += c;
  }
  out.push(f);
  return Object.fromEntries(header.map((h, i) => [h, (out[i] || '').trim()]));
}
const lines = readFileSync(src, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
const header = lines[0].split(';').map((h) => h.replace(/^"|"$/g, '').trim());
for (const need of ['entreprise_url', 'nom', 'domaine', 'niveau', 'mx']) if (!header.includes(need)) { console.error(`colonne manquante dans ${src} : ${need}`); process.exit(1); }
const rows = lines.slice(1).map((l) => parseLine(l, header));

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const srcOf = db.prepare('SELECT domaine, domaine_source FROM entreprises WHERE entreprise_url = ?');
const ctxOf = db.prepare('SELECT titre, localisation FROM prospects WHERE entreprise_url = ? LIMIT 8');

const written = [], deferred = [];
let skippedVerified = 0, skippedGhost = 0;
for (const r of rows) {
  if (GHOST.test(r.nom.trim())) { skippedGhost++; continue; }
  const e = srcOf.get(r.entreprise_url);
  if (e && e.domaine_source === 'vérifié-agent') { skippedVerified++; continue; }
  const people = ctxOf.all(r.entreprise_url);
  const titres = [...new Set(people.map((p) => (p.titre || '').trim()).filter(Boolean))].slice(0, 4).join(' / ');
  const localisation = (people.find((p) => p.localisation)?.localisation || '').trim();
  const mxOk = /^(oui|yes|true|1)$/i.test(r.mx);
  const row = { nom: r.nom, domaine: r.domaine, niveau: r.niveau, preuve_titre: r.preuve_titre || '', url: r.url || '', nb_prospects: r.nb_prospects || String(people.length), titres, localisation };
  (/^(fort|moyen)$/i.test(r.niveau) && mxOk ? written : deferred).push(row);
}

mkdirSync(outDir, { recursive: true });
const cols = ['nom', 'domaine', 'niveau', 'preuve_titre', 'url', 'nb_prospects', 'titres', 'localisation'];
const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""').replace(/\|/g, '/') + '"';
let n = 0; const files = [];
for (const [kind, list] of [['differes', deferred], ['ecrits', written]]) {
  for (let i = 0; i < list.length; i += SIZE) {
    n++;
    const f = join(outDir, `lot-${n}-${kind}.csv`);
    writeFileSync(f, cols.join(';') + '\n' + list.slice(i, i + SIZE).map((r) => cols.map((c) => cell(r[c])).join(';')).join('\n') + '\n');
    files.push(`${f} (${Math.min(SIZE, list.length - i)} entreprises)`);
  }
}
console.log(`${rows.length} lignes lues → différés ${deferred.length} · écrits ${written.length} · déjà vérifiés (exclus) ${skippedVerified} · fantômes (exclus) ${skippedGhost}`);
for (const f of files) console.log('  ' + f);
if (!files.length) console.log('rien à vérifier : aucun lot produit');

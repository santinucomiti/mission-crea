#!/usr/bin/env node
// Applique au CRM les verdicts des agents de vérification de domaines.
//   node verif-apply.mjs bench/verif/lot-1.result.md [lot-2.result.md …] [--dry-run]
// Chaque fichier contient le tableau markdown rendu par un agent :
//   | nom | verdict | domaine_final | preuve_url | motif |
// Règles :
//   OK        → le domaine proposé est confirmé : domaine_source = 'vérifié-agent' (écrit s'il ne l'était pas : lignes « faible »).
//   VARIANTE  → remplacé par domaine_final (même groupe, domaine principal) : domaine_source = 'vérifié-agent'.
//   FAUX      → domaine retiré ; si l'agent donne domaine_final avec preuve, il le remplace (domaine_source = 'vérifié-agent').
//   INCONNU   → aucun changement (reste « à vérifier », jamais utilisé pour générer).
// Seules les entrées de source 'recherche' (ou absentes) sont modifiées : jamais une page compte Sales Navigator.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolveMx } from 'node:dns/promises';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const SRC = (() => { const i = args.indexOf('--source'); return i > -1 ? args[i + 1] : '/home/ubuntu/enrich/bench/resolved-pilot-200.csv'; })();
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--source');
if (!files.length) { console.error('usage : node verif-apply.mjs lot-1.result.md … [--dry-run]'); process.exit(1); }
const db = new DatabaseSync('/home/ubuntu/outreach/data/outreach.sqlite');
db.exec('PRAGMA busy_timeout = 5000');

const clean = (d) => (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/[`*]/g, '');
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function hasMx(d) { try { return (await resolveMx(d)).length > 0; } catch { return false; } }

// Entreprises du pilote : nom → (entreprise_url, domaine proposé, niveau) depuis le CSV du résolveur.
const pilot = readFileSync(SRC, 'utf8').replace(/^﻿/, '').split('\n').filter(Boolean);
const ph = pilot[0].split(';').map((h) => h.replace(/^"|"$/g, ''));
const parseLine = (l) => { const out = []; let f = '', q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"') { if (l[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ';') { out.push(f); f = ''; } else f += c; } out.push(f); return Object.fromEntries(ph.map((h, i) => [h, out[i] || ''])); };
const byName = new Map(pilot.slice(1).map(parseLine).map((r) => [norm(r.nom), r]));

const verdicts = [];
for (const f of files) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*(OK|VARIANTE|TROUV[ÉE]|FAUX|INCONNU)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|?\s*$/i);
    if (!m) continue;
    // TROUVÉ = lots « sans domaine » (aucune proposition à auditer) : traité comme VARIANTE (on écrit domaine_final).
    const verdict = m[2].toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').startsWith('TROUV') ? 'VARIANTE' : m[2].toUpperCase();
    verdicts.push({ nom: m[1].replace(/[`*]/g, '').replace(/&amp;/g, '&').trim(), verdict, final: clean(m[3]), preuve: m[4].trim(), motif: m[5].trim() });
  }
}
console.log(`${verdicts.length} verdicts lus dans ${files.length} fichier(s)`);

const getE = db.prepare('SELECT entreprise_url u, domaine, domaine_source FROM entreprises WHERE entreprise_url = ?');
const setE = db.prepare(`INSERT INTO entreprises(entreprise_url, nom, site, domaine, maj, domaine_source) VALUES (@u, @nom, @site, @domaine, @maj, @src)
  ON CONFLICT(entreprise_url) DO UPDATE SET domaine = excluded.domaine, site = excluded.site, domaine_source = excluded.domaine_source, maj = excluded.maj`);
const delE = db.prepare("DELETE FROM entreprises WHERE entreprise_url = ? AND COALESCE(domaine_source, '') <> 'sales-nav'");
const stats = { OK: 0, VARIANTE: 0, FAUX: 0, INCONNU: 0, introuvables: 0, ecrits: 0, retires: 0, sans_mx: 0, proteges: 0 };
db.exec('BEGIN');
try {
  for (const v of verdicts) {
    const p = byName.get(norm(v.nom));
    if (!p) { stats.introuvables++; console.log('  ? entreprise inconnue du pilote :', v.nom); continue; }
    stats[v.verdict] = (stats[v.verdict] || 0) + 1;
    const cur = getE.get(p.entreprise_url);
    if (cur && cur.domaine_source === 'sales-nav') { stats.proteges++; continue; } // jamais par-dessus une page compte
    const now = new Date().toISOString();
    const write = async (domain) => {
      const d = clean(domain); if (!d) return false;
      if (!(await hasMx(d))) { stats.sans_mx++; console.log(`  ⚠ ${v.nom} : ${d} sans MX — non écrit`); return false; }
      if (!DRY) setE.run({ u: p.entreprise_url, nom: p.nom, site: 'https://' + d + '/', domaine: d, maj: now, src: 'vérifié-agent' });
      stats.ecrits++; return true;
    };
    if (v.verdict === 'OK') { await write(p.domaine || v.final); }
    else if (v.verdict === 'VARIANTE') { if (!(await write(v.final || p.domaine))) { /* variante sans MX : on garde l'existant */ } }
    else if (v.verdict === 'FAUX') {
      if (v.final && await write(v.final)) { /* remplacé par le bon domaine, avec preuve */ }
      else if (cur && cur.domaine_source === 'recherche') { if (!DRY) delE.run(p.entreprise_url); stats.retires++; console.log(`  ✗ ${v.nom} : ${cur.domaine} retiré (${v.motif})`); }
    }
    // INCONNU : rien
  }
  db.exec(DRY ? 'ROLLBACK' : 'COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(`${DRY ? '[essai à blanc] ' : ''}verdicts : OK ${stats.OK} · VARIANTE ${stats.VARIANTE} · FAUX ${stats.FAUX} · INCONNU ${stats.INCONNU} · non rapprochés ${stats.introuvables}`);
console.log(`domaines écrits/confirmés : ${stats.ecrits} · retirés : ${stats.retires} · refusés (sans MX) : ${stats.sans_mx} · protégés (page compte) : ${stats.proteges}`);
console.log(db.prepare("SELECT COALESCE(domaine_source,'sales-nav') s, COUNT(*) n FROM entreprises WHERE domaine <> '' GROUP BY s").all().map((r) => `${r.s}=${r.n}`).join(' · '));

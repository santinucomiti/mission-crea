import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { countryOf } from '/home/ubuntu/outreach/db.js';
const LIMIT = Number(process.argv[2] || 100);
const db = new DatabaseSync('/home/ubuntu/outreach/data/outreach.sqlite', { readOnly: true });
const state = JSON.parse(readFileSync('/home/ubuntu/enrich/smoke-uk/etat-v3.json', 'utf8'));
const all = db.prepare(`SELECT p.id, p.prenom, p.nom, p.entreprise, e.domaine, p.titre, p.localisation, p.a_propos, p.contexte_linkedin
  FROM prospects p JOIN entreprises e ON e.entreprise_url = p.entreprise_url WHERE e.domaine <> ''`).all();
const uk = all.filter((r) => countryOf(r.localisation) === 'Royaume-Uni');
const truncated = (nom) => /^[A-Za-zÀ-ÿ]\.?$/.test((nom || '').trim());
const prio = (r) => {
  if (truncated(r.nom)) return 4;                                  // nom masqué : aucune adresse possible
  const d = state.domains[r.domaine];
  if (!d) return 0;                                                // jamais vu → domaine + témoins + sondage
  if (/vérificateur muet/.test(d.patternStatus || '') || (d.probed || []).some((x) => /:unknown$/.test(x))) return 1; // à re-sonder
  if (d.pattern && d.catch_all === 'non') return 2;                // pattern connu, vérifications à compléter
  return 3;                                                        // déjà résolu / catch-all : gratuit
};
const byDom = new Map(); for (const r of uk) byDom.set(r.domaine, (byDom.get(r.domaine) || 0) + 1);
uk.sort((a, b) => prio(a) - prio(b) || byDom.get(b.domaine) - byDom.get(a.domaine) || a.domaine.localeCompare(b.domaine) || (a.nom || '').localeCompare(b.nom || ''));
const pick = uk.slice(0, LIMIT);
const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const cols = [['id','id'],['prenom','Prénom'],['nom','Nom'],['entreprise','Entreprise'],['domaine','Domaine'],['titre','Titre'],['localisation','Localisation'],['a_propos','À propos'],['contexte_linkedin','Profil LinkedIn']];
writeFileSync(process.argv[3], '﻿' + [cols.map((c) => cell(c[1])).join(';'), ...pick.map((r) => cols.map((c) => cell(r[c[0]])).join(';'))].join('\n'));
const dist = {}; for (const r of pick) dist[prio(r)] = (dist[prio(r)] || 0) + 1;
console.log(`UK avec domaine: ${uk.length} (sur ${all.length} avec domaine) → retenus: ${pick.length}, domaines: ${new Set(pick.map((r) => r.domaine)).size}`);
console.log('priorités retenues (0=nouveau,1=muet à re-sonder,2=B à vérifier,3=déjà résolu,4=nom tronqué):', dist);

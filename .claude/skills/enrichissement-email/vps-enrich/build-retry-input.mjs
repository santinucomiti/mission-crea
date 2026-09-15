#!/usr/bin/env node
// EXPÉRIENCE « re-sondage des serveurs muets » : un serveur qui n'a pas répondu au vérificateur répond-il
// plus tard ? Échantillon stratifié par type de serveur, pour savoir OÙ un re-sondage paie.
//
//   node build-retry-input.mjs <N> <out.csv> [--pays "Royaume-Uni"] [--type "Microsoft 365"]
//
// RÉSULTAT DE L'EXPÉRIENCE (13/09/2026, 50 domaines muets re-sondés 12 h après) : Microsoft 365 répond
// 84 % du temps au 2e essai (12 valides sur 25 !), passerelles 0/15, Google 0/10. Décision : ne re-sonder
// QUE les serveurs Microsoft 365 (--type "Microsoft 365") ; les autres muets sont un cul-de-sac.
//
// Sélectionne N domaines dont le dernier sondage est resté « unknown », répartis entre Microsoft 365,
// passerelle et Google, avec un profil chacun. À lancer avec UNKNOWN_TTL_HOURS=12 pour que enrich.mjs
// accepte de rappeler l'API avant le délai normal de 48 h.
// Node ≥ 22.13, aucune dépendance.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveMx } from 'node:dns/promises';
import { countryOf } from '/home/ubuntu/outreach/db.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !['--pays', '--type'].includes(args[i - 1]));
const TYPE = opt('--type', ''); // ex. --type "Microsoft 365" : ne garder qu'un type de serveur (décision du 13/09)
const [nArg, outPath] = positional;
const N = Number(nArg || 50);
const PAYS = opt('--pays', 'Royaume-Uni');
if (!outPath) { console.error('usage : node build-retry-input.mjs <N> <out.csv> [--pays "Royaume-Uni"]'); process.exit(1); }

const state = JSON.parse(readFileSync('/home/ubuntu/enrich/smoke-uk/etat-v3.json', 'utf8'));
const db = new DatabaseSync('/home/ubuntu/outreach/data/outreach.sqlite', { readOnly: true });
const rows = db.prepare(`SELECT p.id, p.prenom, p.nom, p.entreprise, e.domaine, p.titre, p.localisation, p.a_propos, p.contexte_linkedin
  FROM prospects p JOIN entreprises e ON e.entreprise_url = p.entreprise_url WHERE e.domaine <> ''`).all()
  .filter((r) => countryOf(r.localisation) === PAYS);

const tronque = (n) => /^[A-Za-zÀ-ÿ]\.?$/.test((n || '').trim()) || !(n || '').trim();
const parDom = new Map();
for (const r of rows) {
  if (tronque(r.nom) || tronque(r.prenom)) continue;
  const d = state.domains[r.domaine];
  if (!d || d.pattern) continue;
  // Serveurs muets : dernier sondage « unknown », OU sondage « vide » (quota épuisé avant l'appel : le domaine
  // avait été retenu comme muet la veille — 134 cas le 14/09).
  // Depuis le correctif du 14/09, un sondage sans appel laisse probed = null MAIS probedAt renseigné : c'est un
  // domaine qui avait été retenu pour re-sondage et que le quota n'a pas atteint → toujours éligible.
  const probed = d.probed || [];
  const interrompu = !probed.length && !!d.probedAt;
  if (!(probed.some((p) => /:unknown$/.test(p)) || interrompu)) continue;
  if (!parDom.has(r.domaine)) parDom.set(r.domaine, r);
}

const GATEWAY = /mimecast|proofpoint|pphosted|barracuda|messagelabs|symantec|trendmicro|forcepoint|sophos|egress|fortinet|retarus|hornetsecurity/;
const cibles = [...parDom.entries()].map(([dom, r]) => ({ dom, r }));
await Promise.all(cibles.map(async (c) => {
  try {
    const mx = (await resolveMx(c.dom)).map((m) => m.exchange.toLowerCase()).join(' ');
    c.mx = !mx ? 'sans MX' : GATEWAY.test(mx) ? 'passerelle' : /protection\.outlook\.com/.test(mx) ? 'Microsoft 365' : /google|googlemail/.test(mx) ? 'Google' : 'autre';
  } catch { c.mx = 'sans MX'; }
}));

// Échantillon stratifié : moitié Microsoft 365, puis passerelles, puis Google — c'est là que se joue le
// rendement (mesuré le 12/09 : 12 %, 8 %, 6 % de réussite au premier sondage).
const quota = TYPE ? { [TYPE]: N } : { 'Microsoft 365': Math.round(N * 0.5), 'passerelle': Math.round(N * 0.3), 'Google': Math.round(N * 0.2) };
const pick = [];
for (const [type, q] of Object.entries(quota)) {
  const dispo = cibles.filter((c) => c.mx === type);
  for (let i = 0; i < Math.min(q, dispo.length); i++) pick.push(dispo[Math.floor((i * dispo.length) / Math.min(q, dispo.length))]);
}
const vus = new Set(); const final = pick.filter((c) => !vus.has(c.dom) && vus.add(c.dom)).slice(0, N);

const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const cols = [['id', 'id'], ['prenom', 'Prénom'], ['nom', 'Nom'], ['entreprise', 'Entreprise'], ['domaine', 'Domaine'], ['titre', 'Titre'], ['localisation', 'Localisation'], ['a_propos', 'À propos'], ['contexte_linkedin', 'Profil LinkedIn']];
writeFileSync(outPath, '﻿' + [cols.map((c) => cell(c[1])).join(';'), ...final.map((x) => cols.map((c) => cell(x.r[c[0]])).join(';'))].join('\n'));
const rep = {}; for (const c of final) rep[c.mx] = (rep[c.mx] || 0) + 1;
console.log(`domaines muets disponibles (${PAYS}) : ${cibles.length} → échantillon ${final.length} ${JSON.stringify(rep)}`);
console.log(`témoin de comparaison : au 1er sondage, ces serveurs avaient répondu dans 0 % des cas (par définition)`);

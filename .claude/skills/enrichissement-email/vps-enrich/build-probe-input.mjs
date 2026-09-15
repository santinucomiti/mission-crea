#!/usr/bin/env node
// Entrée pour une CAMPAGNE DE SONDAGE : un profil par domaine dont le format d'adresse est inconnu.
//
//   node build-probe-input.mjs <LIMIT> <out.csv> [--pays "Royaume-Uni"]
//
// But : dépenser les crédits MyEmailVerifier là où ils CRÉENT une adresse (sonder prenom.nom sur un domaine
// sans format connu) plutôt qu'à re-vérifier des B déjà utilisables. Le script enrich.mjs sonde de lui-même
// tout domaine sans format quand on lui passe --verify ; il suffit donc de lui donner cette entrée-là.
//
// Ordre de priorité :
//   0. domaine avec adresses génériques observées (contact@, info@…) mais aucun format de noms
//      → on sait déjà que le domaine reçoit le courrier de l'entreprise : une seule inconnue, le format ;
//   1. domaine sans aucun témoin (deux inconnues : le domaine est-il le bon, et quel format) ;
//   à nombre de profils égal, les domaines qui débloquent le plus de profils d'abord.
// Exclus : formats déjà connus, catch-all connus (le sondage ne prouverait rien), domaines déjà sondés,
// profils au nom masqué par Sales Navigator (aucune adresse possible).
// Node ≥ 22.13, aucune dépendance.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveMx } from 'node:dns/promises';
import { countryOf } from '/home/ubuntu/outreach/db.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--pays');
const [limitArg, outPath] = positional;
const LIMIT = Number(limitArg || 100);
const PAYS = opt('--pays', 'Royaume-Uni');
if (!outPath) { console.error('usage : node build-probe-input.mjs <LIMIT> <out.csv> [--pays "Royaume-Uni"]'); process.exit(1); }

const state = JSON.parse(readFileSync('/home/ubuntu/enrich/smoke-uk/etat-v3.json', 'utf8'));
const db = new DatabaseSync('/home/ubuntu/outreach/data/outreach.sqlite', { readOnly: true });
const rows = db.prepare(`SELECT p.id, p.prenom, p.nom, p.entreprise, e.domaine, p.titre, p.localisation, p.a_propos, p.contexte_linkedin
  FROM prospects p JOIN entreprises e ON e.entreprise_url = p.entreprise_url WHERE e.domaine <> ''`).all()
  .filter((r) => countryOf(r.localisation) === PAYS);

const tronque = (n) => /^[A-Za-zÀ-ÿ]\.?$/.test((n || '').trim()) || !(n || '').trim();
const utilisables = rows.filter((r) => !tronque(r.nom) && !tronque(r.prenom));

// un seul profil par domaine (celui dont le nom est le plus simple : moins de risque d'échec du sondage)
const parDom = new Map();
for (const r of utilisables) {
  const d = state.domains[r.domaine];
  if (d && d.pattern) continue;                              // format déjà connu
  if (d && d.catch_all === 'oui') continue;                  // catch-all : le sondage ne prouve rien
  if (d && (d.probed || []).length) continue;                // déjà sondé
  const g = parDom.get(r.domaine) || { profils: [], temoins: d ? (d.witnesses || []).length : 0, vu: !!d };
  g.profils.push(r);
  parDom.set(r.domaine, g);
}
const simplicite = (r) => (r.prenom + r.nom).length + (/[ '-]/.test(r.prenom + r.nom) ? 5 : 0);
const cibles = [...parDom.entries()].map(([dom, g]) => ({
  dom, n: g.profils.length, temoins: g.temoins,
  r: g.profils.sort((a, b) => simplicite(a) - simplicite(b))[0],
}));

// Type de serveur de courrier (une requête DNS, zéro crédit) : il prédit le rendement du sondage.
// Mesuré le 12/09/2026 sur 185 sondages : Microsoft 365 15 % de réussite, passerelle 6 %, Google 6 %, autre 0 %
// — et surtout ~70 % de « muets » (serveur qui refuse de répondre) sur les deux derniers. À budget serré,
// sonder d'abord Microsoft 365 rapporte deux à trois fois plus d'adresses par crédit.
const GATEWAY = /mimecast|proofpoint|pphosted|barracuda|messagelabs|symantec|trendmicro|forcepoint|sophos|egress|fortinet|retarus|hornetsecurity/;
const rang = { 'microsoft365': 0, 'autre': 1, 'google': 2, 'passerelle': 3, 'sans-mx': 9 };
await Promise.all(cibles.map(async (c) => {
  try {
    const mx = (await resolveMx(c.dom)).map((m) => m.exchange.toLowerCase()).join(' ');
    c.mx = !mx ? 'sans-mx' : GATEWAY.test(mx) ? 'passerelle' : /protection\.outlook\.com/.test(mx) ? 'microsoft365' : /google|googlemail/.test(mx) ? 'google' : 'autre';
  } catch { c.mx = 'sans-mx'; }
}));
// RÈGLE DÉCISIVE (campagne du 12/09/2026, 552 domaines sondés) : sur les 316 domaines où le site n'avait
// livré AUCUNE adresse, le sondage a donné 0 réussite sur 316 — même parmi les 64 serveurs qui ont répondu.
// Sur les 236 domaines où au moins une adresse générique (contact@, info@…) avait été vue, 21 % de réussite.
// Voir une adresse sur le domaine prouve que c'est bien son domaine de messagerie ; sans cette preuve, le
// crédit est perdu. On ne sonde donc que ces domaines-là, sauf --tout (pour re-mesurer la règle).
const TOUT = args.includes('--tout');
const sansPreuve = cibles.filter((c) => c.temoins === 0).length;
if (!TOUT) for (let i = cibles.length - 1; i >= 0; i--) if (cibles[i].temoins === 0) cibles.splice(i, 1);
// Un domaine sans MX ne reçoit pas de courrier : jamais de crédit dessus.
const sansMx = cibles.filter((c) => c.mx === 'sans-mx').length;
const retenues = cibles.filter((c) => c.mx !== 'sans-mx');
retenues.sort((a, b) => (b.temoins > 0) - (a.temoins > 0) || rang[a.mx] - rang[b.mx] || b.n - a.n || a.dom.localeCompare(b.dom));
cibles.length = 0; cibles.push(...retenues);

const pick = cibles.slice(0, LIMIT);
const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const cols = [['id', 'id'], ['prenom', 'Prénom'], ['nom', 'Nom'], ['entreprise', 'Entreprise'], ['domaine', 'Domaine'], ['titre', 'Titre'], ['localisation', 'Localisation'], ['a_propos', 'À propos'], ['contexte_linkedin', 'Profil LinkedIn']];
writeFileSync(outPath, '﻿' + [cols.map((c) => cell(c[1])).join(';'), ...pick.map((x) => cols.map((c) => cell(x.r[c[0]])).join(';'))].join('\n'));
const avecTemoins = pick.filter((x) => x.temoins > 0).length;
console.log(`domaines sondables (${PAYS}) : ${cibles.length} → retenus ${pick.length} · écartés : ${sansPreuve} sans aucune adresse vue${TOUT ? " (gardés : --tout)" : ""}, ${sansMx} sans MX`);
console.log(`profils débloqués si tous les sondages passaient : ${pick.reduce((s, x) => s + x.n, 0)}`);

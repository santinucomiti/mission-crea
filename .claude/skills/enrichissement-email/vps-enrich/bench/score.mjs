#!/usr/bin/env node
// Score d'une expérience d'enrichissement (zéro crédit) : node score.mjs sortie.csv etat.json [--json]
// Métriques + tests d'invariant (sortie non nulle si un invariant est violé).
import { readFileSync } from 'node:fs';

const [outCsv, statePath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const JSON_ONLY = process.argv.includes('--json');

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

const rows = parseCsv(readFileSync(outCsv, 'utf8'));
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const D = state.domains || {};
const V = state.verified || {};

const m = { profils: rows.length, A: 0, B: 0, C: 0, D: 0, sans_adresse: 0, AB: 0, a_verifier: 0, observes: 0,
  domaines: 0, dom_stop: 0, suspects: 0, dom_confirme: 0, dom_probable: 0, dom_inconnu: 0, dom_avec_temoin: 0, temoins_total: 0, temoins_site: 0, temoins_persistants: 0, catch_all_oui: 0 };
const violations = [];
// Verdicts du vérificateur par domaine : ≥ 2 refus et 0 succès = pattern contredit. Le scoreur applique cette
// règle lui-même, identiquement pour tous les candidats (un candidat qui l'ignore ne gagne pas de « confirmé » fictifs).
// Comptés PAR PATTERN (forme du local-part) : un « p.nom » invalide ne contredit pas un pattern « prenom.nom ».
const shapeOf = (local) => /^[a-z]\.[a-z]{2,}$/.test(local) ? 'p.nom' : /^[a-z]{2,}\.[a-z]{2,}$/.test(local) ? 'prenom.nom' : /^[a-z]{2,}_[a-z]{2,}$/.test(local) ? 'prenom_nom' : /^[a-z]{2,}-[a-z]{2,}$/.test(local) ? 'prenom-nom' : null;
const verdicts = {};
for (const [e, v] of Object.entries(V)) { const [local, dom] = e.split('@'); const sh = shapeOf(local || ''); if (!dom || !sh) continue; const k = dom + '|' + sh; verdicts[k] = verdicts[k] || { invalid: 0, valid: 0 }; if (v.status === 'invalid') verdicts[k].invalid++; if (v.status === 'valid') verdicts[k].valid++; }
const contradicted = (dom, pattern) => { const vd = verdicts[dom + '|' + pattern]; return !!vd && vd.invalid >= 2 && vd.valid === 0; };
m.dom_contredit = 0;

for (const [key, d] of Object.entries(D)) {
  if (d.stop) { m.dom_stop++; continue; }
  m.domaines++;
  const w = d.witnesses || [];
  if (w.length) m.dom_avec_temoin++;
  m.temoins_total += w.length;
  m.temoins_site += w.filter((x) => /^site/.test(x.source)).length;
  m.temoins_persistants += w.filter((x) => /^(sondage|verif)/.test(x.source)).length;
  if (d.catch_all === 'oui') m.catch_all_oui++;
  const st = d.pattern && contradicted(d.domain, d.pattern) ? 'contredit' : (d.patternStatus || '');
  if (st === 'contredit') m.dom_contredit++; else if (st === 'confirmé') m.dom_confirme++; else if (st === 'probable') m.dom_probable++; else m.dom_inconnu++;
}

const domByName = new Map(Object.values(D).filter((d) => d.domain).map((d) => [d.domain, d]));
for (const r of rows) {
  const c = r.confiance || '';
  if (c) m[c] = (m[c] || 0) + 1; else m.sans_adresse++;
  if (r.pattern === 'observé') m.observes++;
  if (r.email && r.verifie === 'non' && r.catch_all !== 'oui' && !V[r.email]) m.a_verifier++;
  if (r.email && r.pattern !== 'observé' && (r.confiance === 'B' || r.confiance === 'C') && contradicted(r.domaine, r.pattern)) m.suspects++;
  // ---- invariants ----
  if (r.email) {
    if (!/^[a-z0-9][a-z0-9._'-]*@[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.email)) violations.push(`adresse mal formée : ${r.email}`);
    if (/\b(mba|cissp|cism|cisa|phd|msc|bsc)\b/i.test(r.email.split('@')[0])) violations.push(`titre/diplôme dans l'adresse : ${r.email}`);
    if (/nom tronqu/i.test(r.note || '')) violations.push(`adresse générée sur un nom masqué : ${r.email}`);
    const d = domByName.get(r.domaine);
    if (r.pattern !== 'observé') {
      if (!d || !d.pattern) violations.push(`adresse sans pattern établi sur le domaine : ${r.email}`);
      else if (!(d.witnesses || []).length && !/sondage|verif/.test(d.source || '')) violations.push(`adresse générée sans témoin ni sondage : ${r.email}`);
    }
  }
}
m.AB = m.A + m.B;
m.invariants_ok = violations.length === 0;
m.violations = violations.slice(0, 10);

if (JSON_ONLY) console.log(JSON.stringify(m));
else {
  console.log(`profils ${m.profils} · A ${m.A} · B ${m.B} · C ${m.C} · D ${m.D} · sans adresse ${m.sans_adresse} · A+B ${m.AB} · observés ${m.observes} · à vérifier (crédits) ${m.a_verifier} · suspects ${m.suspects}`);
  console.log(`domaines ${m.domaines} (+${m.dom_stop} stop) · confirmé ${m.dom_confirme} · probable ${m.dom_probable} · inconnu ${m.dom_inconnu} · contredit ${m.dom_contredit} · avec témoin ${m.dom_avec_temoin} · témoins ${m.temoins_total} (site ${m.temoins_site}, persistants ${m.temoins_persistants}) · catch-all ${m.catch_all_oui}`);
  console.log(m.invariants_ok ? 'invariants : OK' : 'INVARIANTS VIOLÉS :\n  ' + violations.join('\n  '));
}
process.exit(m.invariants_ok ? 0 : 2);

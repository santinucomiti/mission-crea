// Mesure A+B par origine du domaine (prospects UK avec domaine). usage : node mesure.mjs [--all]
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/home/ubuntu/outreach/data/outreach.sqlite', { readOnly: true });
const rows = db.prepare(`
  SELECT p.id, p.nom_norm, p.prenom, p.nom, p.email_statut s, p.email_confiance c, e.domaine_source src
  FROM prospects p JOIN entreprises e ON e.entreprise_url = p.entreprise_url
  WHERE e.domaine IS NOT NULL AND e.domaine <> '' AND p.localisation LIKE '%Royaume-Uni%'`).all();
const masked = r => !r.prenom || !r.nom || /linkedin member|membre linkedin|^\W*$/i.test(`${r.prenom} ${r.nom}`) || /^[A-Z]\.?$/.test(r.nom);
const tab = {};
for (const r of rows) {
  const k = r.src || 'null';
  const t = (tab[k] ??= { total: 0, masques: 0, A: 0, B: 0, C: 0, D: 0, nonTrouve: 0, nonEnrichi: 0 });
  t.total++;
  if (masked(r)) { t.masques++; continue; }
  if (r.s === 'trouvé') t[r.c]++;
  else if (r.s === 'non trouvé') { if (r.c === 'D') t.D++; else t.nonTrouve++; }
  else t.nonEnrichi++;
}
const fmt = t => { const n = t.total - t.masques; const ab = t.A + t.B; return `${String(t.total).padStart(4)} (dont ${t.masques} masqués) | A ${t.A} · B ${t.B} · C ${t.C} · D ${t.D} · non trouvé ${t.nonTrouve} · non enrichi ${t.nonEnrichi} | A+B = ${ab}/${n} = ${n ? Math.round(100 * ab / n) : 0} %`; };
let tot = { total: 0, masques: 0, A: 0, B: 0, C: 0, D: 0, nonTrouve: 0, nonEnrichi: 0 };
for (const [k, t] of Object.entries(tab).sort()) { console.log(`${k.padEnd(15)} ${fmt(t)}`); for (const f in tot) tot[f] += t[f]; }
console.log(`${'TOTAL UK'.padEnd(15)} ${fmt(tot)}`);
console.log('mesuré le', new Date().toISOString());

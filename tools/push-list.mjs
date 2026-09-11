// node push-list.mjs rssi-list.json — upsert dans le CRM + marque contactés ceux qui ont eu une interaction
import { readFileSync } from 'node:fs';
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const cookie = readFileSync('/tmp/claude-1000/cj', 'utf8').split('\n').filter((l) => l.includes('outreach_session')).map((l) => l.split('\t')).map((p) => p[5] + '=' + p[6]).join('; ');
const BASE = 'https://missioncrea.clippingatlas.com/api';
const call = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(j));
  return j;
};
const toLead = (r) => {
  const [prenom, ...rest] = r.nomComplet.split(/\s+/);
  return {
    prenom, nom: rest.join(' '), nomComplet: r.nomComplet, degre: r.degre, premium: 'non',
    titre: r.titre, entreprise: r.entreprise, entrepriseUrl: r.entrepriseUrl, localisation: r.localisation,
    enregistre: 'oui', listes: 'RSSI', profilUrl: `https://www.linkedin.com/sales/lead/${r.id}`, photoUrl: r.photoUrl,
    derniereActivite: '',
  };
};
let created = 0, updated = 0, merged = 0;
for (let i = 0; i < rows.length; i += 50) {
  const r = await call('/sync/upsert', { leads: rows.slice(i, i + 50).map(toLead) });
  created += r.created; updated += r.updated; merged += r.merged;
}
console.log({ created, updated, merged });
const contacted = rows.filter((r) => !/Aucune activité/i.test(r.interaction));
const before = await (await fetch(BASE + '/prospects', { headers: { cookie } })).json();
const wasContacted = new Set(before.filter((p) => p.contacte).map((p) => p.id));
let marked = 0, already = 0;
for (const r of contacted) {
  if (wasContacted.has(r.id)) { already++; continue; }
  await call('/sync/contacted', { id: r.id, lead: toLead(r) });
  marked++;
}
console.log({ contacted: contacted.length, marked, already });

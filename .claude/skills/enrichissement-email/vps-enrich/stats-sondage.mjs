#!/usr/bin/env node
// Bilan d'une campagne de sondage : rendement par type de serveur, par groupe de départ, coût par adresse.
//   node stats-sondage.mjs <journal1.log> [journal2.log …] [--depuis 2026-09-12T11:50]
// Lit les journaux (lignes « sondage : … ») et l'état pour croiser avec les MX et les témoins.

import { readFileSync } from 'node:fs';
import { resolveMx } from 'node:dns/promises';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const DEPUIS = opt('--depuis', '2026-09-12T11:50');
const logs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--depuis');
const st = JSON.parse(readFileSync('/home/ubuntu/enrich/smoke-uk/etat-v3.json', 'utf8'));

// Domaines sondés pendant la campagne (d'après l'état, pour avoir le domaine exact)
const sondes = Object.entries(st.domains).filter(([, x]) => (x.probed || []).length && x.probedAt && x.probedAt >= DEPUIS);

const GATEWAY = /mimecast|proofpoint|pphosted|barracuda|messagelabs|symantec|trendmicro|forcepoint|sophos|egress|fortinet|retarus|hornetsecurity/;
const typeMx = async (d) => {
  try { const mx = (await resolveMx(d)).map((m) => m.exchange.toLowerCase()).join(' ');
    return !mx ? 'sans MX' : GATEWAY.test(mx) ? 'passerelle' : /protection\.outlook\.com/.test(mx) ? 'Microsoft 365' : /google|googlemail/.test(mx) ? 'Google' : 'autre';
  } catch { return 'sans MX'; }
};
const issue = (x) => {
  const p = x.probed[0] || '';
  if (/contrôle:(valid|catch_all)/.test(x.probed.join(' '))) return 'catch-all masqué';
  if (/:valid$/.test(p)) return 'valide';
  if (/:invalid$/.test(p)) return 'refusé';
  if (/:catch_all$/.test(p)) return 'catch-all';
  return 'muet';
};

const par = (cle) => {
  const t = {};
  for (const [d, x] of sondes) { const k = cle(d, x); const r = issue(x); (t[k] ??= { total: 0 }); t[k].total++; t[k][r] = (t[k][r] || 0) + 1; }
  return t;
};
const table = (titre, t) => {
  console.log('\n' + titre);
  console.log('  ' + 'groupe'.padEnd(20) + 'sondés  valides  refusés  catch-all  muets  rendement  crédits/adresse');
  for (const [k, c] of Object.entries(t).sort((a, b) => b[1].total - a[1].total)) {
    const v = c.valide || 0;
    const credits = c.total + v; // 1 sondage + 1 contrôle quand il réussit
    console.log('  ' + k.padEnd(20) + String(c.total).padStart(5) + String(v).padStart(8) + String(c['refusé'] || 0).padStart(9)
      + String((c['catch-all'] || 0) + (c['catch-all masqué'] || 0)).padStart(10) + String(c.muet || 0).padStart(8)
      + (Math.round(100 * v / c.total) + ' %').padStart(10) + (v ? (credits / v).toFixed(1) : '—').padStart(16));
  }
};

const mxDe = new Map();
await Promise.all(sondes.map(async ([d]) => mxDe.set(d, await typeMx(d))));

console.log(`campagne : ${sondes.length} domaines sondés depuis ${DEPUIS}`);
let crédits = 0, contrôles = 0, masqués = 0;
for (const [, x] of sondes) { crédits += x.probed.filter((p) => !p.startsWith('contrôle')).length; const c = x.probed.filter((p) => p.startsWith('contrôle')).length; contrôles += c; crédits += c; if (/contrôle:(valid|catch_all)/.test(x.probed.join(' '))) masqués++; }
console.log(`crédits consommés : ${crédits} (dont ${contrôles} adresses de contrôle) · catch-all masqués démasqués : ${masqués}`);

table('Par type de serveur de messagerie', par((d) => mxDe.get(d)));
table('Par situation de départ', par((d, x) => (x.witnesses || []).length ? 'adresses génériques vues' : 'aucun témoin'));

const ok = sondes.filter(([, x]) => issue(x) === 'valide');
console.log(`\nformats adoptés : ${ok.length} → ${ok.map(([d]) => d).sort().join(' · ')}`);
for (const l of logs) { const n = (readFileSync(l, 'utf8').match(/sondage :/g) || []).length; console.log(`journal ${l} : ${n} sondages`); }

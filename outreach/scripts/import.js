// Import CSV en ligne de commande : node scripts/import.js fichier1.csv [fichier2.csv ...]
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertProspects } from '../db.js';
import { parseCsv, mapRow } from '../csv.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const db = openDb(resolve(ROOT, process.env.DB_PATH || './data/outreach.sqlite'));
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/import.js fichier.csv [...]');
  process.exit(1);
}
for (const f of files) {
  const rows = parseCsv(readFileSync(f, 'utf8')).map(mapRow).filter(Boolean);
  const r = upsertProspects(db, rows, basename(f));
  console.log(`${basename(f)} : ${rows.length} lignes → ${r.created} créés, ${r.updated} mis à jour`);
}

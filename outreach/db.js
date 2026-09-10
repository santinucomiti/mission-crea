import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS prospects (
      id TEXT PRIMARY KEY,
      prenom TEXT, nom TEXT, nom_complet TEXT,
      degre TEXT, premium INTEGER DEFAULT 0,
      titre TEXT, entreprise TEXT, entreprise_url TEXT, localisation TEXT,
      anciennete_poste TEXT, anciennete_entreprise TEXT,
      relations_communes INTEGER DEFAULT 0, groupes_partages INTEGER DEFAULT 0, posts_recents INTEGER DEFAULT 0,
      derniere_activite TEXT, enregistre_sn INTEGER DEFAULT 0, listes_sn TEXT,
      a_propos TEXT, profil_url TEXT, linkedin_url TEXT, photo_url TEXT,
      contact_par TEXT,
      contacte INTEGER NOT NULL DEFAULT 0, contacte_le TEXT, contacte_par TEXT,
      notes TEXT DEFAULT '', relance_le TEXT,
      source_file TEXT, imported_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prospects_contacte ON prospects(contacte);
    CREATE INDEX IF NOT EXISTS prospects_contact ON prospects(contact_par);
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL, corps TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS people (
      name TEXT PRIMARY KEY, color TEXT NOT NULL, position INTEGER NOT NULL
    );
  `);
  seed(db);
  return db;
}

function seed(db) {
  if (!db.prepare('SELECT COUNT(*) AS n FROM people').get().n) {
    const ins = db.prepare('INSERT INTO people(name, color, position) VALUES (?, ?, ?)');
    ins.run('Santinu', '#1F5FBF', 1);
    ins.run('Eva', '#B7791F', 2);
    ins.run('Rémi', '#0F766E', 3);
  }
  if (!db.prepare('SELECT COUNT(*) AS n FROM templates').get().n) {
    db.prepare('INSERT INTO templates(nom, corps, updated_at) VALUES (?, ?, ?)').run(
      'Invitation — étude pentests',
      'Bonjour [Prénom], avec deux étudiants de X-HEC Entrepreneurs, nous analysons les opportunités sur le marché des pentests. Auriez-vous 20 minutes pour partager votre regard sur le secteur ?',
      new Date().toISOString()
    );
  }
}

const PROSPECT_FIELDS = [
  'prenom', 'nom', 'nom_complet', 'degre', 'premium', 'titre', 'entreprise', 'entreprise_url',
  'localisation', 'anciennete_poste', 'anciennete_entreprise', 'relations_communes',
  'groupes_partages', 'posts_recents', 'derniere_activite', 'enregistre_sn', 'listes_sn',
  'a_propos', 'profil_url', 'photo_url',
];

// Insère ou met à jour les champs issus du CSV ; ne touche jamais au suivi
// (contacté, notes, relance, attribution déjà renseignée).
export function upsertProspects(db, rows, sourceFile) {
  const now = new Date().toISOString();
  const cols = [...PROSPECT_FIELDS, 'contact_par'];
  const insert = db.prepare(`
    INSERT INTO prospects (id, ${cols.join(', ')}, source_file, imported_at, updated_at)
    VALUES (@id, ${cols.map((c) => '@' + c).join(', ')}, @source_file, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      ${PROSPECT_FIELDS.map((c) => `${c} = excluded.${c}`).join(', ')},
      contact_par = COALESCE(prospects.contact_par, excluded.contact_par),
      updated_at = excluded.updated_at
  `);
  const exists = db.prepare('SELECT 1 FROM prospects WHERE id = ?');
  let created = 0;
  let updated = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (exists.get(r.id)) updated++; else created++;
      insert.run({ ...r, source_file: sourceFile, now });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { created, updated };
}

export const EDITABLE = ['contact_par', 'contacte', 'notes', 'relance_le', 'linkedin_url'];

export function updateProspect(db, id, patch, who) {
  const current = db.prepare('SELECT * FROM prospects WHERE id = ?').get(id);
  if (!current) return null;
  const now = new Date().toISOString();
  const sets = [];
  const params = { id, now };
  for (const field of EDITABLE) {
    if (!(field in patch)) continue;
    let value = patch[field];
    if (field === 'contacte') {
      value = value ? 1 : 0;
      if (value !== current.contacte) {
        sets.push('contacte_le = @contacte_le', 'contacte_par = @contacte_par');
        params.contacte_le = value ? now : null;
        params.contacte_par = value ? who : null;
      }
    }
    if (value === '') value = null;
    if ((current[field] ?? null) === (value ?? null)) continue;
    sets.push(`${field} = @${field}`);
    params[field] = value;
  }
  if (sets.length) {
    db.prepare(`UPDATE prospects SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
  }
  return db.prepare('SELECT * FROM prospects WHERE id = ?').get(id);
}

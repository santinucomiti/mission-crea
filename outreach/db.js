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
      nom_norm TEXT,
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
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL,
      uploaded_by TEXT, uploaded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_prospect ON files(prospect_id, uploaded_at);
  `);
  migrate(db);
  seed(db);
  return db;
}

// Nom normalisé pour rapprocher « Jean-Pierre DUPONT », « Dupont Jean Pierre », « jean pierre dupont ».
export function normName(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean).sort().join(' ');
}

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(prospects)').all().map((c) => c.name);
  if (!cols.includes('nom_norm')) db.exec('ALTER TABLE prospects ADD COLUMN nom_norm TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS prospects_nom_norm ON prospects(nom_norm)');
  const missing = db.prepare('SELECT id, nom_complet FROM prospects WHERE nom_norm IS NULL').all();
  const upd = db.prepare('UPDATE prospects SET nom_norm = ? WHERE id = ?');
  for (const r of missing) upd.run(normName(r.nom_complet), r.id);
}

const isLeadId = (id) => /^ACwAA/.test(id);

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

// Insère ou met à jour les champs issus du CSV / de l'extension ; ne touche jamais au suivi
// (contacté, notes, relance, attribution déjà renseignée). Une fiche créée à partir d'un simple
// nom (import de liste) est fusionnée dans la fiche Sales Navigator dès qu'elle est croisée.
export function upsertProspects(db, rows, sourceFile) {
  const now = new Date().toISOString();
  const cols = [...PROSPECT_FIELDS, 'contact_par', 'nom_norm'];
  const insert = db.prepare(`
    INSERT INTO prospects (id, ${cols.join(', ')}, source_file, imported_at, updated_at)
    VALUES (@id, ${cols.map((c) => '@' + c).join(', ')}, @source_file, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      ${PROSPECT_FIELDS.map((c) => `${c} = excluded.${c}`).join(', ')},
      nom_norm = excluded.nom_norm,
      contact_par = COALESCE(prospects.contact_par, excluded.contact_par),
      updated_at = excluded.updated_at
  `);
  const exists = db.prepare('SELECT 1 FROM prospects WHERE id = ?');
  const placeholder = db.prepare("SELECT * FROM prospects WHERE nom_norm = ? AND id NOT LIKE 'ACwAA%' LIMIT 1");
  const carry = db.prepare(`UPDATE prospects SET contacte = @contacte, contacte_le = @contacte_le, contacte_par = @contacte_par,
    notes = @notes, relance_le = @relance_le, contact_par = COALESCE(contact_par, @contact_par), linkedin_url = COALESCE(linkedin_url, @linkedin_url)
    WHERE id = @id`);
  const moveFiles = db.prepare('UPDATE files SET prospect_id = ? WHERE prospect_id = ?');
  const del = db.prepare('DELETE FROM prospects WHERE id = ?');
  let created = 0;
  let updated = 0;
  let merged = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const row = { ...r, nom_norm: normName(r.nom_complet), source_file: sourceFile, now };
      if (exists.get(r.id)) { updated++; insert.run(row); continue; }
      const ph = isLeadId(r.id) ? placeholder.get(row.nom_norm) : null;
      insert.run(row);
      if (ph) {
        carry.run({ id: r.id, contacte: ph.contacte, contacte_le: ph.contacte_le, contacte_par: ph.contacte_par, notes: ph.notes || '', relance_le: ph.relance_le, contact_par: ph.contact_par, linkedin_url: ph.linkedin_url });
        moveFiles.run(r.id, ph.id);
        del.run(ph.id);
        merged++;
      } else created++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { created, updated, merged };
}

// Liste de noms (un par ligne) → marque contacté ; crée une fiche minimale si inconnu.
export function markContactedByNames(db, names, who) {
  const now = new Date().toISOString();
  const byNorm = db.prepare('SELECT id, contacte FROM prospects WHERE nom_norm = ?');
  const mark = db.prepare('UPDATE prospects SET contacte = 1, contacte_le = COALESCE(contacte_le, ?), contacte_par = COALESCE(contacte_par, ?), updated_at = ? WHERE id = ?');
  const create = db.prepare(`INSERT INTO prospects (id, prenom, nom, nom_complet, nom_norm, contacte, contacte_le, contacte_par, source_file, imported_at, updated_at)
    VALUES (@id, @prenom, @nom, @nom_complet, @nom_norm, 1, @now, @who, 'liste', @now, @now)`);
  const result = { matched: 0, alreadyContacted: 0, created: 0, ignored: [] };
  db.exec('BEGIN');
  try {
    for (const raw of names) {
      const full = raw.replace(/\s+/g, ' ').trim();
      const norm = normName(full);
      if (norm.split(' ').length < 2) { if (full) result.ignored.push(full); continue; }
      const rows = byNorm.all(norm);
      if (rows.length) {
        for (const r of rows) { if (r.contacte) result.alreadyContacted++; else { result.matched++; mark.run(now, who, now, r.id); } }
        continue;
      }
      const parts = full.split(' ');
      create.run({ id: 'n-' + norm.replace(/ /g, '-').slice(0, 80), prenom: parts[0], nom: parts.slice(1).join(' '), nom_complet: full, nom_norm: norm, now, who });
      result.created++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
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

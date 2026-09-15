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
    CREATE TABLE IF NOT EXISTS entreprises (
      entreprise_url TEXT PRIMARY KEY, nom TEXT, site TEXT, domaine TEXT, maj TEXT
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL,
      uploaded_by TEXT, uploaded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_prospect ON files(prospect_id, uploaded_at);
    CREATE TABLE IF NOT EXISTS notion_ignore (
      page_id TEXT PRIMARY KEY, motif TEXT, ajoute_le TEXT
    );
    CREATE TABLE IF NOT EXISTS transcripts (
      file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      text TEXT NOT NULL, segments TEXT NOT NULL, model TEXT, language TEXT, created_at TEXT NOT NULL
    );
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
  if (!cols.includes('zone')) db.exec('ALTER TABLE prospects ADD COLUMN zone TEXT');
  if (!cols.includes('notion_page_id')) {
    db.exec('ALTER TABLE prospects ADD COLUMN notion_page_id TEXT');
    db.exec('ALTER TABLE prospects ADD COLUMN notion_sync_at TEXT');
  }
  if (!cols.includes('contexte_linkedin')) {
    db.exec('ALTER TABLE prospects ADD COLUMN contexte_linkedin TEXT');
    db.exec('ALTER TABLE prospects ADD COLUMN contexte_maj TEXT');
  }
  // Emails trouvés par le skill enrichissement-email (confiance A-D, statut, pattern, source, vérification).
  if (!cols.includes('email')) {
    for (const c of ['email', 'email_confiance', 'email_statut', 'email_pattern', 'email_source', 'email_verifie', 'email_catch_all', 'email_note', 'email_maj']) db.exec(`ALTER TABLE prospects ADD COLUMN ${c} TEXT`);
  }
  if (!cols.includes('interviewe')) {
    db.exec('ALTER TABLE prospects ADD COLUMN interviewe INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE prospects ADD COLUMN interviewe_le TEXT');
  }
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

// Retrouve la fiche correspondant à un profil linkedin.com/in/… : URL déjà connue, puis identifiant
// membre (les 9 caractères après le préfixe sont communs aux ids Sales Navigator « ACwAA… » et
// membre « ACoAA… »), puis nom complet s'il est unique.
// Slug d'un lien de profil : « https://fr.linkedin.com/in/Jean-Dupont-123/?x=1 » → « jean-dupont-123 ».
export const profileSlug = (u) => { const m = String(u || '').match(/linkedin\.com\/in\/([^/?#]+)/i); return m ? decodeURIComponent(m[1]).toLowerCase() : null; };

// Fusionne la fiche `drop` dans `keep` : suivi (contacté, interviewé, notes, relance, Notion), fichiers, puis suppression.
export function mergeProspects(db, keep, drop) {
  const notes = [keep.notes, drop.notes].map((n) => (n || '').trim()).filter(Boolean);
  const merged = {
    id: keep.id,
    contacte: keep.contacte || drop.contacte ? 1 : 0,
    contacte_le: [keep.contacte_le, drop.contacte_le].filter(Boolean).sort()[0] || null,
    contacte_par: keep.contacte_par || drop.contacte_par || null,
    interviewe: keep.interviewe || drop.interviewe ? 1 : 0,
    interviewe_le: [keep.interviewe_le, drop.interviewe_le].filter(Boolean).sort()[0] || null,
    notes: notes.length === 2 && notes[0] !== notes[1] ? notes.join('\n\n') : notes[0] || '',
    relance_le: keep.relance_le || drop.relance_le || null,
    linkedin_url: keep.linkedin_url || drop.linkedin_url || null,
    zone: keep.zone || drop.zone || null,
    notion_page_id: keep.notion_page_id || drop.notion_page_id || null,
    notion_sync_at: keep.notion_sync_at || drop.notion_sync_at || null,
    titre: keep.titre || drop.titre || '',
    localisation: keep.localisation || drop.localisation || '',
    photo_url: keep.photo_url || drop.photo_url || null,
    contexte_linkedin: keep.contexte_linkedin || drop.contexte_linkedin || null,
    contexte_maj: keep.contexte_maj || drop.contexte_maj || null,
    now: new Date().toISOString(),
  };
  // « Pierre B. » (Sales Navigator) + « Pierre Belin » (Notion) : on garde le nom complet.
  const fullName = isTruncatedName(keep.nom) && drop.nom && !isTruncatedName(drop.nom) ? drop : null;
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE prospects SET contacte = @contacte, contacte_le = @contacte_le, contacte_par = @contacte_par, interviewe = @interviewe, interviewe_le = @interviewe_le,
      notes = @notes, relance_le = @relance_le, linkedin_url = @linkedin_url, zone = @zone, notion_page_id = @notion_page_id, notion_sync_at = @notion_sync_at,
      titre = @titre, localisation = @localisation, photo_url = @photo_url, contexte_linkedin = @contexte_linkedin, contexte_maj = @contexte_maj, updated_at = @now WHERE id = @id`).run(merged);
    if (fullName) db.prepare('UPDATE prospects SET prenom = ?, nom = ?, nom_complet = ?, nom_norm = ? WHERE id = ?').run(fullName.prenom || keep.prenom, fullName.nom, fullName.nom_complet, normName(fullName.nom_complet), keep.id);
    db.prepare('UPDATE files SET prospect_id = ? WHERE prospect_id = ?').run(keep.id, drop.id);
    db.prepare('DELETE FROM prospects WHERE id = ?').run(drop.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return db.prepare('SELECT * FROM prospects WHERE id = ?').get(keep.id);
}

// Retrouve la fiche d'un profil linkedin.com/in/… : lien LinkedIn de la fiche (optionnel, comparé sur le slug),
// puis identifiant membre commun avec Sales Navigator, puis nom complet s'il est unique.
// Si plusieurs fiches désignent la même personne (ex. fiche Notion « Pierre Belin » + fiche SN « Pierre B. »),
// elles sont fusionnées dans la fiche Sales Navigator.
export function findByProfile(db, { url, memberId, nomComplet }) {
  const found = [];
  const add = (rows) => { for (const r of rows) if (!found.some((f) => f.id === r.id)) found.push(r); };
  const slug = profileSlug(url);
  if (slug) add(db.prepare("SELECT * FROM prospects WHERE linkedin_url LIKE '%/in/%'").all().filter((r) => profileSlug(r.linkedin_url) === slug));
  if (memberId && /^ACoAA/.test(memberId)) {
    const rows = db.prepare("SELECT * FROM prospects WHERE id LIKE 'ACwAA%' AND substr(id, 4, 9) = ?").all(memberId.slice(3, 12));
    if (rows.length === 1) add(rows);
  }
  if (nomComplet) {
    const rows = db.prepare('SELECT * FROM prospects WHERE nom_norm = ?').all(normName(nomComplet));
    if (rows.length === 1) add(rows);
  }
  if (!found.length) return null;
  let keep = found.find((r) => isLeadId(r.id)) || found[0];
  for (const other of found) if (other.id !== keep.id) keep = mergeProspects(db, keep, other);
  return keep;
}

export const EDITABLE = ['contacte', 'interviewe', 'notes', 'relance_le', 'linkedin_url', 'zone', 'email'];

// Zone déduite de la localisation Sales Navigator ; `zone` en base est une surcharge manuelle (FR / INT).
const FR_PLACES = /\bFrance\b|Île-de-France|Ile-de-France|\bParis\b|\bLyon\b|\bMarseille\b|\bBordeaux\b|\bLille\b|\bToulouse\b|\bNantes\b|\bStrasbourg\b|\bRennes\b|\bNice\b|\bMontpellier\b|\bGrenoble\b|\bRouen\b|\bReims\b|\bDijon\b|\bTours\b|\bOrléans\b|\bNancy\b|\bMetz\b|\bAngers\b|\bCaen\b|\bBrest\b|\bLe Havre\b|\bToulon\b|\bNîmes\b|\bClermont-Ferrand\b|\bLimoges\b|\bPerpignan\b|\bAix-en-Provence\b|\bAnnecy\b|\bSophia Antipolis\b|Auvergne-Rhône-Alpes|Occitanie|Bretagne|Normandie|Provence-Alpes|Nouvelle-Aquitaine|Hauts-de-France|Grand Est|Pays de la Loire|Bourgogne-Franche-Comté|Centre-Val de Loire|\bCorse\b|Guadeloupe|Martinique|La Réunion|\bRéunion\b|Guyane|Mayotte|Nouvelle-Calédonie|Polynésie/i;
// Pays déduit de la localisation Sales Navigator (noms français ou anglais, grandes villes connues).
const COUNTRIES = [
  ['France', /\bFrance\b/],
  ['Belgique', /Belgique|Belgium|Bruxelles|Brussels|Anvers|Antwerp|Liège|Gand|Ghent/],
  ['Suisse', /Suisse|Switzerland|Schweiz|Genève|Geneva|Lausanne|Zurich|Zürich|Bâle|Basel|Berne|\bBern\b/],
  ['Luxembourg', /Luxembourg/],
  ['Royaume-Uni', /Royaume-Uni|United Kingdom|\bUK\b|England|Angleterre|Scotland|Écosse|Wales|Londres|London|Manchester|Birmingham|Edinburgh|Édimbourg|Belfast|Northern Ireland|Irlande du Nord/],
  ['Allemagne', /Allemagne|Germany|Deutschland|Berlin|Munich|München|Francfort|Frankfurt|Hambourg|Hamburg|Cologne|Köln|Stuttgart|Düsseldorf/],
  ['Italie', /Italie|Italy|Italia|Milan|Milano|\bRome\b|\bRoma\b|Turin|Torino|Naples|Napoli|Bologne|Bologna/],
  ['Espagne', /Espagne|Spain|España|Madrid|Barcelone|Barcelona|Valence|Valencia|Séville|Sevilla|Bilbao/],
  ['Pays-Bas', /Pays-Bas|Netherlands|Nederland|Amsterdam|Rotterdam|La Haye|The Hague|Utrecht|Eindhoven/],
  ['Portugal', /Portugal|Lisbonne|Lisbon|Lisboa|Porto/],
  ['Irlande', /Irlande|Ireland|Dublin/],
  ['Autriche', /Autriche|Austria|Vienne|Vienna|\bWien\b/],
  ['Pologne', /Pologne|Poland|Varsovie|Warsaw|Cracovie|Kraków/],
  ['Suède', /Suède|Sweden|Stockholm|Göteborg/],
  ['Danemark', /Danemark|Denmark|Copenhague|Copenhagen/],
  ['Norvège', /Norvège|Norway|\bOslo\b/],
  ['Finlande', /Finlande|Finland|Helsinki/],
  ['Grèce', /Grèce|Greece|Athènes|Athens/],
  ['Roumanie', /Roumanie|Romania|Bucarest|Bucharest/],
  ['Tchéquie', /Tchéquie|Czech|Prague|Praha/],
  ['Hongrie', /Hongrie|Hungary|Budapest/],
  ['Turquie', /Turquie|Turkey|Türkiye|Istanbul|Ankara/],
  ['Israël', /Israël|Israel|Tel Aviv/],
  ['Émirats arabes unis', /Émirats|Emirates|Dubaï|Dubai|Abu Dhabi/],
  ['Singapour', /Singapour|Singapore/],
  ['Australie', /Australie|Australia|Sydney|Melbourne/],
  ['Inde', /\bInde\b|\bIndia\b|Bangalore|Bengaluru|Mumbai|Delhi/],
  ['Chine', /\bChine\b|\bChina\b|Shanghai|Beijing|Pékin|Hong Kong/],
  ['Japon', /Japon|Japan|Tokyo/],
  ['Brésil', /Brésil|Brazil|Brasil|São Paulo|Sao Paulo/],
  ['Mexique', /Mexique|Mexico/],
  ['Canada', /Canada|Québec|Quebec|Montréal|Montreal|Toronto|Vancouver|Ottawa/],
  ['États-Unis', /États-Unis|United States|\bUSA\b|\bU\.S\.|New York|San Francisco|Boston|Chicago|Los Angeles|Seattle|Austin|Washington|California|Texas|Bellingham/],
  ['Maroc', /Maroc|Morocco|Casablanca|Rabat|Marrakech/],
  ['Tunisie', /Tunisie|Tunisia|Tunis/],
  ['Algérie', /Algérie|Algeria|Alger/],
  ['Sénégal', /Sénégal|Senegal|Dakar/],
  ['Côte d’Ivoire', /Côte d.Ivoire|Ivory Coast|Abidjan/],
  ['Monaco', /Monaco/],
];
export function countryOf(loc) {
  loc = (loc || '').trim();
  if (!loc) return '';
  for (const [name, re] of COUNTRIES) if (re.test(loc)) return name;
  if (FR_PLACES.test(loc) || /et périphérie$/i.test(loc)) return 'France';
  // Dernier segment « Ville, Région, Pays » sinon.
  const parts = loc.split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : 'Autre';
}
export function zoneOf(p) {
  if (p.zone === 'FR' || p.zone === 'INT') return p.zone;
  const c = countryOf(p.localisation);
  return c ? (c === 'France' ? 'FR' : 'INT') : '';
}
export function paysOf(p) {
  const c = countryOf(p.localisation);
  if (p.zone === 'FR') return 'France';
  if (p.zone === 'INT') return c && c !== 'France' ? c : 'International';
  return c;
}
export const withZone = (p) => ({ ...p, zone_calc: zoneOf(p), pays_calc: paysOf(p) });

export const domainOfSite = (site) => (site || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
// Site web relevé sur la page compte Sales Navigator → domaine de l'entreprise, partagé par tous ses prospects.
export function upsertCompany(db, { entrepriseUrl, nom, site }) {
  const domaine = domainOfSite(site);
  db.prepare(`INSERT INTO entreprises(entreprise_url, nom, site, domaine, maj) VALUES (@u, @nom, @site, @domaine, @maj)
    ON CONFLICT(entreprise_url) DO UPDATE SET nom = COALESCE(NULLIF(excluded.nom, ''), entreprises.nom), site = excluded.site, domaine = excluded.domaine, maj = excluded.maj`)
    .run({ u: entrepriseUrl, nom: nom || '', site: site || '', domaine, maj: new Date().toISOString() });
  return domaine;
}
// Nom complet retrouvé (slug LinkedIn, page profil) pour une fiche dont Sales Navigator masquait le nom (« Mark K. »).
export const isTruncatedName = (nom) => /^[A-Za-zÀ-ÿ]\.?$/.test((nom || '').trim());
const CREDENTIALS = /\b(mba|msc|bsc|ma|phd|dr|cissp|cism|cisa|crisc|ccsp|cipp|cipm|ceh|oscp|cgeit|pmp|fbcs|mbcs|fsyi|msyi|afciis|fcips|ccie|cipd|cbe|obe|mbe|frsa)\b/gi;
export function fixName(db, id, nomComplet) {
  const row = db.prepare('SELECT prenom, nom FROM prospects WHERE id = ?').get(id);
  if (!row || !isTruncatedName(row.nom)) return false;
  const parts = (nomComplet || '').replace(CREDENTIALS, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const nom = parts.slice(1).join(' ');
  if (isTruncatedName(nom) || nom[0].toLowerCase() !== (row.nom || '')[0].toLowerCase()) return false;
  db.prepare('UPDATE prospects SET prenom = ?, nom = ?, nom_complet = ?, nom_norm = ?, updated_at = ? WHERE id = ?')
    .run(parts[0], nom, parts.join(' '), normName(parts.join(' ')), new Date().toISOString(), id);
  return true;
}

export function updateProspect(db, id, patch, who) {
  const current = db.prepare('SELECT * FROM prospects WHERE id = ?').get(id);
  if (!current) return null;
  const now = new Date().toISOString();
  const sets = [];
  const params = { id, now };
  // Un entretien réalisé implique un contact : on coche « contacté » en même temps.
  if (patch.interviewe && !current.contacte) patch = { ...patch, contacte: true };
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
    if (field === 'zone') value = value === 'FR' || value === 'INT' ? value : null;
    if (field === 'interviewe') {
      value = value ? 1 : 0;
      if (value !== current.interviewe) { sets.push('interviewe_le = @interviewe_le'); params.interviewe_le = value ? now : null; }
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

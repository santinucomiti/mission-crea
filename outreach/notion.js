// Synchronisation avec la base Notion « Liste de contacts » — uniquement les entretiens réalisés,
// dans les deux sens. Le CRM est la source pour le pipeline (statuts, dates, contexte, audio) ;
// Notion pour les notes écrites là-bas. Les notes sont concaténées, jamais supprimées.
//
// Env : NOTION_TOKEN (intégration interne), NOTION_DB_ID (base « Liste de contacts »), NOTION_CRM_URL (URL publique du CRM).

import { normName, updateProspect } from './db.js';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CRM_MARK = '🔁 Synchronisé depuis le CRM';
const NOTES_MARK = '📝 Notes CRM';
const PEOPLE_MATCH = { Santinu: /santinu/i, Eva: /eva/i, 'Rémi': /r[ée]mi/i };

// NOTION_SYNC=off coupe la synchro (cycle automatique et bouton) sans retirer le jeton.
export function notionEnabled(env = process.env) {
  return !!(env.NOTION_TOKEN && env.NOTION_DB_ID) && String(env.NOTION_SYNC || 'on').toLowerCase() !== 'off';
}

function client(token) {
  let last = 0;
  return async (method, path, body) => {
    const wait = 350 - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetch(API + path, {
      method, headers: { authorization: 'Bearer ' + token, 'notion-version': VERSION, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Notion ${r.status} ${j.code || ''}: ${j.message || ''}`);
    return j;
  };
}

const text = (rt) => (rt || []).map((t) => t.plain_text).join('');
const rich = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, 2000) } }];
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
// Paragraphes normalisés pour comparer des notes venant des deux côtés.
const paras = (s) => (s || '').split(/\n{2,}|\r?\n/).map((x) => x.trim()).filter(Boolean);
// Clé de comparaison d'un paragraphe : sans le tampon « [Notion · date] », sans casse ni espaces multiples.
// (Sans ce retrait, chaque cycle ré-ajoutait toutes les notes Notion : 15 000 blocs sur une fiche.)
const unstamp = (s) => s.replace(/^\[Notion[^\]]*\]\s*/, '');
const key = (s) => unstamp(s).toLowerCase().replace(/\s+/g, ' ').trim();

function readRow(page) {
  const p = page.properties;
  return {
    pageId: page.id,
    nom: text(p['Nom contact']?.title),
    entreprise: text(p['Nom entreprise']?.rich_text),
    role: text(p['Rôle']?.rich_text),
    contacte: p['Contacté']?.status?.name || '',
    entretien: p['Entretien réalisé']?.select?.name || '',
    email: p['Email']?.email || '',
    remarques: text(p['Remarques']?.rich_text),
    dateContact: p['Date de contact']?.date?.start || null,
    dateRelance: p['Date de relance']?.date?.start || null,
    demarcheurs: (p['Démarcheur']?.people || []).map((u) => u.name || ''),
    source: p['Source']?.select?.name || '',
    edited: page.last_edited_time,
  };
}

// Blocs de la page : ceux hors du bloc « 🔁 Synchronisé depuis le CRM » sont des notes écrites dans Notion.
async function readPageBlocks(api, pageId) {
  const blocks = [];
  let cursor;
  do {
    const r = await api('GET', `/blocks/${pageId}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`);
    blocks.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  const crmBlock = blocks.find((b) => b.type === 'toggle' && text(b.toggle.rich_text).startsWith(CRM_MARK));
  const notesBlock = blocks.find((b) => b.type === 'toggle' && text(b.toggle.rich_text).startsWith(NOTES_MARK));
  const notionNotes = blocks
    .filter((b) => b !== crmBlock && b !== notesBlock && b[b.type]?.rich_text)
    .map((b) => text(b[b.type].rich_text).trim()).filter(Boolean);
  let crmNotesInNotion = [];
  if (notesBlock?.has_children) {
    const r = await api('GET', `/blocks/${notesBlock.id}/children?page_size=100`);
    crmNotesInNotion = r.results.filter((b) => b[b.type]?.rich_text).map((b) => text(b[b.type].rich_text).trim()).filter(Boolean);
  }
  return { crmBlock, notesBlock, notionNotes, crmNotesInNotion };
}

function crmContextChildren(p, crmUrl, files) {
  const children = [];
  const links = [`Fiche CRM : ${crmUrl}/#p=${encodeURIComponent(p.id)}`];
  if (p.linkedin_url) links.push(`LinkedIn : ${p.linkedin_url}`);
  if (p.profil_url) links.push(`Sales Navigator : ${p.profil_url}`);
  for (const f of files) links.push(`Audio « ${f.filename} » : ${crmUrl}/api/files/${f.id}`);
  for (const l of links) children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(l) } });
  const meta = [p.titre && `Poste : ${p.titre}`, p.entreprise && `Entreprise : ${p.entreprise}`, p.localisation && `Localisation : ${p.localisation}`,
    p.contacte_le && `Contacté le ${day(p.contacte_le)}${p.contacte_par ? ' par ' + p.contacte_par : ''}`, p.interviewe_le && `Entretien le ${day(p.interviewe_le)}`].filter(Boolean);
  if (meta.length) children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(meta.join(' · ')) } });
  if (p.a_propos) children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich('À propos : ' + p.a_propos) } });
  if (p.contexte_linkedin) {
    const chunks = p.contexte_linkedin.split(/\n{2,}/).map((c) => c.trim()).filter(Boolean).slice(0, 30);
    children.push({ object: 'block', type: 'toggle', toggle: { rich_text: rich('Profil LinkedIn (aspiré le ' + day(p.contexte_maj) + ')'), children: chunks.map((c) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(c) } })) } });
  }
  return children.slice(0, 100);
}

// Un cycle complet. Retourne un compte rendu. `log` reçoit les lignes du journal.
export async function syncNotion(db, { token, dbId, crmUrl, who = 'sync', log = () => {} } = {}) {
  const api = client(token);
  const report = { notionRows: 0, matched: 0, createdInCrm: 0, createdInNotion: 0, updatedNotion: 0, notesToCrm: 0, notesToNotion: 0, errors: [] };
  const users = (await api('GET', '/users?page_size=100')).results.filter((u) => u.type === 'person');
  const userFor = (name) => users.find((u) => PEOPLE_MATCH[name]?.test(u.name || ''))?.id || null;

  // 1. Lignes Notion avec entretien réalisé.
  const rows = [];
  let cursor;
  do {
    const r = await api('POST', `/databases/${dbId}/query`, { page_size: 100, start_cursor: cursor, filter: { property: 'Entretien réalisé', select: { equals: 'Oui' } } });
    rows.push(...r.results.map(readRow));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  // Pages Notion à ignorer (lignes qui ne sont pas des personnes, ex. « Antoine Fleuret AI ») :
  // INSERT INTO notion_ignore(page_id, motif, ajoute_le) VALUES ('<id de page>', '…', datetime('now')).
  const ignored = new Set(db.prepare('SELECT page_id FROM notion_ignore').all().map((r) => r.page_id));
  const kept = rows.filter((r) => !ignored.has(r.pageId));
  report.notionRows = kept.length;

  const byPage = db.prepare('SELECT * FROM prospects WHERE notion_page_id = ?');
  const byNorm = db.prepare('SELECT * FROM prospects WHERE nom_norm = ? ORDER BY interviewe DESC, contacte DESC LIMIT 2');
  const setPage = db.prepare('UPDATE prospects SET notion_page_id = ?, notion_sync_at = ? WHERE id = ?');
  const now = new Date().toISOString();

  // 2. Notion → CRM : rapprocher, créer si absent, statuts « le plus avancé gagne », notes.
  const blocksByPage = new Map();
  for (const row of kept) {
    try {
      if (!row.nom.trim()) continue;
      let p = byPage.get(row.pageId) || byNorm.all(normName(row.nom))[0] || null;
      if (!p) {
        const [prenom, ...rest] = row.nom.trim().split(/\s+/);
        const id = 'notion-' + row.pageId.replace(/-/g, '').slice(0, 16);
        db.prepare(`INSERT OR IGNORE INTO prospects (id, prenom, nom, nom_complet, nom_norm, titre, entreprise, contacte, contacte_le, interviewe, interviewe_le, relance_le, notes, source_file, imported_at, updated_at)
          VALUES (@id, @prenom, @nom, @nomComplet, @norm, @titre, @entreprise, 1, @contacte_le, 1, @interviewe_le, @relance, '', 'notion', @now, @now)`)
          .run({ id, prenom, nom: rest.join(' '), nomComplet: row.nom.trim(), norm: normName(row.nom), titre: row.role, entreprise: row.entreprise, contacte_le: row.dateContact ? row.dateContact + 'T12:00:00.000Z' : now, interviewe_le: row.dateContact ? row.dateContact + 'T12:00:00.000Z' : now, relance: row.dateRelance, now });
        p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(id);
        report.createdInCrm++;
        log(`+ CRM ← Notion : ${row.nom}`);
      } else {
        report.matched++;
        if (!p.interviewe) { updateProspect(db, p.id, { interviewe: true }, who); log(`interviewé ← Notion : ${p.nom_complet}`); }
        if (!p.relance_le && row.dateRelance) updateProspect(db, p.id, { relance_le: row.dateRelance }, who);
      }
      setPage.run(row.pageId, now, p.id);
      // Notes Notion (Remarques + corps de page hors blocs CRM) → notes CRM, paragraphes manquants seulement.
      const blocks = await readPageBlocks(api, row.pageId);
      const fromNotion = [...paras(row.remarques), ...blocks.notionNotes];
      const current = db.prepare('SELECT notes FROM prospects WHERE id = ?').get(p.id).notes || '';
      const have = new Set(paras(current).map(key));
      const add = fromNotion.filter((x) => !have.has(key(x)) && !have.has(key(x.replace(/^\[Notion[^\]]*\]\s*/, ''))));
      if (add.length) {
        const stamped = add.map((x) => `[Notion · ${day(row.edited)}] ${x}`);
        updateProspect(db, p.id, { notes: (current ? current.trimEnd() + '\n\n' : '') + stamped.join('\n\n') }, who);
        report.notesToCrm += add.length;
      }
      blocksByPage.set(row.pageId, blocks);
    } catch (e) { report.errors.push(`${row.nom}: ${e.message}`); }
  }

  // 3. CRM → Notion : tous les interviewés.
  const interviewed = db.prepare('SELECT * FROM prospects WHERE interviewe = 1').all();
  for (const p of interviewed) {
    try {
      const fresh = db.prepare('SELECT * FROM prospects WHERE id = ?').get(p.id);
      const files = db.prepare('SELECT id, filename FROM files WHERE prospect_id = ? ORDER BY uploaded_at').all(p.id);
      const cached = rows.find((r) => r.pageId === fresh.notion_page_id);
      const props = {
        'Nom entreprise': { rich_text: rich(fresh.entreprise) },
        'Rôle': { rich_text: rich(fresh.titre) },
        'Contacté': { status: { name: 'Terminé' } },
        'Entretien réalisé': { select: { name: 'Oui' } },
      };
      if (fresh.contacte_le && !cached?.dateContact) props['Date de contact'] = { date: { start: day(fresh.contacte_le) } };
      if (fresh.relance_le && !cached?.dateRelance) props['Date de relance'] = { date: { start: fresh.relance_le } };
      if (!cached?.source && /^ACwAA|^in-/.test(fresh.id)) props['Source'] = { select: { name: 'LinkedIn' } };
      const uid = userFor(fresh.contacte_par);
      if (uid && !(cached?.demarcheurs || []).length) props['Démarcheur'] = { people: [{ object: 'user', id: uid }] };

      let pageId = fresh.notion_page_id;
      let blocks = fresh.notion_page_id ? blocksByPage.get(fresh.notion_page_id) : null;
      if (!pageId) {
        const page = await api('POST', '/pages', { parent: { database_id: dbId }, properties: { 'Nom contact': { title: rich(fresh.nom_complet) }, ...props } });
        pageId = page.id; setPage.run(pageId, now, fresh.id); report.createdInNotion++; log(`+ Notion ← CRM : ${fresh.nom_complet}`);
        blocks = { crmBlock: null, notesBlock: null, notionNotes: [], crmNotesInNotion: [] };
      } else {
        // Ne pas écraser ce que Notion sait déjà : on ne pousse que les champs vides ou moins avancés.
        if (cached) { if (cached.entreprise) delete props['Nom entreprise']; if (cached.role) delete props['Rôle']; }
        await api('PATCH', `/pages/${pageId}`, { properties: props }); report.updatedNotion++;
        if (!blocks) blocks = await readPageBlocks(api, pageId);
      }
      // Bloc contexte CRM : recréé à chaque synchro (liens, audio, profil), notes CRM ajoutées à la suite.
      if (blocks.crmBlock) await api('DELETE', `/blocks/${blocks.crmBlock.id}`);
      const children = [{ object: 'block', type: 'toggle', toggle: { rich_text: rich(CRM_MARK + ' — ' + day(now)), children: crmContextChildren(fresh, crmUrl, files) } }];
      const crmParas = paras(fresh.notes).filter((x) => !/^\[Notion/.test(x));
      const already = new Set(blocks.crmNotesInNotion.map(key));
      const newNotes = crmParas.filter((x) => !already.has(key(x)));
      if (!blocks.notesBlock && crmParas.length) {
        children.push({ object: 'block', type: 'toggle', toggle: { rich_text: rich(NOTES_MARK), children: crmParas.slice(0, 100).map((x) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(x) } })) } });
        report.notesToNotion += crmParas.length;
      } else if (blocks.notesBlock && newNotes.length) {
        await api('PATCH', `/blocks/${blocks.notesBlock.id}/children`, { children: newNotes.slice(0, 100).map((x) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(x) } })) });
        report.notesToNotion += newNotes.length;
      }
      await api('PATCH', `/blocks/${pageId}/children`, { children });
      setPage.run(pageId, now, fresh.id);
    } catch (e) { report.errors.push(`${p.nom_complet}: ${e.message}`); }
  }
  log(`Notion : ${JSON.stringify(report)}`);
  return report;
}

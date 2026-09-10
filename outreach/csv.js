// Parseur CSV minimal (RFC 4180, séparateur ; ou ,) + mapping des colonnes
// produites par le userscript Sales Navigator vers le schéma prospects.

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.indexOf('\n') > -1 ? text.indexOf('\n') : text.length);
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const COLUMNS = {
  prenom: ['Prénom', 'Prenom', 'prenom', 'First name'],
  nom: ['Nom', 'nom', 'Last name'],
  nom_complet: ['Nom complet', 'nom_complet', 'Full name'],
  degre: ['Degré', 'Degre', 'degre'],
  premium: ['Premium'],
  titre: ['Titre', 'Title'],
  entreprise: ['Entreprise', 'Company'],
  entreprise_url: ['URL entreprise'],
  localisation: ['Localisation', 'Location'],
  anciennete_poste: ['Ancienneté poste'],
  anciennete_entreprise: ['Ancienneté entreprise'],
  relations_communes: ['Relations en commun'],
  groupes_partages: ['Groupes partagés'],
  posts_recents: ['Posts récents (30 j)', 'Posts récents'],
  derniere_activite: ['Dernière activité'],
  enregistre: ['Enregistré'],
  listes: ['Listes'],
  a_propos: ['À propos', 'A propos'],
  profil_url: ['URL profil', 'Profile URL'],
  photo_url: ['URL photo'],
  contact_par: ['Contact par'],
};

export function leadIdFromUrl(url) {
  const m = (url || '').match(/\/sales\/lead\/([^,/?]+)/);
  return m ? m[1] : null;
}

// Une ligne CSV → objet prospect. Retourne null si aucun identifiant exploitable.
export function mapRow(raw) {
  const pick = (key) => {
    for (const name of COLUMNS[key]) if (raw[name] !== undefined && raw[name] !== '') return raw[name];
    return '';
  };
  const profilUrl = pick('profil_url');
  const id = leadIdFromUrl(profilUrl) || slug(pick('nom_complet') + '|' + pick('entreprise'));
  if (!id) return null;
  const nomComplet = pick('nom_complet') || [pick('prenom'), pick('nom')].filter(Boolean).join(' ');
  return {
    id,
    prenom: pick('prenom') || nomComplet.split(' ')[0] || '',
    nom: pick('nom'),
    nom_complet: nomComplet,
    degre: pick('degre'),
    premium: pick('premium') === 'oui' ? 1 : 0,
    titre: pick('titre'),
    entreprise: pick('entreprise'),
    entreprise_url: pick('entreprise_url'),
    localisation: pick('localisation'),
    anciennete_poste: pick('anciennete_poste'),
    anciennete_entreprise: pick('anciennete_entreprise'),
    relations_communes: parseInt(pick('relations_communes'), 10) || 0,
    groupes_partages: pick('groupes_partages') === 'oui' ? 1 : 0,
    posts_recents: parseInt(pick('posts_recents'), 10) || 0,
    derniere_activite: pick('derniere_activite'),
    enregistre_sn: pick('enregistre') === 'oui' ? 1 : 0,
    listes_sn: pick('listes'),
    a_propos: pick('a_propos'),
    profil_url: leadIdFromUrl(profilUrl) ? `https://www.linkedin.com/sales/lead/${leadIdFromUrl(profilUrl)}` : profilUrl,
    photo_url: pick('photo_url'),
    contact_par: pick('contact_par') || null,
  };
}

function slug(s) {
  const out = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return out.length > 3 ? out : null;
}

import { html, render, useState, useEffect, useMemo, useRef } from './vendor/htm-preact.js';

// ---------- API ----------
async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  const res = await fetch('/api' + path, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error('non connecté'), { status: 401 });
  if (!res.ok) throw new Error(data.error || `erreur ${res.status}`);
  return data;
}

// ---------- helpers ----------
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const initials = (name) => (name || '?').split(/\s+/).slice(0, 2).map((s) => s[0] || '').join('').toUpperCase();
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function renderTemplate(corps, p) {
  return (corps || '')
    .replace(/\[pr[ée]nom\]/gi, p.prenom || '')
    .replace(/\[nom\]/gi, p.nom || '')
    .replace(/\[entreprise\]/gi, p.entreprise || '')
    .replace(/\[titre\]/gi, p.titre || '');
}

// linkedin.com/in/<id Sales Navigator> redirige vers le profil public ; sinon recherche par nom.
function linkedinProfileUrl(p) {
  if (p.linkedin_url) return { href: p.linkedin_url, label: 'Ouvrir le profil LinkedIn' };
  if (/^ACwAA/.test(p.id)) return { href: 'https://www.linkedin.com/in/' + p.id, label: 'Ouvrir le profil LinkedIn' };
  const q = [p.nom_complet, p.entreprise].filter(Boolean).join(' ');
  return { href: 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(q), label: 'Chercher sur LinkedIn' };
}

function relanceState(p) {
  if (!p.relance_le || p.contacte) return null;
  return p.relance_le < today() ? 'overdue' : p.relance_le === today() ? 'due' : 'later';
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// ---------- composants ----------
// Initiales toujours rendues sous la photo : si l'image manque ou est bloquée, la mise en page ne bouge pas.
function Avatar({ p, size }) {
  return html`<div class=${'avatar' + (size ? ' ' + size : '')} aria-hidden="true">
    <span>${initials(p.nom_complet)}</span>
    ${p.photo_url && html`<img src=${'/api/photo/' + encodeURIComponent(p.id)} alt="" loading="lazy" onError=${(e) => e.target.remove()} />`}
  </div>`;
}

function PersonChip({ name, people }) {
  if (!name) return null;
  const color = people.find((x) => x.name === name)?.color || '#8A94A6';
  return html`<span class="chip person" style=${`--c:${color}`}><span class="dot"></span>${name}</span>`;
}

function ContactChip({ p }) {
  if (p.interviewe) return html`<span class="chip interviewed">🎙 Interviewé</span>`;
  return p.contacte
    ? html`<span class="chip done">✓ Contacté</span>`
    : html`<span class="chip todo">À contacter</span>`;
}

function RelanceChip({ p }) {
  const st = relanceState(p);
  if (!st) return null;
  const label = st === 'overdue' ? 'Relance en retard' : st === 'due' ? 'Relance aujourd’hui' : 'Relance ' + fmtDate(p.relance_le);
  return html`<span class=${'chip ' + (st === 'later' ? 'later' : st)}>${label}</span>`;
}

function Login({ onOk }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { await api('/login', { method: 'POST', body: { password: pw } }); onOk(); }
    catch (e) { setErr(e.message); }
  };
  return html`<div class="login"><form onSubmit=${submit}>
    <div class="brand"><span class="logo"></span>Outreach <span class="sub">Mission Créa</span></div>
    <h1>Connexion</h1>
    <label class="field">Ton mot de passe
      <input type="password" value=${pw} onInput=${(e) => setPw(e.target.value)} autofocus />
    </label>
    ${err && html`<div class="error">${err}</div>`}
    <button class="btn primary" type="submit">Entrer</button>
  </form></div>`;
}

function ImportModal({ onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [log, setLog] = useState([]);
  const [names, setNames] = useState('');
  const [namesResult, setNamesResult] = useState('');
  const input = useRef();
  const markNames = async () => {
    setBusy(true);
    try {
      const r = await api('/import/names', { method: 'POST', body: { text: names } });
      setNamesResult(`${r.matched} marqué${r.matched > 1 ? 's' : ''}, ${r.alreadyContacted} déjà contacté${r.alreadyContacted > 1 ? 's' : ''}, ${r.created} créé${r.created > 1 ? 's' : ''}${r.ignored.length ? `, ignorés : ${r.ignored.join(', ')}` : ''}`);
      setNames(''); onDone();
    } catch (e) { setNamesResult(e.message); }
    setBusy(false);
  };
  const handle = async (files) => {
    setBusy(true);
    const lines = [];
    for (const f of files) {
      try {
        const text = await f.text();
        const r = await api('/import?filename=' + encodeURIComponent(f.name), { method: 'POST', body: text, raw: true });
        lines.push(`${f.name} : ${r.parsed} lignes → ${r.created} nouveaux, ${r.updated} mis à jour`);
      } catch (e) { lines.push(`${f.name} : ${e.message}`); }
    }
    setLog(lines); setBusy(false); onDone();
  };
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal">
    <h2>Importer des exports Sales Navigator</h2>
    <p class="muted">Les fichiers <code>salesnav-pageNNN-….csv</code> produits par le bouton « ⬇ CSV page ». Un prospect déjà présent est mis à jour sans perdre son suivi (contacté, notes, relance).</p>
    <div class=${'drop' + (over ? ' over' : '')}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); handle([...e.dataTransfer.files]); }}>
      ${busy ? 'Import en cours…' : html`Glisse tes CSV ici ou <a href="#" onClick=${(e) => { e.preventDefault(); input.current.click(); }}>choisis des fichiers</a>`}
      <input ref=${input} type="file" accept=".csv,text/csv" multiple hidden onChange=${(e) => handle([...e.target.files])} />
    </div>
    ${log.length > 0 && html`<ul class="tiny">${log.map((l) => html`<li>${l}</li>`)}</ul>`}
    <h3 class="muted" style="margin:6px 0 0;font-size:13px">Ou : marquer des personnes comme déjà contactées</h3>
    <p class="muted tiny" style="margin:0">Colle des noms, un par ligne (« Prénom Nom »). Ceux qui existent sont marqués contactés ; les autres sont créés en fiche minimale et fusionnés automatiquement quand l’extension les croise sur Sales Navigator.</p>
    <textarea value=${names} onInput=${(e) => setNames(e.target.value)} placeholder=${'Nicolas Dupont\nSandy Rivière\n…'} rows="5"></textarea>
    <div class="actions"><button class="btn" disabled=${!names.trim() || busy} onClick=${markNames}>Marquer contactés</button>${namesResult && html`<span class="tiny muted">${namesResult}</span>`}</div>
    <div class="foot"><button class="btn" onClick=${onClose}>Fermer</button></div>
  </div></div>`;
}

function TemplatesModal({ templates, onClose, onChange }) {
  const [drafts, setDrafts] = useState(() => templates.map((t) => ({ ...t })));
  const [adding, setAdding] = useState({ nom: '', corps: '' });
  const save = async (t) => { await api('/templates/' + t.id, { method: 'PUT', body: { nom: t.nom, corps: t.corps } }); onChange(); };
  const del = async (t) => { if (confirm(`Supprimer « ${t.nom} » ?`)) { await api('/templates/' + t.id, { method: 'DELETE' }); onChange(); } };
  const add = async () => { if (adding.nom && adding.corps) { await api('/templates', { method: 'POST', body: adding }); setAdding({ nom: '', corps: '' }); onChange(); } };
  useEffect(() => setDrafts(templates.map((t) => ({ ...t }))), [templates]);
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal">
    <h2>Modèles de message</h2>
    <p class="muted tiny">Tokens remplacés à la copie : <code>[Prénom]</code> <code>[Nom]</code> <code>[Entreprise]</code> <code>[Titre]</code></p>
    ${drafts.map((t, i) => html`<div class="tpl" key=${t.id}>
      <input type="text" value=${t.nom} onInput=${(e) => setDrafts(drafts.map((d, j) => j === i ? { ...d, nom: e.target.value } : d))} />
      <textarea value=${t.corps} onInput=${(e) => setDrafts(drafts.map((d, j) => j === i ? { ...d, corps: e.target.value } : d))}></textarea>
      <div class="actions"><button class="btn small primary" onClick=${() => save(t)}>Enregistrer</button><button class="btn small ghost" onClick=${() => del(t)}>Supprimer</button></div>
    </div>`)}
    <div class="tpl">
      <input type="text" placeholder="Nom du nouveau modèle" value=${adding.nom} onInput=${(e) => setAdding({ ...adding, nom: e.target.value })} />
      <textarea placeholder="Bonjour [Prénom], …" value=${adding.corps} onInput=${(e) => setAdding({ ...adding, corps: e.target.value })}></textarea>
      <div class="actions"><button class="btn small" onClick=${add} disabled=${!adding.nom || !adding.corps}>Ajouter</button></div>
    </div>
    <div class="foot"><button class="btn" onClick=${onClose}>Fermer</button></div>
  </div></div>`;
}

function ExtensionModal({ onClose, toast }) {
  const [token, setToken] = useState('');
  useEffect(() => { api('/token').then((r) => setToken(r.token)).catch((e) => toast(e.message)); }, []);
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}><div class="modal">
    <h2>Connecter l’extension Sales Navigator</h2>
    <p class="muted">Avec ce jeton, l’extension affiche sur chaque prospect Sales Navigator s’il est déjà dans le CRM et s’il a déjà été contacté, envoie les pages visitées ici automatiquement, et marque « contacté » quand tu envoies une invitation.</p>
    <ol class="muted" style="margin:0;padding-left:20px;display:grid;gap:6px">
      <li>Installe le userscript <code>salesnav-rssi-connect.user.js</code> dans Violentmonkey.</li>
      <li>Sur Sales Navigator, clique le bouton flottant « CRM » (ou menu Violentmonkey → « Connecter au CRM ») et colle ce jeton :</li>
    </ol>
    <textarea class="message-box mono" readonly value=${token} rows="3" onFocus=${(e) => e.target.select()}></textarea>
    <div class="foot">
      <button class="btn" onClick=${onClose}>Fermer</button>
      <button class="btn primary" onClick=${async () => toast((await copyText(token)) ? 'Jeton copié' : 'Copie impossible')}>Copier le jeton</button>
    </div>
  </div></div>`;
}

const fmtSize = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' Mo' : Math.round(n / 1e3) + ' Ko');
// Un .mp4 est lu dans un lecteur audio : seule la piste son nous intéresse.
const isPlayable = (f) => /^audio\//.test(f.mime || '') || /\.(mp3|m4a|aac|wav|ogg|oga|opus|webm|flac|mp4|m4b|mov)$/i.test(f.filename || '');

function Files({ p, toast }) {
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState('');
  const [over, setOver] = useState(false);
  const input = useRef();
  const reload = () => api('/prospects/' + encodeURIComponent(p.id) + '/files').then(setFiles).catch((e) => toast(e.message));
  useEffect(() => { setFiles(null); reload(); }, [p.id]);

  const upload = async (list) => {
    for (const f of list) {
      setBusy(f.name);
      try {
        const res = await fetch('/api/prospects/' + encodeURIComponent(p.id) + '/files?filename=' + encodeURIComponent(f.name), {
          method: 'POST', body: f, headers: { 'content-type': f.type || 'application/octet-stream' },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'envoi impossible');
      } catch (e) { toast(`${f.name} : ${e.message}`); }
    }
    setBusy(''); reload();
  };
  const del = async (f) => {
    if (!confirm(`Supprimer « ${f.filename} » ?`)) return;
    await api('/files/' + f.id, { method: 'DELETE' }); reload();
  };

  return html`<section>
    <h3>Fichiers · audio, notes d’entretien</h3>
    <div class=${'drop small' + (over ? ' over' : '')}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]); }}>
      ${busy ? `Envoi de ${busy}…` : html`Glisse un enregistrement (.mp3, .m4a, .wav, .mp4…) ici ou <a href="#" onClick=${(e) => { e.preventDefault(); input.current.click(); }}>choisis un fichier</a>`}
      <input ref=${input} type="file" multiple hidden accept="audio/*,video/mp4,.mp3,.m4a,.wav,.mp4,.mov" onChange=${(e) => upload([...e.target.files])} />
    </div>
    ${files === null ? html`<div class="muted tiny">Chargement…</div>`
      : files.length === 0 ? ''
        : html`<ul class="files">${files.map((f) => html`<li key=${f.id}>
          <div class="file-head">
            <a href=${'/api/files/' + f.id} target="_blank" rel="noopener">${f.filename}</a>
            <span class="muted tiny mono">${fmtSize(f.size)} · ${f.uploaded_by || '?'} · ${fmtDate(f.uploaded_at)}</span>
            <button class="btn ghost small" onClick=${() => del(f)} aria-label="Supprimer">✕</button>
          </div>
          ${isPlayable(f) && html`<audio controls preload="none" src=${'/api/files/' + f.id}></audio>`}
        </li>`)}</ul>`}
  </section>`;
}

function Detail({ p, people, templates, onPatch, onClose, toast }) {
  const [tplId, setTplId] = useState(templates[0]?.id);
  const [msg, setMsg] = useState('');
  const [notes, setNotes] = useState(p.notes || '');
  const [tab, setTab] = useState('fiche');
  const notesTimer = useRef();
  useEffect(() => { setNotes(p.notes || ''); }, [p.id]);
  useEffect(() => {
    const t = templates.find((x) => x.id === Number(tplId)) || templates[0];
    setMsg(t ? renderTemplate(t.corps, p) : '');
  }, [tplId, p.id, templates]);

  const patch = (data) => onPatch(p.id, data);
  const onNotes = (v) => {
    setNotes(v);
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => patch({ notes: v }), 600);
  };
  const copy = async () => {
    toast((await copyText(msg)) ? 'Message copié' : 'Copie impossible — sélectionne le texte à la main');
  };

  return html`<aside class="detail">
    <div class="head">
      <${Avatar} p=${p} />
      <div>
        <h2>${p.nom_complet} ${p.degre && html`<span class="muted tiny">· ${p.degre}</span>`}</h2>
        <div>${p.titre}</div>
        <div class="muted">${p.entreprise}${p.localisation ? ' · ' + p.localisation : ''}</div>
      </div>
      <button class="btn ghost small close" onClick=${onClose} aria-label="Fermer">✕</button>
    </div>
    <nav class="tabs detail-tabs" aria-label="Sections de la fiche">
      <button class=${'tab' + (tab === 'fiche' ? ' active' : '')} onClick=${() => setTab('fiche')}>Fiche</button>
      <button class=${'tab' + (tab === 'notes' ? ' active' : '')} onClick=${() => setTab('notes')}>Notes${p.notes ? ' •' : ''}</button>
    </nav>

    ${tab === 'notes' ? html`<section class="notes-pane">
      <h3>Notes d’entretien${p.interviewe && p.interviewe_le ? html` <span class="muted" style="text-transform:none;letter-spacing:0">· interviewé le ${fmtDateTime(p.interviewe_le)}</span>` : ''}</h3>
      <textarea class="notes-area" value=${notes} onInput=${(e) => onNotes(e.target.value)} placeholder="Compte rendu de l’entretien, verbatims, besoins, prochaine étape… Enregistré automatiquement, visible par toute l’équipe." spellcheck="true"></textarea>
    </section>` : html`
    <section>
      <div class="actions">
        ${p.profil_url && html`<a class="btn" href=${p.profil_url} target="_blank" rel="noopener">Ouvrir dans Sales Navigator</a>`}
        <a class="btn" href=${linkedinProfileUrl(p).href} target="_blank" rel="noopener">${linkedinProfileUrl(p).label}</a>
      </div>
      <label class="contact-toggle">
        <input type="checkbox" checked=${!!p.contacte} onChange=${(e) => patch({ contacte: e.target.checked })} />
        <span><b>Contacté</b>${p.contacte && p.contacte_le ? html` <span class="muted tiny">le ${fmtDateTime(p.contacte_le)}</span>` : ''}</span>
      </label>
      <label class="contact-toggle interview">
        <input type="checkbox" checked=${!!p.interviewe} onChange=${(e) => patch({ interviewe: e.target.checked })} />
        <span><b>Interviewé</b> <span class="muted tiny">entretien réalisé${p.interviewe && p.interviewe_le ? ' le ' + fmtDateTime(p.interviewe_le) : ''}</span></span>
      </label>
      <div class="grid2">
        <label class="field">Contact par
          <select value=${p.contact_par || ''} onChange=${(e) => patch({ contact_par: e.target.value })}>
            <option value="">— non attribué —</option>
            ${people.map((x) => html`<option value=${x.name}>${x.name}</option>`)}
          </select>
        </label>
        <label class="field">Relance le
          <input type="date" value=${p.relance_le || ''} onChange=${(e) => patch({ relance_le: e.target.value })} />
        </label>
      </div>
    </section>

    <section>
      <h3>Message</h3>
      ${templates.length > 1 && html`<select value=${tplId} onChange=${(e) => setTplId(e.target.value)}>${templates.map((t) => html`<option value=${t.id}>${t.nom}</option>`)}</select>`}
      <textarea class="message-box" value=${msg} onInput=${(e) => setMsg(e.target.value)}></textarea>
      <div class="actions"><button class="btn primary" onClick=${copy}>Copier le message</button><span class="muted tiny mono">${msg.length} caractères${msg.length > 300 ? ' — au-delà de 300 pour une invitation' : ''}</span></div>
    </section>

    <${Files} p=${p} toast=${toast} />

    ${p.a_propos && html`<section><h3>À propos</h3><div class="about">${p.a_propos}</div></section>`}

    <section>
      <h3>Signaux</h3>
      <dl class="kv">
        <dt>Relations en commun</dt><dd class="mono">${p.relations_communes || 0}</dd>
        <dt>Groupes partagés</dt><dd>${p.groupes_partages ? 'oui' : 'non'}</dd>
        <dt>Posts récents (30 j)</dt><dd class="mono">${p.posts_recents || 0}</dd>
        <dt>Dernière activité</dt><dd>${p.derniere_activite || '—'}</dd>
        <dt>Ancienneté</dt><dd>${[p.anciennete_poste, p.anciennete_entreprise].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Enregistré dans SN</dt><dd>${p.enregistre_sn ? 'oui' + (p.listes_sn ? ' (' + p.listes_sn + ')' : '') : 'non'}</dd>
        <dt>Importé</dt><dd>${fmtDate(p.imported_at)}${p.source_file ? html` <span class="muted tiny">${p.source_file}</span>` : ''}</dd>
      </dl>
      <label class="field">URL LinkedIn publique (optionnel)
        <input type="text" value=${p.linkedin_url || ''} placeholder="https://www.linkedin.com/in/…" onChange=${(e) => patch({ linkedin_url: e.target.value })} />
      </label>
    </section>`}
  </aside>`;
}

function App() {
  const [auth, setAuth] = useState('unknown');
  const [people, setPeople] = useState([]);
  const [who, setWho] = useState('');
  const [prospects, setProspects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [filters, setFilters] = useState({ q: '', contacte: 'all', person: 'all', relance: false, degre: 'all' });
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(null);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef();

  const toast = (m) => { setToastMsg(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(''), 2200); };

  const load = async () => {
    try {
      const [me, list, tpls] = await Promise.all([api('/me'), api('/prospects'), api('/templates')]);
      setPeople(me.people); setWho(me.who); setProspects(list); setTemplates(tpls); setAuth('ok');
    } catch (e) {
      if (e.status === 401) setAuth('no'); else toast(e.message);
    }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (auth !== 'ok') return;
    const t = setInterval(() => api('/prospects').then(setProspects).catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [auth]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { setSelectedId(null); setModal(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const logout = async () => { await api('/logout', { method: 'POST' }); setAuth('no'); setProspects([]); setSelectedId(null); };

  const onPatch = async (id, data) => {
    try {
      const row = await api('/prospects/' + encodeURIComponent(id), { method: 'PATCH', body: data });
      setProspects((list) => list.map((p) => (p.id === id ? row : p)));
    } catch (e) { toast(e.message); }
  };

  const counts = useMemo(() => {
    const c = { total: prospects.length, contacte: 0, aContacter: 0, interviewe: 0, relance: 0, person: {}, degre: {} };
    for (const p of prospects) {
      if (p.contacte) c.contacte++; else c.aContacter++;
      if (p.interviewe) c.interviewe++;
      const rs = relanceState(p);
      if (rs === 'due' || rs === 'overdue') c.relance++;
      const k = p.contact_par || '';
      c.person[k] = (c.person[k] || 0) + 1;
      if (p.degre) c.degre[p.degre] = (c.degre[p.degre] || 0) + 1;
    }
    return c;
  }, [prospects]);

  const visible = useMemo(() => {
    const q = norm(filters.q);
    return prospects
      .filter((p) => {
        if (filters.contacte === 'oui' && !p.contacte) return false;
        if (filters.contacte === 'non' && p.contacte) return false;
        if (filters.contacte === 'interviewe' && !p.interviewe) return false;
        if (filters.person !== 'all' && (p.contact_par || '') !== filters.person) return false;
        if (filters.degre !== 'all' && p.degre !== filters.degre) return false;
        if (filters.relance) { const rs = relanceState(p); if (rs !== 'due' && rs !== 'overdue') return false; }
        if (q && !norm([p.nom_complet, p.titre, p.entreprise, p.localisation, p.notes].join(' ')).includes(q)) return false;
        return true;
      })
      .sort((a, b) => (a.contacte - b.contacte) || (a.interviewe - b.interviewe) || (relanceRank(a) - relanceRank(b)) || a.nom_complet.localeCompare(b.nom_complet, 'fr'));
  }, [prospects, filters]);

  const selected = prospects.find((p) => p.id === selectedId);
  const set = (patch) => setFilters({ ...filters, ...patch });

  if (auth === 'unknown') return html`<div class="empty">Chargement…</div>`;
  if (auth === 'no') return html`<${Login} onOk=${load} />`;

  return html`<div class="app">
    <header class="topbar">
      <div class="brand"><span class="logo"></span>Outreach <span class="sub">Mission Créa</span></div>
      <input class="search" type="search" placeholder="Rechercher nom, titre, entreprise, ville, notes…" value=${filters.q} onInput=${(e) => set({ q: e.target.value })} />
      <span class="spacer"></span>
      <a class="btn" href="/api/export.csv" download>Exporter CSV</a>
      <button class="btn" onClick=${() => setModal('extension')}>Extension</button>
      <button class="btn" onClick=${() => setModal('templates')}>Modèles</button>
      <button class="btn primary" onClick=${() => setModal('import')}>Importer un CSV</button>
      <div class="who">
        <${PersonChip} name=${who} people=${people} />
        <button class="btn ghost small" onClick=${logout}>Se déconnecter</button>
      </div>
    </header>

    <div class=${'layout' + (selected ? ' with-detail' : '')}>
      <nav class="rail">
        <h3>Suivi</h3>
        <button class=${'row' + (filters.contacte === 'all' && !filters.relance ? ' active' : '')} onClick=${() => set({ contacte: 'all', relance: false })}>Tous <span class="n">${counts.total}</span></button>
        <button class=${'row' + (filters.contacte === 'non' && !filters.relance ? ' active' : '')} onClick=${() => set({ contacte: 'non', relance: false })}>À contacter <span class="n">${counts.aContacter}</span></button>
        <button class=${'row' + (filters.contacte === 'oui' && !filters.relance ? ' active' : '')} onClick=${() => set({ contacte: 'oui', relance: false })}>Contactés <span class="n">${counts.contacte}</span></button>
        <button class=${'row' + (filters.contacte === 'interviewe' && !filters.relance ? ' active' : '')} onClick=${() => set({ contacte: 'interviewe', relance: false })}>Interviewés <span class="n">${counts.interviewe}</span></button>
        <button class=${'row' + (filters.relance ? ' active' : '')} onClick=${() => set({ relance: !filters.relance, contacte: 'all' })}>Relances dues <span class="n">${counts.relance}</span></button>

        <h3>Contact par</h3>
        <button class=${'row' + (filters.person === 'all' ? ' active' : '')} onClick=${() => set({ person: 'all' })}>Tout le monde <span class="n">${counts.total}</span></button>
        ${people.map((x) => html`<button class=${'row' + (filters.person === x.name ? ' active' : '')} onClick=${() => set({ person: x.name })}><span style="display:flex;align-items:center"><span class="swatch" style=${`background:${x.color}`}></span>${x.name}</span> <span class="n">${counts.person[x.name] || 0}</span></button>`)}
        <button class=${'row' + (filters.person === '' ? ' active' : '')} onClick=${() => set({ person: '' })}>Non attribué <span class="n">${counts.person[''] || 0}</span></button>

        <h3>Degré</h3>
        <button class=${'row' + (filters.degre === 'all' ? ' active' : '')} onClick=${() => set({ degre: 'all' })}>Tous</button>
        ${Object.keys(counts.degre).sort().map((d) => html`<button class=${'row' + (filters.degre === d ? ' active' : '')} onClick=${() => set({ degre: d })}>${d} <span class="n">${counts.degre[d]}</span></button>`)}
      </nav>

      <main class="main">
        <div class="list-head">
          <span class="count">${visible.length} prospect${visible.length > 1 ? 's' : ''}</span>
          ${(filters.q || filters.contacte !== 'all' || filters.person !== 'all' || filters.degre !== 'all' || filters.relance) && html`<button class="btn ghost small" onClick=${() => setFilters({ q: '', contacte: 'all', person: 'all', relance: false, degre: 'all' })}>Effacer les filtres</button>`}
        </div>
        ${prospects.length === 0
          ? html`<div class="empty"><h2>Aucun prospect pour l’instant</h2><p>Importe les CSV exportés depuis Sales Navigator avec le bouton « ⬇ CSV page ».</p><button class="btn primary" onClick=${() => setModal('import')}>Importer un CSV</button></div>`
          : visible.length === 0
            ? html`<div class="empty"><h2>Rien ne correspond</h2><p>Élargis les filtres ou modifie la recherche.</p></div>`
            : html`<div class="list">${visible.map((p) => html`
              <article class=${'prospect' + (p.id === selectedId ? ' selected' : '')} key=${p.id} onClick=${() => setSelectedId(p.id)}>
                <${Avatar} p=${p} />
                <div class="body">
                  <div class="name"><span class="who-name">${p.nom_complet}</span>${p.degre && html`<span class="deg">${p.degre}</span>`}${p.premium ? html`<span class="deg" title="LinkedIn Premium">★</span>` : ''}</div>
                  <div class="line">${p.titre}${p.entreprise && html`<span class="sep">·</span><b>${p.entreprise}</b>`}</div>
                  <div class="meta">
                    ${p.localisation && html`<span>${p.localisation}</span>`}
                    ${p.relations_communes > 0 && html`<span>${p.relations_communes} relation${p.relations_communes > 1 ? 's' : ''} en commun</span>`}
                    ${p.groupes_partages ? html`<span>groupe partagé</span>` : ''}
                    ${p.notes && html`<span title=${p.notes}>📝 note</span>`}
                  </div>
                </div>
                <div class="chips"><${ContactChip} p=${p} /><${PersonChip} name=${p.contact_par} people=${people} /><${RelanceChip} p=${p} /></div>
              </article>`)}</div>`}
      </main>

      ${selected && html`<${Detail} key=${selected.id} p=${selected} people=${people} templates=${templates} onPatch=${onPatch} onClose=${() => setSelectedId(null)} toast=${toast} />`}
    </div>

    ${modal === 'import' && html`<${ImportModal} onClose=${() => setModal(null)} onDone=${() => api('/prospects').then(setProspects)} />`}
    ${modal === 'extension' && html`<${ExtensionModal} onClose=${() => setModal(null)} toast=${toast} />`}
    ${modal === 'templates' && html`<${TemplatesModal} templates=${templates} onClose=${() => setModal(null)} onChange=${() => api('/templates').then(setTemplates)} />`}
    ${toastMsg && html`<div class="toast">${toastMsg}</div>`}
  </div>`;
}

function relanceRank(p) {
  const rs = relanceState(p);
  return rs === 'overdue' ? 0 : rs === 'due' ? 1 : 2;
}

render(html`<${App} />`, document.getElementById('app'));

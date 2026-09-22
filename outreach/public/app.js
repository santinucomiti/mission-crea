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

// ---------- e-mail : niveaux de confiance ----------
// Calculés par le script d'enrichissement (~/enrich) et poussés dans le CRM par upsert-crm.mjs. Jamais devinés :
// sans témoin réel sur le domaine, aucune adresse n'est générée. Une adresse D (refusée) n'est pas conservée.
const EMAIL_TIERS = {
  A: { short: 'Observée (témoin réel) ou vérifiée « valid » — prête à l’envoi.', title: 'A — adresse observée (témoin réel) ou pattern confirmé + vérifiée « valid » → envoyer' },
  B: { short: 'Pattern du domaine confirmé ; non vérifiable (catch-all) ou pas encore vérifiée — envoyable.', title: 'B — pattern confirmé (≥ 2 témoins), catch-all ou non vérifiée → envoyer' },
  C: { short: 'Pattern probable (1 seul témoin), non vérifiée — volume réduit, ou re-vérifier avant.', title: 'C — pattern probable (1 témoin), non vérifiée → volume réduit' },
  D: { short: 'Refusée par le vérificateur — non conservée.', title: 'D — refusée par le vérificateur → jamais' },
};
const EMAIL_LEGEND = [
  ['A', 'Adresse observée (témoin réel : site, GitHub, profil) ou pattern confirmé puis vérifiée « valid » par le vérificateur.', 'Envoyer.'],
  ['B', 'Pattern du domaine confirmé par ≥ 2 témoins, mais adresse non vérifiable (domaine catch-all) ou pas encore vérifiée (quota du jour).', 'Envoyer.'],
  ['C', 'Pattern probable (1 seul témoin), adresse non vérifiée.', 'Volume réduit, ou re-vérifier avant d’envoyer.'],
  ['D', 'Adresse générée puis refusée par le vérificateur. Elle n’est pas conservée.', 'Jamais.'],
  ['—', 'Non trouvé : aucun témoin fiable, nom masqué, domaine inconnu, catch-all sans témoin… La raison est indiquée sur la fiche.', 'À obtenir autrement : LinkedIn, Hunter, page compte Sales Navigator, à la main.'],
];
const emailBucket = (p) => (p.email_statut === 'trouvé' && p.email ? (p.email_confiance === 'C' ? 'C' : 'ready') : p.email_statut === 'non trouvé' ? 'none' : 'pending');

function EmailChip({ p }) {
  if (p.email_statut === 'trouvé' && p.email) return html`<span class=${'chip mail-' + p.email_confiance} title=${(EMAIL_TIERS[p.email_confiance]?.title || '') + '\n' + p.email}>@ ${p.email_confiance}</span>`;
  if (p.email_statut === 'non trouvé') return html`<span class=${'chip ' + (p.email_confiance === 'D' ? 'mail-D' : 'mail-none')} title=${p.email_note || 'e-mail non trouvé'}>@ ${p.email_confiance === 'D' ? 'D' : '—'}</span>`;
  return null;
}

function EmailSection({ p, legend, setLegend, toast, patch }) {
  const found = p.email_statut === 'trouvé' && p.email;
  const tier = EMAIL_TIERS[p.email_confiance];
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState(p.email || '');
  useEffect(() => { setEdit(false); setDraft(p.email || ''); }, [p.id]);
  const save = () => { patch({ email: draft.trim() }); setEdit(false); };
  const manual = html`<div class="email-row">
    <input class="email-input" type="email" placeholder="prenom.nom@entreprise.com" value=${draft} onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(false); }} />
    <button class="btn small primary" onClick=${save}>Enregistrer</button>
    <button class="btn ghost small" onClick=${() => setEdit(false)}>Annuler</button>
  </div>`;
  return html`<section>
    <h3>E-mail <button class="btn ghost small help" type="button" title="Comprendre les niveaux A / B / C / D" aria-expanded=${legend ? 'true' : 'false'} onClick=${() => setLegend(!legend)}>?</button></h3>
    ${found ? html`
      <div class="email-row">
        <span class="mono email-addr">${p.email}</span>
        <span class=${'chip mail-' + p.email_confiance} title=${tier?.title || ''}>${p.email_confiance}</span>
        <button class="btn small" onClick=${async () => toast((await copyText(p.email)) ? 'E-mail copié' : 'Copie impossible')}>Copier</button>
        <a class="btn small" href=${'mailto:' + p.email}>Écrire</a>
        <button class="btn ghost small" onClick=${() => setEdit(!edit)}>Corriger</button>
      </div>
      ${edit && manual}
      <div class="muted tiny">${tier?.short || ''}${p.email_note ? ' · ' + p.email_note : ''}</div>
      <div class="muted tiny mono">pattern ${p.email_pattern || '—'} · source ${p.email_source || '—'} · vérifiée : ${p.email_verifie || '—'}${p.email_catch_all === 'oui' ? ' · domaine catch-all' : ''} · ${fmtDate(p.email_maj)}</div>`
    : p.email_statut === 'non trouvé' ? html`
      <div class="email-row"><span class=${'chip ' + (p.email_confiance === 'D' ? 'mail-D' : 'mail-none')} title=${p.email_confiance === 'D' ? EMAIL_TIERS.D.title : 'Aucune adresse fiable — à obtenir autrement'}>${p.email_confiance === 'D' ? 'D · refusée' : 'Non trouvé'}</span><span class="muted tiny">${fmtDate(p.email_maj)}</span></div>
      <div class="muted tiny">${p.email_note || ''}</div>
      ${edit ? manual : html`<button class="btn ghost small" onClick=${() => setEdit(true)}>Saisir à la main</button>`}`
    : html`<div class="muted tiny">Pas encore enrichi — visiter la page compte Sales Navigator (extension), puis lancer l’enrichissement.</div>
      ${edit ? manual : html`<button class="btn ghost small" onClick=${() => setEdit(true)}>Saisir à la main</button>`}`}
    ${legend && html`<div class="legend" role="note">
      <div class="lg head"><span></span><span>Le script ne devine jamais : sans témoin réel sur le domaine, il ne génère rien.</span></div>
      ${EMAIL_LEGEND.map(([k, what, use]) => html`<div class="lg" key=${k}><span class=${'chip mail-' + (k.length === 1 && k !== '—' ? k : 'none')}>${k}</span><span>${what} <span class="use">→ ${use}</span></span></div>`)}
    </div>`}
  </section>`;
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


// Lecteur synchronisé : audio en haut, transcript en dessous, phrase + mot en cours surlignés
// en temps réel (comme les paroles sur Spotify). Clic sur un mot ou une phrase → saut dans l'audio.
const mmss = (s) => { s = Math.max(0, Math.floor(s)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };

function Player({ file, p, onClose, toast }) {
  const [tr, setTr] = useState(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const audio = useRef();
  const box = useRef();
  const raf = useRef();
  const lastAuto = useRef(0);

  useEffect(() => { api('/files/' + file.id + '/transcript').then(setTr).catch((e) => toast(e.message)); }, [file.id]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const a = audio.current; if (!a) return;
      if (e.key === ' ') { e.preventDefault(); a.paused ? a.play() : a.pause(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); a.currentTime = Math.max(0, a.currentTime - 5); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); a.currentTime += 5; }
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); cancelAnimationFrame(raf.current); };
  }, []);

  // Position lue à ~60 Hz pendant la lecture (timeupdate ne tire que 4×/s, trop saccadé pour le mot en cours).
  const tick = () => { const a = audio.current; if (!a) return; setT(a.currentTime); if (!a.paused) raf.current = requestAnimationFrame(tick); };
  const onPlay = () => { setPlaying(true); cancelAnimationFrame(raf.current); tick(); };
  const onPause = () => { setPlaying(false); cancelAnimationFrame(raf.current); setT(audio.current.currentTime); };

  const segs = tr?.segments || [];
  let cur = -1;
  for (let i = 0; i < segs.length; i++) { if (segs[i].start <= t + 0.05) cur = i; else break; }
  if (cur >= 0 && t > segs[cur].end + 1.5 && cur < segs.length - 1) cur = -1; // silence entre deux phrases

  // Défilement automatique vers la phrase en cours, sauf si l'utilisateur vient de scroller lui-même.
  useEffect(() => {
    if (!follow || cur < 0 || !box.current) return;
    const el = box.current.querySelector('.line.now');
    if (!el) return;
    lastAuto.current = Date.now();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cur, follow]);
  const onScroll = () => { if (Date.now() - lastAuto.current > 1200) setFollow(false); };

  const seek = (s) => { const a = audio.current; a.currentTime = s; setT(s); setFollow(true); if (a.paused) a.play(); };
  const needle = q.trim().toLowerCase();
  const hits = needle ? segs.filter((s) => s.text.toLowerCase().includes(needle)).length : 0;
  const copy = () => navigator.clipboard.writeText(segs.map((s) => `[${mmss(s.start)}] ${s.text}`).join('\n')).then(() => toast('Transcript copié'));

  return html`<div class="modal-bg" onClick=${onClose}>
    <div class="modal player" onClick=${(e) => e.stopPropagation()}>
      <div class="player-head">
        <div>
          <h2>${p.nom_complet}</h2>
          <div class="muted tiny">${file.filename}${tr ? ` · ${segs.length} phrases · ${tr.model ? tr.model.split('/').pop() : 'whisper'}` : ''}</div>
        </div>
        <button class="btn ghost small" onClick=${onClose} aria-label="Fermer">✕</button>
      </div>
      <audio ref=${audio} controls preload="metadata" src=${'/api/files/' + file.id}
        onPlay=${onPlay} onPause=${onPause} onSeeked=${() => setT(audio.current.currentTime)} onEnded=${onPause}></audio>
      <div class="player-bar">
        <span class="mono tiny clock">${mmss(t)}${tr ? ` / ${mmss(tr.segments[segs.length - 1]?.end || 0)}` : ''}</span>
        <div class="seg" role="group" aria-label="Vitesse">
          ${[1, 1.25, 1.5, 2].map((r) => html`<button class=${'seg-btn' + (rate === r ? ' active' : '')} onClick=${() => setRate(r)}>×${r}</button>`)}
        </div>
        <input class="player-search" placeholder="Chercher dans le transcript…" value=${q} onInput=${(e) => setQ(e.target.value)} />
        ${needle && html`<span class="muted tiny">${hits} phrase${hits > 1 ? 's' : ''}</span>`}
        ${!follow && playing && html`<button class="btn small" onClick=${() => setFollow(true)}>↧ Suivre</button>`}
        <button class="btn ghost small" onClick=${copy} title="Copier le transcript horodaté">Copier</button>
        <span class="muted tiny kbd">espace · ← → 5 s</span>
      </div>
      <div class="lyrics" ref=${box} onScroll=${onScroll}>
        ${!tr ? html`<div class="muted">Chargement du transcript…</div>` : segs.map((s, i) => {
          const hit = needle && s.text.toLowerCase().includes(needle);
          const cls = 'line' + (i === cur ? ' now' : i < cur ? ' past' : '') + (hit ? ' hit' : '');
          return html`<p key=${i} class=${cls} onClick=${() => seek(s.start)}>
            <span class="ts mono">${mmss(s.start)}</span>
            <span class="txt">${s.words && s.words.length ? s.words.map((w, j) => html`<span key=${j}
              class=${'word' + (i === cur && w.s <= t && t < w.e + 0.08 ? ' now' : w.e <= t ? ' past' : '')}
              onClick=${(e) => { e.stopPropagation(); seek(w.s); }}>${j === 0 ? w.w.trimStart() : w.w}</span>`) : s.text}</span>
          </p>`;
        })}
      </div>
    </div>
  </div>`;
}

function Files({ p, toast }) {
  const [files, setFiles] = useState(null);
  const [player, setPlayer] = useState(null);
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
          ${isPlayable(f) && (f.has_transcript
            ? html`<button class="btn small transcript-btn" onClick=${() => setPlayer(f)}>🎧 Lecteur synchronisé · transcript</button>`
            : html`<span class="muted tiny">Pas encore de transcript</span>`)}
        </li>`)}</ul>`}
    ${player && html`<${Player} file=${player} p=${p} onClose=${() => setPlayer(null)} toast=${toast} />`}
  </section>`;
}

function Detail({ p, people, templates, onPatch, onClose, toast }) {
  const [tplId, setTplId] = useState(templates[0]?.id);
  const [msg, setMsg] = useState('');
  const [notes, setNotes] = useState(p.notes || '');
  const [tab, setTab] = useState('fiche');
  const [legend, setLegend] = useState(false);
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
      <div class="zone-row">
        <span class="muted tiny">Zone</span>
        <div class="seg">
          ${[['FR', 'France'], ['INT', 'International']].map(([v, l]) => html`<button class=${'seg-btn' + (p.zone_calc === v ? ' active' : '')} onClick=${() => patch({ zone: p.zone === v ? '' : v })} title=${p.zone ? 'Forcée à la main — cliquer pour revenir à la déduction' : 'Déduite de la localisation — cliquer pour forcer'}>${l}</button>`)}
        </div>
        <span class="muted tiny">${p.zone ? 'forcée' : p.zone_calc ? 'déduite de « ' + p.localisation + ' »' : 'localisation inconnue'}</span>
      </div>
      <div class="grid2">
        <label class="field">Relance le
          <input type="date" value=${p.relance_le || ''} onChange=${(e) => patch({ relance_le: e.target.value })} />
        </label>
      </div>
    </section>

    <${EmailSection} p=${p} legend=${legend} setLegend=${setLegend} toast=${toast} patch=${patch} />

    <section>
      <h3>Message</h3>
      ${templates.length > 1 && html`<select value=${tplId} onChange=${(e) => setTplId(e.target.value)}>${templates.map((t) => html`<option value=${t.id}>${t.nom}</option>`)}</select>`}
      <textarea class="message-box" value=${msg} onInput=${(e) => setMsg(e.target.value)}></textarea>
      <div class="actions"><button class="btn primary" onClick=${copy}>Copier le message</button><span class="muted tiny mono">${msg.length} caractères${msg.length > 300 ? ' — au-delà de 300 pour une invitation' : ''}</span></div>
    </section>

    <${Files} p=${p} toast=${toast} />

    ${p.a_propos && html`<section><h3>À propos</h3><div class="about">${p.a_propos}</div></section>`}
    ${p.contexte_linkedin && html`<section><h3>Profil LinkedIn <span class="muted" style="text-transform:none;letter-spacing:0">· aspiré le ${fmtDateTime(p.contexte_maj)}</span></h3><div class="about context">${p.contexte_linkedin}</div></section>`}

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

// ---------- Ajouter un prospect depuis un lien LinkedIn (sans extension) ----------
// LinkedIn refuse la lecture automatique depuis un serveur (mur de connexion) : la voie fiable est le texte de la
// page collé par la personne (Ctrl+A, Ctrl+C sur le profil), dont on déduit les champs comme le fait l'extension.
function LinkedInModal({ onClose, onDone, toast }) {
  const [url, setUrl] = useState('');
  const [texte, setTexte] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [form, setForm] = useState({ nomComplet: '', titre: '', entreprise: '', localisation: '', aPropos: '' });
  const [auto, setAuto] = useState(null); // aperçu de la lecture automatique (profil public), si tentée
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const ok = /linkedin\.com\/in\//i.test(url);
  const deduce = async (t) => {
    if (!t.trim()) return;
    try { const r = await api('/linkedin/parse', { method: 'POST', body: { texte: t, nomComplet: form.nomComplet } });
      setForm({ nomComplet: r.nomComplet || form.nomComplet, titre: r.titre || form.titre, entreprise: r.entreprise || form.entreprise, localisation: r.localisation || form.localisation, aPropos: r.aPropos || form.aPropos });
      setNote(r.nomComplet ? 'Champs déduits du texte collé — vérifie et corrige si besoin.' : 'Nom non reconnu dans le texte : saisis-le à la main.');
    } catch (e) { toast(e.message); }
  };
  const tryAuto = async () => {
    setBusy('auto'); setAuto(null);
    try { const r = await api('/linkedin/preview', { method: 'POST', body: { url } }); setAuto(r);
      if (r.found) { setForm({ nomComplet: r.nomComplet, titre: r.titre || '', entreprise: r.entreprise || '', localisation: r.localisation || '', aPropos: r.aPropos || '' }); setNote('Profil public lu automatiquement.'); }
      else setNote('Lecture automatique impossible : ' + r.reason + '. Colle le texte de la page.');
    } catch (e) { toast(e.message); }
    setBusy('');
  };
  const submit = async () => {
    setBusy('save');
    try {
      const r = await api('/prospects/from-linkedin', { method: 'POST', body: { url, ...form, texteColle: texte, contexte: auto?.found ? auto.contexte : texte, photoUrl: auto?.photoUrl || '' } });
      toast(r.created ? `${r.prospect.nom_complet} ajouté au CRM` : `${r.prospect.nom_complet} existait déjà : fiche complétée`);
      onDone(r.prospect); onClose();
    } catch (e) { toast(e.message); }
    setBusy('');
  };
  return html`<div class="modal-bg" onClick=${onClose}><div class="modal" onClick=${(e) => e.stopPropagation()}>
    <h2>Ajouter depuis LinkedIn</h2>
    <p class="muted tiny">Sans extension : ouvre le profil dans ton navigateur, colle son lien, puis fais <b>Ctrl+A</b> et <b>Ctrl+C</b> sur la page et colle le texte ici. Le CRM en déduit nom, poste, entreprise, lieu et « À propos », et garde le texte pour la recherche et l’enrichissement e-mail — comme avec l’extension.</p>
    <div class="field"><label>Lien LinkedIn *</label><input value=${url} placeholder="https://www.linkedin.com/in/…" onInput=${(e) => setUrl(e.target.value)} /></div>
    <div class="field"><label>Texte de la page (Ctrl+A, Ctrl+C sur le profil, puis coller ici)</label>
      <textarea rows="5" value=${texte} placeholder="Colle ici tout le texte du profil…" onInput=${(e) => setTexte(e.target.value)} onBlur=${(e) => deduce(e.target.value)} onPaste=${(e) => setTimeout(() => deduce(e.target.value), 0)}></textarea></div>
    ${note && html`<div class="warn">${note}</div>`}
    <div class="grid2">
      <div class="field"><label>Nom complet *</label><input value=${form.nomComplet} onInput=${f('nomComplet')} /></div>
      <div class="field"><label>Poste</label><input value=${form.titre} onInput=${f('titre')} /></div>
      <div class="field"><label>Entreprise</label><input value=${form.entreprise} onInput=${f('entreprise')} /></div>
      <div class="field"><label>Localisation</label><input value=${form.localisation} onInput=${f('localisation')} /></div>
    </div>
    <div class="field"><label>À propos</label><textarea rows="2" value=${form.aPropos} onInput=${f('aPropos')}></textarea></div>
    <div class="modal-actions">
      <button class="btn ghost small" disabled=${!ok || busy === 'auto'} onClick=${tryAuto} title="Ne marche que si le profil est public (rare)">${busy === 'auto' ? 'Lecture…' : 'Essayer la lecture automatique'}</button>
      <span class="spacer"></span>
      <button class="btn" onClick=${onClose}>Annuler</button>
      <button class="btn primary" disabled=${busy === 'save' || !form.nomComplet.trim() || !ok} onClick=${submit}>${busy === 'save' ? 'Ajout…' : 'Ajouter au CRM'}</button>
    </div>
  </div></div>`;
}

function App() {
  const [auth, setAuth] = useState('unknown');
  const [people, setPeople] = useState([]);
  const [who, setWho] = useState('');
  const [ro, setRo] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [prospects, setProspects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [filters, setFilters] = useState({ q: '', contacte: 'all', relance: false, degre: 'all', zone: 'all', email: 'all' });
  const [selectedId, setSelectedId] = useState(() => decodeURIComponent((location.hash.match(/p=([^&]+)/) || [])[1] || '') || null);
  const [notionBusy, setNotionBusy] = useState(false);
  const [notionOn, setNotionOn] = useState(false);
  useEffect(() => { history.replaceState(null, '', selectedId ? '#p=' + encodeURIComponent(selectedId) : location.pathname); }, [selectedId]);
  const syncNotion = async () => {
    setNotionBusy(true);
    try {
      const r = await api('/notion/sync', { method: 'POST' });
      toast(r.errors?.length && !r.notionRows ? 'Notion : ' + r.errors[0] : `Notion : ${r.notionRows} entretiens côté Notion · ${r.createdInNotion} créés là-bas · ${r.createdInCrm} créés ici · ${r.notesToCrm + r.notesToNotion} notes échangées${r.errors?.length ? ' · ' + r.errors.length + ' erreur(s)' : ''}`);
      api('/prospects').then(setProspects);
    } catch (e) { toast(e.message); }
    setNotionBusy(false);
  };
  const [modal, setModal] = useState(null);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef();

  const toast = (m) => { setToastMsg(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(''), 2200); };

  const load = async () => {
    try {
      const [me, list, tpls] = await Promise.all([api('/me'), api('/prospects'), api('/templates')]);
      setPeople(me.people); setWho(me.who); setRo(!!me.readOnly); setAdmin(!!me.admin); setProspects(list); setTemplates(tpls); setAuth('ok');
      document.body.classList.toggle('ro', !!me.readOnly);
      api('/notion/status').then((s) => setNotionOn(!!s.enabled)).catch(() => setNotionOn(false));
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
    const c = { total: prospects.length, contacte: 0, aContacter: 0, interviewe: 0, relance: 0, degre: {}, zone: { FR: 0, INT: 0, '': 0 }, pays: {}, email: { ready: 0, C: 0, none: 0, pending: 0 } };
    for (const p of prospects) {
      c.email[emailBucket(p)]++;
      if (p.contacte) c.contacte++; else c.aContacter++;
      if (p.interviewe) c.interviewe++;
      c.zone[p.zone_calc || ''] = (c.zone[p.zone_calc || ''] || 0) + 1;
      c.pays[p.pays_calc || ''] = (c.pays[p.pays_calc || ''] || 0) + 1;
      const rs = relanceState(p);
      if (rs === 'due' || rs === 'overdue') c.relance++;
      if (p.degre) c.degre[p.degre] = (c.degre[p.degre] || 0) + 1;
    }
    return c;
  }, [prospects]);

  const visible = useMemo(() => {
    // Mots-clés : chaque mot doit apparaître quelque part (nom, poste, entreprise, ville, notes, e-mail,
    // et données LinkedIn : « À propos » du CSV Sales Navigator, listes SN, profil aspiré par l'extension).
    const words = norm(filters.q).split(/\s+/).filter(Boolean);
    const haystack = (p) => norm([p.nom_complet, p.titre, p.entreprise, p.localisation, p.notes, p.email, p.a_propos, p.listes_sn, p.contexte_linkedin].join(' '));
    return prospects
      .filter((p) => {
        if (filters.contacte === 'oui' && !p.contacte) return false;
        if (filters.contacte === 'non' && p.contacte) return false;
        if (filters.contacte === 'interviewe' && !p.interviewe) return false;
        if (filters.zone !== 'all' && (p.pays_calc || '') !== filters.zone) return false;
        if (filters.degre !== 'all' && p.degre !== filters.degre) return false;
        if (filters.relance) { const rs = relanceState(p); if (rs !== 'due' && rs !== 'overdue') return false; }
        if (filters.email !== 'all' && emailBucket(p) !== filters.email) return false;
        if (words.length) { const h = haystack(p); if (!words.every((w) => h.includes(w))) return false; }
        return true;
      })
      .sort((a, b) => (a.contacte - b.contacte) || (a.interviewe - b.interviewe) || (zoneRank(a) - zoneRank(b)) || (relanceRank(a) - relanceRank(b)) || a.nom_complet.localeCompare(b.nom_complet, 'fr'));
  }, [prospects, filters]);

  const selected = prospects.find((p) => p.id === selectedId);
  const set = (patch) => setFilters({ ...filters, ...patch });

  if (auth === 'unknown') return html`<div class="empty">Chargement…</div>`;
  if (auth === 'no') return html`<${Login} onOk=${load} />`;

  return html`<div class="app">
    <header class="topbar">
      <div class="brand"><span class="logo"></span>Outreach <span class="sub">Mission Créa</span></div>
      <input class="search" type="search" placeholder="Rechercher nom, titre, entreprise, ville, notes, profil LinkedIn…" title="Mots-clés : chaque mot doit apparaître dans la fiche (nom, poste, entreprise, ville, notes, e-mail, « À propos », profil LinkedIn aspiré)" value=${filters.q} onInput=${(e) => set({ q: e.target.value })} />
      <span class="spacer"></span>
      <a class="btn" href="/api/export.csv" download>Exporter CSV</a>
      ${admin && html`<a class="btn" href="/api/admin/backup.sqlite" download title="Télécharge une copie complète de la base (prospects, entreprises, fichiers rattachés, transcripts) au format SQLite. Les audios ne sont pas inclus.">Sauvegarde</a>`}
      ${!ro && html`<button class="btn" onClick=${() => setModal('linkedin')} title="Ajouter une personne avec son lien LinkedIn, sans l’extension">＋ Depuis LinkedIn</button>
      <button class="btn" onClick=${() => setModal('extension')}>Extension</button>
      ${notionOn && html`<button class="btn" disabled=${notionBusy} onClick=${syncNotion} title="Entretiens réalisés ↔ Notion « Liste de contacts »">${notionBusy ? 'Notion…' : 'Notion'}</button>`}
      <button class="btn" onClick=${() => setModal('templates')}>Modèles</button>
      <button class="btn primary" onClick=${() => setModal('import')}>Importer un CSV</button>`}
      <div class="who">
        <${PersonChip} name=${who} people=${people} />${ro && html`<span class="chip ro-chip" title="Ce compte peut tout consulter mais rien modifier">lecture seule</span>`}
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

        <h3>E-mail</h3>
        <button class=${'row' + (filters.email === 'all' ? ' active' : '')} onClick=${() => set({ email: 'all' })}>Tous <span class="n">${counts.total}</span></button>
        <button class=${'row' + (filters.email === 'ready' ? ' active' : '')} onClick=${() => set({ email: 'ready' })} title="Adresses A ou B — prêtes à l’envoi">Prêts (A · B) <span class="n">${counts.email.ready}</span></button>
        <button class=${'row' + (filters.email === 'C' ? ' active' : '')} onClick=${() => set({ email: 'C' })} title="Pattern probable, non vérifié — volume réduit">À re-vérifier (C) <span class="n">${counts.email.C}</span></button>
        <button class=${'row' + (filters.email === 'none' ? ' active' : '')} onClick=${() => set({ email: 'none' })} title="Non trouvé — la raison est sur la fiche : à obtenir autrement">Non trouvé <span class="n">${counts.email.none}</span></button>
        <button class=${'row' + (filters.email === 'pending' ? ' active' : '')} onClick=${() => set({ email: 'pending' })} title="Pas encore passé par l’enrichissement">Non enrichi <span class="n">${counts.email.pending}</span></button>

        <h3>Pays</h3>
        <button class=${'row' + (filters.zone === 'all' ? ' active' : '')} onClick=${() => set({ zone: 'all' })}>Tous <span class="n">${counts.total}</span></button>
        ${Object.entries(counts.pays).filter(([k]) => k).sort((a, b) => (a[0] === 'France' ? -1 : b[0] === 'France' ? 1 : b[1] - a[1] || a[0].localeCompare(b[0], 'fr'))).map(([k, n]) => html`<button class=${'row' + (filters.zone === k ? ' active' : '')} onClick=${() => set({ zone: k })}>${k === 'France' ? 'France' : '🌍 ' + k} <span class="n">${n}</span></button>`)}
        ${counts.pays[''] > 0 && html`<button class=${'row' + (filters.zone === '' ? ' active' : '')} onClick=${() => set({ zone: '' })}>Non renseigné <span class="n">${counts.pays['']}</span></button>`}

        <h3>Degré</h3>
        <button class=${'row' + (filters.degre === 'all' ? ' active' : '')} onClick=${() => set({ degre: 'all' })}>Tous</button>
        ${Object.keys(counts.degre).sort().map((d) => html`<button class=${'row' + (filters.degre === d ? ' active' : '')} onClick=${() => set({ degre: d })}>${d} <span class="n">${counts.degre[d]}</span></button>`)}
      </nav>

      <main class="main">
        <div class="list-head">
          <span class="count">${visible.length} prospect${visible.length > 1 ? 's' : ''}</span>
          ${(filters.q || filters.contacte !== 'all' || filters.degre !== 'all' || filters.zone !== 'all' || filters.relance || filters.email !== 'all') && html`<button class="btn ghost small" onClick=${() => setFilters({ q: '', contacte: 'all', relance: false, degre: 'all', zone: 'all', email: 'all' })}>Effacer les filtres</button>`}
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
                <div class="chips"><${ContactChip} p=${p} /><${EmailChip} p=${p} />${p.zone_calc === 'INT' && html`<span class="chip intl" title=${p.localisation}>🌍 ${p.pays_calc}</span>`}<${RelanceChip} p=${p} /></div>
              </article>`)}</div>`}
      </main>

      ${selected && html`<${Detail} key=${selected.id} p=${selected} people=${people} templates=${templates} onPatch=${onPatch} onClose=${() => setSelectedId(null)} toast=${toast} />`}
    </div>

    ${modal === 'linkedin' && html`<${LinkedInModal} onClose=${() => setModal(null)} toast=${toast} onDone=${(row) => { api('/prospects').then(setProspects); setSelectedId(row.id); }} />`}
    ${modal === 'import' && html`<${ImportModal} onClose=${() => setModal(null)} onDone=${() => api('/prospects').then(setProspects)} />`}
    ${modal === 'extension' && html`<${ExtensionModal} onClose=${() => setModal(null)} toast=${toast} />`}
    ${modal === 'templates' && html`<${TemplatesModal} templates=${templates} onClose=${() => setModal(null)} onChange=${() => api('/templates').then(setTemplates)} />`}
    ${toastMsg && html`<div class="toast">${toastMsg}</div>`}
  </div>`;
}

const zoneRank = (p) => (p.zone_calc === 'FR' ? 0 : p.zone_calc === 'INT' ? 2 : 1);

function relanceRank(p) {
  const rs = relanceState(p);
  return rs === 'overdue' ? 0 : rs === 'due' ? 1 : 2;
}

render(html`<${App} />`, document.getElementById('app'));

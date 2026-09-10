// ==UserScript==
// @name         Sales Navigator — liste + Se connecter
// @namespace    micoti.salesnav
// @version      0.6.0
// @description  Par prospect : ouvre « Se connecter », pré-remplit la note ([Prénom], [Nom], [Entreprise], [Titre]) et marque « contacté » dans le CRM Outreach dès le clic. Badges CRM, envoi auto des pages, export CSV.
// @match        https://www.linkedin.com/sales/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      missioncrea.clippingatlas.com
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  document.documentElement.dataset.snMacro = 'loading';

  const DEFAULTS = {
    message:
      'Bonjour [Prénom], avec deux étudiants de X-HEC Entrepreneurs, nous analysons ' +
      'les opportunités sur le marché des pentests. Auriez-vous 20 minutes pour ' +
      'partager votre regard sur le secteur ?',
    contacts: 'Santinu|Eva|Rémi',
    crmUrl: 'https://missioncrea.clippingatlas.com',
    crmToken: '',
  };
  const TOKENS_HELP = 'Tokens : [Prénom] [Nom] [Entreprise] [Titre]';
  const contactList = () => cfg('contacts').split('|').map((s) => s.trim()).filter(Boolean);
  const cfg = (key) => GM_getValue(key, DEFAULTS[key]);

  GM_registerMenuCommand('Modifier le message', () => {
    const v = prompt('Message — ' + TOKENS_HELP, cfg('message'));
    if (v && v.trim()) GM_setValue('message', v.trim());
  });
  GM_registerMenuCommand('Modifier les contacts (CSV)', () => {
    const v = prompt('Contacts séparés par | — le premier est toi (prospects déjà enregistrés)', cfg('contacts'));
    if (v && v.trim()) GM_setValue('contacts', v.trim());
  });
  GM_registerMenuCommand('Connecter au CRM (jeton)', () => askCrmToken());
  GM_registerMenuCommand('URL du CRM', () => {
    const v = prompt('URL du CRM Outreach', cfg('crmUrl'));
    if (v && v.trim()) { GM_setValue('crmUrl', v.trim().replace(/\/$/, '')); crm.reset(); }
  });

  function askCrmToken() {
    const v = prompt('Colle le jeton affiché dans le CRM (bouton « Extension »)', cfg('crmToken'));
    if (v !== null) { GM_setValue('crmToken', v.trim()); crm.reset(); syncPage(true); }
  }

  const log = (...a) => console.log('[SN-macro]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => sleep(min + Math.random() * (max - min));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const visible = (el) => !!el && el.offsetParent !== null;

  async function waitFor(fn, { timeout = 5000, every = 100 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const r = fn();
      if (r) return r;
      await sleep(every);
    }
    return null;
  }

  const cleanName = (s) => s.replace(/[^\p{L}\p{M}\s'’.-]/gu, '').trim();
  const text = (card, sel) => norm(card.querySelector(sel)?.textContent);
  const absUrl = (href) => (href ? new URL(href, location.origin).href.replace(/\?.*$/, '') : '');

  function leadInfo(card) {
    const full = cleanName(text(card, '[data-anonymize="person-name"]'));
    const [prenom, ...rest] = full.split(/\s+/);
    const spot = [...card.querySelectorAll('[data-search-spotlight]')].map((b) => norm(b.textContent));
    const pick = (re) => spot.find((s) => re.test(s)) || '';
    const num = (s) => (s.match(/\d+/) || [''])[0];
    const tenureText = text(card, '.artdeco-entity-lockup__metadata');
    const tenure = (tenureText.match(/^(.*?à ce poste)\s*(.*)$/) || [, tenureText, '']).slice(1).map(norm);
    return {
      prenom: prenom || '',
      nom: rest.join(' '),
      nomComplet: full,
      degre: text(card, '.artdeco-entity-lockup__degree').replace(/[·\s]/g, ''),
      premium: card.querySelector('[type="linkedin-premium-gold-icon"]') ? 'oui' : 'non',
      titre: text(card, '[data-anonymize="title"]'),
      entreprise: text(card, '[data-anonymize="company-name"]'),
      entrepriseUrl: absUrl(card.querySelector('[data-anonymize="company-name"]')?.getAttribute('href')),
      localisation: text(card, '[data-anonymize="location"]'),
      ancienneteposte: tenure[0] || '',
      ancienneteEntreprise: tenure[1] || '',
      relationsCommunes: num(pick(/relations? en commun/i)),
      groupesPartages: pick(/groupes? partagés?/i) ? 'oui' : 'non',
      postsRecents: num(pick(/posts? récents?/i)),
      derniereActivite: card.querySelector('.presence-indicator')?.getAttribute('title') || '',
      enregistre: /^Enregistré$/.test(text(card, 'button[data-x--save-menu-trigger]')) ? 'oui' : 'non',
      listes: text(card, '[data-x--lists-indicator--lists-loaded]'),
      aPropos: norm(card.querySelector('[data-anonymize="person-blurb"]')?.getAttribute('title')),
      profilUrl: absUrl(card.querySelector('a[data-control-name="view_lead_panel_via_search_lead_name"]')?.getAttribute('href')),
      photoUrl: (card.querySelector('img[data-anonymize="headshot-photo"]')?.src || '').startsWith('http')
        ? card.querySelector('img[data-anonymize="headshot-photo"]').src
        : '',
    };
  }

  function renderMessage(info) {
    return cfg('message')
      .replace(/\[pr[ée]nom\]/gi, info.prenom)
      .replace(/\[nom\]/gi, info.nom)
      .replace(/\[entreprise\]/gi, info.entreprise)
      .replace(/\[titre\]/gi, info.titre);
  }

  // Hue menus are rendered in #hue-web-menu-outlet; the trigger's aria-controls
  // points at the menu container, which only has content while open.
  function openedMenu(trigger) {
    const id = trigger.getAttribute('aria-controls');
    const el = id && document.getElementById(id);
    return visible(el) && norm(el.textContent) ? el : null;
  }

  function closeMenus() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();
  }

  // Deepest visible element whose text matches `re`.
  function findItem(container, re) {
    const sel = 'button, [role^="menuitem"], [role="option"], a, li, label, span, div';
    const matches = [...container.querySelectorAll(sel)].filter(
      (el) => visible(el) && re.test(norm(el.textContent))
    );
    return matches.reverse().find((el) => !matches.some((o) => o !== el && el.contains(o))) || null;
  }

  function clickable(el) {
    return el.closest('button, [role^="menuitem"], [role="option"], a, label') || el;
  }

  function allFields() {
    return [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(visible);
  }

  async function openConnect(card) {
    const trigger = card.querySelector('button[data-search-overflow-trigger]');
    if (!trigger) throw new Error('bouton « … » introuvable');
    const before = new Set(allFields());
    trigger.click();
    const menu = await waitFor(() => openedMenu(trigger));
    if (!menu) throw new Error('menu « … » non ouvert');
    await jitter(300, 600);

    const item = findItem(menu, /^Se connecter$/i);
    if (!item) {
      closeMenus();
      throw new Error('« Se connecter » absent (déjà en relation ou invitation en attente ?)');
    }
    clickable(item).click();
    return before;
  }

  function setValue(el, text) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    } else {
      el.textContent = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillNote(message, fieldsBefore) {
    const newField = () => allFields().find((el) => !fieldsBefore.has(el));

    let field = await waitFor(newField, { timeout: 6000 });
    if (!field) {
      const dialogs = [...document.querySelectorAll('[role="dialog"], .artdeco-modal, #hue-web-modal-outlet')];
      const addNote = dialogs.map((d) => findItem(d, /ajouter une note/i)).find(Boolean);
      if (addNote) {
        clickable(addNote).click();
        field = await waitFor(newField, { timeout: 4000 });
      }
    }
    if (!field) throw new Error('champ message introuvable dans la fenêtre « Se connecter »');

    setValue(field, message);
    field.focus();
    return field;
  }

  // ---- CRM Outreach ----
  const crm = {
    state: 'idle', // idle | ok | no-token | error
    who: '',
    synced: new Set(),
    status: new Map(), // id -> {contacte, contacte_par, contacte_le, contact_par, notes}
    reset() { this.state = 'idle'; this.synced.clear(); this.status.clear(); },
    request(method, path, body) {
      const token = cfg('crmToken');
      if (!token) return Promise.reject(Object.assign(new Error('jeton manquant'), { noToken: true }));
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url: cfg('crmUrl') + '/api' + path,
          headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          data: body === undefined ? undefined : JSON.stringify(body),
          timeout: 15000,
          onload: (r) => {
            let data = {};
            try { data = JSON.parse(r.responseText || '{}'); } catch { /* réponse non JSON */ }
            if (r.status >= 200 && r.status < 300) resolve(data);
            else reject(Object.assign(new Error(data.error || `CRM ${r.status}`), { status: r.status }));
          },
          onerror: () => reject(new Error('CRM injoignable')),
          ontimeout: () => reject(new Error('CRM : délai dépassé')),
        });
      });
    },
  };

  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '');

  function crmBadge(card, id) {
    const st = crm.status.get(id);
    let el = card.querySelector('.sn-macro-crm');
    if (!el) {
      const anchorLi = card.querySelector('.' + BTN_CLASS)?.closest('li');
      if (!anchorLi) return;
      el = document.createElement('li');
      el.className = 'sn-macro-crm';
      anchorLi.before(el);
    }
    el.innerHTML = '';
    if (!st) {
      if (crm.synced.has(id)) el.append(pill('CRM', 'synced', 'Dans le CRM, personne ne l’a contacté'));
      return;
    }
    if (st.contacte) {
      el.append(pill(`✓ Contacté${st.contacte_le ? ' · ' + fmtDay(st.contacte_le) : ''}`, 'done', st.notes || ''));
      return;
    }
    if (st.contact_par) el.append(pill(`CRM · ${st.contact_par}`, 'assigned', 'Attribué dans le CRM'));
    else el.append(pill('CRM', 'synced', 'Dans le CRM, personne ne l’a contacté'));
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'sn-macro-mark';
    mark.textContent = 'Marquer contacté';
    mark.title = 'Marque ce prospect comme contacté par toi dans le CRM';
    mark.addEventListener('click', (e) => { e.stopPropagation(); markContacted(card); });
    el.append(mark);
  }

  function pill(text, kind, title) {
    const s = document.createElement('span');
    s.className = 'sn-macro-pill ' + kind;
    s.textContent = text;
    if (title) s.title = title;
    return s;
  }

  async function markContacted(card) {
    const info = leadInfo(card);
    const id = leadId(info);
    if (!id) return;
    try {
      const row = await crm.request('POST', '/sync/contacted', { id, lead: info });
      crm.status.set(id, row);
      crmBadge(card, id);
      crmIndicator();
    } catch (e) {
      log('markContacted', e);
      if (e.noToken) askCrmToken(); else alert('CRM : ' + e.message);
    }
  }

  const leadId = (info) => (info.profilUrl.match(/\/sales\/lead\/([^,/?]+)/) || [])[1] || null;

  let syncTimer;
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncPage(false), 800); }

  async function syncPage(force) {
    if (!cfg('crmToken')) { crm.state = 'no-token'; crmIndicator(); return; }
    const cards = [...document.querySelectorAll('[data-x-search-result="LEAD"]')];
    const entries = cards.map((card) => ({ card, info: leadInfo(card) })).filter((e) => leadId(e.info));
    if (!entries.length) return;
    try {
      const fresh = entries.filter((e) => force || !crm.synced.has(leadId(e.info)));
      if (fresh.length) {
        await crm.request('POST', '/sync/upsert', { leads: fresh.map((e) => e.info) });
        fresh.forEach((e) => crm.synced.add(leadId(e.info)));
      }
      const ids = entries.map((e) => leadId(e.info));
      const r = await crm.request('GET', '/sync/status?ids=' + encodeURIComponent(ids.join(',')));
      crm.who = r.who;
      ids.forEach((id) => { if (r.status[id]) crm.status.set(id, r.status[id]); else crm.status.delete(id); });
      crm.state = 'ok';
    } catch (e) {
      log('sync', e);
      crm.state = e.noToken ? 'no-token' : 'error';
      crm.lastError = e.message;
    }
    entries.forEach((e) => crmBadge(e.card, leadId(e.info)));
    crmIndicator();
  }

  function crmIndicator() {
    let el = document.querySelector('.sn-macro-crm-indicator');
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'sn-macro-crm-indicator';
      el.addEventListener('click', () => (crm.state === 'no-token' ? askCrmToken() : syncPage(true)));
      document.body.appendChild(el);
    }
    el.dataset.state = crm.state;
    el.textContent = crm.state === 'ok' ? `CRM ✓ ${crm.who} · ${crm.synced.size} sync`
      : crm.state === 'no-token' ? 'CRM : coller le jeton'
        : crm.state === 'error' ? `CRM ✗ ${crm.lastError || ''}` : 'CRM…';
    el.title = crm.state === 'ok' ? 'Cliquer pour resynchroniser la page' : crm.state === 'no-token' ? 'Jeton disponible dans le CRM, bouton « Extension »' : '';
  }

  async function run(card, btn) {
    if (btn.dataset.busy) return;
    const info = leadInfo(card);
    const st = crm.status.get(leadId(info));
    if (st?.contacte && !confirm(`${info.nomComplet} a déjà été contacté${st.contacte_le ? ' le ' + fmtDay(st.contacte_le) : ''}.\nContinuer quand même ?`)) return;
    if (!cfg('crmToken')) askCrmToken();
    btn.dataset.busy = '1';
    btn.classList.remove('done', 'err');
    const status = (s) => (btn.textContent = s);
    const message = renderMessage(info);
    try {
      status('… connexion');
      const fieldsBefore = await openConnect(card);
      await fillNote(message, fieldsBefore);
      // Marqué contacté dès que l'invitation est prête (demande explicite : pas de clic supplémentaire).
      const tracked = !!cfg('crmToken');
      if (tracked) { status('… CRM'); await markContacted(card); }

      status(tracked ? '✓ note prête · contacté' : '✓ note prête, relis et envoie');
      btn.classList.add('done');
    } catch (e) {
      log(e);
      status('✗ ' + e.message);
      btn.classList.add('err');
    } finally {
      delete btn.dataset.busy;
    }
  }

  const BTN_CLASS = 'sn-macro-btn';

  function inject() {
    document.querySelectorAll('[data-x-search-result="LEAD"]').forEach((card) => {
      if (card.querySelector('.' + BTN_CLASS)) return;
      const anchorLi = card.querySelector('button[data-x--save-menu-trigger]')?.closest('li');
      if (!anchorLi) return;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = BTN_CLASS;
      btn.textContent = '⚡ Connecter';
      btn.title = 'Ouvre « Se connecter », pré-remplit la note ; marque contacté dans le CRM dès le clic';
      btn.addEventListener('click', () => run(card, btn));
      li.appendChild(btn);
      anchorLi.after(li);
    });
  }

  // ---- Export CSV de la page ----
  const CSV_COLUMNS = [
    ['contactPar', 'Contact par'], ['prenom', 'Prénom'], ['nom', 'Nom'], ['nomComplet', 'Nom complet'], ['degre', 'Degré'],
    ['premium', 'Premium'], ['titre', 'Titre'], ['entreprise', 'Entreprise'], ['entrepriseUrl', 'URL entreprise'],
    ['localisation', 'Localisation'], ['ancienneteposte', 'Ancienneté poste'],
    ['ancienneteEntreprise', 'Ancienneté entreprise'], ['relationsCommunes', 'Relations en commun'],
    ['groupesPartages', 'Groupes partagés'], ['postsRecents', 'Posts récents (30 j)'],
    ['derniereActivite', 'Dernière activité'], ['enregistre', 'Enregistré'], ['listes', 'Listes'],
    ['aPropos', 'À propos'], ['profilUrl', 'URL profil'], ['photoUrl', 'URL photo'],
  ];
  const csvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

  function exportPage() {
    const cards = [...document.querySelectorAll('[data-x-search-result="LEAD"]')];
    if (!cards.length) return alert('Aucun prospect chargé sur cette page.');
    const rows = cards.map(leadInfo);
    // Déjà enregistré → premier contact (toi) ; sinon rotation sur les autres.
    const [me, ...others] = contactList();
    let turn = 0;
    rows.forEach((r) => {
      r.contactPar = r.enregistre === 'oui' || !others.length ? me || '' : others[turn++ % others.length];
    });
    const lines = [CSV_COLUMNS.map(([, h]) => csvCell(h)).join(';')].concat(
      rows.map((r) => CSV_COLUMNS.map(([k]) => csvCell(r[k])).join(';'))
    );
    const page = (new URLSearchParams(location.search).get('page') || '1').padStart(3, '0');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `salesnav-page${page}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return rows.length;
  }

  function injectExportButton() {
    if (document.querySelector('.sn-macro-export')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sn-macro-export';
    btn.title = 'Exporte les prospects affichés sur cette page (DOM) en CSV';
    const refresh = () => {
      const n = document.querySelectorAll('[data-x-search-result="LEAD"]').length;
      btn.textContent = `⬇ CSV page (${n})`;
      btn.disabled = n === 0;
    };
    btn.addEventListener('click', () => {
      const n = exportPage();
      if (n) { btn.textContent = `✓ ${n} exportés`; setTimeout(refresh, 2000); }
    });
    refresh();
    setInterval(refresh, 1500);
    document.body.appendChild(btn);
  }

  const style = document.createElement('style');
  style.textContent = `
    .sn-macro-export {
      position: fixed; right: 24px; bottom: 24px; z-index: 99999;
      padding: 8px 14px; border-radius: 20px; border: 1px solid #0a66c2;
      background: #0a66c2; color: #fff; font: 600 13px/1.4 -apple-system, system-ui, sans-serif;
      cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
    .sn-macro-export:hover { background: #004182; }
    .sn-macro-export:disabled { opacity: .5; cursor: default; }
    .sn-macro-crm-indicator {
      position: fixed; right: 24px; bottom: 68px; z-index: 99999;
      padding: 6px 12px; border-radius: 20px; border: 1px solid #c7ccd4;
      background: #fff; color: #333; font: 500 12px/1.4 -apple-system, system-ui, sans-serif;
      cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.15); max-width: 320px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sn-macro-crm-indicator[data-state="ok"] { border-color: #057642; color: #057642; }
    .sn-macro-crm-indicator[data-state="no-token"] { border-color: #b24020; color: #b24020; }
    .sn-macro-crm-indicator[data-state="error"] { border-color: #b24020; color: #b24020; }
    .sn-macro-crm { display: inline-flex; align-items: center; gap: 6px; margin-right: 6px; }
    .sn-macro-pill {
      display: inline-block; padding: 3px 9px; border-radius: 12px; font: 600 12px/1.4 -apple-system, system-ui, sans-serif;
      background: #eef3f8; color: #56687a; white-space: nowrap;
    }
    .sn-macro-pill.done { background: #dcf5e6; color: #057642; }
    .sn-macro-pill.assigned { background: #fdf1dc; color: #915907; }
    .sn-macro-mark {
      padding: 3px 9px; border-radius: 12px; border: 1px solid #c7ccd4; background: #fff; color: #56687a;
      font: 500 12px/1.4 -apple-system, system-ui, sans-serif; cursor: pointer;
    }
    .sn-macro-mark:hover { border-color: #057642; color: #057642; }
    .${BTN_CLASS} {
      margin-left: 8px; padding: 5px 12px; border-radius: 16px;
      border: 1px solid #0a66c2; background: #fff; color: #0a66c2;
      font: 600 13px/1.4 -apple-system, system-ui, sans-serif; cursor: pointer;
      max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .${BTN_CLASS}:hover { background: #eef3f8; }
    .${BTN_CLASS}[data-busy] { opacity: .6; cursor: progress; }
    .${BTN_CLASS}.done { border-color: #057642; color: #057642; }
    .${BTN_CLASS}.err { border-color: #b24020; color: #b24020; }
  `;
  document.head.appendChild(style);

  let timer;
  new MutationObserver((muts) => {
    if (muts.every((m) => m.target.closest?.('.sn-macro-crm, .sn-macro-crm-indicator'))) return;
    clearTimeout(timer);
    timer = setTimeout(() => { inject(); scheduleSync(); }, 200);
  }).observe(document.body, { childList: true, subtree: true });
  inject();
  injectExportButton();
  crmIndicator();
  syncPage(false);
  document.documentElement.dataset.snMacro = 'ready';
  log('prêt — liste cible :', cfg('listName'));
})();

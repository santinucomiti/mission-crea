// ==UserScript==
// @name         Sales Navigator — liste + Se connecter
// @namespace    micoti.salesnav
// @version      0.3.0
// @description  Par prospect : ajoute à la liste cible, ouvre « Se connecter », pré-remplit la note ([Prénom], [Nom], [Entreprise], [Titre]). Export CSV de la page.
// @match        https://www.linkedin.com/sales/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  document.documentElement.dataset.snMacro = 'loading';

  const DEFAULTS = {
    listName: 'RSSI',
    message:
      'Bonjour [Prénom], avec deux étudiants de X-HEC Entrepreneurs, nous analysons ' +
      'les opportunités sur le marché des pentests. Auriez-vous 20 minutes pour ' +
      'partager votre regard sur le secteur ?',
    contacts: 'Santinu|Eva|Rémi',
  };
  const TOKENS_HELP = 'Tokens : [Prénom] [Nom] [Entreprise] [Titre]';
  const contactList = () => cfg('contacts').split('|').map((s) => s.trim()).filter(Boolean);
  const cfg = (key) => GM_getValue(key, DEFAULTS[key]);

  GM_registerMenuCommand('Modifier la liste cible', () => {
    const v = prompt('Nom exact de la liste Sales Navigator', cfg('listName'));
    if (v && v.trim()) GM_setValue('listName', v.trim());
  });
  GM_registerMenuCommand('Modifier le message', () => {
    const v = prompt('Message — ' + TOKENS_HELP, cfg('message'));
    if (v && v.trim()) GM_setValue('message', v.trim());
  });
  GM_registerMenuCommand('Modifier les contacts (CSV)', () => {
    const v = prompt('Contacts séparés par | — le premier est toi (prospects déjà enregistrés)', cfg('contacts'));
    if (v && v.trim()) GM_setValue('contacts', v.trim());
  });

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

  async function saveToList(card) {
    const listName = cfg('listName');
    const alreadyRe = new RegExp('ajouté\\(e\\) à la liste ' + esc(listName) + '(\\s|$)');
    if (alreadyRe.test(norm(card.textContent))) return `déjà dans ${listName}`;

    const trigger = card.querySelector('button[data-x--save-menu-trigger]');
    if (!trigger) throw new Error('bouton Enregistrer introuvable');
    trigger.click();
    const menu = await waitFor(() => openedMenu(trigger));
    if (!menu) throw new Error('menu des listes non ouvert');
    await jitter(300, 600);

    const item = findItem(menu, new RegExp('^' + esc(listName) + '\\s*(\\(\\d+\\))?$'));
    if (!item) {
      closeMenus();
      throw new Error(`liste « ${listName} » absente du menu`);
    }
    const target = clickable(item);
    if (target.getAttribute('aria-checked') === 'true' || target.querySelector('input:checked')) {
      closeMenus();
      return `déjà dans ${listName}`;
    }
    target.click();
    await waitFor(() => !openedMenu(trigger), { timeout: 3000 });
    return `ajouté à ${listName}`;
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

  async function run(card, btn) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.classList.remove('done', 'err');
    const status = (s) => (btn.textContent = s);
    const message = renderMessage(leadInfo(card));
    try {
      status('… liste');
      const saved = await saveToList(card);
      status('✓ ' + saved);
      await jitter(500, 900);

      status('… connexion');
      const fieldsBefore = await openConnect(card);
      await fillNote(message, fieldsBefore);

      status(`✓ ${saved} · note prête, relis et envoie`);
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
      btn.textContent = `⚡ ${cfg('listName')} + connecter`;
      btn.title = 'Ajoute à la liste, ouvre « Se connecter » et pré-remplit la note';
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
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(inject, 200);
  }).observe(document.body, { childList: true, subtree: true });
  inject();
  injectExportButton();
  document.documentElement.dataset.snMacro = 'ready';
  log('prêt — liste cible :', cfg('listName'));
})();

# Contexte de travail — Mission Créa (dump de session, 2026-09-11)

Ce fichier est le point de reprise pour une nouvelle session d'assistant IA : ce qui existe, où
ça tourne, ce qui a été décidé, ce qui reste à faire. Lis-le avant de toucher à quoi que ce soit.
Le dépôt est privé (`santinucomiti/mission-crea`, collaborateur : `remiflachaire`).

## Les trois personnes et le but

Santinu (moi, `santinu.comiti@gmail.com`), Eva, Rémi — étudiants X-HEC Entrepreneurs. Mission :
entretiens exploratoires avec des CISO / RSSI sur le marché du pentest. Encadrant : Fabrice Imbault
(il suit via Notion). Deux canaux : LinkedIn (Sales Navigator, France + UK), puis mailing (CISO
étrangers, UK en premier).

## Ce qui existe

| Quoi | Où | État |
|---|---|---|
| CRM « Outreach » (Node 22 + `node:sqlite`, Preact sans build) | `outreach/` → https://missioncrea.clippingatlas.com (VPS `vps`, user ubuntu, `/home/ubuntu/outreach`, service systemd `outreach`, nginx + Let's Encrypt) | en prod |
| Extension Sales Navigator (userscript Violentmonkey 0.7.1) | `salesnav-macro/salesnav-rssi-connect.user.js` | installée chez Santinu ; guide d'installation IA pour Rémi = `README.md` racine |
| Skill d'enrichissement e-mail | `.claude/skills/enrichissement-email/` (SKILL.md + `scripts/enrich.mjs`), lié dans `~/.claude/skills/` | v2, 3 smoke tests documentés dans SKILL.md |
| Synchro Notion | `outreach/notion.js`, route `POST /api/notion/sync`, bouton « Notion » dans l'app, cycle auto toutes les 10 min | premier cycle OK le 2026-09-11 15:43 UTC |
| Outils de pilotage navigateur | `tools/` (voir ci-dessous) | scripts ad hoc, à lancer depuis ce dossier |

Déploiement : `cd outreach && ./deploy/deploy.sh` (rsync + restart ; `data/` et `.env` jamais écrasés).
Mots de passe CRM : `Santinu12345`, `Eva12345`, `Remi12345` (le mot de passe identifie la personne).
Jeton extension : bouton « Extension » dans l'app.

### CRM — modèle et règles
- Table `prospects` : identifiant = id Sales Navigator (`ACwAA…`) ou slug (`in-…`, `n-…`, `notion-…`).
  Suivi : `contacte`/`contacte_le`/`contacte_par`, `interviewe`/`interviewe_le`, `relance_le`,
  `notes`, `linkedin_url`, `zone` (surcharge FR/INT), `contexte_linkedin`/`contexte_maj` (profil
  aspiré), `notion_page_id`/`notion_sync_at`. `contact_par` existe encore en base mais n'est plus
  affiché (décision : on veut juste savoir si contacté oui/non).
- Table `entreprises` : `entreprise_url` (page compte SN) → `site`, `domaine`. Colonne « Domaine »
  dans `/api/prospects` et l'export CSV.
- `files` : audio par prospect (`.mp3/.m4a/.wav/.mp4…` seulement, `.mp4` lu en audio), 500 Mo max ;
  **déposer un audio passe la fiche en Interviewé** (et contacté).
- Pays déduit de la localisation (`countryOf` dans `db.js`), filtre « Pays » dans la colonne de gauche,
  tri France d'abord. Fiche = onglets « Fiche » / « Notes ».
- Photos : `/api/photo/:id` recopie l'image LinkedIn dans `data/photos/` (le bouclier Brave bloque
  `media.licdn.com`). Lien profond vers une fiche : `/#p=<id>`.
- Routes de synchro (jeton `Authorization: Bearer prénom.hmac`) : `/api/sync/status`, `/sync/upsert`,
  `/sync/contacted`, `/sync/profile` (page linkedin.com/in/…), `/sync/company` (page compte SN),
  `/sync/names` (noms masqués), `/import/names`, `/import` (CSV), `/export.csv`.
- Le CRM n'envoie pas d'e-mails et ne le fera pas (Lemlist / Brevo pour l'envoi).

### Extension — comportement
- Pages de recherche SN : bouton ⚡ Connecter (ouvre « Se connecter », pré-remplit la note, **marque
  contacté dès le clic**), badges CRM (« 🎙 Interviewé », « ✓ Contacté · date », « CRM »), envoi
  automatique des pages visitées ; pastille verte en bas à droite = interrupteur pause/reprise de la
  synchro ; bouton ⬇ CSV page.
- Pages `linkedin.com/in/…` : aspire le profil (Infos, Expérience…) → `contexte_linkedin` ; pastille
  « Hors CRM · cliquer pour ajouter » ; nom complet pris dans le slug si le nom est masqué.
- Pages compte `/sales/company/…` : site web → CRM.
- Ne gère pas les pages de liste SN (DOM tableau) : la liste « RSSI » (188) a été importée une fois
  via `tools/scrape-list.mjs` + `push-list.mjs`.
- Mise à jour : `python3 -m http.server 8765 --directory salesnav-macro` puis ouvrir
  `http://localhost:8765/salesnav-rssi-connect.user.js` → Violentmonkey « Réinstaller ». Incrémenter `@version`.

### Enrichissement e-mail — état des tests (détail dans SKILL.md, « Retours d'expérience » 1-17)
- Échantillon : 200 profils UK / 86 entreprises (`smoke-uk-200-v3.csv` à la racine, ignoré par git).
- v1 séquentiel : A+B 13 % (moteur de recherche bloqué à mi-course). v2 parallèle + GitHub + Bing :
  16 %. **v3 avec les domaines relevés sur les pages compte SN : 34 A + 14 B = 24 %**, 4 min, 50 crédits.
- Résidu structurel : 86 profils sur domaines catch-all / sans témoin (→ Hunter ou Dropcontact),
  40 noms masqués (le slug n'en récupère que 11 %), 13 domaines sans MX.
- MyEmailVerifier : clé dans `.claude/skills/enrichissement-email/.env` (ignoré par git) ;
  **1 000 crédits achetés** (~2,50 $), ~250 consommés. Greylistage = réessayer après 10 min (géré).
  Plusieurs clés possibles (`MYEMAILVERIFIER_KEYS`, un compte par membre, jamais deux pour la même personne).
- Hunter : pas de compte. Décision en attente : un mois de Starter (~34 €, ~500 recherches par domaine)
  pour attaquer le résidu « pattern inconnu ». `--hunter` déjà branché dans le script.
- Toujours : faire visiter les pages compte SN avant d'enrichir (extension ou `tools/hl-batch.mjs companies`),
  vérificateur en série, passe de reprise à +10 min, pas de génération sans témoin, jamais envoyer du D.
- Cadre légal noté dans SKILL.md (UK ok en B2B avec opt-out ; Italie/Allemagne : consentement).

### Synchro Notion
- Base « Mission création → Interviews → Liste de contacts » (`NOTION_DB_ID=3d47651dd081802187d9ccaeb4130c4c`),
  intégration interne « Santinu Comiti », jeton dans le `.env` du VPS (`NOTION_TOKEN`), base partagée.
- **Règle : seuls les entretiens réalisés sont synchronisés, dans les deux sens.** Notes concaténées
  paragraphe par paragraphe, jamais supprimées ; statut « le plus avancé gagne » ; blocs Notion
  « 🔁 Synchronisé depuis le CRM » (liens fiche/LinkedIn/SN/audio, contexte, profil aspiré, recréé à
  chaque passage) et « 📝 Notes CRM » ; notes écrites dans Notion → notes CRM préfixées « [Notion · date] ».
- Premier cycle : 9 lignes Notion, 6 rapprochées, 3 créées dans le CRM (dont « RSSI chez Baccarat »,
  « Antoine Fleuret AI », « Demp fleuret AI » — titres Notion qui ne sont pas des noms de personne :
  **à vérifier / nettoyer côté Notion**), 3 créées dans Notion (Florent Gilain, Paul Richiardi,
  David Giorgis), 87 paragraphes vers le CRM, 50 vers Notion. Page vérifiée : Paul Richiardi.
- Démarcheur mappé sur les comptes Notion (Santinu, Rémi ; Eva absente du workspace).

## Fils ouverts (par priorité)

1. **Transcription des entretiens** (demande du 2026-09-11, interrompue avant l'installation) :
   4 audios dans le CRM (Simon Hallay 26 Mo, Julien Ramel 18 Mo/25 min, Luis Gomes de Abreu 26 Mo,
   Paul Richiardi 31 Mo/43 min). Deux fichiers déjà extraits en WAV 16 kHz dans `/tmp/claude-1000/transcripts/`
   (paulo.wav, julien.wav — temporaire). Plan : `faster-whisper` en local (RTX 5060 8 Go, CUDA),
   modèle large-v3 ou turbo, horodatage par segment, **`initial_prompt`** avec le vocabulaire métier
   (RSSI, CISO, pentest, SOC, EDR, SIEM, NIS2, DORA, ISO 27001, PSSI, RGPD, red team, bug bounty…)
   — Whisper accepte ce contexte (≤ 224 jetons), `hotwords` aussi avec faster-whisper. Santinu a
   refusé l'installation `pip` pendant la session : **demander avant d'installer**.
   Objectif : livrer 1-2 transcripts horodatés pour juger la qualité ; ensuite, possible intégration
   dans le CRM (transcript stocké avec l'audio, poussé vers Notion).
2. Vérifier/nettoyer les 3 fiches créées depuis Notion avec des titres qui ne sont pas des noms.
3. Décider Hunter Starter pour le résidu ; lancer l'enrichissement sur tout le UK (1 100 profils :
   ~450 pages compte à visiter via `tools/hl-batch.mjs companies`, ~1 h, puis 15 min d'enrichissement).
4. Export « pour mailing » (A/B seulement) vers Lemlist/Brevo — pas encore fait ; les e-mails trouvés
   ne sont pas encore importés dans le CRM (pas de champ e-mail dans le CRM ; seul le CSV les porte).
5. Facultatif : import automatique des pages de liste SN dans l'extension ; Verifalia en second
   vérificateur ; GITHUB_TOKEN pour les témoins GitHub.

## Outils (`tools/`) et conventions de pilotage
- Brave de Santinu lancé avec `--remote-debugging-port=9222` (`~/.config/brave-flags.conf`, backup `.bak`).
  `tools/cdp.mjs <url-substring> <js>` évalue du JS dans un onglet ouvert ; `tools/shot-tab.mjs` capture.
  **Ne pas ouvrir/fermer des onglets dans son Brave pendant qu'il travaille** : utiliser le Brave
  headless séparé (port 9333) — `tools/get-cookies.mjs` exporte la session LinkedIn (fichier
  `li-cookies.json`, sensible, ignoré par git, à régénérer), `tools/hl.mjs` / `tools/hl-batch.mjs`
  parcourent des pages LinkedIn avec cette session (une page toutes les 7-10 s).
  Lancement : `brave --headless=new --remote-debugging-port=9333 --user-data-dir=<tmp>`.
- `pkill -f` / `pgrep -f` : toujours ancrer le motif (`^/usr/bin/brave`, `^node server.js`) sinon on
  tue son propre shell.
- Secrets : jamais dans le dépôt. MyEmailVerifier → `.env` du skill ; Notion → `.env` du VPS ;
  scratchpad de session = temporaire.
- Le scratchpad de la session précédente (`/tmp/claude-1000/-home-micoti-Work-granola/…/scratchpad/`)
  contient les états des smoke tests (`smoke-uk/etat-v3.json`, journaux) — utiles mais périssables.

## Décisions de produit à respecter
- Rester simple : contacté oui/non, interviewé oui/non, relance, notes. Pas de pipeline de statuts,
  pas d'attribution manuelle.
- Ne pas afficher « qui » a contacté (stocké quand même).
- Priorité France > international dans la liste ; les CISO étrangers servent au test mailing.
- Pas d'automatisation des envois LinkedIn : ⚡ prépare, l'humain clique Envoyer.

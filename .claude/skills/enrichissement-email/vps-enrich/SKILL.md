---
name: enrichissement-email
description: v5 — Trouver et vérifier les e-mails professionnels des prospects du CRM Mission Créa (RSSI/DSI, UK en priorité), entreprise par entreprise, sans coût récurrent — domaine (page compte Sales Nav ou résolveur + agents) → témoins → pattern → génération → vérification → confiance A/B/C/D → upsert CRM → rapport. Procédure mécanique, exécutable par un petit modèle. Version 5 (2026-09-12), remplace la v2.
---

# Enrichissement e-mail — procédure v5

Tout tourne sur le VPS dans `/home/ubuntu/enrich` (scripts Node ≥ 22, zéro dépendance) et écrit dans le CRM
Outreach (`/home/ubuntu/outreach/data/outreach.sqlite`, visible sur missioncrea.clippingatlas.com).
Ton rôle : lancer les scripts dans l'ordre, lire leurs journaux, faire vérifier les domaines par des agents,
pousser dans le CRM, mesurer, rapporter. **Rien d'autre n'est à inventer.**

## 0. Invariants (jamais négociables)

1. **Zéro bruit dans les e-mails** : aucune adresse devinée sans témoin réel ; un D (refusé par le vérificateur)
   n'est jamais stocké ; un « non trouvé » porte toujours sa raison sur la fiche CRM.
2. **On n'envoie aucun e-mail**, on ne contacte personne. Les contacts de Yanis ne sont pas touchés.
3. **Jamais deux passes `enrich.mjs` en même temps** sur `smoke-uk/etat-v3.json` (le script `run-nuit.sh` refuse).
4. **Pas de PII dans Notion** (e-mails, téléphones) : le CRM SQLite et les CSV, c'est tout.
5. **Ne jamais tuer une session `claude`** ni un process d'un autre utilisateur ; si la mémoire manque, le dire.
6. **Le dépôt du CRM est sur le laptop de Santinu** : avant tout `deploy.sh`, appliquer `~/enrich/outreach-email.patch`
   (sinon les colonnes e-mail de l'UI sont écrasées). Ne pas modifier `~/outreach` sans le dire.
7. Le script de prod `enrich.mjs` ne se modifie **jamais pendant un run**, et une modification passe par le bench (§ 6).
8. Ne jamais afficher les clés de `.env` (MyEmailVerifier, GitHub, Brave) dans une réponse.

## 1. Carte des fichiers

| Fichier | Rôle |
|---|---|
| `enrich.mjs` | domaine → témoins (site, GitHub, profil) → pattern → génération → sondage/vérification → CSV scoré. État persistant : `smoke-uk/etat-v3.json` (toujours le même). |
| `build-input.mjs <LIMIT> <out.csv>` | fabrique l'entrée depuis le CRM : prospects UK ayant un domaine, triés par priorité (0 nouveau · 1 vérificateur muet · 2 B à vérifier · 3 déjà résolu · 4 nom tronqué). |
| `run-nuit.sh soir\|nuit <dossier>` | le cycle standard (§ 2). |
| `upsert-crm.mjs sortie.csv [--dry-run]` | pousse le CSV scoré dans `prospects.email_*` ; plafonne à C les adresses non vérifiées sur un domaine `recherche` ; n'écrase jamais un `email_source='manuel'`. |
| `mesure.mjs` | part d'A+B par origine du domaine (prospects UK avec domaine, hors noms masqués) — la métrique du projet. |
| `resolve-domains.mjs` | nom d'entreprise → site → domaine (Brave Search API), pour les entreprises sans domaine (§ 3). |
| `make-lots.mjs <resolver.csv> <dossier>` | découpe le résultat du résolveur en lots de 50 pour les agents (§ 4). |
| `bench/verif/PROMPT-agent.md` | le prompt exact des agents de vérification. |
| `verif-apply.mjs --source <resolver.csv> lot.result.md…` | applique les verdicts au CRM (`domaine_source='vérifié-agent'`, MX exigé, jamais par-dessus une page compte). |
| `bench/verif/precision.py <resolver.csv> '<glob>'` | précision écrits / différés après verdicts. |
| `bench/` (`run.sh`, `score.mjs`, `judge.py`, `LEDGER*.md`) | boucle d'optimisation du script (§ 6). |
| `backups/` | copies de l'état, du CRM, des scripts avant chaque étape risquée. |
| `RAPPORT-2026-09-11.md` | le rapport courant (addenda datés) ; `run-*/` = un dossier par run. |
| `.env` (chmod 600) | `MYEMAILVERIFIER_KEY` (100 vérifs/jour, remise à zéro à 00:00 UTC), `GITHUB_TOKEN`, `BRAVE_API_KEY` (crédits prépayés), `HUNTER_API_KEY` (vide), `SERPER_API_KEY` (vide). |

Vue d'ensemble du CRM : `entreprises(entreprise_url, nom, site, domaine, domaine_source ∈ {sales-nav, vérifié-agent, recherche})`,
`prospects(id = lead Sales Navigator, prenom, nom, titre, localisation, email, email_confiance, email_statut, email_note, …)`.

## 2. Le cycle standard (recette v6 — à répéter tant qu'il reste des B à vérifier ou de nouveaux domaines)

**Pourquoi deux temps** : la récolte des témoins ne coûte rien mais dure ~45 min ; la vérification coûte les 100 crédits
du jour et dure 4 min sur cache chaud. On récolte le soir, on vérifie après 00:00 UTC.

```bash
cd /home/ubuntu/enrich
R=run-$(date -u +%F)                       # un dossier par cycle, ex. run-2026-09-13
nohup ./run-nuit.sh soir $R > $R.soir.out 2>&1 &          # (1) soir : entrée CRM + passe sans crédit
# attendre la ligne « soir terminé » dans $R/NOTES.txt (tail -f $R/NOTES.txt)
nohup ./run-nuit.sh nuit $R > $R.nuit.out 2>&1 &          # (2) après 00:00 UTC : vérification + reprise + upsert + mesure
# attendre « nuit terminée » dans $R/NOTES.txt (≈ 20 min, dont 11 min d'attente greylist)
```

Contrôles à faire (et à citer dans le rapport) :
- `head -n 1 $R/soir.log` doit dire `GitHub authentifié` ; sinon `.env` n'est pas lu → stop.
- Dernière ligne `✔ … Confiance : {…} · vérifications aujourd'hui : N` dans chaque `*.log`. Si `N` reste à 0 en passe `verif`,
  tester l'API : `curl -s "https://client.myemailverifier.com/verifier/validate_single/info@cls-group.com/$KEY"` (1 crédit) ;
  `Status` attendu (Valid/Catch-all/…). Pas de réponse → quota pas encore remis, réessayer plus tard.
- `⏱ délai dépassé` : normal en petit nombre (< 5 %) ; l'entreprise continue en arrière-plan et son résultat est repris à la passe suivante grâce au cache.
- `$R/upsert.txt` : « rapprochées par id » = toutes les lignes ; « introuvables 0 ».
- `$R/mesure-avant.txt` vs `$R/mesure-apres.txt` : la ligne `TOTAL UK` doit monter ou stagner, jamais baisser.
  D doit rester ≤ 3 % des adresses générées ; au-delà, un pattern est faux → le signaler, ne pas relancer.

Quand la passe `nuit` ne change plus rien (A+B stable, « vérifications aujourd'hui » < 20), il n'y a plus de B à vérifier :
passer au § 3 (nouveaux domaines) ou s'arrêter.

## 3. Nouveaux domaines : le résolveur (quand des entreprises n'ont pas de domaine)

Le résolveur trouve le site d'une entreprise par son nom via l'API Brave (payante à l'usage ; une requête ≈ 1 crédit ;
`HTTP 402 CREDIT_EXHAUSTED` = solde à recharger par Santinu sur api.search.brave.com → **s'arrêter et le dire**).
Depuis le VPS aucun moteur gratuit ne marche (Bing sert des leurres, DuckDuckGo/Qwant → 403) : **pas d'autre moteur**.

```bash
cd /home/ubuntu/enrich
node --no-warnings resolve-domains.mjs --uk --engine brave --concurrency 3 --write --out bench/resolved-$(date -u +%F).csv \
  2>&1 | tee bench/resolved-$(date -u +%F).log
```
- Les entreprises déjà dotées d'un domaine sont sautées ; `--limit N` pour un pilote.
- Il écrit dans le CRM (`domaine_source='recherche'`) seulement les niveaux **fort/moyen avec MX** ; les **faible/aucun** sont
  « différés » (dans le CSV, pas dans le CRM). Précision mesurée : écrits **87 %** de bonnes entreprises (93 % sur le pilote),
  différés 40 % — d'où les agents (§ 4) sur les deux.
- Le fichier `bench/resolved-*.csv` (colonnes `entreprise_url;nom;nb_prospects;domaine;niveau;mx;preuve_titre;url`) est
  l'entrée du § 4. Ne rien enrichir sur ces domaines avant les verdicts des agents (les adresses seraient plafonnées à C).

## 4. Vérification des domaines par agents (obligatoire après chaque run du résolveur)

```bash
cd /home/ubuntu/enrich
node --no-warnings make-lots.mjs bench/resolved-2026-09-13.csv bench/verif-2026-09-13     # lots de 50 : lot-N-differes.csv puis lot-N-ecrits.csv
```
1. Lancer **un agent par lot, tous en parallèle**, avec le prompt de `bench/verif/PROMPT-agent.md` (remplacer `{FICHIER}` ;
   adapter la phrase écrits/différés). Chaque agent rend un tableau `| nom | verdict | domaine_final | preuve_url | motif |`.
   Coût observé : ~100-200 k tokens et 15-30 min par lot de 50.
2. Coller chaque tableau **tel quel** dans `bench/verif-2026-09-13/lot-N-<type>.result.md` (`&amp;` → `&` dans les noms).
3. Relecture rapide avant d'appliquer (5 règles) : pas de domaine partagé (`gov.uk`, `nhs.uk`, `police.uk` seuls → variante
   propre `dft.gov.uk`, sinon INCONNU) ; pas de domaine construit sans preuve ; un FAUX sans `domaine_final` retire le domaine ;
   un nom fantôme (« Confidential », « Not Specified ») = FAUX vide ; une cellule ne contient pas de `|`.
4. Appliquer, puis mesurer :
```bash
node --no-warnings verif-apply.mjs --source bench/resolved-2026-09-13.csv bench/verif-2026-09-13/lot-*.result.md   # « non rapprochés 0 » attendu
python3 bench/verif/precision.py bench/resolved-2026-09-13.csv 'bench/verif-2026-09-13/lot-*.result.md'
```
   `verif-apply` refuse un domaine sans MX (souvent : site vitrine ≠ domaine e-mail, ex. `home.barclays`, `cms.law`, sites NHS) :
   les lister dans le rapport comme « corrects mais sans MX », ne pas forcer.
5. Puis relancer le cycle § 2 : `build-input.mjs` prend automatiquement les nouveaux domaines.

## 5. Rapport (après chaque cycle ou run du résolveur)

Ajouter un addendum daté à `RAPPORT-2026-09-11.md` (ne pas réécrire le reste), en français, avec exactement :
1. **Périmètre** : nombre de profils / domaines de l'entrée, dossier, durées, crédits consommés (`vérifications aujourd'hui`).
2. **Résultat CRM** : e-mails avant → après (`upsert.txt` : `trouvé=… · A=… B=… C=…`), D non stockés, non trouvés.
3. **Mesure avant/après** : le tableau de `mesure-avant.txt` / `mesure-apres.txt` (lignes `sales-nav`, `vérifié-agent`, `TOTAL UK`).
4. **Ce qui s'est bien passé / mal passé** : erreurs des journaux (`exit`, `⏱`, `402`, « vérificateur muet »), lots d'agents
   non rapprochés, domaines refusés sans MX — avec la cause quand elle est établie, sinon « cause non établie ».
5. **Ce qui bloque encore** : les raisons « non trouvé » (`email_note`) par volume, et le nombre d'entreprises UK sans domaine.
6. **Suite proposée** en 2-3 lignes (recharge Brave, prochaine nuit, Hunter…).
Envoyer le fichier à Santinu (SendUserFile) et résumer en 8 lignes dans la réponse. Mettre à jour la mémoire projet
(`enrich-email-pipeline.md`) : chiffres du CRM, ce qui a changé, ce qui reste.

Chiffres de référence (12/09/2026) pour repérer une anomalie : CRM **292 e-mails (80 A · 122 B · 90 C)** sur 2 846 prospects ;
prospects UK avec domaine 913 (155 noms masqués) ; A+B hors masqués : Sales Nav **39 %**, domaines résolveur+agents **22 %**,
total **26 %** ; D = 20 ; entreprises avec domaine 749 (664 `vérifié-agent`, 84 `sales-nav`) ; **421 entreprises UK sans domaine**.
Rendement attendu d'un nouveau lot de domaines vérifiés : 20-25 % d'A+B ; un lot à < 10 % ou à > 5 % de D est suspect.

## 6. Boucle d'optimisation du script (seulement si Santinu le demande)

Une hypothèse = une copie du script (`bench/enrich-candidate.mjs`, jamais `enrich.mjs`), un run déterministe sur l'échantillon figé
(`BENCH_GITHUB=1 ./bench/run.sh <tag>` : état copié, cache HTTP, 0 crédit, ~10 s), un score (`bench/score.mjs`) et un juge
mécanique (`python3 bench/judge.py bench/results/<ref>.json bench/results/<tag>.json` → KEEP/REVERT ; la référence est dans
`bench/current-ref.txt`). KEEP ⇒ `cp bench/enrich-candidate.mjs bench/candidate.ref.mjs` et, **entre deux runs de prod seulement**,
`cp bench/candidate.ref.mjs enrich.mjs` (après `cp enrich.mjs backups/enrich.mjs.$(date -u +%Y%m%dT%H%M%SZ)`). Tout est journalisé
dans `bench/LEDGER.md`. Hypothèses déjà tranchées : voir `bench/LEDGER-final.md` (ne pas les rejouer).

## 7. Grille de confiance et raisons « non trouvé »

| Niveau | Sens | Usage |
|---|---|---|
| **A** | adresse observée (témoin réel) ou pattern confirmé puis vérifiée « valid » | envoyer |
| **B** | pattern confirmé (≥ 2 témoins), non vérifiable (catch-all) ou pas encore vérifiée | envoyer ; à vérifier au prochain cycle |
| **C** | pattern probable (1 témoin ou sondage), non vérifiée ; ou domaine `recherche` non vérifié | volume réduit ; re-vérifier |
| **D** | refusée par le vérificateur | jamais ; l'adresse n'est pas conservée |

**Sondage et contrôle catch-all.** Sur un domaine sans format connu, le script teste une seule adresse `prenom.nom`
(les autres formats ne valent pas le crédit : 94 % des domaines UK confirmés sont en `prenom.nom`). Un « valid » ne
suffit pas : un serveur catch-all dit oui à tout. Trois garde-fous, dans cet ordre :
1. le drapeau catch-all du vérificateur (il se déclenche sur ~24 % des sondages) → domaine écarté ;
2. **une adresse de contrôle** de même forme mais impossible (`zqxxxxxx.zqxxxxxx@domaine`), envoyée seulement quand
   le sondage a réussi (1 crédit pour ~24 % des domaines) : si elle est acceptée, le serveur accepte tout et le
   sondage est annulé. Indispensable car ~30 % des domaines cibles sont derrière une passerelle (Mimecast,
   Proofpoint, Barracuda…) qui accepte au périmètre sans être déclarée catch-all ;
3. la contre-épreuve sur un second profil de la même entreprise, quand il y en a un (un « valid » isolé peut être
   une collision de prénom).
L'adresse de contrôle est retirée de l'historique après usage. Budget d'une campagne : ~1,25 crédit par domaine.

**Deux règles mesurées, à ne pas rediscuter** (campagnes des 12 et 13/09/2026) :
- ne sonder qu'un domaine où au moins une adresse a déjà été vue (contact@ compte) : 21 % de réussite ; sur un
  domaine muet, 0 sur 316. `build-probe-input.mjs` applique la règle (`--tout` pour re-mesurer) ;
- un serveur qui n'a pas répondu ne vaut un second essai QUE s'il est sous Microsoft 365 (84 % répondent 12 h
  plus tard, 48 % de formats valides) ; passerelles et Google : 0 sur 25, cul-de-sac.
  `build-retry-input.mjs N out.csv --type "Microsoft 365"` + `UNKNOWN_TTL_HOURS=6` sur enrich.mjs.

Raisons « non trouvé » écrites sur la fiche et quoi en faire : *aucun témoin fiable sur ce domaine* → Hunter (clé absente) ou
attendre un 2e prospect de la même entreprise ; *nom masqué par Sales Navigator* → ouvrir le profil LinkedIn (rien à faire côté script) ;
*vérificateur sans réponse (M365/Google)* → re-sondé automatiquement après 48 h ; *pas de MX* → chercher le domaine e-mail (§ 4 règle MX) ;
*adresse générée refusée* → le pattern est douteux, ne pas forcer ; *domaine inconnu* → § 3.

## 8. Dépannage (symptôme → action)

- `Brave HTTP 402` : crédits épuisés → arrêter, demander la recharge. `422 SUBSCRIPTION_TOKEN_INVALID` : clé mal copiée dans `.env`.
- `pattern : — (inconnu (vérificateur muet))` sur toutes les entreprises : quota non remis ou API en panne → test curl (§ 2), attendre.
- `ABANDON : un enrich.mjs tourne déjà` : attendre la fin (`pgrep -af '^node --no-warnings enrich.mjs'`) ; ne pas tuer.
- Tâche de fond du harnais « stopped because the system is running low on memory » : le process **nohup** continue, seul le
  guetteur est mort → relancer un guetteur (`until grep -q 'terminée' $R/NOTES.txt; do sleep 30; done`), ne rien relancer d'autre.
- `⏱ délai dépassé` massifs (> 15 %) : charge CPU (agents en parallèle) → laisser finir ; la passe suivante sur cache rattrape.
- `non rapprochés N` dans `verif-apply` : nom du lot ≠ nom du CSV du résolveur → corriger le nom dans le `.result.md`.
- Mémoire VPS : 11,7 Go, swap saturé par des sessions `claude --resume` inactives → le signaler à Santinu, ne pas tuer.
- État corrompu ou résultat aberrant : restaurer `backups/etat-v3.avant-<run>-*.json` et `backups/outreach.avant-<run>.sqlite`
  (arrêter `outreach` avant de remplacer le SQLite : `sudo systemctl stop outreach`, copier, `start`), puis expliquer.

## 9. Historique court (ce que les versions ont appris — ne pas re-tester)

- v1-v2 (2026-09-10/11, 200 profils UK) : moteurs gratuits inutilisables depuis le VPS ; noms masqués irrécupérables ; titres
  collés au nom ; sondage `prenom@` = faux positifs ; greylist = réessayer à +11 min ; sérialiser le vérificateur.
- v3 (page compte Sales Nav comme source de domaine) : 0 homonyme, A+B 24 %.
- Bench (11/09) : +22 % d'A+B à crédits constants (titres UK, liens internes 2 passes, en-têtes navigateur, Cloudflare cfemail,
  GitHub authentifié) ; H3 sitemap et H7 « pattern contredit » annulées ; le scoreur compte les refus **par pattern**.
- Résolveur + agents (11/09) : Brave API seule option ; écrits 87-93 % de bonnes entreprises ; agents récupèrent 78-80 % des différés ;
  règles : requête nue d'abord, contrôle du nom sur la page, signal UK obligatoire, noms courts différés, MX exigé, domaines partagés interdits.
- v5-v6 (11-12/09) : CRM 74 → 149 → **292 e-mails** ; domaines résolveur vérifiés = même taux de refus que Sales Nav (1,2 % de D) ;
  rendement 22 % (longue traîne : 1 prospect/entreprise → C). Recette soir/nuit validée (`run-nuit.sh`).

## 10. Checklist de fin de cycle

- [ ] `NOTES.txt` contient « nuit terminée » ; aucun `exit` non expliqué dans les `*.log`.
- [ ] `upsert.txt` : toutes les lignes rapprochées, 0 introuvable ; aucune adresse D stockée (le script l'interdit — le vérifier dans `mesure-apres.txt`).
- [ ] Mesure avant/après collée dans le rapport ; D ≤ 3 % ; A+B `TOTAL UK` ≥ avant.
- [ ] Lots d'agents : tous les `.result.md` sauvegardés et appliqués (`non rapprochés 0`), précision calculée.
- [ ] Rapport envoyé, mémoire mise à jour, quota du jour et prochaine étape indiqués.
- [ ] Rien envoyé, rien dans Notion, contacts de Yanis intacts, `.env` jamais affiché.

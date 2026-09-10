---
name: enrichissement-email
description: Trouver les e-mails professionnels d'une liste de prospects (prénom, nom, entreprise) sans coût récurrent, entreprise par entreprise — domaine → témoins → pattern → génération → catch-all → vérification → score A/B/C/D. À utiliser pour préparer une campagne de mailing (CISO / RSSI étrangers en priorité) à partir d'un export du CRM Mission Créa.
---

# Enrichissement e-mail « low-hanging fruits »

Principe directeur : **on ne cherche pas profil par profil, on résout entreprise par entreprise.**
Un pattern trouvé une fois débloque tous les contacts de la boîte. Tout le travail mécanique est
fait par `scripts/enrich.mjs` (Node ≥ 20, zéro dépendance) ; ton rôle est de préparer l'entrée,
lancer le script, lire son journal, traiter les cas qu'il laisse de côté, et rendre un CSV scoré.

## Quand l'utiliser

- L'utilisateur veut des e-mails pour une liste de prospects (export CRM, CSV Sales Navigator…).
- Il veut lancer / préparer un mailing et n'a pas d'outil payant d'enrichissement.
- Il demande « le pattern e-mail de telle entreprise ».

Ne pas l'utiliser pour : scraper LinkedIn en masse, envoyer les e-mails (le CRM et ce skill
n'envoient rien — l'envoi passe par Lemlist / Brevo / La Growth Machine), ou trouver des adresses
personnelles (gmail, etc. → hors périmètre).

## Entrée / sortie

**Entrée** — CSV (`;` ou `,`) avec au minimum `prenom`, `nom`, `entreprise` ; colonnes
optionnelles reconnues : `domaine`, `id`, `linkedin_url`, `poste`, `pays`, `À propos`,
`Profil LinkedIn` (les deux dernières sont fouillées pour y trouver des e-mails écrits en clair,
y compris `(at)` / `[dot]`). Les en-têtes du CRM (`Prénom`, `Nom`, `Entreprise`…) sont acceptés tels quels.

Depuis le CRM : filtrer (ex. Pays → Royaume-Uni, Suivi → À contacter) puis **Exporter CSV** ; ou
`curl -b cookie https://missioncrea.clippingatlas.com/api/export.csv` puis filtrer sur la colonne Pays.

**Sortie** — le CSV d'entrée + `domaine`, `email`, `pattern`, `source_pattern`, `nb_temoins`,
`catch_all` (oui / non / inconnu), `verifie` (oui / non / impossible / inconnu), `confiance` (A-D), `note`.

## Commandes

```bash
S=~/.claude/skills/enrichissement-email/scripts   # ou .claude/skills/enrichissement-email/scripts dans le dépôt mission-crea
node $S/enrich.mjs entree.csv sortie.csv --state etat.json              # domaines + témoins + patterns + génération, sans vérification
node $S/enrich.mjs entree.csv sortie.csv --state etat.json --verify     # + catch-all et vérification (100/jour gratuits)
node $S/enrich.mjs entree.csv sortie.csv --state etat.json --hunter     # + Hunter pour les domaines sans témoin (25/mois gratuits)
node $S/enrich.mjs entree.csv sortie.csv --state etat.json --only-domains   # juste résoudre domaines et témoins (rapide, pour inspecter)
```

- **Toujours passer le même `--state`** d'une exécution à l'autre : il mémorise domaines, témoins,
  patterns, résultats de vérification et quota du jour → jamais deux fois la même requête.
- Le journal (stderr) dit pour chaque entreprise : domaine, témoins, pattern et statut. C'est là
  que tu vois quoi traiter à la main.
- Clés : `MYEMAILVERIFIER_KEY` (ou `MYEMAILVERIFIER_KEYS=clé1,clé2` — un compte **par membre de
  l'équipe**, jamais deux comptes pour la même personne), `HUNTER_API_KEY` ; en variables
  d'environnement ou dans `.env` à côté du script (voir `.env.example`, jamais commité). Le quota de
  100/jour est suivi par clé ; le script passe à la clé suivante quand la première est épuisée.
  Sans clé : pas de vérification, `confiance` plafonne à B/C.
- Relancer le lendemain avec `--verify` pour consommer le nouveau quota ; le script reprend la file
  là où elle en était.

## Pipeline (ce que fait le script, et les règles à appliquer à la main sur le reste)

1. **Domaine** — colonne `domaine` si fournie ; sinon recherche web « *entreprise* site officiel »
   en excluant les annuaires (Pappers, Societe.com, LinkedIn, Pages Jaunes…) ; suivi des
   redirections en gardant le domaine racine ; **pas de MX → STOP** ; domaine grand public → STOP.
2. **Témoins** — e-mails **nominatifs** réels observés sur le domaine (jamais `contact@`, `rh@`,
   `info@`…). Sources par rendement : pages du site (`/contact`, `/mentions-legales`, `/legal`,
   `/about`, `/equipe`, `/team`, `/careers`, pied de page), Hunter (1 requête = pattern dominant du
   domaine), profils LinkedIn de la liste (section Infos), GitHub pour les boîtes tech (`git log
   --format='%ae'` sur les dépôts de l'org — à faire à la main), communiqués de presse, offres d'emploi.
3. **Pattern** — chaque témoin est comparé aux noms normalisés (minuscules, sans accents, prénoms
   composés soudés ou avec tiret, particules retirées ou gardées, noms composés en 3 variantes).
   - ≥ 2 témoins concordants → **confirmé** ; 1 témoin → **probable** ;
   - témoins contradictoires (formats multiples, typique des grosses boîtes ou fusions) → **STOP** ou traitement manuel ;
   - **aucun témoin → pas de génération** (on ne devine jamais à l'aveugle).
   Patterns par fréquence décroissante en France : `prenom.nom`, `prenom`, `pnom`, `prenomnom`,
   `prenom_nom`, `nom.prenom`, `p.nom`, `nom`.
4. **Génération** — une adresse par profil avec le pattern du domaine ; un témoin qui correspond à
   un profil de la liste devient son e-mail **observé** (A d'office).
5. **Catch-all** — la première adresse générée du domaine passe au vérificateur ; `catch_all = oui`
   → on ne dépense plus rien sur ce domaine (B max) ; `non` → les autres adresses vont dans la file ;
   `inconnu` / timeout (fréquent sur Google Workspace / M365) → traité comme catch-all.
6. **Vérification** — MyEmailVerifier, 100 / jour gratuits, réponse avec le flag catch-all, pas de
   ping SMTP maison. `valid` → A ; `invalid` → D (et si plusieurs invalides sur un domaine,
   re-questionner le pattern) ; `unknown` / greylisté → rester en B, retenter sous 48 h, puis abandonner.
   Pour monter à 150-300 / jour sans payer : empiler d'autres quotas journaliers (Verifalia 25/jour…)
   en round-robin. Au-delà : crédits à l'unité (5-30 € les 10 000) plutôt qu'un ping SMTP depuis son infra.

## Grille de confiance

| Score | Condition | Usage |
|---|---|---|
| **A** | e-mail observé (témoin) ou pattern confirmé + vérifié OK | envoyer |
| **B** | pattern confirmé + catch-all / non vérifiable | envoyer |
| **C** | pattern probable (1 témoin) + catch-all ou non vérifié | volume réduit, ou après re-vérification |
| **D** | vérification négative / ambiguë | **jamais** |

## Priorisation du volume

1. Entreprises avec **plusieurs profils** dans la liste (un pattern débloque N contacts) — le script trie déjà ainsi.
2. PME / scale-ups avec domaine propre (patterns stables).
3. Boîtes tech (GitHub exploitable).
4. Grosses entreprises (sous-domaines, patterns multiples, catch-all) → fin de pile.
5. Freelances / adresses grand public → skip.

## Ce qu'on ne fait pas

- Scraper LinkedIn en masse (CGU, blocage de compte, RGPD).
- Pinger le SMTP depuis le domaine de prospection ou en rafale (blacklist, délivrabilité).
- Générer sans témoin (bounces) ; envoyer sur du D.
- Conserver plus que nécessaire ; ignorer un désabonnement.

## Cadre légal (rappel court)

- **France** : B2B sur adresse professionnelle nominative possible sur base de l'intérêt légitime
  (RGPD / CNIL) si le message est lié à la fonction, avec opt-out clair et registre de traitement.
- **Royaume-Uni** : PECR — pas de consentement requis vers les « corporate subscribers »
  (sociétés), s'identifier + opt-out ; indépendants = particuliers → consentement.
- **Italie, Allemagne** : consentement préalable en principe, même en B2B nominatif → privilégier
  LinkedIn, e-mail seulement vers `info@` ou en second contact.
- Pays-Bas, Belgique, Suisse, Irlande : régime proche du UK/France en B2B avec opt-out.

## Résultat attendu

Sur un gros volume hétérogène : **40-50 % d'adresses en A/B sans coût**, avec un niveau de confiance
explicite par ligne. Le résidu (C/D, patterns inconnus, catch-all non résolus) part, si besoin, vers
un outil payant (Dropcontact, Lemlist) uniquement sur ce résidu.

## Checklist avant de rendre le résultat

- [ ] Journal lu : entreprises « pattern inconnu / contradictoire » listées à l'utilisateur avec la piste manuelle (site, Hunter, GitHub).
- [ ] Aucune adresse D dans la liste d'envoi ; C signalées comme « volume réduit ».
- [ ] Quota du jour indiqué (`vérifications aujourd'hui : N/100`) et prochaine relance proposée.
- [ ] `--state` conservé (même fichier) pour la suite.
- [ ] Les e-mails trouvés sont reportés dans le CRM (fiche → notes ou import) si l'utilisateur le demande.

# Script RSSI à branches (v2, 18 sept. 2026)

> Version interactive (segment, chrono, cases à cocher, grille à copier) : https://claude.ai/code/artifact/57b964d3-9329-40c5-a33b-4c35fd0dda81 · source `interviews/script-rssi.html`. Page Notion : https://app.notion.com/p/3df7651dd081818daf33fc1693a7dfb4 (texte ci-dessous à y coller quand le workspace aura des blocs disponibles). Construit à partir des 15 entretiens du 10 au 16 septembre, des dix constats F1-F10 et de la trame X-HEC « Script d'interview » (inchangée).

## Règles

- Avant le bloc 5, on ne prononce ni « IA », ni « continu », ni « abonnement », ni « plateforme ». On dit « test d'intrusion », jamais « pentest IA » seul.
- Format : **20 min** (rendez-vous LinkedIn) ou **30 min** (rendez-vous mail). Les questions marquées *(30)* ne se posent qu'en format long.
- ★ = à poser quoi qu'il arrive. Chaque question porte le constat qu'elle teste (F1 à F10).
- Ancrer dans un cas passé et concret (« la dernière fois que… »). Relancer : « pourquoi ? », « dites-m'en plus ».
- Deux personnes : l'une mène, l'autre note dans la fiche CRM.

**Leurs mots** : test d'intrusion · boîte noire / grise / blanche · PASSI · surface exposée · chemin de compromission · contre-audit · remédiation, patcher · criticité · cartographie · unités d'œuvre, jours-homme · IA de confiance.
**À bannir** : token · pentest IA (seul) · couverture continue · plateforme · bug bounty à coût fixe · remplacer le pentester.

**Segments** : **A** grand compte régulé (CISO gouvernance, équipes 10 à 80, DORA, 10 à 30 pentests/an) · **B** ETI industrielle, RSSI seul (1 à 3 personnes, budget en COMEX, TISAX / NIS2 / PASSI, 1 à 2 pentests/an) · **C** PME tech et fintech (2 à 3 cyber, ISO 27001 / SOC 2 / DORA, pentest 6-15 k€ acheté comme preuve client).

## 0. Ouverture (0 → 1 min)

> Merci de nous accorder ce temps. On est trois étudiants d'X-HEC Entrepreneurs et on fait une étude sur la façon dont les entreprises achètent et utilisent les tests d'intrusion. C'est exploratoire, on n'a rien à vendre. On travaille pour Fleuret AI, une jeune entreprise de cyber qui nous a confié l'étude, on vous en dit un mot à la fin. On enregistre pour ne rien perdre, ça reste dans l'équipe ? On en a pour vingt minutes.

Dire « test d'intrusion » et « Fleuret » dès la première minute, sinon « votre projet c'est quoi ? » tombe au milieu de l'entretien.

## 1. Qualifier (1 → 3 min)

Trois questions pour choisir la branche. Si la fiche CRM répond déjà, sauter.

- ★ Vous êtes RSSI à plein temps ? Vous êtes combien sur la sécurité ? → seul avec casquette DSI : **B** · équipe de 10 et plus : **A** · 2-3 cyber dans une boîte tech : **C**
- ★ Qu'est-ce qui vous impose des tests : régulateur, certification, clients ? → DORA, TLPT, appel d'offres : **A** · TISAX, NIS2, PASSI : **B** · ISO 27001, SOC 2, SWIFT, questionnaires clients : **C**
- ★ Comment se décide le budget sécurité, et qui signe ? → COMEX et décharge signée : **B** · enveloppe annuelle et unités d'œuvre : **A** · arbitrage CTO / DG au cas par cas : **C**

## 2. Le dernier pentest, en vrai (3 → 8 min)

Un cas concret, pas des opinions : déclencheur, périmètre, prix, prestataire, critère de choix.

- ★ Racontez-moi votre dernier test d'intrusion : qu'est-ce qui l'a déclenché, sur quel périmètre, qui l'a fait ? *(F1, F7)* — si « c'est annuel » : pourquoi une fois et pas deux, ni zéro ?
- ★ Ça vous a coûté combien, en ordre de grandeur, et qu'est-ce qui vous retient d'en faire plus ? *(F2)* — noter le prix par test et l'enveloppe annuelle.
- Sur quoi vous êtes-vous basé pour choisir ce prestataire ? Vous en changez ? *(F7)* — « quand est le prochain appel d'offres ? »
- Pourquoi n'étiez-vous pas satisfait du précédent ? *(F7, 30)*

**Branche A** : ★ Dans votre appel d'offres, comment sont définies les unités d'œuvre, et combien restent non consommées en fin d'année ? *(F2, F10)* · Pour un TLPT ou un audit DORA, que doit contenir le livrable et qui doit l'avoir signé pour qu'il soit accepté ? *(F1, F6)*
**Branche B** : ★ Quand vous présentez ce budget en COMEX, qu'est-ce qui fait passer ou refuser la ligne ? *(F2)* · Votre audit PASSI ou TISAX, il couvre quoi exactement et qu'est-ce qu'il laisse de côté ? *(F1)* — audit de configuration vs test d'intrusion, réseau industriel inclus ou non.
**Branche C** : ★ Quand un client ou un auditeur exige un pentest dans un questionnaire, qu'accepte-t-il exactement : quelle date, quel périmètre, quelle signature ? *(F1, F6)* · Vous payez déjà un outil de test automatique ? Combien, par quoi (URL, actif, an), et il tient sa promesse ? *(F6, F10)*

## 3. Après le rapport (8 → 12 min)

Le constat le plus partagé : le goulot est dans la remédiation, pas dans la détection. Creuser avec des chiffres.

- ★ Le rapport arrive. Concrètement, il se passe quoi ensuite, et qui fait quoi ? *(F3)* — tickets, priorisation, patch, contre-audit ; « stocké dans un coin » : le faire assumer.
- ★ Sur le dernier rapport, combien de vulnérabilités sont encore ouvertes aujourd'hui, et qui a signé l'acceptation du risque ? *(F3, F8)* — noter le délai réel entre découverte et correction.
- Le goulot, chez vous, c'est trouver les failles ou les corriger ? *(F3)* — puis pourquoi : humain, gestion du changement, décision.
- Si on vous libérait une journée par semaine, quelle tâche vous laisseriez tomber en premier ? *(F3, 30)* — fait sortir reporting, questionnaires clients, revue des tiers.

**Branche A** : Comment vous priorisez entre rapports de pentest, bug bounty, scanners ? Un seul tableau ou plusieurs ? *(F3)*
**Branche B** : Une faille critique tombe un vendredi soir : il se passe quoi, en combien d'heures ? *(F8)*
**Branche C** : ★ Entre la mise en prod d'un sprint et le moment où c'est testé, il se passe combien de temps ? Vous voudriez le déclencher depuis la CI/CD ? *(F3, F8)* — qui accepte le risque entre deux tests ?

## 4. Entre deux tests (12 → 14 min)

Ne pas dire « continu ». Tester si le trou entre deux tests est un risque accepté, déjà couvert, ou une douleur. Faire sortir l'inventaire et les tiers.

- ★ Entre deux tests, qu'est-ce qui tourne pour vous rassurer ? Et ce qui reste à découvert, c'est accepté par qui ? *(F5)* — « risque accepté » sans hésiter = segment peu réceptif au récurrent.
- ★ Vous avez une liste à jour de ce qui est exposé sur internet ? Qui la tient, depuis quand ? *(F4)*
- D'où sont venus vos derniers incidents ? *(F9)* — souvent les tiers ; « vous testez vos tiers ? vous pourriez leur imposer un test ? »

**Branche A** *(30)* : Vous évaluez combien de sous-traitants par an ? Un test imposé à moins de 5 000 € remplacerait-il le questionnaire ? *(F9, F10)*
**Branche B** *(30)* : Votre réseau industriel est dans le périmètre des tests ? Qui y touche ? *(F4)*
**Branche C** *(30)* : Vos dépendances et packages, vous les suivez comment ? *(F4, F9)*

## 5. Réaction à l'offre (14 → 19 min)

Présenter en trente secondes, dans leurs mots. Puis faire sortir les trois objections connues plutôt qu'attendre qu'elles viennent.

> Fleuret fait des tests d'intrusion réalisés par des agents logiciels, avec un pentester qui relit et signe : un test étendu livré en quelques heures au lieu de deux semaines, avec les chemins de compromission et un rapport prêt à ticketer. Hébergé en France. Ce qu'on explore : au lieu d'un test par an, vous achetez l'équivalent de dix tests étendus à consommer dans l'année, sur les périmètres et au moment que vous choisissez, par exemple à chaque grosse mise en prod.

- ★ Première réaction ? Qu'est-ce qui vous fait tiquer ? *(F6)*
- ★ Quels outils de test automatisés vous avez déjà évalués ou vus en démo, et pourquoi vous n'avez pas signé ? *(F6)* — objection « ça existe déjà ».
- ★ À qui montrez-vous le rapport en dehors de votre équipe, et qu'est-ce qui le rend acceptable pour eux ? *(F6, F1)* — objection « pas de valeur de preuve ».
- La dernière fois qu'un test a perturbé la production, ça s'est passé comment ? Quelles garanties vous exigez depuis ? *(F6)* — objection « ça va casser la prod ».
- ★ Un test étendu de ce type, vous le paieriez combien ? Vous pouvez dire zéro. Et l'équivalent de dix tests dans l'année ? *(F10, F2)* — nos chiffres seulement s'il ne se prononce pas : un test sous 5 000 €, le pool autour de 20 000 €. Noter ce qu'il retirerait du budget pour le financer.
- Un hébergement sur un cloud américain : non ferme ou négociable ? *(F6, 30)*
- Qu'est-ce qui ferait que vous n'achèteriez jamais ? *(F6, 30)*

**Branche A** : ★ Ce pool de tests, il rentrerait dans vos unités d'œuvre de l'appel d'offres, ou à côté ? Et pour vos sous-traitants ? *(F10, F9)* — Pentera et le bug bounty occupent déjà la place du « continu » : entrée par les tiers et les nouvelles applis.
**Branche B** : ★ Qui signe 20 000 € chez vous, et en combien de temps ? Vous commenceriez plutôt par un petit test pour voir ? *(F10, F2)* — segment le plus réceptif si livrable actionnable, hébergement souverain, caution humaine : vérifier les trois.
**Branche C** : ★ Par rapport à ce que vous payez déjà par URL ou par an, vous préféreriez payer par actif, par test, ou en abonnement ? *(F10)* — le récurrent est rejeté ici : chercher le test à la demande à prix plancher qui passe chez l'auditeur.

## 6. Clôture (19 → 20 min)

- ★ Quelle question on aurait dû vous poser ?
- ★ Vous connaissez deux personnes concernées à qui on pourrait parler ? On peut dire que ça vient de vous ? — proposer en échange un scan externe gratuit ou une checklist DORA / NIS2.
- On vous envoie la synthèse ? On peut vous recontacter ?

Dans l'heure : audio déposé dans le CRM (la fiche passe en Interviewé), grille ci-dessous remplie dans la fiche contact.

## Grille de compte rendu

| Champ | À noter |
|---|---|
| Segment | A / B / C, temps plein, taille équipe, réglementation |
| Dernier pentest | Déclencheur, périmètre, prix, prestataire, critère de choix |
| Après le rapport | Qui fait quoi, vulnérabilités ouvertes, délai de remédiation, qui signe le risque |
| Entre deux tests | Outils en place, risque accepté ou non, inventaire, tiers |
| Réaction à l'offre | Première réaction, outils déjà évalués, preuve acceptable, prod, prix dit, hébergement |
| Objections | Dans ses mots |
| Verbatims | Deux ou trois phrases, avec minute |
| Constats | F confirmés / nuancés / contredits |
| Suite | Mises en relation, recontact, synthèse promise |

## Les dix constats testés

F1 pentest acheté comme preuve · F2 budget petit, borné par le prix · F3 goulot après le rapport · F4 « visibilité » = connaître son SI · F5 continu souhaité en principe, rejeté en pentest · F6 IA accélérateur oui, signataire non · F7 humain rare, réputation, rotation annuelle · F8 le KPI devient le délai de remédiation · F9 tiers = première source d'incident · F10 pool et crédits oui, « token » non.

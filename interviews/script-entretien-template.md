# Script d'entretien — Mission Fleuret AI (template v1, 2026-09-18)

Trame de 45 min pour un entretien exploratoire avec un RSSI / CISO / DSI (ou CTO de startup certifiée).
Structure = les 8 blocs de l'« Interview Table » X-HEC, remplis avec nos questions (page Notion « Hypothèses »)
et celles qui ont bien fonctionné dans les 14 premiers entretiens.

**Règle d'or : on ne présente l'idée qu'au bloc 8.** Avant, on ne dit jamais « pentest IA », « continu » ni « abonnement » :
c'est à l'interviewé de mettre ces mots sur la table. Si on les prononce trop tôt, tout le reste de l'entretien est biaisé.

Légende : **★** = question à poser absolument · ↳ = relance si la réponse est courte · ⏱ = minutage indicatif.

---

## 0. Avant l'appel (5 min de préparation)

- Fiche CRM ouverte (`https://missioncrea.clippingatlas.com/#p=…`) : titre, entreprise, taille, secteur, profil LinkedIn aspiré.
- Repérer d'avance : secteur réglementé ? (banque, santé, industrie, assurance, e-commerce) · taille (200-5 000 = cœur de cible) · RSSI dédié ou casquette partagée.
- Enregistrement : demander l'accord au début, déposer l'audio dans le CRM à la fin (la fiche passe en « Interviewé »).
- Deux personnes idéalement : une qui mène, une qui note dans la grille (§ 9).

## 1. Introduction (⏱ 0-3 min)

> Bonjour, merci de nous accorder ce temps. On est trois étudiants d'X-HEC Entrepreneurs. Dans le cadre de notre mission
> de création, on fait une étude sur le marché de la cybersécurité, et en particulier sur la façon dont les entreprises
> testent leur sécurité. Aucune démarche commerciale : on cherche à comprendre votre réalité et votre ressenti.
> Ça prend 45 minutes. Est-ce que ça vous va qu'on enregistre pour ne rien perdre ? Ça reste entre nous.

À dire tout de suite, avant qu'on nous le demande (ça a créé de la confusion chez Baccarat) :
> On travaille avec une jeune entreprise de cyber, Fleuret AI, qui nous a confié cette étude. On vous en dira un mot à la fin si ça vous intéresse.

## 2. Profil et enjeux (⏱ 3-10 min)

Objectif : qualifier l'interviewé (segment, maturité, contraintes) et faire remonter ses vrais sujets, sans orienter.

- **★** Vous êtes RSSI à temps plein ? Combien de personnes s'occupent de la sécurité de l'information chez vous ?
- **★** Quelles sont les problématiques que vous rencontrez au quotidien dans votre fonction ?
  ↳ Qu'est-ce qui vous prend le plus de temps ? Qu'est-ce qui vous empêche de dormir ?
- **★** À quelles réglementations ou certifications êtes-vous soumis ? (NIS2, DORA, ISO 27001, SOC 2, TISAX, HDS, PCI-DSS…)
  ↳ Concrètement, qu'est-ce que ça vous impose ? À quelle fréquence ?
- Sur une échelle de 1 à 10, où votre direction place-t-elle la cybersécurité ? Qu'est-ce qui vous fait dire ça ?
  ↳ Comment se décide le budget ? (COMEX mensuel, arbitrage DSI, signature de décharge…)
- Le périmètre à protéger s'est-il beaucoup élargi ces dernières années ? (cloud, API, industriel, IA…)
- **★** Avez-vous déjà vécu un incident cyber ? Racontez-moi. Comment ça s'est passé après ?
  ↳ Qu'est-ce que vous avez changé ensuite ?

## 3. Pratiques actuelles : comment vous testez votre sécurité (⏱ 10-20 min)

Objectif : comprendre les solutions en place, sans dire « pentest » en premier. Si l'interviewé ne le dit pas, on demande « des tests d'intrusion ? ».

- **★** Comment vous assurez-vous aujourd'hui que votre système est sûr ? Quels outils, quels prestataires ?
- **★** Vous faites combien de pentests par an ? Sur quel périmètre ? (appli, infra, réseau, OT…)
  ↳ Comment est décidée cette fréquence ? Qui la décide ?
- **★** Qu'est-ce qui a déclenché vos derniers pentests ? (certification, nouveau projet, incident, exigence client, assurance…)
- **★** Qui les réalise ? Comment avez-vous choisi ce prestataire ? Sur quels critères ? (réputation, PASSI, prix, bouche-à-oreille)
  ↳ Vous en avez changé récemment ? Pourquoi ?
- Entre deux pentests, qu'est-ce qui tourne ? (scanners de vulnérabilités, EDR, SOC, bug bounty…)
- **★** Quelle part de votre budget sécurité représentent les pentests ? Ordre de grandeur d'un pentest chez vous ?
  (Les RSSI répondent volontiers en fourchette : « entre 5 et 15 k€ », « 100 k€ par an ».)
- Utilisez-vous l'IA aujourd'hui, en interne ou dans vos pratiques cyber ? Comment ? Qu'est-ce qui vous freine ?

## 4. Séquence d'usage d'un pentest (⏱ 20-27 min)

Objectif : le déroulé réel, étape par étape, pour repérer où ça coince.

- **★** Racontez-moi le dernier pentest, du cadrage au rapport : combien de temps entre la décision et le début ? Durée ? Restitution ?
- **★** Comment les vulnérabilités remontent-elles aux équipes techniques ? Qui suit la remédiation ? Combien de temps ça prend ?
  ↳ Vous refaites tester après correction ? Comment ?
- Que faites-vous du rapport ensuite ? (COMEX, certificateur, assureur, clients)
- Combien d'applications ou de périmètres avez-vous à sécuriser ? Tous sont testés ?

## 5. Ce qui marche bien : critères à conserver (⏱ 27-30 min)

- **★** Qu'est-ce qui vous plaît dans votre façon de faire actuelle ? Qu'est-ce qu'il ne faudrait surtout pas perdre ?
- Qu'est-ce qui fait un bon pentest, pour vous ? Un bon pentesteur ?
- Que vaut la signature du prestataire (nom, certification PASSI) auprès de votre direction, de vos clients, du certificateur ?

## 6. Ce qui coince : insatisfactions (⏱ 30-35 min)

- **★** Quels sont les plus gros défauts des pentests tels que vous les vivez ? (coût, délai, périmètre figé, rapport trop long, faux positifs, photo à un instant T…)
- **★** En toute transparence : ne pas avoir de visibilité entre deux pentests, c'est un vrai problème pour vous ou un risque accepté ?
  ↳ Qu'est-ce que vous faites quand une grosse mise en production tombe entre deux tests ?
- Quelle est la chose la plus urgente à changer ? Pourquoi celle-là ?
- Quel indicateur aimeriez-vous améliorer en priorité ? (temps de remédiation, couverture, coût, fréquence)

## 7. L'idéal (⏱ 35-38 min)

- **★** Si vous aviez une baguette magique, comment ça se passerait ? Fréquence, format, prix, restitution.
- **★** Dans l'idéal, combien de tests feriez-vous par mois, ou par gros projet ?
- Qu'est-ce qui serait indispensable ? Qu'est-ce qui serait un plus ?
- Quel impact sur votre organisation, votre budget, votre sommeil ?

## 8. Réaction à l'idée Fleuret (⏱ 38-44 min)

Présenter en 30 secondes, sans vendre :
> Fleuret AI fait des pentests réalisés par des agents IA : un test complet en quelques heures au lieu de deux semaines,
> avec rapport et scénarios d'attaque. L'idée qu'on explore : passer d'un pentest ponctuel à une couverture continue,
> un test approfondi par an, plus des tests intermédiaires réguliers qui reprennent les résultats précédents
> et vos nouvelles mises en production, avec une application où vous suivez l'état de votre sécurité en continu.

- **★** Première réaction ? Qu'est-ce qui vous fait tiquer ?
- **★** Voyez-vous une différence de valeur entre un pentest IA, un test de vulnérabilité et un scan automatique ?
  (Laisser l'interviewé définir les termes : la confusion est fréquente et c'est une info en soi.)
- **★** Un pentest IA complet livré en quelques heures : le paieriez-vous au même prix qu'un pentest humain de deux semaines ? Pourquoi ?
- **★** Pensez-vous qu'un pentest IA soit accepté pour votre certification, votre assureur, vos clients ? Vous l'avez déjà vérifié ?
- **★** Vous préféreriez une fréquence fixe (un test intermédiaire par mois) ou des crédits à dépenser dans l'année ?
- **★** Combien seriez-vous prêt à payer pour ça, par an ? Vous pouvez dire zéro.
  ↳ Et si c'était 20 k€ ? (donner le chiffre seulement s'il ne se prononce pas)
- Des tests intermédiaires trouveraient-ils des choses pertinentes chez vous, ou pas grand-chose entre deux gros tests ?
- **★** Selon vous, quelles sont les failles de cette idée ? Qu'est-ce qui ferait que vous n'achèteriez jamais ?
- Vous préféreriez ça en complément de vos pentesteurs actuels, ou à la place ?

## 9. Clôture (⏱ 44-45 min)

- **★** Quelle question aurait-on dû vous poser ?
- **★** Connaissez-vous d'autres personnes à qui parler ? (RSSI d'autres secteurs, DSI, certificateur, courtier assurance) Pouvez-vous nous mettre en relation ?
- Peut-on vous recontacter pour un retour sur ce qu'on aura appris ? Voulez-vous une synthèse de l'étude ?
- Remercier. Déposer l'audio dans le CRM, remplir la grille dans l'heure.

---

## Grille de compte rendu (une ligne par entretien, à copier dans Notion)

| Champ | À remplir |
|---|---|
| Interviewé | Nom, poste, entreprise, taille, secteur, temps plein ou non, taille de l'équipe sécu |
| Réglementations | Lesquelles, ce qu'elles imposent (fréquence de pentest) |
| Enjeux prioritaires | Ses trois sujets, dans ses mots |
| Pratiques actuelles | Nb de pentests/an, périmètre, prestataire, critères de choix, budget, outils entre deux tests, usage de l'IA |
| Déclencheurs et motivations | Certification / projet / incident / client / peur |
| Séquence d'usage | Délai de démarrage, durée, restitution, remédiation, re-test |
| Ce qu'il veut garder | Critères de qualité, valeur de la signature humaine |
| Insatisfactions | Défauts cités, continuité = vrai problème ou risque accepté |
| Idéal | Fréquence rêvée, format, prix |
| Réaction à l'idée | Première réaction, valeur perçue pentest IA vs humain, acceptation certification, prix accepté, préférence fréquence vs crédits, failles citées |
| Typologie | Ouvert à l'IA / fermé / zone grise · cœur de cible (200-5 000, réglementé) oui/non |
| Verbatims | Deux ou trois phrases à citer telles quelles |
| Suite | Mises en relation obtenues, recontact souhaité |

## Pièges vus dans les premiers entretiens

- Expliquer la mission de façon trop abstraite (« on doit trouver un besoin produit ») : l'interviewé ne comprend pas ce qu'on attend de lui. Dire simplement « étude sur la façon dont les entreprises testent leur sécurité ».
- Sauter à l'IA dès la présentation : on n'apprend plus rien sur ses pratiques réelles.
- Poser des questions fermées (« vous faites des pentests ? ») : préférer « comment vous assurez-vous que… ».
- Laisser passer un chiffre vague : toujours demander un ordre de grandeur (budget, délai, fréquence).
- Oublier la mise en relation : c'est le meilleur canal pour atteindre les 100 entretiens.

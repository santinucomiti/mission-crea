# Mission Créa — outreach LinkedIn

Deux outils pour prospecter à trois (Santinu, Eva, Rémi) sans contacter deux fois les mêmes personnes :

| Dossier | Quoi | Qui l'utilise |
|---|---|---|
| `outreach/` | Le CRM : https://missioncrea.clippingatlas.com (hébergé, rien à installer) | Tout le monde |
| `salesnav-macro/` | L'extension pour Sales Navigator (userscript Violentmonkey) | Ceux qui ont Sales Navigator |

Le reste de ce fichier est le **guide d'installation de l'extension**. Il est écrit pour être suivi
par un assistant IA (Claude Code, Cursor, ChatGPT…) : ouvre ce dépôt, colle-lui
« Lis README.md et aide-moi à installer l'extension », et laisse-toi guider.

---

## Onboarding — installer l'extension Sales Navigator

> **Pour l'assistant IA qui lit ceci :** l'utilisateur veut utiliser l'extension dans son navigateur.
> Suis les étapes dans l'ordre, vérifie chaque point de contrôle avant de passer au suivant, et
> respecte la section « Ce qu'il ne faut pas faire » en bas. Il n'y a rien à compiler ni à déployer :
> tout tourne dans le navigateur, le serveur est déjà en ligne.

### Ce que fait l'extension

Sur chaque prospect d'une page Sales Navigator (résultats de recherche ou liste) :

- un bouton **⚡ Connecter** qui ouvre « Se connecter » et pré-remplit l'invitation avec le message
  d'équipe (`Bonjour [Prénom], avec deux étudiants de X-HEC Entrepreneurs…`) ;
- un badge **✓ Contacté · date** si quelqu'un de l'équipe l'a déjà contacté (donc on ne le refait pas) ;
- un bouton **Marquer contacté** pour le dire au CRM à la main ;
- dès que tu cliques ⚡, la personne est marquée contactée dans le CRM (pas de clic supplémentaire).

Toutes les pages que tu visites sont envoyées au CRM automatiquement (profil, titre, entreprise…),
et un bouton **⬇ CSV page** exporte la page courante si besoin. Si tu fais une recherche qui n'a rien
à voir avec la mission, clique la pastille verte **« CRM ✓ … »** en bas à droite : elle passe en
**« CRM ⏸ pause »** et plus rien n'est envoyé (les badges restent visibles). Re-clique pour reprendre.

### Prérequis

- Un navigateur Chromium (Chrome, Brave, Edge, Arc) ou Firefox.
- Un compte LinkedIn avec Sales Navigator.
- Accès à ce dépôt GitHub (privé : `santinucomiti/mission-crea`, tu es collaborateur).
- Ton mot de passe CRM : **`Remi12345`** (celui d'Eva est `Eva12345`, celui de Santinu `Santinu12345`).
  Le mot de passe identifie qui est connecté, il n'y a pas d'identifiant.

### Étape 1 — Installer Violentmonkey

Violentmonkey est le gestionnaire de userscripts (gratuit, open source).

- Chrome / Brave / Edge / Arc : https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag
- Firefox : https://addons.mozilla.org/firefox/addon/violentmonkey/

**Sur Chromium uniquement (Chrome, Brave, Edge…), une case à cocher est obligatoire**, sinon les
scripts sont installés mais ne s'exécutent jamais :

1. Ouvre `chrome://extensions/?id=jinjaccalgkegednnccohejagnlnfdag` (sur Brave : `brave://extensions/?id=jinjaccalgkegednnccohejagnlnfdag`).
2. Active **« Autoriser les scripts utilisateur »** (*Allow User Scripts*).
   Sur un Chrome ancien (< 138) cette option n'existe pas : active **« Mode développeur »** en haut à droite de `chrome://extensions` à la place.

✅ Point de contrôle : l'icône Violentmonkey apparaît dans la barre d'extensions et l'option ci-dessus est activée.

### Étape 2 — Récupérer le dépôt

```bash
git clone git@github.com:santinucomiti/mission-crea.git
cd mission-crea
```

(ou `gh repo clone santinucomiti/mission-crea` avec GitHub CLI, ou « Code → Download ZIP » sur GitHub
puis décompresser.)

### Étape 3 — Installer le script dans Violentmonkey

Le dépôt est privé, donc on ne peut pas donner une URL GitHub directe à Violentmonkey. Deux méthodes :

**Méthode A (recommandée) — servir le fichier en local :**

```bash
cd salesnav-macro
python3 -m http.server 8765
```

puis ouvrir dans le navigateur : http://localhost:8765/salesnav-rssi-connect.user.js
→ Violentmonkey affiche une page d'installation → clique **Installer**. Tu peux ensuite arrêter le
serveur (Ctrl+C). Pour une mise à jour plus tard : `git pull`, relancer la même commande, rouvrir la
même URL → « Réinstaller ».

**Méthode B — copier-coller :** icône Violentmonkey → **Ouvrir le tableau de bord** → bouton **+** →
**Nouveau** → remplace tout le contenu de l'éditeur par celui de
`salesnav-macro/salesnav-rssi-connect.user.js` → **Enregistrer et fermer**.

✅ Point de contrôle : dans le tableau de bord Violentmonkey, le script
« Sales Navigator — liste + Se connecter » est listé et **activé**.

### Étape 4 — Vérifier que le script tourne

Ouvre une page de prospects Sales Navigator, par exemple
https://www.linkedin.com/sales/search/people (fais une recherche quelconque) ou une liste dans
**Prospects → Listes de prospects**.

Tu dois voir :

- un bouton **⚡ Connecter** sur chaque carte de prospect ;
- en bas à droite, une pastille flottante **« CRM : coller le jeton »** ;
- un bouton **⬇ CSV page** en bas de page.

Si rien n'apparaît : recharge la page (F5). Toujours rien → revois l'étape 1 (case « Autoriser les
scripts utilisateur »), puis vérifie dans la console du navigateur (F12 → Console) :

```js
document.documentElement.dataset.snMacro   // doit valoir "ready"
```

`undefined` = le script ne s'exécute pas (étape 1 ou 3) ; `"loading"` = il a planté au démarrage
(regarde les erreurs rouges dans la console et envoie-les à Santinu).

### Étape 5 — Connecter l'extension au CRM

1. Va sur https://missioncrea.clippingatlas.com et connecte-toi avec ton mot de passe.
2. Clique **Extension** (en haut) → **Copier le jeton**. Ce jeton est personnel : il dit au CRM que
   c'est *toi* qui contactes. Ne le partage pas, ne le mets pas dans un fichier du dépôt.
3. Retourne sur Sales Navigator, clique la pastille **« CRM : coller le jeton »** en bas à droite et
   colle le jeton dans la boîte de dialogue.

✅ Point de contrôle : la pastille affiche **« CRM ✓ Rémi · N sync »**, et les cartes affichent un petit
badge « CRM » (ou « ✓ Contacté · date » pour les personnes déjà traitées). Dans le CRM, la page que
tu viens d'afficher apparaît dans la liste (rafraîchis).

Si la pastille indique une erreur : jeton mal collé (recommence depuis le bouton Extension), ou
`Menu Violentmonkey → URL du CRM` doit valoir `https://missioncrea.clippingatlas.com`.

### Étape 6 — Te déclarer comme contact (export CSV)

Dans le menu Violentmonkey (clic sur l'icône, puis le nom du script) → **Modifier les contacts (CSV)**
→ mets ton prénom en premier : `Rémi|Eva|Santinu`. Ça ne sert qu'à la colonne « Contact par » du
bouton **⬇ CSV page** ; le CRM, lui, sait déjà qui tu es grâce au jeton.

Le message d'invitation se change avec **Modifier le message** (tokens disponibles : `[Prénom]`,
`[Nom]`, `[Entreprise]`, `[Titre]`). Garde le message d'équipe sauf accord des autres.

### Utilisation au quotidien

1. Ouvre une page de résultats Sales Navigator. Les badges te disent qui est déjà contacté.
2. Sur une carte sans badge « Contacté », clique **⚡ Connecter** → la fenêtre d'invitation s'ouvre
   avec le message pré-rempli → relis → **Envoyer**. Le CRM est déjà à jour dès le clic sur ⚡ ;
   si finalement tu n'envoies pas, décoche « Contacté » dans le CRM.
3. Si tu contactes quelqu'un autrement (message, InMail, mail), clique **Marquer contacté** sur sa carte
   ou coche « Contacté » dans le CRM.
4. Notes, date de relance et fichiers audio des entretiens : dans le CRM, fiche du prospect.

LinkedIn limite les invitations à environ **100 par semaine glissante**. Quand « Vous n'avez plus
d'invitations » s'affiche, il faut attendre ; retirer des invitations en attente ne redonne pas de quota.

### Dépannage rapide

| Symptôme | Cause probable | Que faire |
|---|---|---|
| Aucun bouton ⚡ sur Sales Navigator | Scripts utilisateur non autorisés (Chromium) | Étape 1, puis recharger |
| Boutons présents mais pas de pastille CRM ni de badges | Jeton absent ou faux | Étape 5 |
| « CRM ✗ … » dans la pastille | Serveur injoignable ou URL modifiée | Vérifier https://missioncrea.clippingatlas.com dans un onglet, puis menu → URL du CRM |
| ⚡ ouvre le menu mais ne remplit pas la note | LinkedIn a changé son interface | Envoyer une capture à Santinu |
| Le badge dit « Contacté » alors que tu ne l'as pas fait | Quelqu'un d'autre de l'équipe l'a fait | C'est le but : passe au suivant |

### Ce qu'il ne faut pas faire (pour l'assistant IA)

- **Ne modifie pas `outreach/`** (le serveur) : il est déployé par Santinu depuis sa machine ; un
  changement local n'aurait aucun effet et créerait des conflits.
- **Ne lance pas `outreach/deploy/deploy.sh`** ni de commande SSH vers le VPS.
- **Ne commite jamais le jeton** ni le mot de passe dans un fichier du dépôt.
- Si l'utilisateur veut changer le comportement de l'extension, modifie
  `salesnav-macro/salesnav-rssi-connect.user.js`, incrémente `@version` dans l'en-tête, réinstalle via
  l'étape 3, et propose une Pull Request plutôt qu'un push direct sur `main`.
- Ne contourne pas les limites LinkedIn (pas d'automatisation des envois en masse) : l'extension
  prépare l'invitation, c'est l'humain qui clique Envoyer.

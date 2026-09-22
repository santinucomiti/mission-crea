# Outreach — Mission Créa

Suivi de prospection LinkedIn partagé, alimenté par les exports CSV du userscript
Sales Navigator (`../salesnav-macro`). Une page, une base SQLite, un mot de passe par personne
(le mot de passe identifie qui est connecté — `OUTREACH_USERS` dans `.env`).

Pour chaque prospect : contacté ou non (et quand), interviewé ou non,
date de relance, notes, fichiers audio, message pré-rempli à copier (`[Prénom]`, `[Nom]`, `[Entreprise]`, `[Titre]`).
Les photos de profil sont recopiées sur le serveur au premier affichage (`data/photos/`, route
`/api/photo/:id`) : les URL LinkedIn expirent et les bloqueurs de pub les masquent.

L'installation de l'extension pour un nouveau membre est décrite dans le [README racine](../README.md).

## Lancer en local

```bash
npm install
cp .env.example .env        # puis renseigner OUTREACH_USERS et OUTREACH_SECRET
npm run dev                 # http://127.0.0.1:3500
node scripts/import.js ~/Downloads/salesnav-page*.csv   # import en ligne de commande (optionnel)
```

Node ≥ 22.13 (utilise `node:sqlite`, aucune dépendance native).

## Déployer sur le VPS

Une fois (sur le serveur, en tant qu'`ubuntu`) :

```bash
sudo cp deploy/outreach.service /etc/systemd/system/outreach.service
sudo cp deploy/nginx-outreach.conf /etc/nginx/sites-available/outreach
sudo ln -s /etc/nginx/sites-available/outreach /etc/nginx/sites-enabled/outreach
cp .env.example .env && $EDITOR .env
sudo certbot certonly --webroot -w /var/www/certbot -d missioncrea.clippingatlas.com
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl enable --now outreach
```

Ensuite, depuis ce dossier : `./deploy/deploy.sh` (rsync + restart). La base vit dans
`/home/ubuntu/outreach/data/outreach.sqlite` ; elle n'est jamais écrasée par un déploiement.

DNS : `missioncrea.clippingatlas.com` → A `91.134.141.72` (OVH).

## Sauvegarde de la base (administrateurs)

Trois niveaux de compte, tous définis par prénom dans `.env` : lecture seule (`OUTREACH_READONLY`),
membre (par défaut), administrateur (`OUTREACH_ADMIN`). Un administrateur voit un bouton
**Sauvegarde** dans la barre du haut : `GET /api/admin/backup.sqlite` fait un `VACUUM INTO` (copie
cohérente et compacte, sans bloquer les autres) et renvoie le fichier `outreach-<date>.sqlite`.
Il contient tout (prospects, entreprises, fichiers rattachés, transcripts) sauf les
audios eux-mêmes (`data/files/`, ~400 Mo, à récupérer par `rsync` si besoin). Pour restaurer :
arrêter le service, remplacer `data/outreach.sqlite` (et supprimer `-wal`/`-shm`), redémarrer.

## Synchro avec l'extension Sales Navigator

Dans l'app, bouton **Extension** → jeton personnel (`Authorization: Bearer <prénom>.<mac>`,
dérivé de `OUTREACH_SECRET`, révoqué en changeant le secret). Collé une fois dans le userscript
(bouton flottant « CRM » ou menu Violentmonkey → « Connecter au CRM »), il permet :

- badge sur chaque prospect Sales Navigator : « 🎙 Interviewé », « ✓ Contacté · 9 sept. », ou « CRM » ;
- envoi automatique des pages visitées (`POST /api/sync/upsert`, sans écraser le suivi) ;
- « Marquer contacté » sur la carte, et marquage automatique dès le clic sur le bouton ⚡ ;
- le bouton ⚡ demande confirmation si quelqu'un a déjà contacté la personne ;
- sur `linkedin.com/in/…`, `POST /api/sync/profile` retrouve la fiche (URL, clé d'identifiant commune
  aux ids `ACwAA…`/`ACoAA…`, ou nom unique) et stocke le texte du profil dans `contexte_linkedin`.

## Import

Bouton « Importer un CSV » dans l'app (plusieurs fichiers à la fois, glisser-déposer) ou
`node scripts/import.js fichier.csv`. Clé de dédoublonnage : l'identifiant Sales Navigator
du profil. Un ré-import met à jour les infos du profil sans toucher au suivi.

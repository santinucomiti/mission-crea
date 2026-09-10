# Outreach — Mission Créa

Suivi de prospection LinkedIn partagé, alimenté par les exports CSV du userscript
Sales Navigator (`../salesnav-macro`). Une page, une base SQLite, un mot de passe par personne
(le mot de passe identifie qui est connecté — `OUTREACH_USERS` dans `.env`).

Pour chaque prospect : contacté ou non (qui, quand), contact attribué (Santinu / Eva / Rémi),
date de relance, notes, message pré-rempli à copier (`[Prénom]`, `[Nom]`, `[Entreprise]`, `[Titre]`).

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
sudo certbot certonly --webroot -w /var/www/certbot -d outreach.clippingatlas.com
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl enable --now outreach
```

Ensuite, depuis ce dossier : `./deploy/deploy.sh` (rsync + restart). La base vit dans
`/home/ubuntu/outreach/data/outreach.sqlite` ; elle n'est jamais écrasée par un déploiement.

DNS : `outreach.clippingatlas.com` → A `91.134.141.72` (OVH).

## Import

Bouton « Importer un CSV » dans l'app (plusieurs fichiers à la fois, glisser-déposer) ou
`node scripts/import.js fichier.csv`. Clé de dédoublonnage : l'identifiant Sales Navigator
du profil. Un ré-import met à jour les infos du profil sans toucher au suivi.

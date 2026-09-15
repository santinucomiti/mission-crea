#!/usr/bin/env bash
# Déploie l'app sur le VPS : rsync du code (sans data/ ni .env), puis restart du service.
# Usage : ./deploy/deploy.sh [hôte-ssh]   (défaut : vps)
set -Eeuo pipefail
HOST="${1:-vps}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE=/home/ubuntu/outreach

# Filet de sécurité : si du code a été modifié directement sur le serveur (autre session, correctif à chaud),
# on le montre et on garde une copie datée dans ~/outreach-ecrase/<horodatage>/ avant de l'écraser.
CHANGED=$(rsync -azn --delete --itemize-changes \
  --exclude data/ --exclude .env --exclude node_modules/ --exclude .git/ \
  "$DIR/" "$HOST:$REMOTE/" | grep -E '^[<>]f' | awk '{print $2}' || true)
if [ -n "$CHANGED" ]; then
  echo "Fichiers qui vont changer sur le serveur :"; echo "$CHANGED" | sed 's/^/  /'
fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
rsync -az --delete --backup --backup-dir="/home/ubuntu/outreach-ecrase/$STAMP" \
  --exclude data/ --exclude .env --exclude node_modules/ --exclude .git/ \
  "$DIR/" "$HOST:$REMOTE/"
ssh "$HOST" "[ -d /home/ubuntu/outreach-ecrase/$STAMP ] && echo 'Versions serveur écrasées conservées dans ~/outreach-ecrase/$STAMP' || true"

ssh "$HOST" bash -s <<'EOF'
set -e
cd /home/ubuntu/outreach
if [ ! -f .env ]; then
  echo "Pas de .env sur le serveur : copie .env.example vers .env et renseigne OUTREACH_USERS / OUTREACH_SECRET." >&2
  exit 1
fi
sudo systemctl restart outreach
sleep 1
systemctl is-active outreach >/dev/null && echo "outreach: actif" || { journalctl -u outreach -n 20 --no-pager; exit 1; }
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3500/api/me || true
EOF

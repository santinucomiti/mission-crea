#!/usr/bin/env bash
# Déploie l'app sur le VPS : rsync du code (sans data/ ni .env), puis restart du service.
# Usage : ./deploy/deploy.sh [hôte-ssh]   (défaut : vps)
set -Eeuo pipefail
HOST="${1:-vps}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE=/home/ubuntu/outreach

rsync -az --delete \
  --exclude data/ --exclude .env --exclude node_modules/ --exclude .git/ \
  "$DIR/" "$HOST:$REMOTE/"

ssh "$HOST" bash -s <<'EOF'
set -e
cd /home/ubuntu/outreach
if [ ! -f .env ]; then
  echo "Pas de .env sur le serveur : copie .env.example vers .env et renseigne OUTREACH_PASSWORD / OUTREACH_SECRET." >&2
  exit 1
fi
sudo systemctl restart outreach
sleep 1
systemctl is-active outreach >/dev/null && echo "outreach: actif" || { journalctl -u outreach -n 20 --no-pager; exit 1; }
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3500/api/me || true
EOF

#!/usr/bin/env bash
# Une expérience = état copié + run déterministe (0 crédit) + score. Usage : ./run.sh <tag> [options enrich supplémentaires]
# Le script testé est TOUJOURS bench/enrich-candidate.mjs (jamais ../enrich.mjs, qui peut être en cours d'exécution).
set -euo pipefail
B="$(cd "$(dirname "$0")" && pwd)"
TAG="${1:?tag}"; shift || true
mkdir -p "$B/results" "$B/tmp"
cp "$B/etat-bench.json" "$B/tmp/etat-$TAG.json"
START=$(date +%s)
ENRICH_HTTP_CACHE="$B/cache" node "$B/enrich-candidate.mjs" "$B/bench-uk.csv" "$B/tmp/sortie-$TAG.csv" --state "$B/tmp/etat-$TAG.json" \
  --no-search ${BENCH_GITHUB:+} ${BENCH_GITHUB:---no-github} --refresh-witnesses --concurrency 5 "$@" > "$B/tmp/log-$TAG.txt" 2>&1 || echo "(enrich exit=$?)"
DUR=$(( $(date +%s) - START ))
if [ ! -s "$B/tmp/sortie-$TAG.csv" ]; then
  echo "ÉCHEC : le run n'a produit aucune sortie (voir $B/tmp/log-$TAG.txt, dernières lignes ci-dessous)"; tail -n 3 "$B/tmp/log-$TAG.txt"
  printf '{"failed":true,"A":0,"B":0,"C":0,"D":0,"AB":0,"sans_adresse":0,"dom_confirme":0,"dom_probable":0,"dom_avec_temoin":0,"temoins_site":0,"a_verifier":0,"invariants_ok":false,"violations":["run en échec"]}' > "$B/results/$TAG.json"
else
node "$B/score.mjs" "$B/tmp/sortie-$TAG.csv" "$B/tmp/etat-$TAG.json" --json > "$B/results/$TAG.json" || true
node "$B/score.mjs" "$B/tmp/sortie-$TAG.csv" "$B/tmp/etat-$TAG.json" || true
fi
echo "durée ${DUR}s · log : $B/tmp/log-$TAG.txt"
python3 - "$B/results/$TAG.json" "$TAG" "$DUR" "$B/LEDGER.md" <<'PY'
import json,sys,datetime
m=json.load(open(sys.argv[1])); tag=sys.argv[2]; dur=sys.argv[3]
line=f"| {datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%d %H:%M')} | {tag} | {m['A']} | {m['B']} | {m['C']} | {m['AB']} | {m['sans_adresse']} | {m['dom_confirme']} | {m['dom_probable']} | {m['dom_avec_temoin']} | {m['temoins_site']} | {m['a_verifier']} | {'OK' if m['invariants_ok'] else 'VIOLÉ'} | {dur}s |"
open(sys.argv[4],'a').write(line+"\n")
PY

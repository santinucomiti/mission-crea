#!/usr/bin/env python3
"""Décision garder / annuler pour une expérience : python3 judge.py <ref.json> <new.json>
Règle (écrite, appliquée mécaniquement) :
  - invariants violés            → REVERT
  - taux de D (D / adresses générées) monte de plus d'un point → REVERT (proxy de bounce : de faux patterns)
  - suspects (B/C non vérifiés sur un domaine à ≥ 2 refus et 0 succès) augmentent → REVERT
  - score = 3·(A+B) + 2·dom_confirme + dom_probable + dom_avec_temoin − 3·suspects
    strictement supérieur        → KEEP
  - score égal et sans_adresse strictement inférieur → KEEP
  - sinon                        → REVERT
"""
import json, sys
ref = json.load(open(sys.argv[1])); new = json.load(open(sys.argv[2]))
gen = lambda m: m['A'] + m['B'] + m['C'] + m['D']
dr = lambda m: (m['D'] / gen(m)) if gen(m) else 0.0
score = lambda m: 3 * m['AB'] + 2 * m['dom_confirme'] + m['dom_probable'] + m['dom_avec_temoin'] - 3 * m.get('suspects', 0)
delta = lambda k: f"{k} {ref.get(k, 0)}→{new.get(k, 0)}"
keys = ['A', 'B', 'C', 'D', 'AB', 'suspects', 'sans_adresse', 'dom_confirme', 'dom_probable', 'dom_avec_temoin', 'temoins_site']
summary = ' · '.join(delta(k) for k in keys if ref.get(k, 0) != new.get(k, 0)) or 'aucun changement'
if new.get('failed'): verdict, why = 'REVERT', 'run en échec (aucune sortie)'
elif not new['invariants_ok']: verdict, why = 'REVERT', 'invariants violés : ' + '; '.join(new['violations'][:3])
elif new.get('suspects', 0) > ref.get('suspects', 0): verdict, why = 'REVERT', f"suspects {ref.get('suspects', 0)}→{new.get('suspects', 0)} (B/C sur un domaine contredit par le vérificateur)"
elif dr(new) > dr(ref) + 0.01: verdict, why = 'REVERT', f"taux de D {dr(ref):.1%}→{dr(new):.1%} (+ de 1 pt : faux patterns probables)"
elif score(new) > score(ref): verdict, why = 'KEEP', f"score {score(ref)}→{score(new)}"
elif score(new) == score(ref) and new['sans_adresse'] < ref['sans_adresse']: verdict, why = 'KEEP', 'score égal, moins de profils sans adresse'
else: verdict, why = 'REVERT', f"score {score(ref)}→{score(new)} (pas d'amélioration stricte)"
print(f"{verdict} — {why} — {summary}")
sys.exit(0 if verdict == 'KEEP' else 1)

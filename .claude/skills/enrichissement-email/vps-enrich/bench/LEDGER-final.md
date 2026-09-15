# Journal des expériences — bench UK 217, zéro crédit (--no-search --no-github --refresh-witnesses, cache HTTP)
# Toutes les lignes re-scorées avec le scoreur définitif (invariants, suspects et domaines contredits comptés par pattern).

| tag | A | B | C | D | A+B | suspects | sans adresse | dom. confirmé | dom. probable | dom. contredit | dom. avec témoin | témoins site | invariants | décision |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline3 | 36 | 15 | 8 | 7 | 51 | 0 | 151 | 30 | 18 | 4 | 55 | 200 | OK | référence (script corrigé + H1) |
| h2a-pages | 37 | 18 | 8 | 8 | 55 | 0 | 146 | 33 | 19 | 4 | 63 | 268 | OK | annulée (règle D absolue, trop stricte) — reprise dans h2ab |
| h2b-links | 36 | 18 | 7 | 7 | 54 | 0 | 149 | 33 | 17 | 4 | 65 | 638 | OK | conservée |
| h2ab-pages-links | 37 | 19 | 7 | 8 | 56 | 0 | 146 | 34 | 18 | 4 | 67 | 670 | OK | conservée |
| h4-links-all-pages | 37 | 24 | 11 | 9 | 61 | 0 | 136 | 37 | 20 | 4 | 68 | 801 | OK | conservée |
| h3-sitemap | 37 | 24 | 6 | 8 | 61 | 0 | 142 | 39 | 16 | 4 | 66 | 463 | OK | annulée (sature le plafond de pages) |
| h5-browser-fallback | 37 | 25 | 13 | 9 | 62 | 0 | 133 | 38 | 21 | 4 | 71 | 842 | OK | conservée |
| h6-cfemail | 37 | 25 | 13 | 9 | 62 | 0 | 133 | 39 | 20 | 4 | 71 | 859 | OK | conservée = PROD |
| h7-pattern-contredit | 37 | 22 | 11 | 9 | 59 | 0 | 138 | 37 | 18 | 4 | 71 | 859 | OK | conservée puis annulée : ses « suspects » étaient des faux positifs |
| h3-sitemap-sur-h7 | 37 | 24 | 9 | 8 | 61 | 0 | 139 | 39 | 16 | 4 | 69 | 514 | VIOLÉ | annulée (invariant violé : dws.com) |
| h7b-contredit-par-pattern | 37 | 25 | 13 | 9 | 62 | 0 | 133 | 39 | 20 | 4 | 71 | 859 | OK | annulée (0 effet une fois les refus comptés par pattern) |

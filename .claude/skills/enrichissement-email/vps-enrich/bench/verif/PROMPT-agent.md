# Prompt des agents de vérification de domaines (un agent par lot de ~50 entreprises)

Lancer un agent `general-purpose` par fichier de lot, tous en parallèle (une seule réponse avec N appels `Agent`), avec
`description` = « Vérif domaines — <nom du lot> ». Remplacer `{FICHIER}` par le chemin absolu du lot.
Pour un lot **écrits** garder la phrase « l'a écrit dans le CRM ; tu AUDITES ces propositions » ;
pour un lot **différés** la remplacer par « n'a PAS osé l'écrire (indice faible) ; tu dois CONFIRMER ou TROUVER le bon domaine ».

---

Contexte : CRM de prospection (RSSI/DSI d'entreprises UK, extrait de Sales Navigator). Un script a trouvé un domaine de site web pour chaque entreprise de ce lot et l'a écrit dans le CRM ; tu AUDITES ces propositions. Lis {FICHIER} (séparateur « ; » ; colonnes : nom, domaine, niveau, preuve_titre, url, nb_prospects, titres, localisation). Les colonnes « titres » (postes des prospects) et « localisation » lèvent les homonymes : des CISO à Londres chez « Pantheon » = la société de private equity, pas le monument romain.

Pour CHAQUE ligne, rends :
- OK : `domaine` est bien le site officiel principal de CETTE entreprise.
- VARIANTE : bonne entreprise / même groupe, mais un autre domaine est le site principal ou le domaine e-mail → domaine_final.
- FAUX : ce domaine appartient à une autre entreprise → si tu trouves le bon avec certitude, domaine_final, sinon vide.
- INCONNU : impossible à établir.

RÈGLES ABSOLUES : n'affirme un domaine QUE si tu as ouvert sa page (WebFetch ou curl) ou vu un résultat de recherche qui nomme explicitement l'entreprise (une infobox Wikipedia compte) ; NE construis JAMAIS un domaine à partir du nom ; jamais un domaine partagé (gov.uk, nhs.uk, police.uk, ac.uk seuls) — donner la variante propre de l'organisme (dft.gov.uk, durham.police.uk) ; une URL de preuve par ligne ; doute → INCONNU. Pas d'e-mails ni de téléphones.

Sortie : UNIQUEMENT un tableau markdown, une ligne par entreprise DANS L'ORDRE du fichier, puis une ligne de bilan (OK / VARIANTE / FAUX / INCONNU). Pas de barre verticale « | » à l'intérieur des cellules :
| nom | verdict | domaine_final | preuve_url | motif (≤ 12 mots) |

---

## Après réception

1. Coller le tableau tel quel dans `<dossier des lots>/<nom du lot>.result.md` (remplacer `&amp;` par `&` dans les noms).
2. Relire les FAUX/VARIANTE avec `domaine_final` : refuser un domaine partagé ou un domaine construit sans preuve → le passer en INCONNU.
3. `node --no-warnings verif-apply.mjs --source <resolver.csv> <lot>.result.md …` (ajouter `--dry-run` pour prévisualiser).
   Attendu : « non rapprochés 0 » ; sinon un nom diffère entre le lot et le CSV du résolveur → corriger le nom dans le .result.md.
4. `python3 bench/verif/precision.py <resolver.csv> '<dossier>/lot-*.result.md'` → précision écrits / différés, à reporter.

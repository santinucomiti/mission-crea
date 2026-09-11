---
name: transcription
description: Transcrire un entretien enregistré (audio ou .mp4 déposé dans le CRM Mission Créa) en texte horodaté, avec faster-whisper en local (GPU) et un prompt de contexte métier (acronymes cybersécurité, noms des participants, entreprise) construit à partir de la fiche CRM. À utiliser pour vérifier la qualité d'un transcript, produire un compte rendu, ou alimenter les notes / Notion.
---

# Transcription d'entretien (faster-whisper + contexte CRM)

Tout tourne en local sur la machine de Santinu (RTX 5060, 8 Go) : aucun audio ne sort de l'ordinateur.
Le script fait la mécanique ; ton travail est de **préparer le contexte** (c'est ce qui fait la qualité
sur les acronymes), lancer, puis **relire** le résultat avant de le rendre.

## Environnement (déjà en place, ne rien installer sans demander)

- Python : `~/Work/nestjs-course/.venv/bin/python` (faster-whisper 1.2.1 + CUDA fonctionnel).
- Modèle : `mobiuslabsgmbh/faster-whisper-large-v3-turbo`, déjà dans le cache Hugging Face
  (`~/.cache/huggingface/hub/`). Qualité large-v3, ~6× plus rapide. `Systran/faster-whisper-medium`
  est aussi en cache (moins bon en français, à éviter).
- `ffmpeg` installé (extraction de la piste audio des `.mp4`).
- Vitesse observée : 90 s d'audio en 28 s chargement du modèle compris ; ~1 min de calcul pour 10 min d'audio.

## Étapes

1. **Récupérer l'audio** : les enregistrements sont dans le CRM (`https://missioncrea.clippingatlas.com`,
   fiche → Fichiers). Depuis le terminal, se connecter puis télécharger :
   ```bash
   curl -s -c /tmp/cj -X POST https://missioncrea.clippingatlas.com/api/login -H 'content-type: application/json' -d '{"password":"Santinu12345"}'
   curl -s -b /tmp/cj https://missioncrea.clippingatlas.com/api/prospects > /tmp/crm.json      # fiches (notes, titre, entreprise, contexte)
   curl -s -b /tmp/cj https://missioncrea.clippingatlas.com/api/prospects/<id>/files                # liste des fichiers
   curl -s -b /tmp/cj -o entretien.mp4 https://missioncrea.clippingatlas.com/api/files/<file id>
   ```
2. **Construire le contexte** (`contexte.json`) depuis la fiche CRM : `nom`, `entreprise`, `titre`,
   `interviewers` (qui de Santinu / Eva / Rémi menait l'entretien — demander si inconnu), `termes` =
   noms propres et acronymes attendus (produits, concurrents, certifications cités dans les notes ou le
   profil LinkedIn aspiré : `contexte_linkedin`), `notes` = résumé des notes existantes. Les termes
   génériques du métier sont déjà dans `glossaire.txt` ; n'y ajouter que ce qui est spécifique à cet
   entretien. Orthographe exacte : Whisper recopie ce qu'on lui donne.
3. **Lancer** (toujours via `run.sh` : il exporte le `LD_LIBRARY_PATH` vers les bibliothèques cuBLAS/cuDNN
   embarquées par Ollama dans `/usr/local/lib/ollama/`, sans quoi ctranslate2 ne trouve pas le GPU) :
   ```bash
   .claude/skills/transcription/scripts/run.sh entretien.mp4 --out transcripts/<prenom-nom>.txt --context contexte.json --lang fr
   ```
   `--lang en` pour un entretien en anglais (Luis Gomes de Abreu, CISO UK…) ; `--max-seconds 120`
   pour un essai rapide. Le script affiche les segments au fil de l'eau sur stderr.
4. **Relire** : le `.txt` porte un `⚠` sur les segments peu sûrs (`avg_logprob < -0.8`) — les
   vérifier en priorité ; les hallucinations typiques de Whisper sont des phrases répétées, des
   « Sous-titres réalisés par… », ou du texte pendant un silence (le VAD en enlève la plupart).
   Corriger à la main les noms propres mal orthographiés, puis réutiliser les bonnes formes dans
   `termes` pour les entretiens suivants.
5. **Rendre** : le transcript horodaté, puis un court paragraphe « qualité » (langue détectée, nombre
   de segments ⚠, termes mal reconnus repérés). Ne pas résumer l'entretien sauf demande.

## Ce que fait le prompt de contexte (et ses limites)

- `initial_prompt` : texte ≤ 224 jetons que Whisper lit comme s'il précédait l'audio. Il fixe la langue,
  la ponctuation et l'orthographe des mots qu'il contient (« NIS2 », « pentest », « RSSI »). Il agit
  fortement sur les 30 premières secondes puis se propage par conditionnement sur le texte déjà produit.
- `hotwords` (faster-whisper) : liste de mots favorisés pendant tout le fichier, sans consommer le prompt —
  y mettre les noms des participants et de l'entreprise.
- Whisper ne comprend pas des définitions : donner les sigles écrits correctement, pas leur explication.
- Pas de diarisation (qui parle) : les segments ne sont pas attribués aux locuteurs. Si c'est utile,
  demander avant d'ajouter un outil (pyannote nécessite un compte Hugging Face).

## Stockage

Les transcripts ne sont pas dans le dépôt (données personnelles). Les mettre dans `transcripts/`
(ignoré par git) ou, si Santinu le demande, dans les notes de la fiche CRM (elles partent alors vers
Notion par la synchro).

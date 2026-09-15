#!/usr/bin/env python
"""Transcription horodatée d'un entretien avec faster-whisper, guidée par le contexte métier.

  python transcribe.py entretien.mp4 --out entretien.txt [--context contexte.json] [--glossaire glossaire.txt]
                       [--model large-v3-turbo] [--lang fr] [--device cuda]

--context : JSON {"nom": "...", "entreprise": "...", "titre": "...", "interviewers": ["Santinu", ...],
            "termes": ["...", ...], "notes": "texte libre"} — sert à construire l'initial_prompt et les hotwords.
Sortie : texte avec un horodatage [mm:ss] par segment + un .json à côté (segments, mots, probabilités).
Environnement : un venv avec faster-whisper + CUDA (ex. ~/Work/nestjs-course/.venv), modèle en cache HF.
"""
import argparse, json, os, re, subprocess, sys, tempfile, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("audio")
ap.add_argument("--out", required=True)
ap.add_argument("--context")
ap.add_argument("--glossaire", default=str(Path(__file__).with_name("glossaire.txt")))
ap.add_argument("--model", default="mobiuslabsgmbh/faster-whisper-large-v3-turbo")
ap.add_argument("--lang", default="fr")
ap.add_argument("--device", default="cuda")
ap.add_argument("--compute", default="float16")
ap.add_argument("--max-seconds", type=float, default=0, help="ne transcrire que les N premières secondes (test)")
ap.add_argument("--vad-threshold", type=float, default=0.5, help="seuil du détecteur de voix (0.3 si un interlocuteur est faible / au téléphone)")
ap.add_argument("--normalize", action="store_true", help="normalise le volume (dynaudnorm) avant transcription : utile si un interlocuteur est bien plus faible que l'autre")
args = ap.parse_args()

ctx = json.load(open(args.context, encoding="utf-8")) if args.context else {}
glossaire = [l.strip() for l in open(args.glossaire, encoding="utf-8") if l.strip() and not l.startswith("#")] if os.path.exists(args.glossaire) else []

# --- initial_prompt : ≤ ~224 jetons. Style de ponctuation en français + vocabulaire clé + noms propres.
names = [ctx.get("nom", "")] + list(ctx.get("interviewers", [])) + [ctx.get("entreprise", "")]
names = [n for n in names if n]
terms = list(dict.fromkeys(ctx.get("termes", []) + glossaire))
prompt_parts = []
if names:
    prompt_parts.append("Entretien entre " + ", ".join(names) + ".")
if ctx.get("titre"):
    prompt_parts.append(f"{ctx.get('nom', 'L’interviewé')} est {ctx['titre']}.")
prompt_parts.append("Sujets : cybersécurité, " + ", ".join(terms[:45]) + ".")
initial_prompt = " ".join(prompt_parts)[:900]
hotwords = " ".join(dict.fromkeys(names + terms))[:600]

# --- audio → wav 16 kHz mono (ffmpeg), tronqué si demandé
src = Path(args.audio)
tmp = Path(tempfile.mkdtemp()) / "audio.wav"
cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src)]
if args.max_seconds:
    cmd += ["-t", str(args.max_seconds)]
if args.normalize:
    cmd += ["-af", "highpass=f=80,dynaudnorm=f=150:g=15:p=0.9"]
cmd += ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(tmp)]
subprocess.run(cmd, check=True)

from faster_whisper import WhisperModel  # noqa: E402

t0 = time.time()
model = WhisperModel(args.model, device=args.device, compute_type=args.compute)
# Réglages anti-hallucination : pas de conditionnement sur le texte précédent (sinon une boucle se
# propage sur des minutes), pénalité de répétition, rejet des fenêtres trop compressées, VAD strict.
segments, info = model.transcribe(
    str(tmp), language=args.lang or None, beam_size=5, vad_filter=True,
    vad_parameters={"min_silence_duration_ms": 700, "speech_pad_ms": 300, "threshold": args.vad_threshold},
    initial_prompt=initial_prompt, hotwords=hotwords,
    condition_on_previous_text=False, repetition_penalty=1.05,
    compression_ratio_threshold=2.0, log_prob_threshold=-1.0, temperature=[0.0, 0.2, 0.4],
    hallucination_silence_threshold=2.0, word_timestamps=True,
)

# Filtre de sortie : un segment dont le texte est une répétition d'un même bout (≥ 3 fois) est réduit.
import re as _re
def dedup(text):
    for n in range(12, 1, -1):
        text = _re.sub(r'(\b(?:\S+\s+){%d}\S+[\s,.]*)(?:\1){2,}' % (n - 1), r'\1', text)
    text = _re.sub(r'(\b\S+\b[\s,]*)(?:\1){3,}', r'\1', text)
    return text.strip()

def ts(s):
    m, sec = divmod(int(s), 60)
    h, m = divmod(m, 60)
    return f"{h:d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"

out_segments = []
lines = []
low = 0
for seg in segments:
    text = dedup(seg.text.strip())
    # Segment majoritairement hors alphabet latin (coréen, chinois…) dans un entretien fr/en = hallucination.
    if not text or len(_re.findall(r'[^\x00-\x7F\u00C0-\u024F\u2019\u20AC\u2026«»–—]', text)) > len(text) * 0.15:
        continue
    words = [{"w": w.word, "s": round(w.start, 2), "e": round(w.end, 2), "p": round(w.probability, 2)} for w in (seg.words or [])]
    out_segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text, "avg_logprob": round(seg.avg_logprob, 3), "no_speech_prob": round(seg.no_speech_prob, 3), "words": words})
    flag = " ⚠" if seg.avg_logprob < -0.8 else ""
    if flag:
        low += 1
    lines.append(f"[{ts(seg.start)}] {text}{flag}")
    print(f"[{ts(seg.start)}] {text}{flag}", file=sys.stderr, flush=True)

dur = time.time() - t0
header = [
    f"# Transcription — {ctx.get('nom', src.stem)}" + (f" ({ctx['entreprise']})" if ctx.get("entreprise") else ""),
    f"# Fichier : {src.name} · langue détectée : {info.language} (p={info.language_probability:.2f}) · durée audio : {ts(info.duration)} · modèle : {args.model.split('/')[-1]} · {dur:.0f} s de calcul",
    f"# Segments : {len(out_segments)} · segments peu sûrs (⚠, avg_logprob < -0.8) : {low}",
    f"# Prompt : {initial_prompt[:200]}…",
    "",
]
Path(args.out).write_text("\n".join(header + lines) + "\n", encoding="utf-8")
Path(args.out).with_suffix(".json").write_text(json.dumps({"file": src.name, "language": info.language, "duration": info.duration, "model": args.model, "initial_prompt": initial_prompt, "hotwords": hotwords, "segments": out_segments}, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"✔ {args.out} — {len(out_segments)} segments, {ts(info.duration)} d'audio en {dur:.0f} s, {low} segment(s) ⚠", file=sys.stderr)

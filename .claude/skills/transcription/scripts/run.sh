#!/usr/bin/env bash
# Lance transcribe.py avec l'environnement qui marche sur cette machine :
# venv faster-whisper + CUDA, et les bibliothèques cuBLAS/cuDNN embarquées par Ollama (pas de CUDA système).
set -euo pipefail
export LD_LIBRARY_PATH="/usr/local/lib/ollama/cuda_v12:/usr/local/lib/ollama/mlx_cuda_v13:${LD_LIBRARY_PATH:-}"
PY="${TRANSCRIBE_PYTHON:-$HOME/Work/nestjs-course/.venv/bin/python}"
exec "$PY" "$(dirname "$0")/transcribe.py" "$@"

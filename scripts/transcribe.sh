#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: transcribe.sh <audio-file>" >&2
  exit 1
fi

INPUT="$1"
TMP_DIR="$(mktemp -d)"
trap "rm -rf $TMP_DIR" EXIT
WAV="$TMP_DIR/audio.wav"

FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"

if ! command -v "$FFMPEG_BIN" >/dev/null 2>&1; then
  echo "ffmpeg not found. Install ffmpeg and set FFMPEG_BIN if needed." >&2
  exit 1
fi

"$FFMPEG_BIN" -y -i "$INPUT" -ar 16000 -ac 1 "$WAV" >/dev/null 2>&1

ENGINE="${WHISPER_ENGINE:-}"
WHISPER_CPP_ARGS="${WHISPER_CPP_ARGS:--ng}"

if [ -z "$ENGINE" ]; then
  if [ -n "${WHISPER_CPP_BIN:-}" ] || command -v whisper-cli >/dev/null 2>&1 || command -v whisper-cpp >/dev/null 2>&1; then
    ENGINE="cpp"
  elif command -v whisper >/dev/null 2>&1; then
    ENGINE="python"
  else
    echo "No whisper engine found. Install whisper-cpp or python whisper." >&2
    exit 1
  fi
fi

if [ "$ENGINE" = "cpp" ]; then
  if [ -z "${WHISPER_CPP_BIN:-}" ]; then
    if command -v whisper-cli >/dev/null 2>&1; then
      WHISPER_CPP_BIN="whisper-cli"
    else
      WHISPER_CPP_BIN="whisper-cpp"
    fi
  fi
  WHISPER_MODEL="${WHISPER_MODEL:-$HOME/.local/share/whisper/ggml-base.en.bin}"
  OUT="$TMP_DIR/out"

  if [ ! -f "$WHISPER_MODEL" ]; then
    echo "Missing whisper.cpp model at $WHISPER_MODEL" >&2
    exit 1
  fi

  EXTRA_ARGS=()
  if [ -n "${WHISPER_CPP_ARGS:-}" ]; then
    read -r -a EXTRA_ARGS <<< "$WHISPER_CPP_ARGS"
  fi

  "$WHISPER_CPP_BIN" -m "$WHISPER_MODEL" -f "$WAV" "${EXTRA_ARGS[@]}" -otxt -of "$OUT" >/dev/null 2>&1
  cat "$OUT.txt"
  exit 0
fi

if [ "$ENGINE" = "python" ]; then
  WHISPER_PY_MODEL="${WHISPER_PY_MODEL:-base.en}"
  whisper "$WAV" --model "$WHISPER_PY_MODEL" --language en --fp16 False --output_format txt --output_dir "$TMP_DIR" >/dev/null 2>&1
  cat "$TMP_DIR/audio.txt"
  exit 0
fi

echo "Unknown WHISPER_ENGINE: $ENGINE" >&2
exit 1

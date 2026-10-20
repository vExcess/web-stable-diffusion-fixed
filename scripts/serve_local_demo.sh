#!/usr/bin/env bash
# Assemble and serve the browser demo from this checkout.
# Safe to rerun: existing dist/ artifacts are reused, app JS is always refreshed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
SERVE_DIR="$ROOT/.local-demo"
PORT="${PORT:-8889}"
FROM_SOURCE=0
FORCE_FETCH=0
NO_SERVE=0
PREBUILT_BASE="${PREBUILT_BASE:-https://websd.mlc.ai/dist}"

REQUIRED_ARTIFACTS=(
  tvmjs.bundle.js
  tvmjs_runtime.wasi.js
  stable_diffusion_webgpu.wasm
  scheduler_pndm_consts.json
  scheduler_dpm_solver_multistep_consts.json
)

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

  --from-source   Run prep_deps.sh and build.py --target webgpu when wasm is missing
  --force-fetch   Re-download prebuilt dist artifacts even if they already exist
  --no-serve      Assemble the site and print the path, but do not start a server
  --port N        Listen on port N (default: ${PORT}, or \$PORT)
  -h, --help      Show this help

Artifacts already in dist/ are reused. A fresh clone downloads the published
WebGPU build, then overlays this checkout's current web/ files.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-source) FROM_SOURCE=1 ;;
    --force-fetch) FORCE_FETCH=1 ;;
    --no-serve) NO_SERVE=1 ;;
    --port)
      PORT="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '%s\n' "$*"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

missing_required_artifacts() {
  local name
  for name in "${REQUIRED_ARTIFACTS[@]}"; do
    if [[ ! -f "$DIST/$name" ]]; then
      return 0
    fi
  done
  return 1
}

fetch_prebuilt_artifacts() {
  mkdir -p "$DIST"
  if [[ "$FORCE_FETCH" -eq 1 ]]; then
    log "Re-fetching prebuilt demo artifacts"
  else
    log "Fetching missing prebuilt demo artifacts"
  fi

  if have git && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git -C "$ROOT" rev-parse --verify origin/gh-pages >/dev/null 2>&1; then
      git -C "$ROOT" fetch --depth 1 origin gh-pages || true
    fi
    if git -C "$ROOT" rev-parse --verify origin/gh-pages >/dev/null 2>&1; then
      local tmp
      tmp="$(mktemp -d)"
      git -C "$ROOT" archive origin/gh-pages:docs/dist | tar -x -C "$tmp"
      local item
      for item in "$tmp"/*; do
        [[ -e "$item" ]] || continue
        local base
        base="$(basename "$item")"
        if [[ "$FORCE_FETCH" -eq 1 || ! -e "$DIST/$base" ]]; then
          rm -rf "$DIST/$base"
          cp -a "$item" "$DIST/$base"
        fi
      done
      rm -rf "$tmp"
    fi
  fi

  if ! have curl; then
    echo "curl is required to download prebuilt artifacts" >&2
    exit 1
  fi

  local name
  for name in "${REQUIRED_ARTIFACTS[@]}"; do
    if [[ "$FORCE_FETCH" -eq 1 || ! -f "$DIST/$name" ]]; then
      log "Downloading $PREBUILT_BASE/$name"
      curl -fL --retry 3 --retry-delay 1 -o "$DIST/$name" "$PREBUILT_BASE/$name"
    fi
  done
}

build_from_source() {
  log "Building WebGPU artifacts from source"
  if [[ -z "${TVM_HOME:-}" && ! -d "$ROOT/3rdparty/tvm" ]]; then
    echo "Set TVM_HOME or let scripts/prep_deps.sh clone 3rdparty/tvm" >&2
  fi
  (
    cd "$ROOT"
    ./scripts/prep_deps.sh
    python3 build.py --target webgpu
  )
}

write_config() {
  local sd15_params="https://huggingface.co/mlc-ai/web-sd/resolve/main/web-sd-shards-v1-5/"
  if [[ -d "$DIST/params" ]]; then
    sd15_params="web-sd-shards-v1-5/"
    ln -sfn "$DIST/params" "$SERVE_DIR/web-sd-shards-v1-5"
  fi
  if [[ -d "$DIST/params_xl" ]]; then
    ln -sfn "$DIST/params_xl" "$SERVE_DIR/web-sd-shards-xl"
  fi

  python3 - "$SERVE_DIR/stable-diffusion-config.json" "$DIST" "$sd15_params" <<'PY'
import json
import sys
from pathlib import Path

out, dist, sd15_params = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
schedulers = [
    f"dist/{name}"
    for name in (
        "scheduler_dpm_solver_multistep_consts.json",
        "scheduler_pndm_consts.json",
        "scheduler_euler_discrete_consts.json",
    )
    if (dist / name).is_file()
]
model_lib_map = {}
param_dict = {}
if (dist / "stable_diffusion_webgpu.wasm").is_file():
    model_lib_map["Stable-Diffusion-1.5"] = "dist/stable_diffusion_webgpu.wasm"
    param_dict["Stable-Diffusion-1.5"] = sd15_params
if (dist / "stable_diffusion_xl.wasm").is_file():
    model_lib_map["Stable-Diffusion-XL"] = "dist/stable_diffusion_xl.wasm"
    param_dict["Stable-Diffusion-XL"] = "web-sd-shards-xl/"
config = {
    "schedulerConstUrl": schedulers,
    "tokenizer": "openai/clip-vit-large-patch14",
    "tokenizer2": "openai/clip-vit-large-patch14",
    "model_lib_map": model_lib_map,
    "param_dict": param_dict,
}
out.write_text(json.dumps(config, indent=4) + "\n")
PY
}

assemble_site() {
  mkdir -p "$SERVE_DIR/dist"
  local name
  for name in "${REQUIRED_ARTIFACTS[@]}"; do
    cp -a "$DIST/$name" "$SERVE_DIR/dist/$name"
  done
  for name in \
    scheduler_euler_discrete_consts.json \
    stable_diffusion_xl.wasm \
    tvmjs.bundle.js \
    tvmjs_runtime.wasi.js
  do
    if [[ -e "$DIST/$name" ]]; then
      cp -a "$DIST/$name" "$SERVE_DIR/dist/$name"
    fi
  done

  cp -a "$ROOT/web/webgpu-compat.js" "$SERVE_DIR/dist/webgpu-compat.js"
  cp -a "$ROOT/web/clip_tokenizer.js" "$SERVE_DIR/dist/clip_tokenizer.js"
  cp -a "$ROOT/web/model_pack.js" "$SERVE_DIR/dist/model_pack.js"
  cp -a "$ROOT/web/stable_diffusion.js" "$SERVE_DIR/dist/stable_diffusion.js"

  write_config

  local default_model="Stable-Diffusion-1.5"
  if [[ -f "$DIST/stable_diffusion_xl.wasm" ]]; then
    default_model="Stable-Diffusion-XL"
  fi

  python3 - "$ROOT/web/stable_diffusion.html" "$SERVE_DIR/index.html" "$default_model" <<'PY'
from pathlib import Path
import sys

src, dest, default_model = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
body = src.read_text()
if default_model == "Stable-Diffusion-1.5":
    body = body.replace(
        '<option selected="selected">Stable-Diffusion-XL</option>\n    <option>Stable-Diffusion-1.5</option>',
        '<option>Stable-Diffusion-XL</option>\n    <option selected="selected">Stable-Diffusion-1.5</option>',
    )
dest.write_text(
    """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Web Stable Diffusion</title>
  <script src="dist/webgpu-compat.js"></script>
  <script src="dist/tvmjs_runtime.wasi.js"></script>
  <script src="dist/tvmjs.bundle.js"></script>
</head>
<body>
<h1>Web Stable Diffusion</h1>
"""
    + body
    + "\n</body>\n</html>\n"
)
PY
}

port_in_use() {
  if have ss; then
    ss -ltn | grep -qE "[:(]$PORT\\b"
  elif have lsof; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

cd "$ROOT"
mkdir -p "$DIST" "$SERVE_DIR"

if [[ "$FROM_SOURCE" -eq 1 ]]; then
  if [[ "$FORCE_FETCH" -eq 1 ]] || missing_required_artifacts; then
    build_from_source
  else
    log "Source artifacts already present; skipping --from-source rebuild"
  fi
fi

if [[ "$FORCE_FETCH" -eq 1 ]] || missing_required_artifacts; then
  fetch_prebuilt_artifacts
fi

if missing_required_artifacts; then
  echo "Could not locate required demo artifacts in $DIST" >&2
  echo "Re-run with --force-fetch, or build them with --from-source" >&2
  exit 1
fi

assemble_site
log "Demo assembled at $SERVE_DIR"

if [[ "$NO_SERVE" -eq 1 ]]; then
  exit 0
fi

if port_in_use; then
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    log "Already serving at http://127.0.0.1:$PORT/"
    exit 0
  fi
  echo "Port $PORT is already in use" >&2
  exit 1
fi

log "Serving http://127.0.0.1:$PORT/"
exec python3 -m http.server "$PORT" --directory "$SERVE_DIR"

#!/usr/bin/env bash
# Vercel build step: builds public/grids.json (16x16) and public/grids-8.json
# with the data pipeline, using the HARVARD_API_KEY environment variable.
#
# If public/grids.json is committed to the repo, the pipeline is skipped and
# the committed data is used. Set REBUILD_GRIDS=1 to rebuild it anyway.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f public/grids.json ] && [ "${REBUILD_GRIDS:-0}" != "1" ]; then
  echo "Using the committed public/grids.json (set REBUILD_GRIDS=1 to rebuild)."
  exit 0
fi

if [ -z "${HARVARD_API_KEY:-}" ]; then
  echo "ERROR: HARVARD_API_KEY is not set for this deployment." >&2
  echo "Add it in Vercel: Project Settings -> Environment Variables (Production and Preview), then redeploy." >&2
  exit 1
fi

ARGS=(--size 16 8 --cache-dir "")

if command -v python3 >/dev/null 2>&1 && python3 -m venv .venv-build >/dev/null 2>&1; then
  echo "Installing numpy and Pillow into a build venv ($(python3 --version))..."
  .venv-build/bin/pip install --quiet --disable-pip-version-check --only-binary=:all: -r scripts/requirements.txt
  exec .venv-build/bin/python scripts/build_grids.py "${ARGS[@]}"
elif command -v uv >/dev/null 2>&1; then
  echo "Running the pipeline with uv..."
  exec uv run --no-project --with-requirements scripts/requirements.txt python scripts/build_grids.py "${ARGS[@]}"
else
  echo "ERROR: Python 3 (with venv) or uv is needed to build the artwork grids." >&2
  exit 1
fi

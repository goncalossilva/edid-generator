#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: tests/check-edid.sh <edid.bin> [expected-warnings.txt]" >&2
  exit 1
fi

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
input_path=$1
expected_path=${2:-}

if [ ! -f "$input_path" ]; then
  input_path="$root_dir/$input_path"
fi

if [ ! -f "$input_path" ]; then
  echo "EDID file not found: $1" >&2
  exit 1
fi

if command -v edid-decode >/dev/null 2>&1; then
  output=$(edid-decode --check "$input_path" 2>&1) || {
    echo "$output"
    exit 1
  }
else
  if [[ "$input_path" != "$root_dir"/* ]]; then
    echo "EDID file must be inside the project so it can be mounted." >&2
    exit 1
  fi

  relative_path=${input_path#"$root_dir"/}

  if command -v podman >/dev/null 2>&1; then
    runner=podman
  elif command -v docker >/dev/null 2>&1; then
    runner=docker
  else
    echo "Docker, Podman, or edid-decode is required for validation." >&2
    exit 1
  fi

  image="edid-tools:local"

  image_exists=false
  if [ "$runner" = "docker" ]; then
    if docker image inspect "$image" >/dev/null 2>&1; then
      image_exists=true
    fi
  else
    if podman image exists "$image" >/dev/null 2>&1; then
      image_exists=true
    fi
  fi

  if [ "$image_exists" = false ]; then
    "$runner" build -t "$image" -f "$root_dir/tests/Dockerfile" "$root_dir"
  fi

  output=$("$runner" run --rm -v "$root_dir:/work" -w /work "$image" edid-decode --check "$relative_path" 2>&1) || {
    echo "$output"
    exit 1
  }
fi

if echo "$output" | grep -Eq '^Failures?:'; then
  echo "$output"
  echo ""
  echo "Validation failed: edid-decode reported failures."
  exit 1
fi

warnings_block=$(echo "$output" | awk '
  /^Warnings:/{in_block=1; next}
  /^Failures:/{in_block=0}
  /^EDID conformity:/{in_block=0}
  {if (in_block) print}
')
warnings=$(echo "$warnings_block" | sed -e 's/^[[:space:]]*//' -e '/^$/d' -e '/^Block /d')

if [ -n "$expected_path" ] && [ -f "$expected_path" ]; then
  expected=$(sed -e 's/^[[:space:]]*//' -e '/^$/d' "$expected_path")
  normalized_expected=$(echo "$expected" | sort -u)
  normalized_actual=$(echo "$warnings" | sort -u)
  if [ "$normalized_expected" != "$normalized_actual" ]; then
    echo "$output"
    echo ""
    echo "Validation failed: edid-decode warnings did not match expectations."
    echo "Expected warnings:"
    if [ -n "$normalized_expected" ]; then
      echo "$normalized_expected"
    else
      echo "(none)"
    fi
    echo ""
    echo "Actual warnings:"
    if [ -n "$normalized_actual" ]; then
      echo "$normalized_actual"
    else
      echo "(none)"
    fi
    exit 1
  fi
else
  if [ -n "$warnings" ]; then
    echo "$output"
    echo ""
    echo "Validation failed: edid-decode reported warnings."
    exit 1
  fi
fi

echo "$output"

#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ -z "${EDID_TEST_IN_DOCKER:-}" ]; then
  if command -v podman >/dev/null 2>&1; then
    runner=podman
  elif command -v docker >/dev/null 2>&1; then
    runner=docker
  else
    echo "Docker or Podman is required to run the test suite." >&2
    exit 1
  fi

  image="edid-tools:local"
  "$runner" build -t "$image" -f "$root_dir/tests/Dockerfile" "$root_dir"
  "$runner" run --rm "$image" ./tests/run-tests.sh
  exit 0
fi

output_dir="/tmp/edid-fixtures"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run the test generator." >&2
  exit 1
fi

node "$root_dir/tests/generate-fixtures.js"

for edid_file in "$output_dir"/*.bin; do
  expected_file="${edid_file%.bin}.expected-edid-decode.txt"
  if [ -f "$expected_file" ]; then
    "$root_dir/tests/check-edid.sh" "$edid_file" "$expected_file"
  else
    "$root_dir/tests/check-edid.sh" "$edid_file"
  fi
  echo "Validated ${edid_file##*/}"
  echo ""
done

echo "All EDID fixtures validated."

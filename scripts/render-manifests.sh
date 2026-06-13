#!/usr/bin/env bash
set -euo pipefail

rm -rf .rendered
mkdir -p .rendered
for file in manifests/*.yaml; do
  name="$(basename "$file")"
  envsubst < "$file" > ".rendered/$name"
done

if grep -R '\${[A-Za-z_][A-Za-z0-9_]*}' .rendered >/dev/null; then
  echo "Unresolved placeholders remain in .rendered manifests" >&2
  grep -R '\${[A-Za-z_][A-Za-z0-9_]*}' .rendered >&2
  exit 1
fi

#!/bin/bash
set -e

# Publishes all 6 packages to npm to reserve the names
# and enable trusted publisher configuration.
# Run once: ./scripts/init-npm.sh

PACKAGES=(
  "npm/darwin-arm64"
  "npm/darwin-x64"
  "npm/linux-arm64"
  "npm/linux-x64"
  "npm/windows-x64"
  "npm/shadow"
)

for pkg in "${PACKAGES[@]}"; do
  name=$(node -p "require('./$pkg/package.json').name")
  echo "Publishing $name..."
  npm publish "./$pkg" --access public
  echo ""
done

echo "All packages published. Configure trusted publishers on npmjs.com."

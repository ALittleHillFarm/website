#!/usr/bin/env bash
# Assemble the farm site into dist-site/ for deployment.
# Deliberately excludes store/, research/, dist-site/ and anything git-related.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist-site && mkdir -p dist-site
cp ./*.html dist-site/
cp -r goats assets dist-site/
rm -rf dist-site/assets/products          # those belong to the store worker
echo "dist-site: $(find dist-site -type f | wc -l) files, $(du -sh dist-site | cut -f1)"

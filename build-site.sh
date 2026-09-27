#!/usr/bin/env bash
# Assemble the farm site into dist-site/ for deployment.
# Deliberately excludes store/, research/, seed/, dist-site/ and anything
# git-related. Header, footer and goat pages are not built here — the worker
# (site-worker.js + site/) adds them as each page is served.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist-site && mkdir -p dist-site
cp ./*.html favicon.ico apple-touch-icon.png site.webmanifest dist-site/
cp -r assets dist-site/
echo "dist-site: $(find dist-site -type f | wc -l) files, $(du -sh dist-site | cut -f1)"

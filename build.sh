#!/bin/sh
# Builds SoloSend. See BUILD.md.
#
# There is no compilation step: the add-on is packaged verbatim from the four
# source paths listed in SHIPPED. Run with:  sh build.sh
#
# Requires Info-ZIP `zip` (3.0+). Node.js is optional and used only for an
# `--check` syntax pass; it never rewrites a shipped file.

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root"

# The only paths that go into the .xpi. manifest.json must land at the root.
# LICENSE ships too: MIT requires the notice to accompany every copy.
SHIPPED='manifest.json background.js dialog icons LICENSE'

version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)
[ -n "$version" ] || { echo 'Could not read version from manifest.json' >&2; exit 1; }
echo "SoloSend $version"

if command -v node >/dev/null 2>&1; then
  node --check background.js
  node --check dialog/dialog.js
  echo 'Syntax check passed.'
else
  echo 'node not found - skipping the optional syntax check.'
fi

mkdir -p dist
xpi="dist/solosend-$version.xpi"
rm -f "$xpi"

# -r recurse, -X omit platform-specific extra fields, -q quiet.
# shellcheck disable=SC2086
zip -r -X -q "$xpi" $SHIPPED

echo
echo 'Packaged files:'
unzip -l "$xpi"

echo
echo 'SHA-256 of each shipped file:'
# shellcheck disable=SC2086
find $SHIPPED -type f | sort | xargs sha256sum

echo
echo "$root/$xpi"

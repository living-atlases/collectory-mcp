#!/bin/sh
# Download an official collectory WAR from the ALA Nexus (cached): harness/fetch-war.sh 6.3.0 [dest]
set -eu
V="${1:?collectory version, e.g. 6.3.0}"
DEST="${2:-${XDG_CACHE_HOME:-$HOME/.cache}/collectory-mcp/collectory-$V.war}"
mkdir -p "$(dirname "$DEST")"
if [ ! -s "$DEST" ]; then
  curl -fsSL --retry 3 -o "$DEST.part" "https://nexus.ala.org.au/repository/releases/au/org/ala/collectory/$V/collectory-$V.war"
  mv "$DEST.part" "$DEST"
fi
echo "$DEST"

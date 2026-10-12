#!/bin/sh
# Start the disposable collectory and wait until its web services answer: harness/up.sh [version]
set -eu
cd "$(dirname "$0")"
V="${1:-6.3.0}"
export COLLECTORY_WAR="$(./fetch-war.sh "$V")"
# collectory 5.x is built for Java 11, 6.x for Java 17
case "$V" in 5.*) export COLLECTORY_JRE=eclipse-temurin:11-jre ;; *) export COLLECTORY_JRE=eclipse-temurin:17-jre ;; esac
docker compose -p collectory-mcp-it up -d
# collectory answers before Liquibase has finished migrating the schema: wait for an authenticated query on contacts
# (one of the last tables migrated) to stop failing.
for i in $(seq 1 120); do
  if curl -fsS -m 5 http://localhost:8080/ws/dataHub >/dev/null 2>&1; then
    T=$(curl -fsS -m 5 "http://localhost:4000/mint?scope=ala/internal" || true)
    code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" -H "Accept: application/json" http://localhost:8080/ws/contacts/0 || true)
    case "$code" in 400|404|200) echo "collectory is up"; exit 0 ;; esac
  fi
  sleep 5
done
docker compose -p collectory-mcp-it logs --tail 200 collectory
exit 1

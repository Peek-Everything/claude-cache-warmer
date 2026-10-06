#!/usr/bin/env bash
# Tests for cache-segment.sh: sample status line input → expected text and colour.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
SEG="$DIR/cache-segment.sh"
NOW=$(date +%s)
PASS=0; FAIL=0
check() { # name, json, expected substring, [extra args...]
  local name=$1 json=$2 want=$3; shift 3
  local out; out=$(printf '%s' "$json" | "$SEG" "$@" | sed 's/\x1b\[38;5;46m/[green]/; s/\x1b\[38;5;226m/[yellow]/; s/\x1b\[38;5;196m/[red]/; s/\x1b\[0m//')
  if [[ "$out" == *"$want"* ]]; then PASS=$((PASS+1)); echo "  PASS $name"
  else FAIL=$((FAIL+1)); echo "  FAIL $name"; echo "       want: $want"; echo "       got:  $out"; fi
}
check "warm 1h" "{\"prompt_cache\":{\"warm\":true,\"ttl\":\"1h\",\"expires_at\":$((NOW+38*60+20)),\"hit_ratio\":0.91,\"misses\":0}}" \
  "[green]cache ● 1h ████░░ 38m left · hit 91% · misses 0"
# The script reads the clock a moment after this test does, so allow 40-45s.
EXPIRING="{\"prompt_cache\":{\"warm\":true,\"ttl\":\"5m\",\"expires_at\":$((NOW+45)),\"hit_ratio\":0.874,\"misses\":2}}"
check "about to expire (yellow)" "$EXPIRING" "[yellow]cache ● 5m █░░░░░ 4"
check "about to expire (rest)" "$EXPIRING" "s left · hit 87% · misses 2"
check "cold with cause" "{\"prompt_cache\":{\"warm\":false,\"last_miss_cause\":{\"causes\":[\"tools_changed\"]},\"recache_tokens_if_cold\":82400}}" \
  "[red]cache ○ cold · next message re-caches 82k tokens · miss: tools_changed"
check "cold, no cause" "{\"prompt_cache\":{\"warm\":false,\"last_miss_cause\":null,\"recache_tokens_if_cold\":81600}}" \
  "[red]cache ○ cold · next message re-caches 82k tokens"
check "past expiry reads as cold" "{\"prompt_cache\":{\"warm\":true,\"ttl\":\"5m\",\"expires_at\":$((NOW-10)),\"recache_tokens_if_cold\":82000}}" \
  "[red]cache ○ cold"
check "sparse fields" "{\"prompt_cache\":{\"warm\":true,\"hit_ratio\":0.5}}" "[green]cache ● warm · hit 50%"
out=$(printf '{"model":{}}' | "$SEG"); [ -z "$out" ] && { PASS=$((PASS+1)); echo "  PASS no prompt_cache → nothing"; } || { FAIL=$((FAIL+1)); echo "  FAIL no prompt_cache printed: $out"; }
# Wrapping: inner command gets the same stdin; its output comes first, unchanged.
out=$(printf '{"x":"inner-ok","prompt_cache":{"warm":false}}' | "$SEG" jq -r .x)
[ "$(printf '%s\n' "$out" | sed -n 1p)" = "inner-ok" ] && printf '%s\n' "$out" | sed -n 2p | grep -q "cache ○ cold" \
  && { PASS=$((PASS+1)); echo "  PASS wraps an inner status line"; } || { FAIL=$((FAIL+1)); echo "  FAIL wrap: $out"; }
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

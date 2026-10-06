#!/usr/bin/env bash
# cache-segment.sh: Claude Code status line segment for the prompt cache, from the
# `prompt_cache` object Claude Code sends to status line commands (v2.1.251+).
#
#   cache ● 1h ████░░ 38m left · hit 91% · misses 0          (green; yellow under 20% left)
#   cache ○ cold · next message re-caches 82k tokens · miss: tools_changed   (red)
#
# Usage in ~/.claude/settings.json:
#   standalone:        "statusLine": { "type": "command", "command": "/path/cache-segment.sh", "refreshInterval": 30 }
#   after your own:    "command": "/path/cache-segment.sh /path/your-statusline.sh"
# With an inner command, stdin is read once and fed to both; the inner output is
# printed unchanged and the cache segment goes on its own line after it.
# Prints nothing until `prompt_cache` appears; any field your version lacks is skipped.
# Requires: bash, jq, awk.

input=$(cat)
if [ "$#" -gt 0 ]; then
  printf '%s' "$input" | "$@"
fi

# One jq pass → unit-separator-delimited fields (empty string = absent/null).
IFS=$'\x1f' read -r PC WARM TTL EXP HIT MISSES RECACHE CAUSE < <(
  printf '%s' "$input" | jq -r '
    (.prompt_cache // null) as $p
    | if $p == null then "0" else
        [ "1",
          ($p.warm | if . == null then "" else tostring end),
          ($p.ttl // ""),
          ($p.expires_at // "" | tostring),
          ($p.hit_ratio // "" | tostring),
          ($p.misses // "" | tostring),
          ($p.recache_tokens_if_cold // "" | tostring),
          ($p.last_miss_cause.causes? // [] | join(", "))
        ] | join("\u001f") end' 2>/dev/null
)
[ "$PC" = "1" ] || exit 0

fg() { printf '\033[38;5;%sm' "$1"; }
RST=$'\033[0m'
NOW=${EPOCHSECONDS:-$(date +%s)}

# "5m" / "1h" / "30s" → seconds (empty if unparseable)
ttl_secs() {
  case "$1" in
    *h) echo $(( ${1%h} * 3600 )) ;;
    *m) echo $(( ${1%m} * 60 )) ;;
    *s) echo "${1%s}" ;;
  esac 2>/dev/null
}

# Warm only if reported warm AND not already past expires_at (between refreshes).
LEFT=""
[ -n "$EXP" ] && LEFT=$(( EXP - NOW ))
if [ "$WARM" = "true" ] && { [ -z "$LEFT" ] || [ "$LEFT" -gt 0 ]; }; then
  TOTAL=$(ttl_secs "$TTL")
  COLOR=46
  SEG="cache ●"
  if [ -n "$TTL" ]; then SEG="$SEG $TTL"; elif [ -z "$LEFT" ]; then SEG="$SEG warm"; fi
  if [ -n "$LEFT" ] && [ -n "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
    [ "$LEFT" -gt "$TOTAL" ] && LEFT=$TOTAL
    [ $(( LEFT * 5 )) -lt "$TOTAL" ] && COLOR=226          # < 20% of TTL left
    FILLED=$(( (LEFT * 6 + TOTAL / 2) / TOTAL ))
    BAR=""; for i in 1 2 3 4 5 6; do
      if [ "$i" -le "$FILLED" ]; then BAR="$BAR█"; else BAR="$BAR░"; fi
    done
    SEG="$SEG $BAR"
  fi
  if [ -n "$LEFT" ]; then
    if [ "$LEFT" -ge 60 ]; then SEG="$SEG $(( LEFT / 60 ))m left"; else SEG="$SEG ${LEFT}s left"; fi
  fi
  [ -n "$HIT" ] && SEG="$SEG · hit $(awk -v h="$HIT" 'BEGIN{printf "%d", h*100+0.5}')%"
  [ -n "$MISSES" ] && SEG="$SEG · misses $MISSES"
else
  COLOR=196
  SEG="cache ○ cold"
  if [ -n "$RECACHE" ]; then
    K=$(( (RECACHE + 500) / 1000 ))
    if [ "$K" -gt 0 ]; then SEG="$SEG · next message re-caches ${K}k tokens"
    else SEG="$SEG · next message re-caches <1k tokens"; fi
  fi
  [ -n "$CAUSE" ] && SEG="$SEG · miss: $CAUSE"
fi

printf '%s%s%s\n' "$(fg "$COLOR")" "$SEG" "$RST"

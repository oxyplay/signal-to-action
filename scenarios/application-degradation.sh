#!/usr/bin/env bash
# Scenario 2 of 2 - application degradation.
#
#   Traditional monitoring sees : HighCpu
#   The decision layer says    : INVESTIGATE
#
# The same CPU level as scenario 1, but now requests hang and then fail. Request
# volume barely moves, so the load is not explained by traffic and the service is
# failing users.
#
# As in scenario 1, the first phase sends steady traffic so the evaluator has a
# comparison window.
set -euo pipefail

DEMO_APP_URL="${DEMO_APP_URL:-http://localhost:3002}"
ASSESSMENT_URL="${ASSESSMENT_URL:-http://localhost:8081/assessment}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"

BASELINE_SECONDS="${BASELINE_SECONDS:-80}"
LOAD_SECONDS="${LOAD_SECONDS:-80}"
FAILURE_MS=3000

# Traffic is deliberately held at the baseline rate. The point of the scenario
# is that volume does not explain the problem.
TRAFFIC_WORKERS=4
TRAFFIC_DELAY=0.2

SLOW_WORKERS=4
ERROR_WORKERS=6

say() { printf '\n== %s\n' "$*"; }

drive() {
  local path="$1" seconds="$2" workers="$3" delay="$4"
  local deadline=$(( $(date +%s) + seconds ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    seq "$workers" | xargs -P "$workers" -I{} \
      sh -c "curl -s -o /dev/null --max-time 30 '$DEMO_APP_URL$path' || true; sleep $delay"
  done
}

burn_cpu() {
  curl -s -o /dev/null --max-time "$(( LOAD_SECONDS + 30 ))" \
    "$DEMO_APP_URL/work?ms=$(( LOAD_SECONDS * 1000 ))" || true
}

show_alerts() {
  printf '   Prometheus alert state: '
  local alerts
  alerts=$(curl -sS --get "$PROMETHEUS_URL/api/v1/query" \
    --data-urlencode 'query=ALERTS' 2>/dev/null \
    | tr '{' '\n' \
    | grep -o '"alertname":"[A-Za-z]*","alertstate":"[a-z]*"' \
    | sed 's/"alertname":"//; s/","alertstate":"/=/; s/"$//' \
    | sort -u | tr '\n' ' ' || true)
  printf '%s\n' "${alerts:-none}"
}

say "application-degradation: starting"

say "Phase 1/2 - steady healthy traffic for ${BASELINE_SECONDS}s (baseline for the traffic comparison)"
drive "/" "$BASELINE_SECONDS" "$TRAFFIC_WORKERS" "$TRAFFIC_DELAY"

say "Phase 2/2 - CPU burn plus ${FAILURE_MS}ms slow and failing requests for ${LOAD_SECONDS}s"
burn_cpu &
drive "/"                    "$LOAD_SECONDS" "$TRAFFIC_WORKERS" "$TRAFFIC_DELAY" &
drive "/slow?ms=$FAILURE_MS" "$LOAD_SECONDS" "$SLOW_WORKERS"  0 &
drive "/error?ms=$FAILURE_MS" "$LOAD_SECONDS" "$ERROR_WORKERS" 0 &
wait

say "Expected signals"
echo "   CPU          high      (the same HighCpu alert as scenario 1)"
echo "   request rate normal    (volume held at the baseline rate)"
echo "   p95 latency  high      (requests take ${FAILURE_MS}ms)"
echo "   error rate   high      (5xx share above 5%)"

show_alerts

say "Assessment"
curl -sS "$ASSESSMENT_URL" || echo "(could not reach the evaluator at $ASSESSMENT_URL)"

cat <<'MESSAGE'

Expected reading: multiple independent signals show user-visible degradation and
request volume does not explain it. Decision: INVESTIGATE.
MESSAGE

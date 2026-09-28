#!/usr/bin/env bash
# Scenario 1 of 2 - workload pressure.
#
#   Traditional monitoring sees : HighCpu
#   The decision layer says    : OBSERVE
#
# Request volume goes up a lot and the host gets busy. Latency and error rate
# stay healthy, so nothing is actually broken.
#
# The first phase sends steady low traffic. That is not decoration: the
# evaluator compares the current minute of traffic with the preceding minute, so
# it needs a baseline to compare against.
set -euo pipefail

DEMO_APP_URL="${DEMO_APP_URL:-http://localhost:3002}"
ASSESSMENT_URL="${ASSESSMENT_URL:-http://localhost:8081/assessment}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"

BASELINE_SECONDS="${BASELINE_SECONDS:-80}"
LOAD_SECONDS="${LOAD_SECONDS:-80}"

# Approximate requests per second = workers / (request duration + delay).
BASELINE_WORKERS=2
BASELINE_DELAY=1.0
LOAD_WORKERS=16
LOAD_DELAY=0.02

say() { printf '\n== %s\n' "$*"; }

# Sends $1 continuously for $2 seconds with $3 parallel curl processes, each
# waiting $4 seconds between requests.
drive() {
  local path="$1" seconds="$2" workers="$3" delay="$4"
  local deadline=$(( $(date +%s) + seconds ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    seq "$workers" | xargs -P "$workers" -I{} \
      sh -c "curl -s -o /dev/null --max-time 30 '$DEMO_APP_URL$path' || true; sleep $delay"
  done
}

# /work burns CPU in worker threads and only answers when it is done, so the
# HTTP server keeps serving /metrics while node_exporter reports a busy host.
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

say "workload-pressure: starting"

say "Phase 1/2 - steady low traffic for ${BASELINE_SECONDS}s (baseline for the traffic comparison)"
drive "/" "$BASELINE_SECONDS" "$BASELINE_WORKERS" "$BASELINE_DELAY"

say "Phase 2/2 - CPU burn plus elevated request volume for ${LOAD_SECONDS}s"
burn_cpu &
drive "/" "$LOAD_SECONDS" "$LOAD_WORKERS" "$LOAD_DELAY"
wait

say "Expected signals"
echo "   CPU          high      (the HighCpu alert fires)"
echo "   request rate elevated  (tens of req/s vs ~2 req/s baseline)"
echo "   p95 latency  healthy   (all requests are fast)"
echo "   error rate   healthy   (no 5xx)"

show_alerts

say "Assessment"
curl -sS "$ASSESSMENT_URL" || echo "(could not reach the evaluator at $ASSESSMENT_URL)"

cat <<'MESSAGE'

Expected reading: the system is busy, but the increased workload explains the
pressure and users are not experiencing degradation. Decision: OBSERVE.
MESSAGE

# Signal to Action

A small experiment evaluating [Jev](https://jev.pro) as a probabilistic decision layer on top of Prometheus metrics, compared against a deterministic rule baseline. It contains a runnable monitoring demo, a 51-case benchmark, and the raw results behind the findings.

This is an evaluation, not a product. **The probabilistic layer did not outperform the deterministic baseline.** What the run produced instead is a set of specific, measured failure modes and one promising lead, all documented below.

## Why

Prometheus detects conditions well. It is good at telling you that CPU crossed a line. It is not good at telling you whether that line matters, because an operational decision usually depends on several signals together.

A CPU alert at 92% means one of two very different things:

| | CPU | p95 latency | Error rate | Request rate | Meaning |
| --- | --- | --- | --- | --- | --- |
| A | 92% | normal | normal | elevated | harmless workload pressure |
| B | 92% | 2800 ms | 8% | normal | real degradation |

Threshold monitoring sees the same alert in both. A human closes it by opening four more dashboards and correlating them mentally. This project encodes that correlation twice — once as explicit rules, once as a semantic model — and measures which is more useful, more stable, and cheaper to reason about.

## Architecture

```text
demo-app ────────┐
                 ├──> Prometheus ───> Grafana
node-exporter ───┘        facts        visualization
                        │
                        ▼
                   Observation          normalized facts
                    /         \
                  rules        Jev     two interpretations
                    \         /
                     policy            deterministic mapping
                       │
        HEALTHY / OBSERVE / INVESTIGATE
```

- **Prometheus** — facts. Collection, storage, threshold alerts. Unchanged.
- **Observation** — a handful of normalized numbers with explicit `null` for anything unavailable. No PromQL escapes the adapter.
- **Rules / Jev** — interpretation. The same `Observation` goes to both, so they are directly comparable.
- **Policy** — the mapping from a classification to an operational decision. Always deterministic, always in application code.

Three things stay separate throughout, because conflating them is how this kind of system gets oversold:

1. **classification** — `application_degradation`
2. **confidence** — `0.41`
3. **policy decision** — `OBSERVE`, which the gate produced *instead of* using the classification

## Quick start

The baseline works with no OpenRouter key and no cloud credentials.

```bash
docker compose up --build
```

| Service | URL |
| --- | --- |
| demo-app | http://localhost:3002 |
| evaluator | http://localhost:8081 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3001 (`admin` / `admin`) |
| node-exporter | http://localhost:9100 |

The evaluator exposes two endpoints on purpose:

```bash
curl http://localhost:8081/observation    # facts, no opinion
curl http://localhost:8081/assessment     # facts plus interpretation
```

## Demo scenarios

Two reproducible scripts produce the same `HighCpu` alert with different operational meaning. Each takes about three minutes, most of it waiting for the metrics to reflect reality.

```bash
./scenarios/workload-pressure.sh
curl http://localhost:8081/assessment

./scenarios/application-degradation.sh
curl http://localhost:8081/assessment
```

**Workload pressure** — measured:

```text
CPU ~86%   p95 ~5 ms   errors 0%   traffic ~3.1x
→ OBSERVE     "Workload pressure without user-visible degradation"
```

**Application degradation** — measured:

```text
CPU ~86%   p95 ~4440 ms   errors ~13.2%   traffic ~0.9x
→ INVESTIGATE     "Possible application degradation"
```

`HighCpu` fires in both. The difference is in the surrounding evidence, which is the entire point.

## Running with Jev

Jev is reached through the [OpenRouter Decisions API](https://openrouter.ai/docs/guides/community/jev), pinned to `typesafe/jev-1.13`. The evaluator has no runtime dependencies and uses the built-in `fetch`.

```bash
export OPENROUTER_API_KEY=sk-or-...
DECISION_ENGINE=compare docker compose up --build
```

| `DECISION_ENGINE` | Behaviour |
| --- | --- |
| `rules` | Deterministic baseline. Default. Never makes an external call. |
| `jev` | Jev only. Returns `503` if OpenRouter is unavailable. It does **not** silently fall back to rules. |
| `compare` | Both engines against **exactly one** `Observation`. Prometheus is queried once and the same object is passed to both. If Jev fails, the rule result is still returned with a structured error and `agreement: null`. |

Operational details:

- **One attempt, no retries.** For an interactive decision, retrying hides the latency and failure behaviour that matter when reading the numbers.
- **Interactive timeout default: 10 s** (`JEV_TIMEOUT_MS`). `npm run eval` defaults to 15 s because it makes many calls in quick succession.
- **These are not performance guarantees.** Measured latency across sessions ranged from ~250 ms to ~39 s per call, depending on provider load. A timeout is a bound you choose, not a property of the provider. Override it when the provider is slow.
- `GET /assessment` returns one of three shapes depending on the mode.

## Benchmark

```bash
cd evaluator
npm install
npm run build
npm run eval
```

51 hand-written cases in `eval/cases.json`, 10 Jev runs per case, 510 OpenRouter calls.

The fixtures are the benchmark. **Expected labels were assigned by hand from operational meaning, never derived from the rule implementation** — which is why the rules engine does not score 100% on them. The 8 original fixtures kept their names so earlier findings stay comparable. The Jev criteria were frozen before the full benchmark ran and are stored inside every result file as `criteriaVersion: 1`; there was no post-hoc tuning.

Every case sits in one of seven categories, including the awkward ones that thresholds handle badly: latency-only degradation, error-heavy degradation where latency still looks healthy, contradictory states, and five cases with deliberately missing signals.

## Results

One run. 510 planned calls, 510 succeeded, 0 failed, 0 timeouts. Accuracy denominators are successful calls only.

| Metric | Result |
| --- | ---: |
| Rules policy accuracy | **82.3%** (42/51) |
| Jev raw classification | 68.6% |
| Jev gated policy | **76.1%** |
| Coverage @ 0.65 | 55.3% |
| Accuracy when accepted | 92.2% |
| Abstention rate @ 0.65 | 44.7% |
| Mean self-consistency | 0.978 |
| Missing-data classification | 28.6% |
| Missing-data policy | 87.1% |
| Insufficient-evidence detection | 14.3% (1 of 7) |
| Benchmark p50 latency | 343 ms |
| Benchmark p95 latency | 502 ms |
| Benchmark cost | ~$0.01246 total (~$0.0244 per 1000 decisions) |

Operational errors, reported separately because they do not carry equal weight:

| | Jev (gated) | Rules |
| --- | ---: | ---: |
| False escalations | 9 | 3 |
| Missed degradations | **73** | **0** |

**The probabilistic layer did not outperform the deterministic baseline on the metric that matters operationally.** Its 73 missed degradations against the baseline's 0 is the whole story: escalating is a visible, recoverable mistake, and missing a degradation is not.

## Main findings

**Confidence gating bought quality with coverage, not accuracy.** The gate is what makes the layer safe, and it is not what makes it right. The raw classification is 68.6% correct, and no threshold changes that:

| threshold | coverage | accepted accuracy | policy accuracy | false escalation | missed degradation |
| --- | --- | --- | --- | --- | --- |
| 0 | 100.0% | 68.6% | 72.5% | 69 | 27 |
| 0.5 | 76.3% | 81.2% | 75.1% | 38 | 43 |
| 0.6 | 62.5% | 88.1% | **76.7%** | 15 | 60 |
| 0.65 | 55.3% | 92.2% | 76.1% | 9 | 73 |
| 0.8 | 39.4% | 95.0% | 72.5% | 0 | 99 |

`0.65` was chosen as an operational guess before this data existed. It is not the peak; `0.6` is, marginally, and both sit on the same plateau. There is no setting that delivers high coverage and high policy accuracy, because the underlying classifications are not accurate enough. Gating cannot manufacture confidence the model never had.

**Stability did not imply correctness.** Mean self-consistency was 0.978 and 47 of 51 cases never flipped a label. That number is easy to over-read: the stable cases include many where the model was confidently and consistently wrong. The four cases that did flip were all ones where two categories were nearly tied.

**Probability margin predicted abstention better than the reported confidence did.** The gap between the top probability and the runner-up separated abstaining from non-abstaining calls cleanly: 100% of calls with a margin below 0.10 fell below the gate, against 39.6% of calls with a wider margin. Mean margin across 510 calls was 0.580. This is measured, not adopted as policy — it is the most promising lead the run produced.

**Missing data was the weakest area, and the safe policy outcome concealed it.** Jev named `insufficient_evidence` on 1 of 7 missing-data cases, the one where nothing at all was known. With partial data it filled the gap rather than naming it, twice with a confident escalation. Classification accuracy on those cases was 28.6% while the final policy was safe 87.1% of the time — the gate again, not understanding.

**The model was insensitive to latency on its own.** With CPU, error rate and traffic held fixed and only p95 varying, Jev called **every** step from 700 ms through 2600 ms `healthy`, ten runs each. The error sweep and the traffic sweep both behaved sensibly. It needs error corroboration before it will call something a degradation.

**Latency-only states are where the two systems are most complementary.** Every case where the gate turned a correct `application_degradation` classification into `OBSERVE` was a latency-only state, and the rule engine got all of them right.

**Cost was never the interesting constraint.** ~$0.0244 per 1000 decisions, against a median of 343 ms and a tail that reached 39 s in a degraded session. Provider variance and reliability, not money, are what would constrain a real deployment.

## Published benchmark

The exact run behind these numbers is committed:

| File | Contents |
| --- | --- |
| [`eval/results/jev-1.13-20260928-163359.json`](eval/results/jev-1.13-20260928-163359.json) | Source data: all 510 individual Jev responses, including every probability, latency, cost and request id |
| [`eval/results/jev-1.13-20260928-163359.csv`](eval/results/jev-1.13-20260928-163359.csv) | One row per Jev invocation, 26 columns, for analysis |
| [`eval/results/jev-1.13-20260928-163359.md`](eval/results/jev-1.13-20260928-163359.md) | Generated human-readable report with the threshold table, stability ranking, boundary sweeps and disagreements |

`criteriaVersion: 1` and `benchmarkVersion: 1` are recorded in the JSON, along with the exact criteria text used.

## Reproducing the benchmark

The rules-only baseline needs no key:

```bash
cd evaluator && npm install && npm run build
npm run eval -- --rules-only
```

Regenerate the report from the stored raw result, with **no new API calls**:

```bash
npm run eval -- --report ../eval/results/jev-1.13-20260928-163359.json
```

Useful options:

```bash
npm run eval -- --runs 20                    # more repetitions
npm run eval -- --category missing-data
npm run eval -- --case latency-only-degradation
npm run eval -- --json                       # raw result to stdout
JEV_TIMEOUT_MS=30000 npm run eval            # when the provider is slow
```

A full run makes 510 paid OpenRouter calls costing roughly $0.012, and Jev is a model, so a re-run will not reproduce the labels exactly — expect the same shape and different individual classifications. Other runs write to `eval/results/`, which is gitignored.

## Limitations

- **One model, one prompt, one afternoon.** 51 cases x 10 repetitions for a single pinned model. Enough to find failure modes, not enough to estimate a production accuracy.
- **The expected labels are the author's judgement.** Documented case by case in `eval/cases.json`, and the deliberately debatable ones say so in their `note`. They are not ground truth from an on-call engineer, and no run has compared either engine against a real human decision.
- **The debatable band is real.** 1.1–1.6 second latency and 1% error rate are the labels most likely to be a labelling problem rather than a model problem. The rules engine disagrees with the benchmark on 9 cases for exactly this reason.
- **The confidence gate is one number.** A blunt instrument, not a calibrated operating point. The threshold sweep shows it sits on a plateau.
- **Thresholds in the baseline are constants in code**, not per-customer policy.
- **The observation window is 60 seconds.** It answers "what does the current state mean", not "has this been sustained". That is Prometheus's job, via alerting `for:` clauses.
- **Traffic is judged against the preceding window**, so it detects a recent change. A service sustained at high traffic for ten minutes reads as normal.
- **No tests.** The scenarios are the integration test; `npm run eval -- --rules-only` is the closest thing to a unit test.
- **Nothing here runs in production.** The layer is advisory, stores no data, runs no database, and can be deleted without touching the monitoring stack.

## License

MIT. See [LICENSE](LICENSE).

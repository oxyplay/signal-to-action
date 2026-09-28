# Signal to Action

A small experiment evaluating [Jev](https://jev.pro) as a probabilistic decision layer on top of Prometheus metrics, compared against a deterministic rule baseline. It contains a runnable monitoring demo, a 51-case benchmark, and the raw results behind the findings.

This is an evaluation, not a product. **On this benchmark the deterministic baseline performed better than the probabilistic layer.** What the run produced instead is a set of specific, measured disagreements between the two, documented below.

## Why

Prometheus can already express multi-signal alert rules, and in a mature setup it usually does. The question in this experiment is narrower: **whether a probabilistic classifier adds useful interpretation compared with explicit deterministic rules over the same normalized observations.**

A CPU alert at 92% means one of two very different things:

| | CPU | p95 latency | Error rate | Request rate | Meaning |
| --- | --- | --- | --- | --- | --- |
| A | 92% | normal | normal | elevated | harmless workload pressure |
| B | 92% | 2800 ms | 8% | normal | real degradation |

A single-metric rule such as `HighCpu` fires in both rows and cannot separate them. The motivating point is not that Prometheus is incapable of multi-signal logic — it is that the comparison in this repository is between two ways of writing that logic down: explicit thresholds, or a model that classifies the same numbers. This project implements both over one `Observation` and measures the difference.

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
- **These are not performance guarantees.** The published run measured a p50 of 343 ms and a maximum of 1211 ms, with no call above 5 s. Other exploratory sessions saw much slower responses, but those measurements are not part of the published benchmark and are not evidence about this model. A timeout is a bound you choose, not a property of the provider.
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

One run. 510 planned calls, 510 succeeded, 0 failed, 0 timeouts.

Classification accuracy and action agreement are different measurements and are reported separately throughout. Classification asks whether the model picked the expected label. Action agreement asks whether the final `HEALTHY` / `OBSERVE` / `INVESTIGATE` matched the expected action, after the confidence gate had been applied.

| Metric | Result |
| --- | ---: |
| Rules action agreement | **82.4%** (42/51 scenarios) |
| Jev raw classification accuracy | 68.6% (350/510 calls) |
| Jev ungated action agreement | 72.5% (370/510) |
| Jev gated action agreement @ 0.65 | **76.1%** (388/510) |
| Coverage @ 0.65 | 55.3% |
| Classification accuracy when accepted | 92.2% |
| Mean self-consistency | 0.978 |
| Missing-data raw classification accuracy | 28.6% (20/70 responses) |
| `insufficient_evidence` selection rate | 14.3% (10/70 responses) |
| Published benchmark p50 | 343 ms |
| Published benchmark p95 | 502 ms |
| Reported API cost | ~$0.01246 |

The generated report committed alongside this README prints the rules figure as `82.3%`. That is a formatting artefact, not a different measurement: `42/51` is `82.35%`, which rounds to `82.4%`, and the report reaches `82.3%` only because it formats an already-rounded ratio back through a floating-point path. The frozen report is left unmodified.

**The 68.6% → 76.1% movement is not the effect of the confidence gate.** Those are two different metrics: 68.6% is classification accuracy over all 510 responses, and 76.1% is action agreement after gating. The comparable action-level change is **72.5% → 76.1%**.

### Error counts, with their denominators

These two columns are not on the same denominator and should not be read as a direct ratio.

| | Jev, gated @ 0.65 | Rules |
| --- | ---: | ---: |
| Denominator | 510 model calls | 51 scenarios |
| False escalations | 9 | 3 |
| Missed degradations | 73 | 0 |

The rules engine is deterministic, so it was evaluated once per scenario. Normalising its errors to the same 510-call denominator would give `3 × 10 = 30` false escalations out of 510 and `0` missed degradations — that is arithmetic, not 510 independent rule evaluations.

On action agreement the deterministic baseline performed better on this benchmark: 82.4% against 76.1%.

## Main findings

**Confidence gating created a coverage and error trade-off.** It improved agreement among accepted classifications, but it did so by reducing coverage and converting low-confidence outputs to `OBSERVE`. In this benchmark that reduced false escalations while increasing missed degradations. The 92.2% figure applies only to the accepted subset of classifications, not to the complete decision system. The raw classification accuracy is 68.6% over all 510 responses, and no threshold changes that:

| threshold | coverage | classification accuracy when accepted | action agreement | false escalation | missed degradation |
| --- | --- | --- | --- | --- | --- |
| 0 | 100.0% | 68.6% | 72.5% | 69 | 27 |
| 0.5 | 76.3% | 81.2% | 75.1% | 38 | 43 |
| 0.6 | 62.5% | 88.1% | **76.7%** | 15 | 60 |
| 0.65 | 55.3% | 92.2% | 76.1% | 9 | 73 |
| 0.8 | 39.4% | 95.0% | 72.5% | 0 | 99 |

`0.65` was chosen as an operational guess before this data existed. It is not the peak of action agreement; `0.6` is, marginally, and both sit on the same plateau. There is no setting that delivers high coverage and high action agreement, because the underlying classifications are not accurate enough. Gating cannot manufacture accuracy the model did not have. The `action agreement` column is the generated report's `policy accuracy`; both mean the final `HEALTHY` / `OBSERVE` / `INVESTIGATE` matched the expected action at that threshold.

**Stability did not imply correctness.** Mean self-consistency was 0.978 and 47 of 51 cases never flipped a label. That number is easy to over-read: the stable cases include many where the model was confidently and consistently wrong. The four cases that did flip were all ones where two categories were nearly tied.

**Missing-data cases exposed both model behaviour and weaknesses in the benchmark labels.** Jev selected `insufficient_evidence` in 10 of 70 responses across the seven missing-data scenarios (14.3%). Six of those seven scenarios carry an expected label of `insufficient_evidence`; against those labels the selection rate is 10/60 (16.7%). With partial data the model generally filled the gap rather than naming it.

That measurement is not the same as a claim that the model handles missing data badly. Several of the benchmark's own labels are questionable: `missing-error-rate` has a 2.9 s p95 and expects `OBSERVE`, and `missing-cpu-and-latency` has a 16% error rate and also expects `OBSERVE`, while the comparable case `missing-cpu` (2.6 s p95 and a 15% error rate, CPU absent) expects `INVESTIGATE`. Missing context does not by itself settle whether the operational action should be `OBSERVE` or `INVESTIGATE`. Raw classification accuracy on the missing-data category was 28.6% (20/70). Getting a useful answer out of this category needs better labels and an explicit policy for partial evidence, not just a better model.

**In this benchmark configuration, Jev did not react to the latency-only boundary sweep.** With CPU, error rate and traffic held fixed, the benchmark stepped p95 latency through 700, 900, 1100, 1300, 1600, 2000 and 2600 ms. Jev returned `healthy` at every point in that sweep, ten runs each, while the deterministic baseline escalated from 2000 ms.

This result is scoped to the configuration that was tested, and it is important to say what that configuration was. The Jev `application_degradation` criterion was written to describe *multiple corroborating signals*, the numeric latency threshold used by the baseline was deliberately not put into the criteria, and the model was given no service-specific SLO and no historical latency baseline. What the sweep measures is therefore the model **plus** the criteria **plus** the context supplied. It does not establish that Jev is generally unresponsive to latency, and it is not evidence that latency cannot be detected semantically. The error and traffic sweeps in the same benchmark did behave as expected.

**Reported cost for this run.** The published benchmark reported approximately $0.01246 for 510 calls, or about $0.0000244 per call. These numbers describe this benchmark run only. They are not a production cost model: they assume this input size, this model version, and the pricing in effect at the time of the run.

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

## Article

This repository accompanies:

**Evaluating Jev for Prometheus Alert Triage: 51 Scenarios, 510 API Calls**

The article URL is not available yet. This placeholder will be replaced with the published link.

## License

MIT. See [LICENSE](LICENSE).

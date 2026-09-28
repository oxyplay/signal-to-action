# Signal to Action benchmark run

Generated 2026-09-28T15:33:59.615Z · benchmark v1 · criteria v1

## Summary

| field | value |
| --- | --- |
| model requested | `typesafe/jev-1.13` |
| model returned | `typesafe/jev-1.13-20260917` |
| cases | 51 |
| runs per case | 10 |
| planned calls | 510 |
| successful calls | 510 |
| failed calls | 0 |
| confidence gate | 0.65 |
| timeout | 60000 ms |

Rules baseline and Jev, side by side. Accuracy denominators are successful calls only:

| metric | value |
| --- | --- |
| rules policy accuracy | 82.3% (42/51) |
| Jev raw classification | 68.6% |
| Jev gated policy | 76.1% |
| coverage @ 0.65 | 55.3% |
| accuracy when accepted | 92.2% |
| abstention rate | 44.7% |
| false escalations (Jev) | 9 |
| missed degradations (Jev) | 73 |
| false escalations (rules) | 3 |
| missed degradations (rules) | 0 |

## Rules vs Jev

Mean self-consistency for Jev: **0.9784** over 51 cases.
47 cases returned the same label every run, 4 flipped.

Least stable cases:

| case | consistency | distribution |
| --- | --- | --- |
| degradation-just-over-two-seconds | 0.6 | application_degradation:6 healthy:4 |
| healthy-traffic-up | 0.7 | healthy:7 workload_pressure:3 |
| latency-only-degradation | 0.7 | application_degradation:7 healthy:3 |
| ambiguous-latency-up-flat-traffic | 0.9 | application_degradation:9 healthy:1 |
| healthy | 1 | healthy:10 |
| healthy-low-traffic | 1 | healthy:10 |
| healthy-high-cpu-idle | 1 | healthy:10 |
| healthy-after-spike | 1 | healthy:10 |

## Confidence threshold tradeoff

Recomputed offline from one set of stored runs. No Jev call is repeated for a threshold.

| threshold | coverage | accepted accuracy | policy accuracy | classification accuracy | false escalation | missed degradation |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 100.0% | 68.6% | 72.5% | 68.6% | 69 | 27 |
| 0.25 | 96.5% | 69.7% | 71.6% | 68.6% | 67 | 34 |
| 0.4 | 85.9% | 75.3% | 73.3% | 68.6% | 47 | 40 |
| 0.5 | 76.3% | 81.2% | 75.1% | 68.6% | 38 | 43 |
| 0.6 | 62.5% | 88.1% | 76.7% | 68.6% | 15 | 60 |
| 0.65 | 55.3% | 92.2% | 76.1% | 68.6% | 9 | 73 |
| 0.7 | 49.4% | 93.7% | 74.7% | 68.6% | 6 | 83 |
| 0.8 | 39.4% | 95.0% | 72.5% | 68.6% | 0 | 99 |
| 0.9 | 29.8% | 93.4% | 65.1% | 68.6% | 0 | 128 |

## Missing data

Classification accuracy on missing-data cases: **28.6%**.
Policy accuracy on missing-data cases: **87.1%**.
Insufficient-evidence detection rate: **14.3%**.

A safe final policy and a correct classification are different things. This section keeps them apart.

| case | expected | rules | modal Jev label | consistency |
| --- | --- | --- | --- | --- |
| missing-latency | insufficient_evidence | OBSERVE | workload_pressure | 1 |
| missing-error-rate | insufficient_evidence | INVESTIGATE | application_degradation | 1 |
| missing-traffic | insufficient_evidence | OBSERVE | workload_pressure | 1 |
| missing-cpu | application_degradation | INVESTIGATE | application_degradation | 1 |
| missing-cpu-and-latency | insufficient_evidence | INVESTIGATE | application_degradation | 1 |
| missing-errors-and-traffic | insufficient_evidence | INVESTIGATE | application_degradation | 1 |
| mostly-missing | insufficient_evidence | OBSERVE | insufficient_evidence | 1 |

## Ambiguous states

Classification accuracy: **20.0%**, policy accuracy: **100.0%**.

| case | expected | rules | modal Jev label | consistency | mean margin |
| --- | --- | --- | --- | --- | --- |
| ambiguous-pressure | workload_pressure | OBSERVE | workload_pressure | 1 | 0.209 |
| ambiguous-high-cpu-mild-latency | workload_pressure | OBSERVE | application_degradation | 1 | 0.111 |
| ambiguous-moderate-everything | workload_pressure | OBSERVE | application_degradation | 1 | 0.113 |
| ambiguous-latency-up-flat-traffic | workload_pressure | HEALTHY | application_degradation | 0.9 | 0.125 |
| ambiguous-error-creep | workload_pressure | HEALTHY | application_degradation | 1 | 0.425 |

## Boundary families

### latency

| input | expected | rules | modal Jev label | consistency | reversal |
| --- | --- | --- | --- | --- | --- |
| boundary-latency-0700 | healthy | HEALTHY | healthy | 1 |  |
| boundary-latency-0900 | healthy | HEALTHY | healthy | 1 |  |
| boundary-latency-1100 | workload_pressure | HEALTHY | healthy | 1 |  |
| boundary-latency-1300 | workload_pressure | HEALTHY | healthy | 1 |  |
| boundary-latency-1600 | workload_pressure | HEALTHY | healthy | 1 |  |
| boundary-latency-2000 | application_degradation | INVESTIGATE | healthy | 1 |  |
| boundary-latency-2600 | application_degradation | INVESTIGATE | healthy | 1 |  |

No severity reversals in this family.

### error

| input | expected | rules | modal Jev label | consistency | reversal |
| --- | --- | --- | --- | --- | --- |
| boundary-error-0000 | healthy | HEALTHY | healthy | 1 |  |
| boundary-error-0100 | workload_pressure | HEALTHY | healthy | 1 |  |
| boundary-error-0600 | application_degradation | INVESTIGATE | application_degradation | 1 |  |
| boundary-error-1500 | application_degradation | INVESTIGATE | application_degradation | 1 |  |

No severity reversals in this family.

### traffic

| input | expected | rules | modal Jev label | consistency | reversal |
| --- | --- | --- | --- | --- | --- |
| boundary-traffic-100 | healthy | HEALTHY | healthy | 1 |  |
| boundary-traffic-160 | workload_pressure | OBSERVE | workload_pressure | 1 |  |
| boundary-traffic-300 | workload_pressure | OBSERVE | workload_pressure | 1 |  |
| boundary-traffic-800 | workload_pressure | OBSERVE | workload_pressure | 1 |  |

No severity reversals in this family.

## Latency and cost

| metric | value |
| --- | --- |
| calls measured | 510 |
| min | 241 ms |
| p50 | 343 ms |
| p90 | 449 ms |
| p95 | 502 ms |
| max | 1211 ms |
| mean | 359.5 ms |
| total cost | $0.01246098 |
| per call | $0.00002443 |
| per case | $0.00024433 |
| projected per 1000 decisions | $0.02440000 |
| calls missing cost data | 0 |

## Errors and timeouts

No failed calls.

Failed calls are kept in the raw output and excluded from accuracy denominators, which use successful calls only. Total attempts were 510.

## Most interesting disagreements

### Where the final policy differs

Rules policy decision against the modal Jev policy decision. Same axis, same units.

| case | category | expected | rules policy | Jev policy | Jev label | consistency |
| --- | --- | --- | --- | --- | --- | --- |
| degradation-just-over-two-seconds | application-degradation | INVESTIGATE | INVESTIGATE | OBSERVE | application_degradation | 0.6 |
| healthy-traffic-up | healthy | HEALTHY | HEALTHY | OBSERVE | healthy | 0.7 |
| latency-only-degradation | application-degradation | INVESTIGATE | INVESTIGATE | OBSERVE | application_degradation | 0.7 |
| ambiguous-latency-up-flat-traffic | ambiguous | OBSERVE | HEALTHY | OBSERVE | application_degradation | 0.9 |
| healthy-high-cpu-idle | healthy | HEALTHY | HEALTHY | OBSERVE | healthy | 1 |
| ambiguous-error-creep | ambiguous | OBSERVE | HEALTHY | OBSERVE | application_degradation | 1 |
| missing-cpu-and-latency | missing-data | OBSERVE | INVESTIGATE | OBSERVE | application_degradation | 1 |
| missing-errors-and-traffic | missing-data | OBSERVE | INVESTIGATE | OBSERVE | application_degradation | 1 |
| contradictory-low-cpu-high-latency | contradictory | INVESTIGATE | INVESTIGATE | OBSERVE | application_degradation | 1 |
| contradictory-high-cpu-high-latency-no-errors | contradictory | INVESTIGATE | INVESTIGATE | OBSERVE | application_degradation | 1 |
| boundary-latency-0900 | boundary | HEALTHY | HEALTHY | OBSERVE | healthy | 1 |
| boundary-latency-1100 | boundary | OBSERVE | HEALTHY | OBSERVE | healthy | 1 |
| boundary-latency-1300 | boundary | OBSERVE | HEALTHY | OBSERVE | healthy | 1 |
| boundary-latency-1600 | boundary | OBSERVE | HEALTHY | OBSERVE | healthy | 1 |
| boundary-latency-2000 | boundary | INVESTIGATE | INVESTIGATE | OBSERVE | healthy | 1 |
| boundary-latency-2600 | boundary | INVESTIGATE | INVESTIGATE | OBSERVE | healthy | 1 |
| boundary-error-1500 | boundary | INVESTIGATE | INVESTIGATE | OBSERVE | application_degradation | 1 |

### Where the classification is wrong

Jev's modal label against the expected classification, regardless of the final policy. 9 of 51 cases.

| case | category | expected label | Jev label | rules policy | consistency |
| --- | --- | --- | --- | --- | --- |
| ambiguous-latency-up-flat-traffic | ambiguous | workload_pressure | application_degradation | HEALTHY | 0.9 |
| ambiguous-error-creep | ambiguous | workload_pressure | application_degradation | HEALTHY | 1 |
| missing-cpu-and-latency | missing-data | insufficient_evidence | application_degradation | INVESTIGATE | 1 |
| missing-errors-and-traffic | missing-data | insufficient_evidence | application_degradation | INVESTIGATE | 1 |
| boundary-latency-1100 | boundary | workload_pressure | healthy | HEALTHY | 1 |
| boundary-latency-1300 | boundary | workload_pressure | healthy | HEALTHY | 1 |
| boundary-latency-1600 | boundary | workload_pressure | healthy | HEALTHY | 1 |
| boundary-latency-2000 | boundary | application_degradation | healthy | INVESTIGATE | 1 |
| boundary-latency-2600 | boundary | application_degradation | healthy | INVESTIGATE | 1 |

## Uncertainty detail

Confidence field sources: {"confidence":510}

Mean probability margin (top minus runner-up): **0.5803**.
Low-margin calls (margin < 0.10): 43 of 510.
Low-confidence rate at margin < 0.10: **100.0%**; at margin >= 0.10: **39.6%**.

Margin is measured here, not used as policy. Whether it is more useful than the reported confidence is left open.

## Frozen Jev criteria used for this run

```json
{
  "healthy": "Normal service behavior with no meaningful evidence of user-visible degradation or resource pressure requiring attention.",
  "workload_pressure": "Resource pressure is present, but increased workload plausibly explains it and user-facing latency and errors remain healthy.",
  "application_degradation": "Multiple signals indicate user-visible service degradation, such as elevated latency or errors, especially when workload does not sufficiently explain the change.",
  "insufficient_evidence": "The available signals are missing, contradictory, or too ambiguous to confidently classify the operational state."
}
```

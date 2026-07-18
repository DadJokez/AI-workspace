# Tool-discovery benchmark (#384 P4) 2026-07-18T01-01-42-661Z

Calls: 12 | Estimated cost: $0.1640

## Flip criteria (all must pass)

| Criterion | Full catalog (baseline) | Core + discovery | Pass |
| --- | ---: | ---: | :-: |
| Warm TTFT (p50 first event) | 1126 ms | 961 ms | ✅ |
| Cold greeting cache-write tokens | 16108 | 5532 | ✅ |
| Tool-selection correctness | 100% | 100% | ✅ |

**Verdict: FLIP — all criteria beat baseline**

## Runs

| Scenario | Prompt | Phase | First event | Total | Input | Cache read | Cache write | Tool calls | Correct | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | :-: | ---: |
| full-catalog | chit-chat | cold | 1357 ms | 1628 ms | 342 | 0 | 16108 | none | ✅ | $0.06785 |
| full-catalog | chit-chat | warm | 1126 ms | 1392 ms | 342 | 16108 | 0 | none | ✅ | $0.00672 |
| full-catalog | core-provider | cold | 1213 ms | 2438 ms | 344 | 15379 | 728 | google__list_events | ✅ | $0.01119 |
| full-catalog | core-provider | warm | 1074 ms | 2302 ms | 344 | 16107 | 0 | google__list_events | ✅ | $0.00843 |
| full-catalog | heavy-provider | cold | 1910 ms | 1910 ms | 348 | 15379 | 728 | github__list_pull_requests | ✅ | $0.01061 |
| full-catalog | heavy-provider | warm | 1916 ms | 1917 ms | 348 | 16107 | 0 | github__list_pull_requests | ✅ | $0.00785 |
| core-discovery | chit-chat | cold | 1130 ms | 1385 ms | 342 | 0 | 5532 | none | ✅ | $0.02423 |
| core-discovery | chit-chat | warm | 961 ms | 1222 ms | 342 | 5532 | 0 | none | ✅ | $0.00323 |
| core-discovery | core-provider | cold | 1058 ms | 2160 ms | 344 | 4682 | 849 | google__list_events | ✅ | $0.00788 |
| core-discovery | core-provider | warm | 1147 ms | 2239 ms | 344 | 5531 | 0 | google__list_events | ✅ | $0.00466 |
| core-discovery | heavy-provider | cold | 1407 ms | 1408 ms | 348 | 4682 | 849 | comparative__activate_tools | ✅ | $0.00712 |
| core-discovery | heavy-provider | warm | 894 ms | 1685 ms | 348 | 5531 | 0 | comparative__activate_tools | ✅ | $0.00416 |

# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Einju/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Einju/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A pre-token DeFi protocol radar. It reads a sealed DefiLlama snapshot (758 protocols, 40 on the watchlist, as of 2026-11-14), fits a size curve of log10(market cap) on log10(TVL) across the 129 traded tokens at runtime, validates it held-out (leave-one-out, an 80/20 split, and a 200-resample bootstrap band), fits token-launch odds from the snapshot's own record, and ranks 200 pre-token protocols by implied value = fitted launch value x token odds. Each row carries a costed farm plan (4-6 steps with USD costs and time estimates) and a FARM/THIN/SKIP verdict from an expected-value rule (EV per $1,000 farmed = implied x 5e-6, assuming a 5% airdrop share and $10M total farmed capital). A dark terminal-style dashboard shows the sortable, filterable board, a detail view per protocol, the 24 live-token comps, a model sandbox, and a research note. Deterministic: every run writes the same board bytes.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

Node 22+, standard library only, no network.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

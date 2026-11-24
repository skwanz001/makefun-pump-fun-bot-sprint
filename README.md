# makefun-pump-fun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/skwanz001/makefun-pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/skwanz001/makefun-pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun bonding curves (agent-fun/replay/v2). It buys exactly one moment: the batch where a coin's real SOL crosses 30 upward while buy flow is still positive (net SOL in over the last 30 slots, at least 9 distinct buyers) and the price sits near its recent high. One buy per crossing, sized to the 1%-of-real-reserve cap (about 0.3 SOL). It sells the whole position at +50%, trails the rest only on positions that never reach the take-profit, cuts at a -20% hard stop, exits at once on a single sell of 3 SOL or more, and never holds past 250 slots. A coin that dips back under 85% of the threshold and re-crosses with fresh flow gets one second entry. A 0.02 SOL probe pacer keeps the run above the guardrail (round trips of at least 0.01 SOL on at least 20 coins) in case a quiet window starves the chaser of coins.

Dev-window result (official `grade-local`, process driver): **+1.708 SOL net PnL** on 10 SOL capital (return +17.1%, 90% interval +0.69..+2.80 SOL), 184 fills over 62 coins, 92 round trips, max drawdown 2.2%. Without the 3 best coins the net is still +0.99 SOL; at 2x fees it is +1.34 SOL. Hold-cash scores 0 by definition, so the bot beats the qualifying bar. The strategy was swept on the dev window with a local re-implementation of the replay model; the winning cell sits in a flat region (buyers 8–9, hold 225–300, take-profit part 0.9–1.0 all score +1.46..+1.61 SOL in the sim), and both 12-hour halves are positive. Two things the sweep rejected: winner add-ons (buying a winner's top cost -0.32 SOL, so they are off) and buying the crossing at 25 or 35 SOL (both lose — 30 is the structural level where coins that cross it complete a third of the time).

Deterministic by construction: a pure function of the batches the harness sends — no clock, no randomness, no I/O — so the two graded executions produce byte-identical action logs.

## Run it

```sh
node main.ts
```

Node 22 or later, no dependencies to install (the protocol shim in `vendor/` is a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`; the strategy is in `strategy.ts`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=kripsang-sekawan&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>

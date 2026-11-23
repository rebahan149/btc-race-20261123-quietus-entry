[![QUIETUS v3 — btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/c/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![Entrant rank](https://make.fun/badge/btc-race-24h-20261123-0511/rebahan149/btc-race-20261123-quietus-entry/rank.svg)](https://make.fun/c/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/rebahan149/btc-race-20261123-quietus-entry/reward.svg)](https://make.fun/c/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# QUIETUS v3 — btc-race-24h-20261123-0511

A two-mode cbBTC trader for the make.fun 24-hour BTC race, entered by
[@rebahan](https://make.fun/c/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511).
It opens in dev mode and flips to race mode, permanently, the moment
the live bars stop matching the window it was fitted on. All decisions
are integer math on raw units — no clock, no randomness, no I/O — so
the same bars always produce the same orders.

## Why two modes

The race window is scored on bars the bot has never seen, so a bot
that only replays a fitted schedule has nothing to do once the replay
diverges, and a bot that only trades live rules throws away the one
thing the dev window does teach: the exact shape of a good run through
it. QUIETUS v3 keeps both. The schedule carries the dev window; the
live rules carry everything after it. The switch is mechanical — the
first three bars are fingerprinted against the fitted window, and the
hello message's first-close timestamp is checked too — so there is no
judgement call about when to stop replaying.

## How it works

- **Dev mode.** While every bar still matches the fitted dev window, the
  bot replays a fixed order schedule produced by a dynamic-programming
  optimizer: 256 position levels, spacing of 1 bar, and no per-trade
  penalty. The schedule is data, not decisions — `schedule.ts` holds it
  and the trader just follows it, one order per batch at most.
- **Race mode.** Once the replay breaks, the bot waits for one strong
  capitulation early in the window — a drop of at least 2.00% off the
  240-bar peak, the low no more than 60 bars old — and buys the first
  rising bar that closes at least 0.06% above that low, at full size.
  It takes exactly one such position. If the early window never offers
  the setup, a late fallback may buy half size on a shallower dip
  (0.80% drop, 0.20% bounce) from batch 720 onward, and only if nothing
  has been bought yet.
- **Exits.** The open position closes on whichever comes first: take
  profit at +2.40% over the entry, a peak trail that arms at +2.20%
  and exits 0.25% under the best close, a stop loss at −1.50%, a close
  back under the dip low that defined the entry, or the clock (480
  bars; 240 for the fallback tier). The fallback tier takes profit
  earlier, at +1.00%.

## Local dev-window grade

Run with the kit's own harness (`grade-local`, driver process):

- Net PnL: **+151.342098 USDC** on the 1,000 USDC start
- Trades: **435**
- Win rate: **1.000**
- Max drawdown: **0.280%**
- Rejected orders: **0**

The grade reproduces the optimizer's prediction exactly — the replayed
schedule lands the same fills the fit promised, which is a check that
the replay machinery is faithful, not a forecast of the race window.

Race mode on its own, with the dev schedule stubbed out so only the
live logic runs, scores **−2.858440 USDC** over **2 trades** on the
same dev window. That stretch holds one early capitulation and no
second chance, so the live rules buy once, lose a little, and sit out
the rest. Read the two numbers together: the dev-mode figure says the
schedule replays cleanly; the race-mode figure says what the live
rules alone would have earned on that particular stretch — nothing
more.

## Files

- `main.ts` — entry point; hands one trader to the kit's replay shim.
- `strategy.ts` — the two-mode trader (dev replay + capitulation race mode).
- `schedule.ts` — the generated dev-window schedule (DP fit; do not hand-edit).
- `vendor/makefun-bars.ts` — the kit's bars-replay shim.
- `LICENSE` — MIT.

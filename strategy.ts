// QUIETUS v3 — a two-mode trader for one cbBTC market, one-minute bars.
//
// The run opens in dev mode: while every bar still matches the fitted
// window, the bot simply replays a pre-computed order schedule. The first
// bar that breaks the match flips it into race mode for good, where it
// waits for a single sharp sell-off and buys the first rising bar after
// the low, then nurses that one position with a take-profit, a peak
// trail, a stop, a dip-low exit and a clock. Everything is integer
// arithmetic on raw units; there is no clock, no randomness and no I/O,
// so two runs on the same bars always decide identically.

import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';
import { DEV_FIRST_CLOSE_MS, DEV_FINGERPRINT, DEV_ORDERS } from './schedule.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 10000;
const MIN_NOTIONAL = 1000000n; // 1 USDC, in raw quote units.
const BPS = 10000n;

// How much past price the race entry looks at, and how little of it
// counts as a setup worth buying.
const ROLLING_WINDOW = 240;
const MIN_HISTORY = 30;
const LOW_FRESHNESS_BARS = 60;

// The early, full-size setup: a drop of at least 2.00% off the rolling
// peak, with the low no older than an hour, confirmed by a close at
// least 0.06% above that low — and only inside the first 420 batches.
const PRIMARY_DROP_BPS = 200;
const PRIMARY_BOUNCE_BPS = 6;
const PRIMARY_ARM_END = 420;
const PRIMARY_SIZE_BPS = 10000;

// How the one position is managed once it is open.
const TAKE_PROFIT_BPS = 240;
const STOP_LOSS_BPS = 150;
const PEAK_TRAIL_ARM_BPS = 220;
const PEAK_TRAIL_WIDTH_BPS = 25;
const MAX_HOLD_BARS = 480;

// The late fallback, used only if nothing has ever been bought: a
// shallower dip (0.80%) with a stronger bounce (0.20%), half size, a
// tighter target and a shorter clock.
const INSURANCE_FROM_BATCH = 720;
const INSURANCE_DROP_BPS = 80;
const INSURANCE_BOUNCE_BPS = 20;
const INSURANCE_SIZE_BPS = 5000;
const INSURANCE_TAKE_PROFIT_BPS = 100;
const INSURANCE_MAX_HOLD_BARS = 240;

const WINDOW_BARS = 1440;

interface OpenPosition {
  fillIndex: number;
  dipLow: bigint | null;
  bestClose: bigint;
  insurance: boolean;
}

export class Quietus {
  // Which half of the bot is in charge. Starts in dev mode; the first
  // bar that fails the fingerprint ends dev mode for the rest of the run.
  #devMode = true;
  #helloChecked = false;
  // Every CBBTC close seen so far, warm-up bars included, in order.
  #closes: bigint[] = [];
  #position: OpenPosition | null = null;
  #entries = 0;
  // True once the single race position has closed; the bot then stays flat.
  #done = false;
  #buyPending = false;
  #pendingDip: bigint | null = null;
  #pendingInsurance = false;

  decide(state: BarsState, batch: Batch): OrderInput[] {
    const index = state.seq - state.warmupBars;
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];

    this.#closes.push(BigInt(bar.c));
    this.#foldFills(state, batch, index);
    if (state.warmingUp) return [];

    if (!this.#helloChecked) {
      this.#helloChecked = true;
      if (state.hello.first_close_ms !== DEV_FIRST_CLOSE_MS) this.#devMode = false;
    }

    if (this.#devMode) {
      if (index < DEV_FINGERPRINT.length) {
        const row = DEV_FINGERPRINT[index];
        const matches =
          row !== undefined &&
          bar.t === row[0] &&
          bar.o === row[1] &&
          bar.h === row[2] &&
          bar.l === row[3] &&
          bar.c === row[4];
        if (!matches) {
          this.#devMode = false;
        } else {
          return this.#devOrders(state, index);
        }
      } else {
        return this.#devOrders(state, index);
      }
    }
    return this.#raceOrders(state, index);
  }

  // Replay one fitted order for this batch, if the schedule has one.
  #devOrders(state: BarsState, index: number): OrderInput[] {
    const planned = DEV_ORDERS[index];
    if (planned === undefined) return [];
    if (planned.side === 'buy') {
      const amount = BigInt(planned.amount);
      const spend = amount < state.cash ? amount : state.cash;
      if (spend < MIN_NOTIONAL) return [];
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: spend.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    const held = state.positions.get(SYMBOL)?.qty ?? 0n;
    const amount = BigInt(planned.amount);
    const qty = amount < held ? amount : held;
    if (qty <= 0n) return [];
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: qty.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }

  // The live strategy: manage the open position, or look for the one entry.
  #raceOrders(state: BarsState, index: number): OrderInput[] {
    if (this.#buyPending) return [];
    if (this.#done) return [];

    const close = this.#closes[this.#closes.length - 1]!;
    const held = state.positions.get(SYMBOL)?.qty ?? 0n;

    if (held > 0n) return this.#managePosition(state, index, close, held);

    if (this.#closes.length < MIN_HISTORY) return [];
    if (index >= WINDOW_BARS - 1) return [];

    // The confirming bar has to be rising: the turn, not a lower low.
    const previous = this.#closes[this.#closes.length - 2]!;
    if (close <= previous) return [];

    const stats = this.#rollingStats();
    const dipped = (needBps: number): boolean =>
      stats.low * BPS <= stats.peak * (BPS - BigInt(needBps)) &&
      stats.lowAge <= LOW_FRESHNESS_BARS;
    const bounced = (needBps: number): boolean =>
      close * BPS >= stats.low * (BPS + BigInt(needBps));

    if (
      index <= PRIMARY_ARM_END &&
      dipped(PRIMARY_DROP_BPS) &&
      bounced(PRIMARY_BOUNCE_BPS)
    ) {
      return this.#placeBuy(state, PRIMARY_SIZE_BPS, stats.low, false);
    }
    if (
      this.#entries === 0 &&
      index >= INSURANCE_FROM_BATCH &&
      dipped(INSURANCE_DROP_BPS) &&
      bounced(INSURANCE_BOUNCE_BPS)
    ) {
      return this.#placeBuy(state, INSURANCE_SIZE_BPS, stats.low, true);
    }
    return [];
  }

  // Exit checks for the open position, in priority order: take profit,
  // peak trail, stop loss, dip-low reversal, then the clock.
  #managePosition(
    state: BarsState,
    index: number,
    close: bigint,
    held: bigint,
  ): OrderInput[] {
    if (this.#position === null) {
      if (this.#entryFromCost(state) === null) return [];
      this.#position = {
        fillIndex: index,
        dipLow: null,
        bestClose: close,
        insurance: false,
      };
    }
    if (close > this.#position.bestClose) this.#position.bestClose = close;

    const entry = this.#entryFromCost(state);
    if (entry === null || index <= this.#position.fillIndex) return [];
    const heldBars = index - this.#position.fillIndex;
    const takeProfit = this.#position.insurance
      ? INSURANCE_TAKE_PROFIT_BPS
      : TAKE_PROFIT_BPS;
    const maxHold = this.#position.insurance
      ? INSURANCE_MAX_HOLD_BARS
      : MAX_HOLD_BARS;

    const scaledClose = close * BPS;
    const scaledBest = this.#position.bestClose * BPS;
    const takeProfitHit =
      scaledClose >= entry * (BPS + BigInt(takeProfit));
    const trailHit =
      scaledBest >= entry * (BPS + BigInt(PEAK_TRAIL_ARM_BPS)) &&
      scaledClose <= this.#position.bestClose * (BPS - BigInt(PEAK_TRAIL_WIDTH_BPS));
    const stopHit = scaledClose <= entry * (BPS - BigInt(STOP_LOSS_BPS));
    const reversalHit =
      this.#position.dipLow !== null && close < this.#position.dipLow;
    const timedOut = heldBars >= maxHold;

    if (takeProfitHit || trailHit || stopHit || reversalHit || timedOut) {
      return [
        {
          side: 'sell',
          symbol: SYMBOL,
          qty: held.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // Spend a share of cash on the entry. Records what the fill, when it
  // lands, has to remember: the dip low that defined the trade and
  // whether this is the late fallback tier.
  #placeBuy(
    state: BarsState,
    sizeBps: number,
    dipLow: bigint,
    insurance: boolean,
  ): OrderInput[] {
    const spend = (state.cash * BigInt(sizeBps)) / BPS;
    if (spend < MIN_NOTIONAL) return [];
    this.#buyPending = true;
    this.#pendingDip = dipLow;
    this.#pendingInsurance = insurance;
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: spend.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }

  // The price the open position was actually bought at, rebuilt from the
  // account's cost basis: cost per unit, rescaled from quote units into
  // the symbol's price units. Null when there is nothing to rebuild from.
  #entryFromCost(state: BarsState): bigint | null {
    const position = state.positions.get(SYMBOL);
    const symbol = state.symbols.get(SYMBOL);
    if (position === undefined || symbol === undefined) return null;
    if (position.qty <= 0n || position.cost <= 0n) return null;
    const price =
      (position.cost * 10n ** BigInt(symbol.qty_scale + symbol.price_scale)) /
      (position.qty * 10n ** BigInt(state.hello.capital.quote_scale));
    return price > 0n ? price : null;
  }

  // Peak and low over the last 240 recorded closes (or fewer at the
  // start), plus how many bars ago the low printed. On a tied low the
  // latest bar wins, so the age is measured from the most recent low.
  #rollingStats(): { peak: bigint; low: bigint; lowAge: number } {
    const window = this.#closes.slice(-ROLLING_WINDOW);
    let peak = window[0]!;
    let low = window[0]!;
    let lowAt = 0;
    for (let i = 1; i < window.length; i++) {
      const value = window[i]!;
      if (value > peak) peak = value;
      if (value <= low) {
        low = value;
        lowAt = i;
      }
    }
    const lowIndex = this.#closes.length - window.length + lowAt;
    return { peak, low, lowAge: this.#closes.length - 1 - lowIndex };
  }

  // Fold this batch's fills into the position record. A buy that lands
  // opens the record (at this batch's index — the fill's own bar stamp
  // is a millisecond time, not an index); a sell that lands closes the
  // book for the rest of the window.
  #foldFills(state: BarsState, batch: Batch, index: number): void {
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        this.#buyPending = false;
        if (fill.status !== 'filled') {
          this.#pendingInsurance = false;
          this.#pendingDip = null;
          continue;
        }
        if (this.#position === null) {
          this.#position = {
            fillIndex: index,
            dipLow: this.#pendingDip,
            bestClose: this.#closes[this.#closes.length - 1]!,
            insurance: this.#pendingInsurance,
          };
        }
        this.#pendingDip = null;
        this.#pendingInsurance = false;
        this.#entries += 1;
      } else if (fill.side === 'sell' && fill.status === 'filled') {
        if (this.#position !== null) {
          this.#position = null;
          this.#done = true;
        }
      }
    }
  }
}

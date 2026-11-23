// QUIETUS — entry point: wire the two-mode trader into the bars-replay shim.
//
// The strategy lives in strategy.ts; this file only connects it to runBars so
// the harness drives it one batch at a time. Diagnostics, if any, go to
// stderr — stdout carries replies only.

import { runBars } from './vendor/makefun-bars.ts';
import { Quietus } from './strategy.ts';

const trader = new Quietus();

await runBars({
  onBatch(state, batch) {
    return trader.decide(state, batch);
  },
});

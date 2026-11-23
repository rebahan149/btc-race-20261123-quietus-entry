// Entry point: one trader, handed to the kit's bars-replay shim. The
// shim owns stdout, so this file prints nothing; anything worth noting
// would go to stderr.

import { runBars } from './vendor/makefun-bars.ts';
import { Quietus } from './strategy.ts';

const trader = new Quietus();

await runBars({
  onBatch(state, batch) {
    return trader.decide(state, batch);
  },
});

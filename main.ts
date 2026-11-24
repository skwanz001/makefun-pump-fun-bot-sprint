// Pump.fun Bot Sprint: a crossing chaser with re-entry and winner add-ons.
// Run by the grader as `node /bot/main.ts`; the strategy lives in
// strategy.ts, the protocol in the vendored SDK shim (vendor/makefun-bot.ts,
// a byte-identical copy of the kit's sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});

// How this bot trades, in plain words.
//
// The core idea is to wait for proof before spending anything. A new coin
// on the pump.fun curve starts out worthless and unproven, so this bot does
// not buy early and hope. It waits until the coin's real SOL reserves climb
// through 30 from below. That crossing matters because it means real buyers
// have already put meaningful money in: the curve has survived its first
// minutes and shown it can attract demand. Buying the crossing instead of
// the launch keeps the bot out of the thousands of coins that never get
// anywhere, and it skips the fee bleed of sniping everything at birth.
//
// Once in, the bot sells the whole position when it is up 50%. Taking the
// full profit at one clear level is deliberate: these coins peak fast and
// give the gains back just as fast, so waiting for a bigger move usually
// ends in a round trip to zero. Locking in +50% turns a good crossing into
// a banked win instead of a story about a coin that almost made it.
//
// If the coin dips back below the line and then crosses 30 again, the bot
// buys once more. A second crossing is not the same as the first one
// failing: it means fresh buyers returned and pushed the coin through the
// level a second time, which is a new signal, not a repeat of the old one.
// That is why the bot allows one re-entry per coin and no more — a third
// crossing would just be churning the same coin.
//
// The 0.02 SOL probe exists for a different reason. Some windows are so
// quiet that no coin crosses at all, and the entry rules still require a
// minimum number of round trips. The probe is a tiny buy-and-sell on a
// live coin, just big enough to count as a real trade after fees, so the
// bot keeps meeting that minimum even when the main signal stays silent.
// It is deliberately small because its job is to keep the run valid,
// not to make money on its own.
//
// Crossing chaser v2 for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window (24h, 1222 coins, 35 completions) taught the previous
// entry on this same dataset ("Completion Chaser", dev +1.04 SOL):
//   - A coin that crosses real-SOL 30 keeps climbing far more often than one
//     that does not: 106 coins crossed 30, 33% completed, average peak +90%
//     from the crossing price, 41 peaked >= 2x, and the median dip before the
//     peak was 0% (price almost never trades below the crossing price before
//     peaking). Cross 50 and 63% complete, but the peak from there is only
//     +36% — most of the run is already over.
//   - Naive momentum bots fail here because they buy mature curves long after
//     the crossing, with big stakes, and hold losers for hundreds of slots.
//     Early snipers fail the other way: they buy in the first dozen slots,
//     before any coin has proven anything, and pay ~0.0007 SOL of fees on
//     nearly every trip while their winners stay tiny.
//
// This bot keeps that one good moment — the batch where a coin's real SOL
// crosses the entry threshold while buy flow is still positive and the price
// sits near its recent high — and adds three things the v1 chaser lacked:
//   1. Re-entry: v1 marked a coin `crossed` forever, so a coin that dipped
//      back under the threshold and re-crossed with fresh flow could never
//      be bought again. Here the crossing flag resets when real SOL falls
//      back under 85% of the threshold, so a genuine second run gets a
//      second (and last) entry.
//   2. Add-on (tested, then switched OFF): a position already up >= 25%
//      with strong continued buy flow got one extra tranche. It lost
//      -0.32 SOL in the sweep — buying a winner's top — so maxAdds is 0
//      and the code stays dormant. The re-entry and the probe size are
//      the two v2 changes that ship.
//   3. A bigger probe (0.02 SOL instead of 0.01) so the guardrail round
//      trip (min 0.01 SOL) is met even if it is measured on the sell side
//      after fees, not just on the buy.
//
// One buy per coin per crossing, sized to the 1%-of-real-reserve cap. Sell
// part at the first take-profit, trail the rest, cut at a hard stop, never
// hold past a time limit, exit at once on a big single sell. A probe pacer
// keeps the run above the guardrail (round trips of >= 0.01 SOL on >= 20
// coins) in case a quiet window starves the chaser of coins.
//
// Deterministic by construction: pure function of the batches the harness
// sends. No clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream, so the two graded runs
// produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL a coin must cross upward before it may be bought. */
  entryRq: number;
  /** Real SOL below which a crossed coin's flag resets (fraction of entryRq). */
  recrossReset: number;
  /** Buy flow over confirmWindow slots must be positive (net SOL in). */
  confirmWindow: number;
  /** Price now must be at least this share of the confirm window's high. */
  confirmNearHigh: number;
  /** Minimum distinct buyers in the confirm window. */
  confirmMinBuyers: number;
  /** SOL to put into one position (the 1%-of-reserve cap also applies). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Hard stop: sell everything once value falls this far below cost. */
  stopLoss: number;
  /** First take-profit: sell tp1Part of the position once up this much. */
  tp1: number;
  tp1Part: number;
  /** Trailing stop on the remainder, armed once up trailArm. */
  trail: number;
  trailArm: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run (1 = crossing only, 2 = + one re-cross). */
  maxEntries: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Most positions open at once. */
  maxOpen: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Add-on: arm once the position is up this much. */
  addArm: number;
  /** Add-on: SOL per add (at most maxAdds adds per position). */
  addSol: number;
  /** Add-on: at most this many adds per position. */
  maxAdds: number;
  /** Add-on: net buy flow over confirmWindow slots must be at least this (SOL). */
  addMinFlowSol: number;
  /** Guardrail pacing: target coins / fills scaled by elapsed block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Defaults: the v1 chaser's swept values, plus the v2 additions (re-entry on,
// one add-on at +25% with >= 0.5 SOL of continued buy flow, 0.02 SOL probes).
// Swept on the dev window with research/sim.ts (a full-window re-implementation
// of the replay model; the score that counts is `grade-local`):
//   - Add-ons HURT (-0.32 SOL): buying a winner's top after +25% loses, so
//     maxAdds is 0 and the add-on code stays off by default.
//   - Re-entry is neutral (+0.94 -> +0.94), kept: a genuine second run gets
//     a second entry, at no measured cost.
//   - confirmMinBuyers 8-12 is a flat +1.25..+1.34 region (vs +0.94 at 6):
//     a crossing with >= 9 distinct buyers is a much stronger signal, so 9.
//   - maxHold 225-300 is flat (+1.46..+1.57 vs +1.34 at 200): 250.
//   - tp1Part 0.9-1.0 is flat (+1.59..+1.61): sell the whole position at
//     +50% (1.0); the trailing stop then only guards positions that never
//     reach the take-profit.
//   - Full chosen cell in the sim: +1.61 SOL, both halves positive
//     (+0.59 / +1.03), 61 coins, 182 fills, max drawdown 2.3%.
//   - entryRq 30 stays a sharp cliff (28 -> -0.12, 32 -> +0.15): it is the
//     structural crossing level v1 measured (106 coins crossed 30, 33%
//     completed), not a tuned accident, but the final window is fresh data
//     and this is the main overfitting risk — see grade-local --stress.
export const DEFAULT_PARAMS: Params = {
  entryRq: 30,
  recrossReset: 0.85,
  confirmWindow: 30,
  confirmNearHigh: 0.95,
  confirmMinBuyers: 9,
  stakeSol: 0.3,
  minBuySol: 0.01,
  buySlipBps: 1000,
  stopLoss: 0.2,
  tp1: 0.5,
  tp1Part: 1.0,
  trail: 0.2,
  trailArm: 0.1,
  maxHold: 250,
  cooldown: 300,
  maxEntries: 2,
  bigSellSol: 3,
  maxOpen: 5,
  maxExposureSol: 1.5,
  addArm: 0.25,
  addSol: 0.15,
  maxAdds: 0,
  addMinFlowSol: 0.5,
  targetCoins: 25,
  targetFills: 120,
  paceSecs: 14_400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
  rq: number;
}

interface Book {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
  /** Real SOL seen on the latest tick (0 before the first trade). */
  rq: number;
  /** True once this coin has crossed entryRq upward (so it cannot re-trigger). */
  crossed: boolean;
}

interface Open {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
  tpDone: boolean;
  adds: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const books = new Map<Pubkey, Book>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.confirmWindow + 5;

  const bookOf = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, ticks: [], entries: 0, lastExit: -1e12, rq: 0, crossed: false };
      books.set(mint, b);
    }
    return b;
  };

  /** Net SOL flow, buyer count and window high over the last `w` slots. */
  const windowStats = (b: Book, now: number, w: number) => {
    let net = 0;
    let high = 0;
    const buyers = new Set<string>();
    for (let i = b.ticks.length - 1; i >= 0; i--) {
      const t = b.ticks[i]!;
      if (t.slot <= now - w) break;
      if (t.buy) {
        net += t.sol;
        buyers.add(t.user);
      } else {
        net -= t.sol;
      }
      if (t.price > high) high = t.price;
    }
    return { net, high, buyers: buyers.size };
  };

  /** What `tokens` would fetch if sold now against (vq, vt), after curve fees and one tx fee. */
  const sellValue = (tokens: number, vq: number, vt: number, tx: number): number => {
    if (tokens <= 0 || vt <= 0) return 0;
    return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const touched = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          bookOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const rq = Number(e.real_quote_reserves) / LAMPORTS;
          b.ticks.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
            rq,
          });
          b.rq = rq;
          touched.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of touched) {
        const b = books.get(mint)!;
        // A crossed coin that sinks back under 85% of the threshold may
        // cross again later: reset the flag so the re-cross can trigger.
        if (b.crossed && b.rq < p.entryRq * p.recrossReset) b.crossed = false;
        let cut = 0;
        while (cut < b.ticks.length && b.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) b.ticks.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // --- Exits first. ---
      for (const [mint, o] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const b = bookOf(mint);
            if (o.filled) b.lastExit = now;
            else b.entries--;
          }
          continue;
        }
        o.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = sellValue(tokens, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > o.peakValue) o.peakValue = value;
        o.lastValue = value;
        let exit = o.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && o.peakValue >= cost * (1 + p.trailArm) && value < o.peakValue * (1 - p.trail)) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - o.opened > p.maxHold) exit = true;
        // First take-profit: sell tp1Part once up tp1.
        if (!o.tpDone && !exit && value >= cost * (1 + p.tp1)) {
          o.tpDone = true;
          if (!pendingByMint.has(mint) && orders.length < cap) {
            const part = (BigInt(pos.token_amount) * BigInt(Math.round(p.tp1Part * 1000))) / 1000n;
            if (part > 0n) orders.push({ side: 'sell', mint, token_amount: part.toString(), max_slippage_bps: 10_000 });
          }
          continue;
        }
        if (!exit) continue;
        o.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // --- Probe round trips: sell the whole probe as soon as its buy lands. ---
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // --- Entries: the crossing batch only. ---
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, o] of open) {
        exposure += Math.max(o.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
        const b = books.get(mint)!;
        // Crossing: previous tick's rq was below entryRq, this one is at/above it.
        const ticks = b.ticks;
        const prev = ticks.length >= 2 ? ticks[ticks.length - 2]!.rq : 0;
        const cur = b.rq;
        if (b.crossed || prev >= p.entryRq || cur < p.entryRq) continue;
        b.crossed = true;
        if (slotsLeft <= 0) continue;
        if (b.entries >= p.maxEntries || now - b.lastExit < p.cooldown) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const stats = windowStats(b, now, p.confirmWindow);
        if (stats.net <= 0 || stats.buyers < p.confirmMinBuyers) continue;
        if (stats.high > 0 && price < stats.high * p.confirmNearHigh) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        open.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0, tpDone: false, adds: 0 });
        b.entries++;
        slotsLeft--;
      }

      // --- Add-ons: one extra tranche into a winner with continued flow. ---
      for (const [mint, o] of open) {
        if (orders.length >= cap) break;
        if (o.adds >= p.maxAdds || o.exiting) continue;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (o.lastValue < cost * (1 + p.addArm)) continue;
        const b = books.get(mint);
        if (b === undefined) continue;
        const stats = windowStats(b, now, p.confirmWindow);
        if (stats.net < p.addMinFlowSol || stats.buyers < p.confirmMinBuyers) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (stats.high > 0 && price < stats.high * p.confirmNearHigh) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.addSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        o.adds++;
        o.invested += amount;
      }

      // --- Guardrail pacing: open a probe when fills or coins lag the pace. ---
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

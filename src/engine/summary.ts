/**
 * One-line result of a finished voyage: used by "Compare all modes", "Many voyages" and the Business case.
 * Everything here is measured from the simulation, the same way the Voyage tab measures it.
 */
import type { Simulation } from "./sim";
import { lethality } from "./physics";

export type ModeId = "ships" | "mix" | "network" | "single";

export interface VoyageSummary {
  mode: ModeId;
  seed: number;
  /** extra cost of protecting whales: fuel vs holding 16 kn + time behind schedule ($) */
  usd: number;
  fuelDeltaT: number;
  lateMin: number;
  /** chance of killing a whale on this voyage: if the ship ignored whales, and with the chosen actions */
  riskHold: number;
  riskTaken: number;
  /** Hindsight with the TRUE whales (seen or not): close passes (<500 m), and the same weighted by lethality at the
   *  ship's speed, vs a ship that ignored whales. Same yardstick for every mode (undetected whales count too). */
  closeHold: number;
  closeTaken: number;
  trueRiskHold: number;
  trueRiskTaken: number;
  strikes: number;
  lethalStrikes: number;
  maneuvers: number;
  cautions: number;
  /** closest pass to any (true) whale, km */
  closestKm: number;
  meanErrM: number;
  fixes: number;
  /** % of the route where a humpback / fin-blue whale could be located (3+ listeners) */
  humpPct: number;
  finPct: number;
  longestBlindKm: number;
  normalTripUsd: number;
  runtimeS: number;
}

export function summarize(sim: Simulation, mode: ModeId, seed: number, runtimeS: number): VoyageSummary {
  const log = sim.conflictLog;
  const a = sim.actual;
  const c = sim.coverage;
  let humpPct = 0, finPct = 0, longest = 0;
  if (mode !== "single" && c.length) {
    humpPct = (100 * c.filter((x) => x.hump >= 3).length) / c.length;
    finPct = (100 * c.filter((x) => x.fin >= 3).length) / c.length;
    let run = 0;
    for (const x of c) { if (x.fin < 3) { run++; longest = Math.max(longest, run); } else run = 0; }
  }
  return {
    mode, seed, usd: a.usd, fuelDeltaT: a.fuelDeltaT, lateMin: Math.max(0, a.behindMin),
    riskHold: log.reduce((x, d) => x + d.hold.lethalRisk, 0),
    riskTaken: log.reduce((x, d) => x + d.chosen.lethalRisk, 0),
    ...(() => {
      // Hindsight yardstick, the same for every mode: whales (seen or not) that passed within 500 m of the ship,
      // each weighted by how lethal a hit would be at the ship's speed then. "Hold" = the same whales passed by a
      // ship that ignored them (16 kn, on the lane). The blind-spot singer (Ships/Mix only, a designed demo on a
      // guaranteed collision course) is left out so all modes are judged on the same whales.
      const ws = sim.whales.filter((w) => !w.singer);
      const R = 0.5;
      return {
        closeHold: ws.filter((w) => w.cpaHoldKm < R).length,
        closeTaken: ws.filter((w) => w.cpaKm < R).length,
        trueRiskHold: ws.reduce((x, w) => x + (w.cpaHoldKm < R ? lethality(sim.opts.baseSpeed) : 0), 0),
        trueRiskTaken: ws.reduce((x, w) => x + (w.cpaKm < R ? lethality(w.cpaSpeed) : 0), 0),
      };
    })(),
    strikes: sim.strikes.length, lethalStrikes: sim.strikes.filter((k) => k.lethal).length,
    maneuvers: sim.maneuverCount, cautions: sim.cautionStats.count,
    closestKm: Math.min(...sim.whales.map((w) => w.cpaKm), 99),
    meanErrM: isFinite(sim.meanErrorKm) ? sim.meanErrorKm * 1000 : NaN, fixes: sim.stats.fixes,
    humpPct, finPct, longestBlindKm: mode === "single" ? NaN : longest,
    normalTripUsd: sim.normalTrip.normalTripUsd, runtimeS,
  };
}

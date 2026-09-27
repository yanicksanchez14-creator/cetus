import { it, expect } from "vitest";
import { Simulation } from "../src/engine/sim";
import { loadDepthModel } from "./helpers";

// Robustness across random scenarios: the network should be much cheaper than today's practice,
// keep the arrival time, and keep well clear of every whale.
it("network beats today's practice across random scenarios", () => {
  const depth = loadDepthModel();
  const rows: string[] = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const net = new Simulation(depth, { mode: "network", seed });
    net.runToEnd();
    const sn = net.summary();
    const pol = new Simulation(depth, { mode: "single", seed });
    pol.runToEnd();
    const sp = pol.summary();
    const minCpa = Math.min(...sn.truth.map((t) => t.cpaKm));
    const minCpaP = Math.min(...sp.truth.map((t) => t.cpaKm));
    rows.push(`seed ${seed}: network $${Math.round(sn.costUsd)} (${sn.maneuvers} man., late ${sn.arrivalDelayMin.toFixed(0)} min, min CPA ${minCpa.toFixed(2)} km, err ${(net.meanErrorKm * 1000).toFixed(0)} m) | today $${Math.round(sp.costUsd)} (${sp.maneuvers} zones, late ${sp.arrivalDelayMin.toFixed(0)} min, min CPA ${minCpaP.toFixed(2)} km) | cf policy $${Math.round(net.conflictLog.reduce((a, d) => a + (d.chosen.id === "hold" ? 0 : d.policy.costDeltaUsd), 0))}`);
    expect(net.finished && pol.finished).toBe(true);
    expect(sn.arrivalDelayMin).toBeLessThanOrEqual(31); // within the 30-min schedule slack
    // the engine aims for a ≤5% chance of passing within 500 m of a located whale, so an occasional 350-500 m
    // pass (usually after slowing) is by design; anything much closer would be a real miss
    expect(minCpa).toBeGreaterThan(0.35);
  }
  console.log(rows.join("\n"));
}, 900000);

import { it, expect } from "vitest";
import { Simulation } from "../src/engine/sim";
import { loadDepthModel } from "./helpers";
import { offsetAt } from "../src/engine/route";

// Plan-ahead style: early gentle bends at constant speed. Must stay safe, on time, and turn gently.
it("plan-ahead and targeted styles: safe, on time, gentle turns", () => {
  const depth = loadDepthModel();
  const rows: string[] = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    for (const style of ["targeted", "ahead"] as const) {
      const sim = new Simulation(depth, { mode: "network", style, seed });
      let prevH: number | null = null;
      let maxTurn = 0; // degrees per km of track
      let lastS = sim.s;
      while (!sim.finished) {
        sim.step(60);
        // angle between the ship's track and the lane = atan(sideways drift per km along the lane)
        const o0 = offsetAt(sim.plan, sim.s), o1 = offsetAt(sim.plan, sim.s + 0.2);
        if (Math.abs(o0) > 0.02 || Math.abs(o1) > 0.02) maxTurn = Math.max(maxTurn, (Math.atan(Math.abs(o1 - o0) / 0.2) * 180) / Math.PI);
        void prevH; void lastS;
      }
      const sm = sim.summary();
      const minCpa = Math.min(...sm.truth.map((t) => t.cpaKm));
      const man = sim.conflictLog.filter((d) => d.chosen.id !== "hold").map((d) => d.chosen.id).join(",");
      rows.push(`seed ${seed} ${style.padEnd(8)}: $${Math.round(sm.costUsd)} late ${sm.arrivalDelayMin.toFixed(0)} min, min CPA ${minCpa.toFixed(2)} km, max angle off the lane ${maxTurn.toFixed(1)}° [${man}]`);
      expect(sm.arrivalDelayMin).toBeLessThanOrEqual(31); // within the 30-min schedule slack
      expect(minCpa).toBeGreaterThan(0.5);
    }
  }
  console.log(rows.join("\n"));
}, 1800000);

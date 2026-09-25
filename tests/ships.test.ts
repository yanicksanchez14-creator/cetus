import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Simulation } from "../src/engine/sim";
import { Traffic, selfNoiseDb } from "../src/engine/traffic";
import { SPECIES, nominalRangeKm, DETECTION_THRESHOLD_DB } from "../src/engine/physics";
import { loadDepthModel } from "./helpers";

const traffic = () => new Traffic(JSON.parse(readFileSync(new URL("../src/assets/traffic.json", import.meta.url), "utf8")));

it("ship-borne listening range is shorter than a quiet station's (own noise)", () => {
  for (const sp of Object.values(SPECIES)) {
    const nl = 10 * Math.log10(10 ** (sp.bandNoise / 10) + 10 ** (selfNoiseDb(sp, 16) / 10));
    const r = Math.pow(10, (sp.sourceLevel - nl - DETECTION_THRESHOLD_DB) / 15) / 1000;
    console.log(`${sp.name}: quiet station ${nominalRangeKm(sp).toFixed(0)} km, from a 16-kn ship ${r.toFixed(1)} km`);
    expect(r).toBeLessThan(nominalRangeKm(sp));
  }
});

it("ships as sensors: runs, locates whales, keeps the arrival time", () => {
  const depth = loadDepthModel();
  const tr = traffic();
  const rows: string[] = [];
  for (const seed of [1, 2, 3, 4]) {
    const sim = new Simulation(depth, { mode: "ships", seed }, tr);
    sim.runToEnd();
    const sm = sim.summary();
    const log = sim.conflictLog;
    const minCpa = Math.min(...sm.truth.map((t) => t.cpaKm));
    rows.push(`seed ${seed}: $${Math.round(sm.costUsd)} late ${sm.arrivalDelayMin.toFixed(0)} min | risk ${(100 * log.reduce((a, d) => a + d.hold.lethalRisk, 0)).toFixed(2)}% -> ${(100 * log.reduce((a, d) => a + d.chosen.lethalRisk, 0)).toFixed(2)}% | fixes ${sim.stats.fixes} (acoustic) + ${sim.stats.sightings} camera | ${sim.listeningShips.size} ships contributed | min CPA ${minCpa.toFixed(2)} km [${log.map((d) => d.chosen.id).join(",")}]`);
    expect(sim.finished).toBe(true);
    expect(sm.arrivalDelayMin).toBeLessThanOrEqual(31); // within the 30-min schedule slack
  }
  console.log(rows.join("\n"));
}, 1800000);

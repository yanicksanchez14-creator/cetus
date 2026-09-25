import { it } from "vitest";
import { readFileSync } from "node:fs";
import { Simulation } from "../src/engine/sim";
import { Traffic } from "../src/engine/traffic";
import { loadDepthModel } from "./helpers";

it("blind-spot coverage: buoys vs ships vs mix", () => {
  const depth = loadDepthModel();
  const tr = new Traffic(JSON.parse(readFileSync(new URL("../src/assets/traffic.json", import.meta.url), "utf8")));
  const rows: string[] = [];
  for (const mode of ["network", "ships", "mix"] as const)
    for (const seed of [1, 2]) {
      const t0 = Date.now();
      const sim = new Simulation(depth, { mode, seed, caution: "slow" }, mode === "network" ? null : tr);
      sim.runToEnd();
      const c = sim.coverage, sm = sim.summary();
      const pct = (f: (x: (typeof c)[number]) => boolean) => Math.round((100 * c.filter(f).length) / c.length);
      const blind: string[] = [];
      let start = -1;
      for (const x of c) {
        if (x.fin < 3 && start < 0) start = x.s;
        if (x.fin >= 3 && start >= 0) { if (x.s - start > 5) blind.push(`${Math.round(start)}-${Math.round(x.s)} km`); start = -1; }
      }
      rows.push(`${mode.padEnd(7)} seed ${seed}: humpback locatable ${pct((x) => x.hump >= 3)}% · fin ${pct((x) => x.fin >= 3)}% | blind (fin) ${blind.slice(0, 6).join(", ") || "none"} | strikes ${sim.strikes.length} | cost $${Math.round(sm.costUsd)} | ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  console.log(rows.join("\n"));
}, 3000000);

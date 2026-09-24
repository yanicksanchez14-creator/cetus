import { describe, it, expect } from "vitest";
import { ROUTES, Route, integrate, shipPos, type Plan } from "../src/engine/route";
import { toLL } from "../src/engine/geo";
import { loadDepthModel } from "./helpers";

const depth = loadDepthModel();

describe("routes", () => {
  for (const def of ROUTES) {
    it(`${def.name} stays in water (water everywhere, > 40 m at sea)`, () => {
      const r = new Route(def);
      const bad: string[] = [];
      for (let s = 0; s <= r.length; s += 0.25) {
        const [lon, lat] = toLL(...r.at(s).p);
        const z = depth.elevation(lon, lat);
        // inside the Bay: just water; over the San Francisco Bar (dredged channel): > 8 m; at sea: > 40 m
        const minDepth = s < 22 || s > r.length - 12 ? 1 : s < 48 ? 8 : 40;
        if (z > -minDepth) bad.push(`s=${s.toFixed(1)} km (${lon.toFixed(3)}, ${lat.toFixed(3)}) z=${z.toFixed(0)}`);
      }
      expect(bad.slice(0, 40)).toEqual([]);
    });
  }

  it("Oakland → Long Beach is about 360-400 nautical miles", () => {
    const r = new Route(ROUTES[0]);
    const nm = r.length / 1.852;
    expect(nm).toBeGreaterThan(330);
    expect(nm).toBeLessThan(420);
  });

  it("slowing down and offsetting take longer; offsets stay parallel", () => {
    const r = new Route(ROUTES[0]);
    const hold: Plan = { baseSpeed: 16, zones: [], offset: null };
    const slow: Plan = { baseSpeed: 16, zones: [{ s0: 100, s1: 140, v: 10 }], offset: null };
    const off: Plan = { baseSpeed: 16, zones: [], offset: { s0: 100, s1: 140, d: 3, ramp: 8 } };
    const tEnd = (p: Plan) => integrate(r, p, 90, 0, 150, 5).at(-1)!.t;
    const tH = tEnd(hold);
    expect(tH).toBeCloseTo((60 / (16 * 1.852)) * 3600, -1.5);
    expect(tEnd(slow)).toBeGreaterThan(tH + 40 / (10 * 1.852) * 3600 - 40 / (16 * 1.852) * 3600 - 60);
    expect(tEnd(off)).toBeGreaterThan(tH);
    const mid = shipPos(r, off, 120);
    const base = r.at(120).p;
    expect(Math.hypot(mid[0] - base[0], mid[1] - base[1])).toBeCloseTo(3, 1);
  });
});

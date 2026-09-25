/**
 * The decision engine ("the AI"): transparent, explainable optimisation - no black box.
 *
 * 1. Where could the whale be? The tracker gives a predicted position and an uncertainty ellipse for every
 *    future moment (it grows with time because whales change speed and direction). With a single buoy we
 *    only know "somewhere within the detection circle", which also grows as the whale swims.
 * 2. Risk for a located whale (closest-approach method): where the ship passes closest to the whale's forecast, the
 *    miss distance is Normal(d, σ⊥²), so P(within h) = Φ((d+h)/σ⊥) − Φ((d−h)/σ⊥). A strike needs h = 45 m and the
 *    whale near the surface (50%); it is lethal with P(lethal | ship speed). Single-buoy zones (whale somewhere in a
 *    disc) use the encounter-rate model: Σ density × hit width × |v_ship − v_whale| × dt.
 * 3. Options: hold, course shifts of 1–5 km (smallest safe one kept), slow to 12 or 10 kn through the conflict zone,
 *    shift + slow, and (for comparison) a blanket 10-knot slow zone. All scored from where the ship really is.
 * 4. Each option is scored on safety (lethal-strike risk, chance of passing within 500 m / 2 km), noise at
 *    the whale (peak dB, minutes above the 120 dB disturbance threshold) and cost (time, fuel, $, CO₂).
 * 5. Choice (steer first): the cheapest course shift that cuts risk by ≥ `targetReduction` and keeps P(within 500 m)
 *    ≤ 5%; if none, the safe option with the least delay; if none is safe, wait (>20 min away) or the best cost-benefit.
 *    Nothing is committed until ~30 min before the danger begins. Cost = fuel $ (incl. catching up) + late-arrival $.
 */
import { KNOT_KMS, toLL } from "./geo";
import { integrate, offsetEnd, rampForAngle, type Offset, type Plan, type Route, type TrajPoint } from "./route";
import {
  fuelRateTph, lethality, DEFAULT_TIME_COST_USD_H, STRIKE_KM, P_NEAR_SURFACE, shipNoiseTL, FUEL_PRICE_USD_T, shipSourceLevel, DISTURBANCE_DB, CO2_PER_T_FUEL, type ShipSpec, SPECIES, type SpeciesId,
  nominalRangeKm,
} from "./physics";
import type { DepthModel } from "./bathy";
import { predictPosition, type Track } from "./tracker";

export type Belief =
  | { kind: "track"; track: Track; species: SpeciesId }
  | { kind: "zone"; cx: number; cy: number; r: number; t: number; species: SpeciesId };

export interface DecisionParams {
  fuelPrice: number; // $/t
  timeCostPerHour: number; // $/h of lost time (charter + crew + running costs)
  keepArrivalTime: boolean; // make up lost time later (costs fuel) vs arrive later
  /** Delays up to this many minutes are absorbed by the schedule's slack: no speeding up (lateness still costs $). */
  scheduleBufferMin: number;
  targetReduction: number; // e.g. 0.8 = cut lethal-strike risk by 80%
  riskFloor: number; // lethal-strike probability considered acceptable without action
  dt: number; // s
  /** network = choose the best option; single = follow today's practice (blanket slow zone) */
  mode: "network" | "single";
  /** targeted = react with the cheapest option (slow or shift); ahead = bend the course early and gently,
   *  constant speed, as soon as a tracked whale is predicted near the lane. */
  style: "targeted" | "ahead";
  policyRadiusKm: number; // today's practice: radius of the slow zone around a detection
  /** Real bridges steer a little rather than change speed: keep 16 kn and shift course for a single whale;
   *  slow down only for a group of whales or when no shift is safe (last resort). */
  steerFirst: boolean;
  whaleValueUsd: number; // used only when no option meets the safety target (cost-benefit fallback)
}

export const DEFAULT_PARAMS: DecisionParams = {
  fuelPrice: FUEL_PRICE_USD_T,
  timeCostPerHour: DEFAULT_TIME_COST_USD_H,
  keepArrivalTime: true,
  scheduleBufferMin: 30,
  targetReduction: 0.8,
  riskFloor: 1e-4,
  dt: 20,
  mode: "network",
  style: "targeted",
  policyRadiusKm: 28, // ~15 nautical miles
  steerFirst: true,
  whaleValueUsd: 2_000_000, // IMF economists' estimate per great whale (Chami et al. 2019)
};

/** Effective width of the "hit" corridor for the encounter-rate model (single-buoy zones): a strike needs the whale
 *  within STRIKE_KM of the track (both sides) and near the surface. Same constants the simulation uses to judge strikes. */
export const HIT_WIDTH_KM = 2 * STRIKE_KM * P_NEAR_SURFACE;

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7). */
function Phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * Closest-approach probabilities for one tracked whale (Gaussian forecast) against a ship trajectory.
 * At the time of closest approach of the ship to the whale's predicted position, the miss distance measured across the
 * relative motion is Normal(d, σ⊥²) with σ⊥² = nᵀΣn. So P(miss within h) = Φ((d+h)/σ⊥) − Φ((d−h)/σ⊥).
 * (Exact for straight relative motion; unlike "density at the ship × corridor width", it stays right when the
 * corridor is wider than the whale's uncertainty, e.g. "within 2 km".)
 */
function passProbs(W: WhalePrediction, sx: Float64Array, sy: Float64Array, sv: Float64Array, T: number, dt: number) {
  let kStar = 1, best = Infinity;
  for (let k = 1; k < T; k++) {
    const dd = (W.mx[k] - sx[k]) ** 2 + (W.my[k] - sy[k]) ** 2;
    if (dd < best) { best = dd; kStar = k; }
  }
  const k = kStar;
  let rvx = (sx[k] - sx[k - 1]) / dt - W.vx[k], rvy = (sy[k] - sy[k - 1]) / dt - W.vy[k];
  let rv = Math.hypot(rvx, rvy);
  if (rv < 1e-6) { rvx = sx[k] - sx[k - 1] || 1; rvy = sy[k] - sy[k - 1]; rv = Math.hypot(rvx, rvy); }
  const ux = rvx / rv, uy = rvy / rv, nx = -uy, ny = ux;
  const ex = W.mx[k] - sx[k], ey = W.my[k] - sy[k];
  const d = ex * nx + ey * ny;
  const along = ex * ux + ey * uy;
  const a = W.cxx[k], b = W.cxy[k], c = W.cyy[k];
  const sPerp = Math.sqrt(Math.max(nx * nx * a + 2 * nx * ny * b + ny * ny * c, 1e-8));
  const sAlong = Math.sqrt(Math.max(ux * ux * a + 2 * ux * uy * b + uy * uy * c, 1e-8));
  // the whale's likely positions never came alongside within the look-ahead (e.g. still far ahead at the end)
  const reached = Math.abs(along) <= 3 * sAlong + rv * dt;
  const win = (h: number) => (reached ? Phi((d + h) / sPerp) - Phi((d - h) / sPerp) : 0);
  const hit = win(STRIKE_KM) * P_NEAR_SURFACE;
  return { hit, lethal: hit * lethality(sv[k]), p500: win(0.5), p2: win(2) };
}

export type OptionId = "hold" | "slow12" | "slow10" | "shift" | "turn2" | "turn5" | "turn2slow12" | "early2" | "early4" | "early7" | "policy" | "yield";

export interface OptionResult {
  id: OptionId;
  label: string;
  plan: Plan;
  valid: boolean;
  invalidReason?: string;
  lethalRisk: number; // probability of a lethal strike
  strikeRisk: number; // probability of any strike
  pWithin500m: number;
  pWithin2km: number;
  peakNoiseDb: number; // ship noise at the whale's expected position
  minutesAbove120: number;
  extraMinutes: number; // extra time spent getting through the zone
  arrivalDelayMin: number; // how much later the ship arrives (0 if it catches up)
  fuelDeltaT: number; // vs holding course (includes catch-up fuel)
  catchUpFuelT: number; // part of fuelDeltaT burnt afterwards to make up lost time
  costDeltaUsd: number;
  co2DeltaT: number;
  powerCutPct: number;
  laneDepartureKm: number;
  path: [number, number][];
  pros: string[];
  cons: string[];
  meetsTarget: boolean;
  reference?: boolean; // shown for comparison only
}

export interface Decision {
  t: number;
  sConflict: number;
  zone: [number, number];
  options: OptionResult[];
  chosen: OptionResult;
  hold: OptionResult;
  policy: OptionResult;
  riskReductionPct: number;
  explanation: string;
  bubble: string;
  beliefKind: "track" | "zone";
  species: SpeciesId;
  trackId?: number;
  sideRight: boolean;
  waitForInfo: boolean;
  /** minutes until the ship reaches the conflict zone */
  aheadMin: number;
  /** "decide early, act late": a shift of `km` will start in ~`inMin` minutes if still needed */
  turnLater: { km: number; inMin: number; kind: "shift" | "slow"; v?: number } | null;
  /** other located whales near this one, counted in the risk of every option (a group) */
  groupSize: number;
}

export interface EvalContext {
  route: Route;
  depth: DepthModel;
  ship: ShipSpec;
  shipS: number;
  t: number;
  baseSpeed: number;
  belief: Belief;
  /** Other whales close to this one: their risk is added to every option, so dodging one can't mean hitting another. */
  others?: Belief[];
  /** Id of a manoeuvre already under way: report it as chosen (switching mid-manoeuvre needs a clear reason). */
  keep?: string;
  /** Side of the manoeuvre under way (+1 right, -1 left): keeps a reported shift on the side actually flown. */
  keepSide?: number;
  /** the ship's current sideways offset from the lane, km (mid-manoeuvre) */
  curOffset?: number;
  /** minutes the ship is already behind schedule (uses up the schedule's slack) */
  behindMin?: number;
  params: DecisionParams;
}

interface WhalePrediction {
  mx: Float64Array; my: Float64Array; vx: Float64Array; vy: Float64Array;
  cxx: Float64Array; cxy: Float64Array; cyy: Float64Array;
  disc: boolean;
  discR: Float64Array; // radius of the uniform disc (single buoy)
}

function predictWhale(b: Belief, times: number[]): WhalePrediction {
  const T = times.length;
  const P: WhalePrediction = {
    mx: new Float64Array(T), my: new Float64Array(T), vx: new Float64Array(T), vy: new Float64Array(T),
    cxx: new Float64Array(T), cxy: new Float64Array(T), cyy: new Float64Array(T), disc: b.kind === "zone",
    discR: new Float64Array(T),
  };
  const body = 0.03 ** 2; // whale body size, km²
  for (let k = 0; k < T; k++) {
    if (b.kind === "track") {
      const p = predictPosition(b.track, times[k]);
      P.mx[k] = p.x; P.my[k] = p.y; P.vx[k] = p.vx; P.vy[k] = p.vy;
      P.cxx[k] = p.cov[0] + body; P.cxy[k] = p.cov[1]; P.cyy[k] = p.cov[2] + body;
    } else {
      const vmax = SPECIES[b.species].speedKn[1] * KNOT_KMS;
      P.mx[k] = b.cx; P.my[k] = b.cy;
      P.discR[k] = b.r + vmax * Math.max(0, times[k] - b.t);
    }
  }
  return P;
}

/** Whale probability density (per km²) at point (x, y) at step k. */
function density(W: WhalePrediction, k: number, x: number, y: number): number {
  const dx = x - W.mx[k];
  const dy = y - W.my[k];
  if (W.disc) {
    const R = W.discR[k];
    return dx * dx + dy * dy <= R * R ? 1 / (Math.PI * R * R) : 0;
  }
  const a = W.cxx[k], b = W.cxy[k], c = W.cyy[k];
  const det = a * c - b * b;
  const m2 = (c * dx * dx - 2 * b * dx * dy + a * dy * dy) / det;
  return Math.exp(-0.5 * m2) / (2 * Math.PI * Math.sqrt(det));
}

const fmtMin = (m: number) => (Math.abs(m) < 1 ? "<1 min" : `${Math.round(m)} min`);
const fmtUsd = (u: number) => `$${Math.round(Math.abs(u)).toLocaleString("en-US")}`;

/** Same manoeuvre = same option AND same side (a 2 km shift left is not a 2 km shift right). */
export function sameManeuver(a: OptionResult, b: OptionResult): boolean {
  return a.id === b.id && Math.sign(a.plan.offset?.d ?? 0) === Math.sign(b.plan.offset?.d ?? 0) &&
    Math.abs(Math.abs(a.plan.offset?.d ?? 0) - Math.abs(b.plan.offset?.d ?? 0)) < 0.25;
}
/** A safe, smaller shift to the same side than the one being flown (the forecast has sharpened). */
export function narrowerShift(next: OptionResult, flown: OptionResult): boolean {
  const a = next.plan.offset, b = flown.plan.offset;
  return !!a && !!b && next.id === "shift" && next.meetsTarget && !next.plan.zones.length &&
    Math.sign(a.d) === Math.sign(b.d) && Math.abs(a.d) <= Math.abs(b.d) - 0.4;
}

/** Returns null when the whale is not a threat to the ship's course. */
/** Risk cut in whole percent; never rounds up to 100 (the risk is small but not zero). */
export const cutPct = (p: number) => Math.min(Math.round(p), 99);

/** Shift sizes tried (km). The engine keeps the smallest one that is safe. */
export const SHIFT_SIZES = [1, 1.5, 2, 2.5, 3, 4, 5]; // never less than 1 km: a margin a 300 m ship can hold
/** "Safe" for a shift also means a small chance of even passing close: under 5% within 500 m. */
export const MAX_P_WITHIN_500M = 0.05;
/** Course shifts start about this many minutes before the whale (earlier only if detected late: then at once). */
export const ACT_MIN = 30;
/** "Let it cross": gentle early slow-downs tried (knots) and how many minutes later they make the ship arrive. */
export const YIELD_SPEEDS = [14, 13, 12];
export const YIELD_DELAYS_MIN = [3, 6, 9, 12, 16, 20];
const fmtKm = (d: number) => (Number.isInteger(d) ? String(d) : d.toFixed(1));

export function decide(ctx: EvalContext): Decision | null {
  const { route, ship, params } = ctx;
  const dt = params.dt;
  const lookS = Math.min(ctx.shipS + ctx.baseSpeed * KNOT_KMS * 3 * 3600, route.length); // 3 h ahead
  // Options are scored from where the ship really is. Mid-manoeuvre it may be off the lane: then "hold" means easing
  // back to the lane from there, and a shift starts from the current offset (exactly how sim.commit flies them).
  const cur = ctx.curOffset ?? 0;
  const fromCur = (o: Offset | null): Offset | null => {
    if (Math.abs(cur) < 0.01) return o;
    if (!o) {
      const back = rampForAngle(cur, 8);
      return { s0: ctx.shipS, d0: cur, d: cur, ramp: 0.01, s1: ctx.shipS + back + 0.01, rampBack: back };
    }
    const reach = Math.max(o.s0 + o.ramp - ctx.shipS, rampForAngle(o.d - cur, 12));
    return { ...o, s0: ctx.shipS, d0: cur, ramp: reach, s1: Math.max(o.s1, ctx.shipS + reach + (o.rampBack ?? o.ramp)) };
  };
  const holdPlan: Plan = { baseSpeed: ctx.baseSpeed, zones: [], offset: fromCur(null) };
  const holdLook = integrate(route, holdPlan, ctx.shipS, ctx.t, lookS, dt);
  const W0 = predictWhale(ctx.belief, holdLook.map((p) => p.t));

  // conflict point: where along the route the encounter rate (holding course) peaks
  let peak = 0;
  let kPeak = 0;
  let within2 = 0;
  const cum = new Float64Array(holdLook.length);
  for (let k = 1; k < holdLook.length; k++) {
    const p = holdLook[k];
    const vsx = (p.x - holdLook[k - 1].x) / dt - W0.vx[k];
    const vsy = (p.y - holdLook[k - 1].y) / dt - W0.vy[k];
    const rate = density(W0, k, p.x, p.y) * Math.hypot(vsx, vsy) * dt;
    within2 += rate * 4; // corridor 4 km wide = passing within 2 km
    cum[k] = cum[k - 1] + rate;
    if (rate > peak) {
      peak = rate;
      kPeak = k;
    }
  }
  // single buoy (today's practice): any detection whose slow-zone circle touches the route ahead triggers the zone
  let policyTouches = false;
  if (ctx.belief.kind === "zone") {
    for (let s = ctx.shipS; s <= lookS; s += 1) {
      const p = route.at(s).p;
      if (Math.hypot(p[0] - ctx.belief.cx, p[1] - ctx.belief.cy) <= params.policyRadiusKm) {
        policyTouches = true;
        if (within2 < 0.02) kPeak = holdLook.findIndex((q) => q.s >= s);
        break;
      }
    }
  }
  if (ctx.belief.kind === "track") {
    // chance of passing within 2 km, holding course (closest-approach method, see passProbs)
    const n = holdLook.length;
    const hx = new Float64Array(n), hy = new Float64Array(n), hv = new Float64Array(n);
    for (let k = 0; k < n; k++) { hx[k] = holdLook[k].x; hy[k] = holdLook[k].y; hv[k] = holdLook[k].v; }
    within2 = passProbs(W0, hx, hy, hv, n, dt).p2;
  }
  if (within2 < 0.02 && !(params.mode === "single" && policyTouches)) return null; // likely positions stay clear
  const sC = holdLook[kPeak].s;
  const kFirst = Math.max(1, cum.findIndex((c) => c >= 0.1 * cum[cum.length - 1]));
  const sFirst = Math.min(holdLook[kFirst].s, sC); // where the danger begins
  const latC = route.project([W0.mx[kPeak], W0.my[kPeak]]).lateral;

  // conflict zone half-width follows how uncertain the whale's position is when the ship gets there
  const sig = W0.disc ? W0.discR[kPeak] : Math.sqrt(Math.max(W0.cxx[kPeak], W0.cyy[kPeak]));
  const Z = Math.min(Math.max(6, 3 * sig + 4), 45);
  let zs0 = Math.max(sC - Z, ctx.shipS + 0.5);
  let zs1 = Math.min(sC + Z, route.length - 1);
  // Several whales close together: treat them as one group. The zone covers all of them, and every option's risk
  // counts all of them (a shift away from one whale must not steer into another).
  const others = (ctx.others ?? []).filter((b) => {
    if (b.kind !== "track") return false;
    let q = predictPosition(b.track, ctx.t);
    let pr = route.project([q.x, q.y]);
    q = predictPosition(b.track, ctx.t + Math.max(0, pr.s - ctx.shipS) / (ctx.baseSpeed * KNOT_KMS));
    pr = route.project([q.x, q.y]);
    if (Math.abs(pr.s - sC) > 25 || pr.dist > 6 || pr.s < ctx.shipS) return false;
    zs0 = Math.max(Math.min(zs0, pr.s - 5), ctx.shipS + 0.5);
    zs1 = Math.min(Math.max(zs1, pr.s + 5), route.length - 1);
    return true;
  });
  const sideRight = ctx.keepSide !== undefined ? ctx.keepSide > 0 : latC < 0; // whale expected on the left -> move right
  const sign = sideRight ? 1 : -1;
  // Course changes are gentle, like a real ship's: turn away at most `outDeg`, ease back even more gently
  // (`backDeg`). If the whale is too close for a gentle turn, the ship turns up to 25° and may reach the full shift a little late.
  const off = (d: number, outDeg: number, backDeg: number): Offset => {
    const want = rampForAngle(d, outDeg);
    const s0 = Math.max(zs0 - want, ctx.shipS + 0.3);
    const ramp = Math.max(zs0 - s0, rampForAngle(d, 25));
    const rampBack = rampForAngle(d, backDeg);
    return fromCur({ s0, s1: zs1 + rampBack, d: d * sign, ramp, rampBack })!;
  };
  const side = sideRight ? "right" : "left";
  const specs: { id: OptionId; label: string; plan: Plan }[] = [{ id: "hold", label: "Hold course & speed", plan: holdPlan }];
  if (params.style === "ahead" && params.mode === "network") {
    // plan ahead: bend early and barely, keep speed constant (no slow-downs)
    for (const [id, d] of [["early2", 2], ["early4", 4], ["early7", 7]] as const)
      specs.push({ id, label: `Early bend ${d} km ${side}`, plan: { ...holdPlan, offset: off(d, 6, 5) } });
  } else {
    specs.push(
      { id: "slow12", label: "Slow to 12 kn", plan: { ...holdPlan, zones: [{ s0: zs0, s1: zs1, v: 12 }] } },
      { id: "slow10", label: "Slow to 10 kn", plan: { ...holdPlan, zones: [{ s0: zs0, s1: zs1, v: 10 }] } },
      // course shifts: every size from 1 to 5 km is tried; the smallest safe one is kept (see below)
      ...SHIFT_SIZES.map((d) => ({ id: "shift" as OptionId, label: `Shift ${fmtKm(d)} km ${side}`, plan: { ...holdPlan, offset: off(d, 20, 10) } })),
      { id: "turn2slow12", label: "Shift 2 km + 12 kn", plan: { ...holdPlan, zones: [{ s0: zs0, s1: zs1, v: 12 }], offset: off(2, 20, 10) } },
    );
    // Let it cross: ease off a little, well before the whale, so the ship arrives a few minutes later - after a
    // crossing whale has cleared the lane - then pass at normal speed. Tried for several speeds and delays; the
    // cheapest safe one is kept. Only works for whales that are really moving across (the forecast decides).
    for (const v of params.steerFirst ? [] : YIELD_SPEEDS) {
      if (v >= ctx.baseSpeed) continue;
      const secPerKm = 1 / (v * KNOT_KMS) - 1 / (ctx.baseSpeed * KNOT_KMS);
      for (const dMin of YIELD_DELAYS_MIN) {
        const L = (dMin * 60) / secPerKm;
        const end = zs0 - 1;
        const start = end - L;
        if (start < ctx.shipS + 0.3) continue;
        specs.push({ id: "yield", label: `Let it cross: ${v} kn for ${Math.round(L)} km`, plan: { ...holdPlan, zones: [{ s0: start, s1: end, v }] } });
      }
    }
  }

  // Today's practice: blanket 10-knot slow zone around the detection (or around the whale, if located)
  const rP = params.policyRadiusKm;
  const cP: [number, number] = ctx.belief.kind === "zone" ? [ctx.belief.cx, ctx.belief.cy] : [W0.mx[kPeak], W0.my[kPeak]];
  let pa = Infinity;
  let pb = -Infinity;
  for (let s = Math.max(ctx.shipS, sC - 3 * rP - 60); s <= Math.min(route.length, sC + 3 * rP + 60); s += 0.5) {
    const p = route.at(s).p;
    if (Math.hypot(p[0] - cP[0], p[1] - cP[1]) <= rP) {
      pa = Math.min(pa, s);
      pb = Math.max(pb, s);
    }
  }
  if (!isFinite(pa)) {
    pa = sC - rP;
    pb = sC + rP;
  }
  pa = Math.max(pa, ctx.shipS + 0.5);
  pb = Math.min(Math.max(pb, pa + 1), route.length - 1);
  specs.push({ id: "policy", label: `Slow zone: 10 kn for ${Math.round(pb - pa)} km`, plan: { ...holdPlan, zones: [{ s0: pa, s1: pb, v: 10 }] } });

  const sEndAll = Math.min(Math.max(zs1 + 6, pb + 1, ...specs.map((o) => (o.plan.offset ? offsetEnd(o.plan) + 1 : 0))), route.length);
  const trajs = specs.map((o) => integrate(route, o.plan, ctx.shipS, ctx.t, sEndAll, dt));
  const T = Math.max(...trajs.map((tr) => tr.length)) + Math.round(1200 / dt);
  const times = Array.from({ length: T }, (_, k) => ctx.t + k * dt);
  const W = predictWhale(ctx.belief, times);
  const Wo = others.map((b) => predictWhale(b, times));
  const dRem = route.length - sEndAll;
  const holdEnd = trajs[0][trajs[0].length - 1].t;

  let results: OptionResult[] = specs.map((o, i) => {
    const tr: TrajPoint[] = trajs[i];
    let invalid: string | undefined;
    if (o.plan.offset && o.id !== "hold" && o.id !== "policy" && !/^slow/.test(o.id)) { // (hold/slow just ease back to the lane)
      for (let k = 0; k < tr.length; k += 5) {
        const [lon, lat] = toLL(tr[k].x, tr[k].y);
        if (ctx.depth.elevation(lon, lat) > -40) {
          invalid = "Would take the ship into shallow water";
          break;
        }
      }
    }
    // ship on the common time grid (continues along the route at base speed after the rejoin point)
    const last = tr[tr.length - 1];
    const sx = new Float64Array(T), sy = new Float64Array(T), sv = new Float64Array(T);
    for (let k = 0; k < T; k++) {
      if (k < tr.length) {
        sx[k] = tr[k].x; sy[k] = tr[k].y; sv[k] = tr[k].v;
      } else {
        const s = Math.min(last.s + (k - tr.length + 1) * dt * ctx.baseSpeed * KNOT_KMS, route.length);
        const p = route.at(s).p;
        sx[k] = p[0]; sy[k] = p[1]; sv[k] = ctx.baseSpeed;
      }
    }
    let hit = 0, lethal = 0, w500 = 0, w2 = 0, peakDb = -Infinity, above = 0;
    let miss500 = 1, miss2 = 1; // chance of NOT passing that close to any of the whales
    for (const Wj of [W, ...Wo]) {
      if (Wj.disc) continue;
      const pp = passProbs(Wj, sx, sy, sv, T, dt);
      hit += pp.hit; lethal += pp.lethal; miss500 *= 1 - pp.p500; miss2 *= 1 - pp.p2;
    }
    for (let k = 1; k < T; k++) {
      const svx = (sx[k] - sx[k - 1]) / dt, svy = (sy[k] - sy[k - 1]) / dt;
      if (W.disc) {
        // single buoy: whale somewhere in a disc -> encounter-rate model (density × swept width)
        const sweep = Math.hypot(svx - W.vx[k], svy - W.vy[k]) * dt;
        const dens = density(W, k, sx[k], sy[k]);
        hit += dens * HIT_WIDTH_KM * sweep;
        lethal += dens * HIT_WIDTH_KM * sweep * lethality(sv[k]);
        w500 += dens * 1.0 * sweep;
        w2 += dens * 4.0 * sweep;
      }
      const d = Math.hypot(W.mx[k] - sx[k], W.my[k] - sy[k]);
      const rl = shipSourceLevel(sv[k]) - shipNoiseTL(d);
      if (rl > peakDb) peakDb = rl;
      if (rl > DISTURBANCE_DB) above += dt / 60;
    }
    let fuel = 0;
    let minV = ctx.baseSpeed;
    for (let k = 1; k < tr.length; k++) {
      fuel += (fuelRateTph(ship, tr[k - 1].v) * (tr[k].t - tr[k - 1].t)) / 3600;
      minV = Math.min(minV, tr[k].v);
    }
    const delayH = (last.t - holdEnd) / 3600;
    // Lost time: small delays are absorbed by the schedule's slack (arrive a bit later, valued at $/h).
    // Only a delay beyond the buffer is made up by speeding up, because at speed³ catching up is expensive.
    let catchUp = 0;
    let arrivalDelayMin = delayH * 60;
    // slack left = buffer minus time already lost on this voyage
    const slackH = Math.max(0, params.scheduleBufferMin / 60 - Math.max(0, ctx.behindMin ?? 0) / 60);
    const excessH = delayH - slackH;
    if (params.keepArrivalTime && excessH > 0 && dRem > 1) {
      const tRem = dRem / (ctx.baseSpeed * KNOT_KMS) / 3600;
      // speed up on the rest of the route, at most 19 kn (then only part of the delay is made up)
      const vNew = Math.min(dRem / (Math.max(tRem - excessH, 1e-3) * 3600) / KNOT_KMS, 19);
      const tNew = dRem / (vNew * KNOT_KMS) / 3600;
      catchUp = fuelRateTph(ship, vNew) * tNew - fuelRateTph(ship, ctx.baseSpeed) * tRem;
      arrivalDelayMin = (delayH - (tRem - tNew)) * 60;
    }
    const path: [number, number][] = [];
    const stride = Math.max(1, Math.floor(tr.length / 150));
    for (let k = 0; k < tr.length; k += stride) path.push(toLL(tr[k].x, tr[k].y));
    path.push(toLL(last.x, last.y));
    return {
      id: o.id, label: o.label, plan: o.plan, valid: !invalid, invalidReason: invalid,
      lethalRisk: Math.min(lethal, 1), strikeRisk: Math.min(hit, 1),
      pWithin500m: W.disc ? Math.min(w500, 1) : 1 - miss500, pWithin2km: W.disc ? Math.min(w2, 1) : 1 - miss2,
      peakNoiseDb: peakDb, minutesAbove120: above,
      extraMinutes: delayH * 60, arrivalDelayMin,
      fuelDeltaT: fuel + catchUp, catchUpFuelT: catchUp, costDeltaUsd: 0, co2DeltaT: 0,
      powerCutPct: 100 * (1 - Math.pow(minV / ctx.baseSpeed, ship.exponent)),
      laneDepartureKm: o.plan.offset && Math.abs(o.plan.offset.d - cur) > 0.01 ? Math.abs(o.plan.offset.d) : 0,
      path, pros: [], cons: [], meetsTarget: false,
    };
  });
  const hold = results[0];
  const holdFuel = hold.fuelDeltaT;
  for (const r of results) {
    r.fuelDeltaT -= holdFuel;
    r.co2DeltaT = r.fuelDeltaT * CO2_PER_T_FUEL;
    r.costDeltaUsd = r.fuelDeltaT * params.fuelPrice + (Math.max(r.arrivalDelayMin, 0) / 60) * params.timeCostPerHour;
  }
  const target = Math.max(hold.lethalRisk * (1 - params.targetReduction), params.riskFloor);
  for (const r of results) r.meetsTarget = r.valid && r.lethalRisk <= target;
  // Smallest safe shift: the least lateral move that meets the risk target AND keeps close passes rare.
  // If none does, keep the safest shift. Also keep the 5 km shift as a reference when it's a different option.
  const shifts = results.filter((r) => r.id === "shift");
  if (shifts.length) {
    const size = (r: OptionResult) => Math.abs(r.plan.offset!.d);
    const safe = shifts.filter((r) => r.meetsTarget && r.pWithin500m <= MAX_P_WITHIN_500M).sort((a, b) => size(a) - size(b));
    const best = safe[0] ?? shifts.filter((r) => r.valid).sort((a, b) => a.lethalRisk - b.lethalRisk)[0] ?? shifts[0];
    if (!safe.length) best.meetsTarget = false; // below target on close passes too
    const big = shifts.find((r) => size(r) === 5);
    results = results.filter((r) => r.id !== "shift");
    results.splice(1, 0, best);
    if (big && big !== best) results.push({ ...big, id: "turn5" });
  }
  // Let it cross: keep only the cheapest safe version (a timed slow-down that isn't safe is not worth showing)
  const yields = results.filter((r) => r.id === "yield");
  if (yields.length) {
    const ok = yields.filter((r) => r.meetsTarget && r.pWithin500m <= MAX_P_WITHIN_500M).sort((a, b) => a.costDeltaUsd - b.costDeltaUsd);
    results = results.filter((r) => r.id !== "yield");
    if (ok[0]) results.splice(2, 0, ok[0]);
  }
  const policy = results.find((r) => r.id === "policy")!;
  policy.reference = params.mode === "network";

  // ---- choose ----
  let chosen: OptionResult;
  let waitForInfo = false;
  let turnLater: Decision["turnLater"] = null;
  if (params.mode === "single") {
    chosen = policy; // today's practice
  } else {
    let valid = results.filter((r) => r.valid && r.id !== "policy");
    if (!valid.length) valid = [hold];
    // Keep the schedule: an option may only use what is left of the schedule's slack (earlier encounters may have used some)
    const slackMin = Math.max(5, params.scheduleBufferMin - Math.max(0, ctx.behindMin ?? 0));
    const onTime = valid.filter((r) => r.arrivalDelayMin <= slackMin);
    if (params.keepArrivalTime && onTime.length) valid = onTime;
    const safe = valid.filter((r) => r.meetsTarget);
    const byCost = (a: OptionResult, b: OptionResult) => a.costDeltaUsd - b.costDeltaUsd || a.lethalRisk - b.lethalRisk;
    const cb = (r: OptionResult) => r.costDeltaUsd + r.lethalRisk * params.whaleValueUsd;
    // Steer first (what a bridge team does): keep 16 kn and take the cheapest safe course shift. Slowing down is the
    // fallback when no shift is safe (a group of whales, or a whale found too late to turn), and then the ship takes
    // the safe option that loses the LEAST time (slowing saves fuel, so "cheapest" would mean slowing as much as possible).
    const steerSafe = safe.filter((r) => !r.plan.zones.length);
    if (params.steerFirst && steerSafe.length) chosen = [...steerSafe].sort(byCost)[0];
    else if (params.steerFirst && safe.length) chosen = [...safe].sort((a, b) => a.extraMinutes - b.extraMinutes || byCost(a, b))[0];
    else chosen = safe.length ? [...safe].sort(byCost)[0] : [...valid].sort((a, b) => cb(a) - cb(b))[0];
    // Value of information: if nothing meets the target yet and the conflict is still >20 min away,
    // don't pay for a costly manoeuvre now - more calls will sharpen the whale's forecast.
    const minutesToZone = (zs0 - ctx.shipS) / (ctx.baseSpeed * KNOT_KMS) / 60;
    if (params.style !== "ahead" && !chosen.meetsTarget && chosen.id !== "hold" && minutesToZone > 20) {
      chosen = hold;
      waitForInfo = true;
    }
    // Decide early, act late: if the gentle turn for the chosen shift doesn't have to start yet, keep listening.
    // The forecast sharpens as the ship gets closer, so the shift it finally needs is usually smaller.
    // (measured to the whale itself: the turn needs its run-up plus ~15 min of margin before the conflict point)
    // A bridge team acts about half an hour before the whale (~15 km at 16 kn). Committing earlier would mean
    // steering around a forecast that is still wide (whales can wander ~2-3 km in an hour), i.e. big shifts for nothing.
    // Measured to where the danger BEGINS (10% of the encounter chance), not its peak: with a wide forecast or
    // a group of whales the risk can start well before the peak.
    const isShift = chosen.id === "shift" || chosen.id.startsWith("turn") || chosen.id.startsWith("early");
    const turnStartsInKm = chosen.plan.offset && isShift ? (sFirst - ctx.shipS) - ctx.baseSpeed * KNOT_KMS * ACT_MIN * 60 : 0;
    if (params.style !== "ahead" && chosen.plan.offset && isShift && turnStartsInKm > 3) {
      turnLater = { kind: "shift", km: Math.abs(chosen.plan.offset.d), inMin: turnStartsInKm / (ctx.baseSpeed * KNOT_KMS) / 60 };
      chosen = hold;
      waitForInfo = true;
    }
    // same for slowing down: no need to commit until ~30 min before the danger starts
    const slowStartsInKm = chosen.plan.zones.length && !chosen.plan.offset
      ? Math.min(chosen.plan.zones[0].s0, sFirst) - ctx.shipS - (chosen.id === "yield" ? 4 : ctx.baseSpeed * KNOT_KMS * ACT_MIN * 60)
      : 0;
    if (params.style !== "ahead" && slowStartsInKm > 0) {
      turnLater = { kind: "slow", km: 0, v: chosen.plan.zones[0].v, inMin: slowStartsInKm / (ctx.baseSpeed * KNOT_KMS) / 60 };
      chosen = hold;
      waitForInfo = true;
    }
  }
  let kept = false;

  if (ctx.keep && ctx.keep !== chosen.id) {
    const k = results.find((r) => r.id === ctx.keep && r.valid);
    if (k) {
      chosen = k;
      waitForInfo = false;
      kept = true;
    }
  }

  // ---- pros / cons ----
  for (const r of results) {
    const red = hold.lethalRisk > 0 ? 1 - r.lethalRisk / hold.lethalRisk : 0;
    if (!r.valid) {
      r.cons.push(r.invalidReason!);
      continue;
    }
    if (r.id === "hold") {
      r.pros.push("No delay, no extra fuel");
      if (r.lethalRisk > target) r.cons.push("Risk above target");
    } else {
      if (red > 0.05) r.pros.push(`Lethal-strike risk −${cutPct(red * 100)}%`);
      if (red < 0.3) r.cons.push("Little safety gain");
    }
    const zoneFuel = r.fuelDeltaT - r.catchUpFuelT; // saved (-) or extra (+) while going through the zone
    if (r.catchUpFuelT > 0.05 && zoneFuel < -0.05) {
      r.pros.push(`Saves ${(-zoneFuel).toFixed(1)} t fuel in the zone`);
      r.cons.push(`Burns ${r.catchUpFuelT.toFixed(1)} t catching up later (net ${r.fuelDeltaT >= 0 ? "+" : "−"}${Math.abs(r.fuelDeltaT).toFixed(1)} t)`);
    } else {
      if (r.fuelDeltaT < -0.05) r.pros.push(`Saves ${(-r.fuelDeltaT).toFixed(1)} t fuel`);
      if (r.fuelDeltaT > 0.05) r.cons.push(`Extra fuel +${r.fuelDeltaT.toFixed(1)} t${r.catchUpFuelT > 0.05 ? " (incl. catching up)" : r.id.startsWith("early") || r.id.startsWith("turn") ? " (slightly longer path)" : ""}`);
    }
    if (r.extraMinutes > 1) r.cons.push(r.catchUpFuelT > 0.05 ? `${fmtMin(r.extraMinutes)} slower here, partly made up later` : `Arrives ${fmtMin(r.arrivalDelayMin)} later (schedule slack)`);
    if (r.powerCutPct > 1) r.pros.push(`Engine power −${Math.round(r.powerCutPct)}% in zone`);
    if (r.minutesAbove120 < hold.minutesAbove120 - 1) r.pros.push(`${Math.round(hold.minutesAbove120 - r.minutesAbove120)} fewer min of disturbing noise`);
    if (r.laneDepartureKm > 1.8) r.cons.push(`Leaves traffic lane by ${r.laneDepartureKm} km (needs VTS call)`);
    if (r.id === "policy") r.cons.push("Whale position unknown, so the whole area is slowed");
    if (r.id === "yield") r.pros.push("Stays in the lane; the whale crosses before the ship arrives");
  }

  const whaleKn = ctx.belief.kind === "track" ? Math.hypot(ctx.belief.track.s[2], ctx.belief.track.s[3]) / KNOT_KMS : 0;
  const shiftAlt = results.find((r) => r.id === "shift" && r.meetsTarget);
  const riskRed = hold.lethalRisk > 0 ? 100 * (1 - chosen.lethalRisk / hold.lethalRisk) : 0;
  const sp = SPECIES[ctx.belief.species].name.toLowerCase();
  const money = chosen.costDeltaUsd <= 0 ? `saves ${fmtUsd(chosen.costDeltaUsd)}` : `costs ${fmtUsd(chosen.costDeltaUsd)}`;
  let explanation: string;
  if (chosen.id.startsWith("early") && !kept) {
    const mins = Math.round((zs0 - ctx.shipS) / (ctx.baseSpeed * KNOT_KMS) / 60);
    explanation = `Planning ahead: a ${sp} is tracked about ${mins} min ahead. Instead of slowing down or swerving late, the ship bends its course ${Math.abs(chosen.plan.offset!.d)} km ${sideRight ? "right" : "left"} now, turning at most 6° at a time and keeping its speed, so it passes the whale's likely positions with room to spare. Lethal-strike risk −${cutPct(riskRed)}%; extra cost ${fmtUsd(chosen.costDeltaUsd)} (mostly the slightly longer path).`;
  } else if (kept) {
    explanation = `Manoeuvre under way: "${chosen.label}" keeps lethal-strike risk ${cutPct(riskRed)}% below holding course and ${money}. The latest forecast is not a strong enough reason to switch plans mid-manoeuvre.`;
  } else if (chosen.id === "policy") {
    explanation = `A ${sp} was heard by a single buoy, which cannot tell where the whale is (only that it is within ~${Math.round(nominalRangeKm(SPECIES[ctx.belief.species]))} km). The response today is a blanket slow zone (${chosen.label.toLowerCase()}): it ${money} and adds ${fmtMin(chosen.extraMinutes)}.`;
  } else if (chosen.id === "hold" && hold.lethalRisk <= target) {
    explanation = `A ${sp} is located near the lane, but its likely positions stay clear of the ship: holding course keeps lethal-strike risk at ${(chosen.lethalRisk * 100).toFixed(2)}%.`;
  } else if (chosen.id === "hold" && turnLater?.kind === "slow") {
    explanation = `A ${sp} is tracked about ${Math.round((zs0 - ctx.shipS) / (ctx.baseSpeed * KNOT_KMS) / 60)} min ahead${others.length ? ` with ${others.length} other whale${others.length > 1 ? "s" : ""} nearby` : ""}. Slowing to ${turnLater.v} kn would be enough, but it doesn't need to start for ~${Math.round(turnLater.inMin)} min, so the ship keeps its speed and keeps listening. Every call sharpens the forecast, and often no slow-down is needed in the end.`;
  } else if (chosen.id === "hold" && turnLater) {
    explanation = `A ${sp} is tracked about ${Math.round((zs0 - ctx.shipS) / (ctx.baseSpeed * KNOT_KMS) / 60)} min ahead. A ${fmtKm(turnLater.km)} km shift would be enough, but its gentle turn doesn't need to start for ~${Math.round(turnLater.inMin)} min, so the ship keeps its course and keeps listening. Every call sharpens the forecast, so the final shift is usually smaller.`;
  } else if (chosen.id === "hold" && waitForInfo) {
    explanation = `A ${sp} is tracked ahead (${Math.round((zs0 - ctx.shipS) / (ctx.baseSpeed * KNOT_KMS) / 60)} min away). No option cuts the ${(hold.lethalRisk * 100).toFixed(2)}% risk by 80% yet because the whale's path is still uncertain, so the ship keeps listening instead of paying for a manoeuvre now. The forecast sharpens with every call.`;
  } else if (chosen.id === "hold") {
    explanation = `A ${sp} is tracked ahead, but it is still too early to act: its path by the time the ship arrives is uncertain, so no option cuts the ${(hold.lethalRisk * 100).toFixed(2)}% risk enough to be worth its cost yet. Re-checking every 2 minutes as new calls refine the track.`;
  } else if (chosen.id === "yield" && !kept) {
    const z = chosen.plan.zones[0];
    explanation = `A ${sp} ahead is crossing the lane${whaleKn ? ` at ~${whaleKn.toFixed(1)} kn` : ""}. Instead of turning, the ship eases to ${z.v} kn for ${Math.round(z.s1 - z.s0)} km so it arrives ~${fmtMin(chosen.extraMinutes)} later, after the whale has cleared the lane, then passes at normal speed. Lethal-strike risk −${cutPct(riskRed)}%; it ${money} (the lost minutes, minus the fuel the slower stretch saves). A course shift would ${shiftAlt ? `need ${Math.abs(shiftAlt.plan.offset!.d)} km and cost ${fmtUsd(shiftAlt.costDeltaUsd)}` : "not be cheaper"}.`;
  } else if (!chosen.meetsTarget) {
    explanation = `A ${sp} is close ahead and no option reaches the 80% target, so the engine takes the best cost-benefit option: "${chosen.label}" cuts lethal-strike risk by ${cutPct(riskRed)}% and ${money} vs holding course (valuing a great whale at $2M, Chami et al. 2019).`;
  } else {
    explanation = `A ${sp} located ahead is likely to be near the lane when the ship arrives. "${chosen.label}" cuts lethal-strike risk by ${cutPct(riskRed)}% and ${money} vs holding course${chosen.extraMinutes > 1 ? `, adding ${fmtMin(chosen.extraMinutes)} in the zone` : ""}. A blanket slow zone (${policy.label.toLowerCase()}) would ${policy.costDeltaUsd < 0 ? "save" : "cost"} ${fmtUsd(policy.costDeltaUsd)}.`;
  }
  const bits = [chosen.id === "policy" ? "Slow zone 10 kn" : chosen.label];
  if (others.length && chosen.id !== "hold") bits[0] += ` (group of ${others.length + 1} whales)`;
  if (chosen.extraMinutes > 1) bits.push(`+${fmtMin(chosen.extraMinutes)}`);
  if (chosen.powerCutPct > 1) bits.push(`power −${Math.round(chosen.powerCutPct)}%`);
  if (Math.abs(chosen.fuelDeltaT) > 0.05) bits.push(`${chosen.fuelDeltaT < 0 ? "fuel saved" : "extra fuel"} ${Math.abs(chosen.fuelDeltaT).toFixed(1)} t`);
  if (Math.abs(chosen.costDeltaUsd) >= 1) bits.push(`${chosen.costDeltaUsd < 0 ? "saves" : "extra cost"} ${fmtUsd(chosen.costDeltaUsd)}`);
  if (chosen.id !== "hold" && riskRed > 0.5) bits.push(`strike risk −${cutPct(riskRed)}%`);
  return {
    t: ctx.t, sConflict: sC, zone: [zs0, zs1], options: results, chosen, hold, policy,
    riskReductionPct: riskRed, explanation, bubble: bits.join(" · "), waitForInfo, turnLater,
    aheadMin: (zs0 - ctx.shipS) / (ctx.baseSpeed * KNOT_KMS) / 60,
    beliefKind: ctx.belief.kind, species: ctx.belief.species,
    trackId: ctx.belief.kind === "track" ? ctx.belief.track.id : undefined, sideRight, groupSize: others.length + 1,
  };
}

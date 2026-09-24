/**
 * The decision engine ("the AI"): transparent, explainable optimisation - no black box.
 *
 * 1. Where could the whale be? The tracker gives a predicted position and an uncertainty ellipse for every
 *    future moment (it grows with time because whales change speed and direction). With a single buoy we
 *    only know "somewhere within the detection circle", which also grows as the whale swims.
 * 2. Encounter-rate model (standard in ship-strike risk studies): the expected number of encounters is
 *    the whale's probability density at the ship's position × the area the ship sweeps (hit width × relative
 *    speed × time), summed along the ship's future track. Deterministic and smooth - no random noise.
 *       risk of a lethal strike = Σ density × width × |v_ship - v_whale| × dt × P(lethal | ship speed)
 * 3. Options: hold, slow to 12 or 10 kn through the conflict zone, a 2 km or 5 km course shift that rejoins
 *    the lane, shift + slow, and (for comparison) today's practice: a blanket 10-knot slow zone.
 * 4. Each option is scored on safety (lethal-strike risk, chance of passing within 500 m / 2 km), noise at
 *    the whale (peak dB, minutes above the 120 dB disturbance threshold) and cost (time, fuel, $, CO₂).
 * 5. Choice: the cheapest option that cuts lethal-strike risk by at least `targetReduction` (or keeps it
 *    below an absolute floor). If none does, the safest one. Cost = fuel $ (incl. catching up) + late-arrival $.
 */
import { KNOT_KMS, toLL } from "./geo";
import { integrate, type Plan, type Route, type TrajPoint } from "./route";
import {
  fuelRateTph, lethality, shipSourceLevel, DISTURBANCE_DB, CO2_PER_T_FUEL, type ShipSpec, SPECIES, type SpeciesId,
  nominalRangeKm,
} from "./physics";
import type { DepthModel } from "./bathy";
import { predictPosition, type Track } from "./tracker";

export type Belief =
  | { kind: "track"; track: Track; species: SpeciesId }
  | { kind: "zone"; cx: number; cy: number; r: number; t: number; species: SpeciesId };

export interface DecisionParams {
  fuelPrice: number; // $/t
  timeCostPerHour: number; // $/h of late arrival (ASSUMPTION: large container ship charter + operating cost)
  keepArrivalTime: boolean; // make up lost time later (costs fuel) vs arrive later
  targetReduction: number; // e.g. 0.8 = cut lethal-strike risk by 80%
  riskFloor: number; // lethal-strike probability considered acceptable without action
  dt: number; // s
  /** network = choose the best option; single = follow today's practice (blanket slow zone) */
  mode: "network" | "single";
  policyRadiusKm: number; // today's practice: radius of the slow zone around a detection
  whaleValueUsd: number; // used only when no option meets the safety target (cost-benefit fallback)
}

export const DEFAULT_PARAMS: DecisionParams = {
  fuelPrice: 1648,
  timeCostPerHour: 3000,
  keepArrivalTime: true,
  targetReduction: 0.8,
  riskFloor: 1e-4,
  dt: 20,
  mode: "network",
  policyRadiusKm: 28, // ~15 nautical miles
  whaleValueUsd: 2_000_000, // IMF economists' estimate per great whale (Chami et al. 2019)
};

/** Width of the "hit" corridor: ship beam (~45 m) + whale body (~20 m) plus manoeuvring margin. */
export const HIT_WIDTH_KM = 0.1;

export type OptionId = "hold" | "slow12" | "slow10" | "turn2" | "turn5" | "turn2slow12" | "policy";

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
}

export interface EvalContext {
  route: Route;
  depth: DepthModel;
  ship: ShipSpec;
  shipS: number;
  t: number;
  baseSpeed: number;
  belief: Belief;
  /** Id of a manoeuvre already under way: report it as chosen (switching mid-manoeuvre needs a clear reason). */
  keep?: string;
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

/** Returns null when the whale is not a threat to the ship's course. */
/** Risk cut in whole percent; never rounds up to 100 (the risk is small but not zero). */
export const cutPct = (p: number) => Math.min(Math.round(p), 99);

export function decide(ctx: EvalContext): Decision | null {
  const { route, ship, params } = ctx;
  const dt = params.dt;
  const lookS = Math.min(ctx.shipS + ctx.baseSpeed * KNOT_KMS * 3 * 3600, route.length); // 3 h ahead
  const holdPlan: Plan = { baseSpeed: ctx.baseSpeed, zones: [], offset: null };
  const holdLook = integrate(route, holdPlan, ctx.shipS, ctx.t, lookS, dt);
  const W0 = predictWhale(ctx.belief, holdLook.map((p) => p.t));

  // conflict point: where along the route the encounter rate (holding course) peaks
  let peak = 0;
  let kPeak = 0;
  let within2 = 0;
  for (let k = 1; k < holdLook.length; k++) {
    const p = holdLook[k];
    const vsx = (p.x - holdLook[k - 1].x) / dt - W0.vx[k];
    const vsy = (p.y - holdLook[k - 1].y) / dt - W0.vy[k];
    const rate = density(W0, k, p.x, p.y) * Math.hypot(vsx, vsy) * dt;
    within2 += rate * 4; // corridor 4 km wide = passing within 2 km
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
  if (within2 < 0.02 && !(params.mode === "single" && policyTouches)) return null; // likely positions stay clear
  const sC = holdLook[kPeak].s;
  const latC = route.project([W0.mx[kPeak], W0.my[kPeak]]).lateral;

  // conflict zone half-width follows how uncertain the whale's position is when the ship gets there
  const sig = W0.disc ? W0.discR[kPeak] : Math.sqrt(Math.max(W0.cxx[kPeak], W0.cyy[kPeak]));
  const Z = Math.min(Math.max(6, 3 * sig + 4), 45);
  const zs0 = Math.max(sC - Z, ctx.shipS + 0.5);
  const zs1 = Math.min(sC + Z, route.length - 1);
  const sideRight = latC < 0; // whale expected on the left of the lane -> move right
  const sign = sideRight ? 1 : -1;
  const ramp = (d: number) => Math.max(5, 2.5 * Math.abs(d));
  const off = (d: number) => ({ s0: zs0 - ramp(d), s1: zs1 + ramp(d), d: d * sign, ramp: ramp(d) });

  const specs: { id: OptionId; label: string; plan: Plan }[] = [
    { id: "hold", label: "Hold course & speed", plan: holdPlan },
    { id: "slow12", label: "Slow to 12 kn", plan: { ...holdPlan, zones: [{ s0: zs0, s1: zs1, v: 12 }] } },
    { id: "slow10", label: "Slow to 10 kn", plan: { ...holdPlan, zones: [{ s0: zs0, s1: zs1, v: 10 }] } },
    { id: "turn2", label: `Shift 2 km ${sideRight ? "right" : "left"}`, plan: { ...holdPlan, offset: off(2) } },
    { id: "turn5", label: `Shift 5 km ${sideRight ? "right" : "left"}`, plan: { ...holdPlan, offset: off(5) } },
    { id: "turn2slow12", label: "Shift 2 km + 12 kn", plan: { ...holdPlan, zones: [{ s0: zs0, s1: zs1, v: 12 }], offset: off(2) } },
  ];

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

  const sEndAll = Math.min(Math.max(zs1 + 6, pb + 1, ...specs.map((o) => (o.plan.offset ? o.plan.offset.s1 + 1 : 0))), route.length);
  const trajs = specs.map((o) => integrate(route, o.plan, ctx.shipS, ctx.t, sEndAll, dt));
  const T = Math.max(...trajs.map((tr) => tr.length)) + Math.round(1200 / dt);
  const times = Array.from({ length: T }, (_, k) => ctx.t + k * dt);
  const W = predictWhale(ctx.belief, times);
  const dRem = route.length - sEndAll;
  const holdEnd = trajs[0][trajs[0].length - 1].t;
  const pois = (x: number) => 1 - Math.exp(-x);

  const results: OptionResult[] = specs.map((o, i) => {
    const tr: TrajPoint[] = trajs[i];
    let invalid: string | undefined;
    if (o.plan.offset) {
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
    for (let k = 1; k < T; k++) {
      const rvx = (sx[k] - sx[k - 1]) / dt - W.vx[k];
      const rvy = (sy[k] - sy[k - 1]) / dt - W.vy[k];
      const sweep = Math.hypot(rvx, rvy) * dt; // km of relative travel this step
      const dens = density(W, k, sx[k], sy[k]);
      const h = dens * HIT_WIDTH_KM * sweep;
      hit += h;
      lethal += h * lethality(sv[k]);
      w500 += dens * 1.0 * sweep;
      w2 += dens * 4.0 * sweep;
      const d = Math.hypot(W.mx[k] - sx[k], W.my[k] - sy[k]);
      const rl = shipSourceLevel(sv[k]) - 20 * Math.log10(Math.max(d * 1000, 10));
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
    let catchUp = 0;
    let arrivalDelayMin = delayH * 60;
    if (params.keepArrivalTime && delayH > 0 && dRem > 1) {
      const tRem = dRem / (ctx.baseSpeed * KNOT_KMS) / 3600;
      const vNew = dRem / ((tRem - delayH) * 3600) / KNOT_KMS;
      if (tRem - delayH > 0.25 * tRem && vNew <= 19) {
        catchUp = fuelRateTph(ship, vNew) * (tRem - delayH) - fuelRateTph(ship, ctx.baseSpeed) * tRem;
        arrivalDelayMin = 0;
      }
    }
    const path: [number, number][] = [];
    const stride = Math.max(1, Math.floor(tr.length / 150));
    for (let k = 0; k < tr.length; k += stride) path.push(toLL(tr[k].x, tr[k].y));
    path.push(toLL(last.x, last.y));
    return {
      id: o.id, label: o.label, plan: o.plan, valid: !invalid, invalidReason: invalid,
      lethalRisk: pois(lethal), strikeRisk: pois(hit), pWithin500m: pois(w500), pWithin2km: pois(w2),
      peakNoiseDb: peakDb, minutesAbove120: above,
      extraMinutes: delayH * 60, arrivalDelayMin,
      fuelDeltaT: fuel + catchUp, costDeltaUsd: 0, co2DeltaT: 0,
      powerCutPct: 100 * (1 - Math.pow(minV / ctx.baseSpeed, ship.exponent)),
      laneDepartureKm: o.plan.offset ? Math.abs(o.plan.offset.d) : 0,
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
  const policy = results.find((r) => r.id === "policy")!;
  policy.reference = params.mode === "network";

  // ---- choose ----
  let chosen: OptionResult;
  let waitForInfo = false;
  if (params.mode === "single") {
    chosen = policy; // today's practice
  } else {
    let valid = results.filter((r) => r.valid && r.id !== "policy");
    // if the ship must keep its arrival time, prefer options that do (late arrival breaks berth windows)
    const onTime = valid.filter((r) => r.arrivalDelayMin < 5);
    if (params.keepArrivalTime && onTime.length) valid = onTime;
    const safe = valid.filter((r) => r.meetsTarget);
    const byCost = (a: OptionResult, b: OptionResult) => a.costDeltaUsd - b.costDeltaUsd || a.lethalRisk - b.lethalRisk;
    // 1) cheapest option that meets the safety target; 2) otherwise best cost-benefit (cost + risk × whale value)
    const cb = (r: OptionResult) => r.costDeltaUsd + r.lethalRisk * params.whaleValueUsd;
    chosen = safe.length ? [...safe].sort(byCost)[0] : [...valid].sort((a, b) => cb(a) - cb(b))[0];
    // Value of information: if nothing meets the target yet and the conflict is still >20 min away,
    // don't pay for a costly manoeuvre now - more calls will sharpen the whale's forecast.
    const minutesToZone = (zs0 - ctx.shipS) / (ctx.baseSpeed * KNOT_KMS) / 60;
    if (!chosen.meetsTarget && chosen.id !== "hold" && minutesToZone > 20) {
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
    if (r.fuelDeltaT < -0.05) r.pros.push(`Saves ${(-r.fuelDeltaT).toFixed(1)} t fuel`);
    if (r.fuelDeltaT > 0.05) r.cons.push(`+${r.fuelDeltaT.toFixed(1)} t fuel${r.extraMinutes > 1 && r.arrivalDelayMin < 1 ? " (incl. catching up)" : ""}`);
    if (r.extraMinutes > 1) r.cons.push(r.arrivalDelayMin < 1 ? `${fmtMin(r.extraMinutes)} slower here, made up later` : `Arrives ${fmtMin(r.arrivalDelayMin)} late`);
    if (r.powerCutPct > 1) r.pros.push(`Engine power −${Math.round(r.powerCutPct)}% in zone`);
    if (r.minutesAbove120 < hold.minutesAbove120 - 1) r.pros.push(`${Math.round(hold.minutesAbove120 - r.minutesAbove120)} fewer min of disturbing noise`);
    if (r.laneDepartureKm > 1.8) r.cons.push(`Leaves traffic lane by ${r.laneDepartureKm} km (needs VTS call)`);
    if (r.id === "policy") r.cons.push("Whale position unknown, so the whole area is slowed");
  }

  const riskRed = hold.lethalRisk > 0 ? 100 * (1 - chosen.lethalRisk / hold.lethalRisk) : 0;
  const sp = SPECIES[ctx.belief.species].name.toLowerCase();
  const money = chosen.costDeltaUsd <= 0 ? `saves ${fmtUsd(chosen.costDeltaUsd)}` : `costs ${fmtUsd(chosen.costDeltaUsd)}`;
  let explanation: string;
  if (kept) {
    explanation = `Manoeuvre under way: "${chosen.label}" keeps lethal-strike risk ${cutPct(riskRed)}% below holding course and ${money}. The latest forecast is not a strong enough reason to switch plans mid-manoeuvre.`;
  } else if (chosen.id === "policy") {
    explanation = `A ${sp} was heard by a single buoy, which cannot tell where the whale is (only within ~${Math.round(nominalRangeKm(SPECIES[ctx.belief.species]))} km). Today's practice is a blanket slow zone (${chosen.label.toLowerCase()}): it ${money} and adds ${fmtMin(chosen.extraMinutes)}.`;
  } else if (chosen.id === "hold" && hold.lethalRisk <= target) {
    explanation = `A ${sp} is located near the lane, but its likely positions stay clear of the ship: holding course keeps lethal-strike risk at ${(chosen.lethalRisk * 100).toFixed(2)}%.`;
  } else if (chosen.id === "hold" && waitForInfo) {
    explanation = `A ${sp} is tracked ahead (${Math.round((zs0 - ctx.shipS) / (ctx.baseSpeed * KNOT_KMS) / 60)} min away). No option cuts the ${(hold.lethalRisk * 100).toFixed(2)}% risk by 80% yet because the whale's path is still uncertain, so the ship keeps listening instead of paying for a manoeuvre now. The forecast sharpens with every call.`;
  } else if (chosen.id === "hold") {
    explanation = `A ${sp} is tracked ahead, but it is still too early to act: its path by the time the ship arrives is uncertain, so no option cuts the ${(hold.lethalRisk * 100).toFixed(2)}% risk enough to be worth its cost yet. Re-checking every 2 minutes as new calls refine the track.`;
  } else if (!chosen.meetsTarget) {
    explanation = `A ${sp} is close ahead and no option reaches the 80% target, so the engine takes the best cost-benefit option: "${chosen.label}" cuts lethal-strike risk by ${cutPct(riskRed)}% and ${money} vs holding course (valuing a great whale at $2M, Chami et al. 2019).`;
  } else {
    explanation = `A ${sp} located ahead is likely to be near the lane when the ship arrives. "${chosen.label}" cuts lethal-strike risk by ${cutPct(riskRed)}% and ${money} vs holding course${chosen.extraMinutes > 1 ? `, adding ${fmtMin(chosen.extraMinutes)} in the zone` : ""}. Today's practice (${policy.label.toLowerCase()}) would cost ${fmtUsd(policy.costDeltaUsd)}.`;
  }
  const bits = [chosen.id === "policy" ? "Slow zone 10 kn" : chosen.label];
  if (chosen.extraMinutes > 1) bits.push(`+${fmtMin(chosen.extraMinutes)}`);
  if (chosen.powerCutPct > 1) bits.push(`power −${Math.round(chosen.powerCutPct)}%`);
  if (Math.abs(chosen.fuelDeltaT) > 0.05) bits.push(`fuel ${chosen.fuelDeltaT < 0 ? "−" : "+"}${Math.abs(chosen.fuelDeltaT).toFixed(1)} t (${chosen.costDeltaUsd <= 0 ? "−" : "+"}${fmtUsd(chosen.costDeltaUsd)})`);
  if (chosen.id !== "hold" && riskRed > 0.5) bits.push(`strike risk −${cutPct(riskRed)}%`);
  return {
    t: ctx.t, sConflict: sC, zone: [zs0, zs1], options: results, chosen, hold, policy,
    riskReductionPct: riskRed, explanation, bubble: bits.join(" · "), waitForInfo,
    beliefKind: ctx.belief.kind, species: ctx.belief.species,
    trackId: ctx.belief.kind === "track" ? ctx.belief.track.id : undefined, sideRight,
  };
}

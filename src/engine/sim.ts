/**
 * The simulation: ship + whales + sensors + detection + locating + tracking + decisions, on one clock.
 */
import { Rng } from "./rng";
import { KNOT_KMS, toLL, toXY, headingDeg, type XY } from "./geo";
import type { DepthModel } from "./bathy";
import { ROUTES, Route, integrate, offsetAt, offsetEnd, rampForAngle, shipHeading, shipPos, speedAt, type Offset, type Plan } from "./route";
import {
  SPECIES, SOUND_SPEED_KMS, DETECTION_THRESHOLD_DB, TIMING_FACTOR, transmissionLoss, detectionProbability, nominalRangeKm, shipSourceLevel, shipNoiseTL, STRIKE_KM, P_NEAR_SURFACE,
  shipBandOffset, fuelRateTph, DEFAULT_SHIP, CO2_PER_T_FUEL, lethality, type ShipSpec, type SpeciesId,
} from "./physics";
import { Whale } from "./whale";
import { networkSensors, singleBuoys, SensorIndex, spacingKm, type Sensor } from "./sensors";
import { locate, type Fix } from "./localize";
import { Tracker, predictPosition, type Track } from "./tracker";
import { decide, sameManeuver, narrowerShift, DEFAULT_PARAMS, type Belief, type Decision, type DecisionParams } from "./decision";
import { SCENARIOS } from "./scenario";
import { SHORE_STATIONS } from "./stations";
import { Traffic, selfNoiseDb, cameraDetectionProb, CAMERA_RANGE_KM, type ShipState } from "./traffic";

export type Mode = "network" | "ships" | "mix" | "single";
/** ships + mix both use real ship traffic as moving sensors */
export const usesShips = (m: Mode) => m === "ships" || m === "mix";

export interface SimOptions {
  seed: number;
  routeId: string;
  mode: Mode;
  /** Ships mode: what to do when our own towed array hears a whale ahead that nobody has located yet. */
  caution: "slow" | "ask" | "ignore";
  /** Old demo: a hidden singer on a guaranteed collision course (off by default; encounters are random now). */
  scriptedSinger: boolean;
  /** Extra whales in the corridor, besides the hotspot whales (illustrative density). */
  extraWhales: number;
  style: "targeted" | "ahead"; // network only: react with the cheapest option, or bend early at constant speed
  sensorCount: number;
  corridorKm: number;
  sigmaT: number; // arrival-time error, s
  baseSpeed: number; // knots
  params: DecisionParams;
  ship: ShipSpec;
}

export const DEFAULT_OPTIONS: SimOptions = {
  seed: 20260924,
  routeId: "oak-lb",
  mode: "network",
  style: "targeted",
  caution: "slow",
  scriptedSinger: false,
  extraWhales: 5,
  sensorCount: 3000,
  corridorKm: 45,
  sigmaT: 0.02,
  baseSpeed: 16,
  params: DEFAULT_PARAMS,
  ship: DEFAULT_SHIP,
};

/** Sensor ids used for ships in ships mode. */
/** A track can't imply a whale faster than the species can swim (noisy fixes otherwise suggest 10-15 kn fin whales). */
function clampSpeed(tr: Track, species: SpeciesId) {
  const vmax = SPECIES[species].speedKn[1] * 1.2 * KNOT_KMS;
  const v = Math.hypot(tr.s[2], tr.s[3]);
  if (v > vmax) { tr.s[2] *= vmax / v; tr.s[3] *= vmax / v; }
}

export const SHIP_SENSOR_BASE = 1_000_000;
export const CAUTION_KN = 13;
/** Only slow for an unlocated whale whose call sounds closer than this (rough range from loudness). */
export const CAUTION_TRIGGER_KM = 3;
/** Hull strike zone: whale within ~45 m of the ship's track (half beam + whale body), and near the surface. */
export { STRIKE_KM } from "./physics";
/** Passing closer than this is reported as a near miss (if not a strike). */
export const NEAR_MISS_KM = 0.2;

export type SimEvent = { type: "call"; call: CallEvent } | { type: "decision"; decision: Decision } | { type: "strike"; strike: Strike } | { type: "nearmiss"; whaleId: number; species: SpeciesId; distM: number; deep: boolean; singer: boolean; speedKn: number };

export interface CautionPrompt {
  t: number;
  species: SpeciesId;
  relBearingDeg: number; // off the bow (port/starboard ambiguous)
  maxRangeKm: number;
  costUsd: number; // estimated cost of slowing (incl. catching up)
  extraMin: number;
}
export interface Strike {
  t: number;
  whaleId: number;
  species: SpeciesId;
  speedKn: number;
  pLethal: number;
  lethal: boolean;
}
export const OWN_SHIP_SENSOR = 999_999;

export interface CallEvent {
  id: number;
  t: number;
  whaleId: number;
  species: SpeciesId;
  truePos: XY;
  detected: { sensor: Sensor; snr: number }[];
  kind?: "call" | "sighting"; // sighting = thermal-camera detection of a surfacing whale (ships mode)
  fix?: Fix;
  trackId?: number;
  errorKm?: number;
}

export interface Zone {
  buoyId: number;
  cx: number;
  cy: number;
  r: number;
  t: number;
  species: SpeciesId;
}

export interface ActiveManeuver {
  decision: Decision;
  plan: Plan;
  endS: number;
}

export class Simulation {
  readonly opts: SimOptions;
  readonly route: Route;
  readonly sensors: Sensor[];
  readonly index: SensorIndex;
  readonly whales: Whale[] = [];
  readonly tracker = new Tracker();
  readonly rng: Rng;
  readonly cTrue: number; // actual sound speed (unknown to the locator)
  readonly spacing: number;
  t = 0;
  s = 0; // ship along-route distance, km
  plan: Plan;
  maneuver: ActiveManeuver | null = null;
  decisions: Decision[] = [];
  calls: CallEvent[] = [];
  zones = new Map<number, Zone>();
  fuelUsed = 0;
  finished = false;
  stats = { calls: 0, detections: 0, fixes: 0, errSum: 0, sightings: 0 };
  /** ships mode: real ships (AIS replay) acting as sensors */
  readonly traffic: Traffic | null;
  shipsNow: ShipState[] = [];
  private shipsNowT = -1;
  readonly listeningShips = new Set<number>();
  private nextSurface = new Map<number, number>();
  /** precautionary slow-down (heard, not located) */
  caution: { s1: number; since: number; startS: number } | null = null;
  pendingCaution: CautionPrompt | null = null;
  private cautionCooldownUntil = -1;
  cautionStats = { count: 0, minutes: 0 };
  strikes: Strike[] = [];
  private strikeChecked = new Set<number>();
  private passMin = new Map<number, number>();
  private lastDecisionCheck = -1e9;
  private callSeq = 0;
  private listeners: ((e: SimEvent) => void)[] = [];

  constructor(private depth: DepthModel, opts: Partial<SimOptions> = {}, traffic: Traffic | null = null) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts, params: { ...DEFAULT_PARAMS, ...(opts.params ?? {}) } };
    this.rng = new Rng(this.opts.seed);
    const def = ROUTES.find((r) => r.id === this.opts.routeId) ?? ROUTES[0];
    this.route = new Route(def);
    this.plan = { baseSpeed: this.opts.baseSpeed, zones: [], offset: null };
    this.cTrue = SOUND_SPEED_KMS * (1 + this.rng.gauss(0, 0.004));
    const scen = SCENARIOS[def.id];
    this.traffic = usesShips(this.opts.mode) ? traffic : null;
    if (usesShips(this.opts.mode) && !this.traffic) throw new Error("Ships mode needs traffic data");
    this.sensors = this.opts.mode === "network"
      ? networkSensors(this.route, depth, this.opts.sensorCount, this.opts.corridorKm, new Rng(this.opts.seed + 7))
      : this.opts.mode === "ships" ? []
      : this.opts.mode === "mix" ? this.shoreStations()
      : singleBuoys(scen.singleBuoys.map((b) => b.at));
    this.index = new SensorIndex(this.sensors, 20);
    this.spacing = spacingKm(this.sensors);
    this.createWhales();
    // (the scripted blind-spot singer is retired: every encounter is now random, so strikes and close calls happen by chance)
    if (this.opts.scriptedSinger && usesShips(this.opts.mode) && this.traffic) this.createBlindSpotSinger();
  }

  on(fn: (e: SimEvent) => void) {
    this.listeners.push(fn);
  }

  /** Time for the ship (holding course) to reach along-route distance s. */
  private etaHold(s: number): number {
    return ((s - this.s) / (this.opts.baseSpeed * KNOT_KMS)) + this.t;
  }

  private createWhales() {
    const scen = SCENARIOS[this.route.def.id];
    const rng = new Rng(this.opts.seed + 99);
    let id = 1;
    // Hotspot encounters, now random: each hotspot gets a whale ~85% of the time, somewhere within ~25 km along the lane,
    // usually of the hotspot's typical species, aimed near (not exactly at) the lane, at a time that may or may not
    // meet the ship. Whether it ends as a close call, a strike or nothing depends on chance and on what the ship does.
    for (const enc0 of scen.encounters) {
      if (rng.next() > 0.85) continue;
      const u = rng.next();
      const species: SpeciesId = u < 0.7 ? enc0.species : u < 0.8 ? "humpback" : u < 0.9 ? "fin" : "blue";
      const enc = { ...enc0, species };
      const cross0 = this.route.project(toXY(enc.near[0], enc.near[1]));
      const cross = { ...cross0, s: Math.min(Math.max(cross0.s + rng.uniform(-25, 25), 15), this.route.length - 15) };
      const cp = this.route.at(cross.s);
      const eta = this.etaHold(cross.s);
      const sp = SPECIES[enc.species];
      const speedKn = rng.uniform(sp.speedKn[0], sp.speedKn[1]);
      const lead = rng.uniform(1.8, 2.4) * 3600; // whale becomes active this long before the ship arrives
      const side = rng.next() < 0.5 ? 1 : -1;
      const sAlong = rng.next() < 0.5 ? 1 : -1;
      const ang = rng.uniform(0.6, 1.2); // approach the lane at ~35-70 degrees
      const nrm: XY = [cp.dir[1] * side, -cp.dir[0] * side]; // unit normal to the lane (right if side=+1)
      const vec: XY = [nrm[0] * Math.sin(ang) + cp.dir[0] * Math.cos(ang) * sAlong, nrm[1] * Math.sin(ang) + cp.dir[1] * Math.cos(ang) * sAlong];
      const dist = speedKn * KNOT_KMS * lead;
      const target: XY = [cp.p[0] + rng.gauss(0, 1.0), cp.p[1] + rng.gauss(0, 1.0)];
      let start: XY = [target[0] + vec[0] * dist, target[1] + vec[1] * dist];
      const [slon, slat] = toLL(...start);
      if (this.depth.elevation(slon, slat) > -80) start = [target[0] - vec[0] * dist, target[1] - vec[1] * dist];
      this.whales.push(new Whale({
        id: id++, species: enc.species, start, activeFrom: Math.max(0, eta - lead),
        guide: { target, until: eta + rng.uniform(-25, 25) * 60 }, speedKn, conflict: true,
      }, new Rng(rng.int(1, 1e9)), this.depth));
    }
    // extra wandering whales spread through the corridor (humpback 45%, fin 30%, blue 25%)
    const extra = Math.max(0, this.opts.extraWhales - scen.background.length);
    for (let i = 0, guard = 0; i < extra && guard < extra * 30; guard++) {
      const sAlong = rng.uniform(20, this.route.length - 20);
      const at = this.route.at(sAlong);
      const lat = rng.gauss(0, 18);
      const p: XY = [at.p[0] + at.dir[1] * lat, at.p[1] - at.dir[0] * lat];
      const [plon, plat] = toLL(p[0], p[1]);
      if (this.depth.elevation(plon, plat) > -80) continue;
      const u = rng.next();
      const species: SpeciesId = u < 0.45 ? "humpback" : u < 0.75 ? "fin" : "blue";
      const sp = SPECIES[species];
      this.whales.push(new Whale({
        id: id++, species, start: p, activeFrom: 0, speedKn: rng.uniform(sp.speedKn[0], sp.speedKn[1]), conflict: false,
      }, new Rng(rng.int(1, 1e9)), this.depth));
      i++;
    }
    for (const bg of scen.background.slice(0, Math.max(0, this.opts.extraWhales))) {
      const sp = SPECIES[bg.species];
      this.whales.push(new Whale({
        id: id++, species: bg.species, start: toXY(bg.at[0], bg.at[1]), activeFrom: 0,
        speedKn: rng.uniform(sp.speedKn[0], sp.speedKn[1]), conflict: false,
      }, new Rng(rng.int(1, 1e9)), this.depth));
    }
  }

  /**
   * Ships mode: one singing humpback in the emptiest stretch of the voyage (no other ship within ~15 km when we
   * pass), crossing exactly where our ship will be. Only our own towed array can hear it: hold speed = strike,
   * slow down = it clears the track. Singers hang ~15 m deep and rarely surface, so cameras don't see it.
   */
  private createBlindSpotSinger() {
    const tr = this.traffic!;
    const v = this.opts.baseSpeed * KNOT_KMS;
    let bestS = this.route.length * 0.5, bestN = Infinity;
    const scen = SCENARIOS[this.route.def.id];
    const busy = scen.encounters.map((e) => this.route.project(toXY(e.near[0], e.near[1])).s);
    for (let sA = 120; sA < this.route.length - 120; sA += 10) {
      if (busy.some((b) => Math.abs(b - sA) < 70)) continue; // keep clear of the scripted encounters
      const eta = sA / v;
      const p = this.route.at(sA).p;
      let n = 0;
      for (const dt of [-1200, 0, 1200]) for (const q of tr.at(eta + dt)) if (Math.hypot(q.pos[0] - p[0], q.pos[1] - p[1]) < 15) n++;
      const [lon, lat] = toLL(p[0], p[1]);
      if (this.depth.elevation(lon, lat) > -100) continue;
      if (n < bestN || (n === bestN && Math.abs(sA - this.route.length * 0.45) < Math.abs(bestS - this.route.length * 0.45))) { bestN = n; bestS = sA; }
    }
    const at = this.route.at(bestS);
    const side = this.rng.next() < 0.5 ? 1 : -1;
    const dir: XY = [-at.dir[1] * side, at.dir[0] * side]; // crossing the lane at right angles
    const speed = 1.5 * KNOT_KMS; // singers drift slowly
    const w = new Whale({
      id: 90, species: "humpback", start: [at.p[0] - dir[0] * 3, at.p[1] - dir[1] * 3], activeFrom: 1e12, speedKn: 1.5, conflict: true,
    }, new Rng(this.opts.seed + 90), this.depth);
    w.script = { target: at.p, dir, speed, eta: null, sAt: bestS };
    w.singer = true;
    this.whales.push(w);
    this.blindSpotS = bestS;
  }
  blindSpotS: number | null = null;

  /** Scheduled arrival: the time the ship would arrive holding its service speed the whole way. */
  get scheduledArrival(): number {
    return this.route.length / (this.opts.baseSpeed * KNOT_KMS);
  }

  /** Speed needed to arrive on schedule (keeps service speed if on time; capped at 19 kn). */
  /** Normal speed, unless the ship would arrive more than the schedule buffer late: then just enough to stay within it. */
  scheduleSpeed(): number {
    if (!this.opts.params.keepArrivalTime) return this.opts.baseSpeed;
    const remain = this.route.length - this.s;
    const tLeft = this.scheduledArrival + this.opts.params.scheduleBufferMin * 60 - this.t;
    if (tLeft <= 0) return 19;
    const v = remain / tLeft / KNOT_KMS;
    return Math.min(Math.max(v, this.opts.baseSpeed), 19);
  }

  get shipXY(): XY {
    return shipPos(this.route, this.plan, this.s);
  }
  get shipSpeed(): number {
    return speedAt(this.plan, this.s);
  }
  get shipHeading(): number {
    return shipHeading(this.route, this.plan, this.s);
  }
  get progress(): number {
    return this.s / this.route.length;
  }
  get meanErrorKm(): number {
    return this.stats.fixes ? this.stats.errSum / this.stats.fixes : NaN;
  }

  /** Fuel the ship would burn holding course the whole way (baseline). */
  get baselineFuel(): number {
    const hours = this.route.length / (this.opts.baseSpeed * KNOT_KMS) / 3600;
    return fuelRateTph(this.opts.ship, this.opts.baseSpeed) * hours;
  }

  step(dtTotal: number) {
    if (this.finished) return;
    let left = dtTotal;
    while (left > 1e-6 && !this.finished && !this.pendingCaution) {
      const dt = Math.min(left, 10);
      this.substep(dt);
      left -= dt;
    }
  }

  private substep(dt: number) {
    const t = this.t;
    // whales + calls
    const own = this.shipXY;
    for (const w of this.whales) {
      if (w.script && !w.script.locked && this.s > w.script.sAt - 20) {
        // aim at where our ship will actually be (its current plan) at the time it gets there; lock at 8 km out
        if (w.script.eta === null) { w.activeFrom = this.t; w.nextCall = this.t + 5; }
        // collision course = where a ship HOLDING its normal speed would be (slowing, for any reason, makes it miss)
        w.script.eta = this.t + (w.script.sAt - this.s) / (Math.max(this.plan.baseSpeed, 1) * KNOT_KMS);
        w.script.target = shipPos(this.route, this.plan, w.script.sAt);
        if (this.s > w.script.sAt - 8) w.script.locked = true;
      }
      w.prevX = w.x; w.prevY = w.y;
      const callT = w.step(t, dt);
      // whales far from the ship can't matter for its decisions: skip their acoustics (saves a lot of work)
      if (!w.conflict && Math.hypot(w.x - own[0], w.y - own[1]) > 150) continue;
      if (callT !== null) this.processCall(w, callT);
      if (usesShips(this.opts.mode) && w.active(t) && !w.singer) this.cameraWatch(w);
    }
    // ship
    const prevShip = this.shipXY;
    const v = this.shipSpeed;
    const ds0 = 0.2;
    const d1 = offsetAt(this.plan, this.s + ds0) - offsetAt(this.plan, this.s);
    const stretch = Math.sqrt(1 + (d1 / ds0) ** 2);
    this.s = Math.min(this.s + (v * KNOT_KMS * dt) / stretch, this.route.length);
    this.fuelUsed += (fuelRateTph(this.opts.ship, v) * dt) / 3600;
    this.t += dt;
    if (this.maneuver && this.s > this.maneuver.endS) {
      this.maneuver = null;
      this.plan = { baseSpeed: this.scheduleSpeed(), zones: [], offset: null };
    }
    if (this.caution) {
      if (this.shipSpeed <= CAUTION_KN + 0.01) this.cautionStats.minutes += dt / 60;
      if (this.s > this.caution.s1 || (this.maneuver && !this.plan.zones.some((z) => z.v === CAUTION_KN))) {
        this.caution = null;
        this.cautionCooldownUntil = this.t + 10 * 60;
        if (!this.maneuver) this.plan = { baseSpeed: this.scheduleSpeed(), zones: [], offset: null };
      }
    }
    this.recordCoverage();
    this.updateAhead();
    if (this.s >= this.route.length - 1e-6) this.finished = true;
    // ground truth (hindsight only - never used by the decision engine): closest approach to each whale
    const sp = this.shipXY;
    // where a ship that ignored whales (16 kn, on the lane) would be now: the benchmark for "risk cut"
    const holdP = this.route.at(Math.min(this.opts.baseSpeed * KNOT_KMS * this.t, this.route.length)).p;
    for (const w of this.whales) {
      if (!w.active(this.t)) continue;
      const dh = Math.hypot(w.x - holdP[0], w.y - holdP[1]);
      if (dh < w.cpaHoldKm) w.cpaHoldKm = dh;
      // distance from the whale to the whole stretch the ship covered this step (it moves ~80 m per step,
      // so checking only the end points could "jump over" a whale)
      // both move during the step: closest distance of the RELATIVE motion (whale minus ship) over the step
      const r0x = (w.prevX ?? w.x) - prevShip[0], r0y = (w.prevY ?? w.y) - prevShip[1];
      const ddx = (w.x - sp[0]) - r0x, ddy = (w.y - sp[1]) - r0y;
      const L2 = ddx * ddx + ddy * ddy;
      const u = L2 > 0 ? Math.max(0, Math.min(1, -(r0x * ddx + r0y * ddy) / L2)) : 0;
      const d = Math.hypot(r0x + u * ddx, r0y + u * ddy);
      // strikes: a whale under the hull is hit if it's near the surface (~half the time; singers always)
      if (d < STRIKE_KM && !this.strikeChecked.has(w.id)) {
        this.strikeChecked.add(w.id);
        if (w.singer || this.rng.next() < P_NEAR_SURFACE) {
          const pL = lethality(v);
          const st: Strike = { t: this.t, whaleId: w.id, species: w.species, speedKn: v, pLethal: pL, lethal: this.rng.next() < pL };
          this.strikes.push(st);
          for (const fn of this.listeners) fn({ type: "strike", strike: st });
        }
      }
      // near misses: reported once the close pass is over (never silent)
      if (d < (w.singer ? 0.6 : NEAR_MISS_KM)) this.passMin.set(w.id, Math.min(this.passMin.get(w.id) ?? Infinity, d));
      else if (d > (w.singer ? 0.8 : 0.3) && this.passMin.has(w.id)) {
        const m = this.passMin.get(w.id)!;
        this.passMin.delete(w.id);
        const struck = this.strikes.some((k) => k.whaleId === w.id && this.t - k.t < 1800);
        if (!struck) for (const fn of this.listeners) fn({ type: "nearmiss", whaleId: w.id, species: w.species, distM: Math.round(m * 1000), deep: m < STRIKE_KM, singer: w.singer, speedKn: v });
        this.strikeChecked.delete(w.id);
      }
      if (d < w.cpaKm) {
        w.cpaKm = d;
        w.cpaSpeed = v;
        w.cpaT = this.t;
      }
    }
    // decisions
    const every = 120; // re-check every 2 min, also mid-manoeuvre (a crossing whale can change the picture fast)
    if (this.t - this.lastDecisionCheck >= every) {
      this.lastDecisionCheck = this.t;
      this.checkDecisions();
    }
    if (Math.floor(this.t / 60) !== Math.floor((this.t - dt) / 60)) this.tracker.prune(this.t);
  }

  private processCall(w: Whale, tCall: number) {
    const sp = SPECIES[w.species];
    const src: XY = [w.x, w.y];
    const R = nominalRangeKm(sp) * 1.5;
    const ship = this.shipXY;
    const shipSL = shipSourceLevel(this.shipSpeed) + shipBandOffset(sp);
    const detected: { sensor: Sensor; snr: number; t: number }[] = [];
    // listeners: fixed buoys, or (ships mode) every ship's towed hydrophone, including our own ship
    const listeners: { s: Sensor; self: number }[] = [
      ...(usesShips(this.opts.mode)
        ? this.shipSensors().filter((q) => Math.hypot(q.s.pos[0] - src[0], q.s.pos[1] - src[1]) <= R)
          .map((q) => ({ s: q.s, self: selfNoiseDb(sp, q.v) }))
        : []),
      ...this.index.within(src, R).map((b) => ({ s: b, self: -Infinity })), // fixed buoys / shore stations (quiet)
    ];
    for (const { s, self } of listeners) {
      const r = Math.hypot(s.pos[0] - src[0], s.pos[1] - src[1]);
      if (r > 2 && this.landBetween(src, s.pos, r)) continue; // sound doesn't cross land (or very shallow water)
      const rl = sp.sourceLevel - transmissionLoss(r, sp.id);
      const dShip = Math.hypot(s.pos[0] - ship[0], s.pos[1] - ship[1]);
      const shipRl = s.id === OWN_SHIP_SENSOR ? -Infinity : shipSL - shipNoiseTL(dShip);
      const nl = 10 * Math.log10(10 ** (sp.bandNoise / 10) + 10 ** (shipRl / 10) + 10 ** (self / 10));
      const snr = rl - nl + this.rng.gauss(0, 1.5);
      if (this.rng.next() < detectionProbability(snr)) {
        detected.push({ sensor: s, snr, t: tCall + r / this.cTrue + this.rng.gauss(0, this.opts.sigmaT * TIMING_FACTOR[w.species]) });
        if (usesShips(this.opts.mode) && s.id >= SHIP_SENSOR_BASE) this.listeningShips.add(s.id);
      }
    }
    detected.sort((a, b) => b.snr - a.snr);
    if (usesShips(this.opts.mode) && detected.some((d) => d.sensor.id === OWN_SHIP_SENSOR)) this.ownShipHeard(w, sp);
    const ev: CallEvent = {
      id: ++this.callSeq, t: tCall, whaleId: w.id, species: w.species, truePos: src,
      detected: detected.map((d) => ({ sensor: d.sensor, snr: d.snr })),
    };
    this.stats.calls++;
    this.stats.detections += detected.length;
    if (this.opts.mode !== "single") {
      if (detected.length >= 3) {
        const top = detected.slice(0, 12).map((d) => ({ pos: d.sensor.pos, t: d.t, snr: d.snr }));
        const fix = locate(top, SOUND_SPEED_KMS, this.opts.sigmaT * TIMING_FACTOR[w.species]);
        // sanity gates: a whale can't be on land; a very uncertain fix may refine a track but not start one
        const sig = Math.sqrt(Math.max(fix.cov[0], fix.cov[2]));
        const [flon, flat] = toLL(fix.x, fix.y);
        // Consistency checks that a real system can do too (it knows where its sensors are):
        // - every sensor that heard the call must be within hearing range of the fix (with margin)
        // - the arrival times must fit well (a wrong "mirror" solution leaves large residuals)
        // - 3 sensors give an exact but possibly wrong solution (no redundancy): they may refine a track, never start one
        const maxR = nominalRangeKm(sp) * 1.5;
        const inRange = top.every((d) => Math.hypot(fix.x - d.pos[0], fix.y - d.pos[1]) < maxR);
        const fitOk = fix.rmsResidualS < 5 * this.opts.sigmaT * TIMING_FACTOR[w.species] + 0.002;
        const plausible = fix.ok && sig < 3 && inRange && fitOk && this.depth.elevation(flon, flat) < -10;
        const tr = plausible ? this.tracker.addFix(fix, tCall, sig < 1.5 && top.length >= 4, w.species) : null;
        if (tr) {
          (tr as Track & { species?: SpeciesId }).species = w.species; // species comes from the call type (frequency)
          clampSpeed(tr, w.species);
          ev.fix = fix;
          ev.trackId = tr.id;
          ev.errorKm = Math.hypot(fix.x - src[0], fix.y - src[1]);
          this.stats.fixes++;
          this.stats.errSum += ev.errorKm;
        }
      }
    } else if (detected.length) {
      const b = detected[0].sensor;
      this.zones.set(b.id, { buoyId: b.id, cx: b.pos[0], cy: b.pos[1], r: nominalRangeKm(sp), t: tCall, species: w.species });
    }
    this.calls.push(ev);
    if (this.calls.length > 60) this.calls.shift();
    for (const fn of this.listeners) fn({ type: "call", call: ev });
  }

  private shoreStations(): Sensor[] {
    return SHORE_STATIONS.map((st, i) => {
      let [lon, lat] = st.at;
      // nudge seaward (west, then south) until the water is deeper than ~40 m
      for (let k = 0; k < 40 && this.depth.elevation(lon, lat) > -40; k++) { lon -= 0.01; if (k % 3 === 2) lat -= 0.005; }
      const pos = toXY(lon, lat);
      return { id: i, pos, ll: [lon, lat], phase: 0 } as Sensor;
    });
  }

  /**
   * Coverage (blind-spot map): at the point the ship is passing, how many listeners could hear a typical call
   * from a whale right there (same noise, self-noise and land-blocking rules as real detections)?
   * Locating needs 3+. Recorded every ~1 km of the voyage.
   */
  coverage: { s: number; lon: number; lat: number; hump: number; fin: number }[] = [];
  private lastCoverageS = -1e9;
  private recordCoverage() {
    if (this.s - this.lastCoverageS < 1) return;
    this.lastCoverageS = this.s;
    const p = this.route.at(this.s).p;
    const [lon, lat] = toLL(p[0], p[1]);
    this.coverage.push({ s: this.s, lon, lat, hump: this.listenersAt(p, SPECIES.humpback), fin: this.listenersAt(p, SPECIES.fin) });
  }

  /** Blind spots on the route ahead, from where the listeners are right now (refreshed every ~5 min). */
  ahead: { lon: number; lat: number; hump: number; fin: number }[] = [];
  private lastAheadT = -1e9;
  private updateAhead() {
    if (this.opts.mode === "single" || this.t - this.lastAheadT < 300) return;
    this.lastAheadT = this.t;
    this.ahead = [];
    for (let k = 2; k <= 80; k += 3) {
      const sA = this.s + k;
      if (sA > this.route.length - 1) break;
      const p = this.route.at(sA).p;
      const fin = this.listenersAt(p, SPECIES.fin, 3);
      const hump = fin < 3 ? 0 : this.listenersAt(p, SPECIES.humpback, 3);
      if (hump >= 3) continue; // covered: not drawn
      const [lon, lat] = toLL(p[0], p[1]);
      this.ahead.push({ lon, lat, hump, fin });
    }
  }

  /** How many listeners (excluding our own ship, which can't locate alone) could hear a typical call from p. */
  private listenersAt(p: XY, sp: (typeof SPECIES)[SpeciesId], cap = 6): number {
    {
      const count = (sp: (typeof SPECIES)[SpeciesId]) => {
      const R = nominalRangeKm(sp) * 1.2;
      const ls: { pos: XY; self: number; own: boolean }[] = [
        ...(usesShips(this.opts.mode) ? this.shipSensors().map((q) => ({ pos: q.s.pos, self: selfNoiseDb(sp, q.v), own: q.s.id === OWN_SHIP_SENSOR })) : []),
        ...this.index.within(p, R).map((b) => ({ pos: b.pos, self: -Infinity, own: false })),
      ];
      let n = 0;
      for (const l of ls) {
        const r = Math.hypot(l.pos[0] - p[0], l.pos[1] - p[1]);
        if (r > R || l.own) continue; // our own ship alone can't locate (direction only)
        const nl = 10 * Math.log10(10 ** (sp.bandNoise / 10) + 10 ** (l.self / 10));
        if (sp.sourceLevel - transmissionLoss(Math.max(r, 0.05), sp.id) - nl < DETECTION_THRESHOLD_DB) continue;
        if (r > 2 && this.landBetween(p, l.pos, r)) continue;
        if (++n >= cap) break; // enough: no need to count further
      }
      return n;
      };
      return count(sp);
    }
  }

  /** True if the straight sound path from a to b crosses land or water shallower than ~5 m (sampled every ~1.5 km). */
  private landBetween(a: XY, b: XY, r: number): boolean {
    const n = Math.ceil(r / 1.5);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      const [lon, lat] = toLL(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
      if (this.depth.elevation(lon, lat) > -5) return true;
    }
    return false;
  }

  /** Our own towed array heard a call: it knows the direction (port/starboard ambiguous), not the distance. */
  private ownShipHeard(w: Whale, sp: (typeof SPECIES)[SpeciesId]) {
    const own = this.shipXY;
    const brg = headingDeg(w.x - own[0], w.y - own[1]);
    let rel = brg - this.shipHeading + this.rng.gauss(0, 4); // ~4° bearing error
    rel = ((rel + 540) % 360) - 180;
    if (Math.abs(rel) > 30) return; // not (nearly) dead ahead
    // is it already located? (a usable track ahead within ~8 km) -> the decision engine handles it
    for (const tr of this.tracker.tracks) {
      if ((tr.nFixes < 3 && !tr.sightings) || this.t - tr.lastUpdate > 10 * 60) continue;
      const p = predictPosition(tr, this.t);
      if (Math.hypot(p.x - own[0], p.y - own[1]) < 8) return;
    }
    // a "hold course" decision for another whale doesn't stop a precaution for this one
    const alreadySlow = this.plan.zones.some((z) => z.v <= CAUTION_KN && z.s0 <= this.s && z.s1 >= this.s + 2);
    if ((alreadySlow && !this.caution) || this.pendingCaution) return;
    // rough distance from loudness: known species source level vs received level (±3 dB => about ±60% in range)
    const dTrue = Math.max(Math.hypot(w.x - own[0], w.y - own[1]), 0.05);
    const rlEst = sp.sourceLevel - transmissionLoss(dTrue, sp.id) + this.rng.gauss(0, 3);
    const rEst = Math.pow(10, (sp.sourceLevel - rlEst) / 15) / 1000;
    if (rEst > CAUTION_TRIGGER_KM) return; // sounds far away: keep listening
    const maxRangeKm = Math.min(2 * rEst, 6);
    const s1 = Math.min(this.s + maxRangeKm + 0.5, this.route.length - 1);
    // a precaution covers at most ~6 km; hearing the whale again doesn't keep extending it
    if (this.caution) { this.caution.s1 = Math.min(Math.max(this.caution.s1, s1), this.caution.startS + 6.5); this.applyCaution(); return; }
    if (this.t < this.cautionCooldownUntil) return;
    const { cost, extraMin } = this.cautionCost(s1 - this.s);
    const prompt: CautionPrompt = { t: this.t, species: w.species, relBearingDeg: Math.round(Math.abs(rel)), maxRangeKm, costUsd: cost, extraMin };
    if (this.opts.caution === "ignore") { this.cautionCooldownUntil = this.t + 10 * 60; return; }
    if (this.opts.caution === "ask") { this.pendingCaution = prompt; return; }
    this.startCaution(s1);
  }

  /** Estimated cost of a precautionary slow-down over `km`, with the engine's rules: fuel in the zone, lost time within
   *  the schedule's remaining slack valued at $/h, and catching up (max 19 kn) only beyond it. */
  private cautionCost(km: number): { cost: number; extraMin: number } {
    const v0 = this.opts.baseSpeed, v1 = CAUTION_KN, sh = this.opts.ship, P = this.opts.params;
    const t0 = km / (v0 * KNOT_KMS) / 3600, t1 = km / (v1 * KNOT_KMS) / 3600;
    let fuel = fuelRateTph(sh, v1) * t1 - fuelRateTph(sh, v0) * t0;
    const delay = t1 - t0;
    let lateH = delay;
    const slackH = Math.max(0, P.scheduleBufferMin / 60 - Math.max(0, this.actual.behindMin) / 60);
    const excessH = delay - slackH;
    const rem = this.route.length - this.s - km;
    if (P.keepArrivalTime && excessH > 0 && rem > 1) {
      const tRem = rem / (v0 * KNOT_KMS) / 3600;
      const vNew = Math.min(rem / (Math.max(tRem - excessH, 1e-3) * 3600) / KNOT_KMS, 19);
      const tNew = rem / (vNew * KNOT_KMS) / 3600;
      fuel += fuelRateTph(sh, vNew) * tNew - fuelRateTph(sh, v0) * tRem;
      lateH = delay - (tRem - tNew);
    }
    return { cost: fuel * P.fuelPrice + Math.max(lateH, 0) * P.timeCostPerHour, extraMin: delay * 60 };
  }

  private startCaution(s1: number) {
    this.caution = { s1, since: this.t, startS: this.s };
    this.cautionStats.count++;
    this.applyCaution();
  }
  private applyCaution() {
    if (!this.caution) return;
    const zone = { s0: this.s, s1: this.caution.s1, v: CAUTION_KN };
    if (this.maneuver && this.plan.offset) {
      // already shifting around another whale: shift AND slow (keep the course change, add the slow zone)
      this.plan = { ...this.plan, zones: [...this.plan.zones.filter((z) => z.v !== CAUTION_KN), zone] };
      this.maneuver.plan = this.plan;
      this.maneuver.endS = Math.max(this.maneuver.endS, zone.s1 + 1);
      return;
    }
    this.maneuver = null; // replace a mere "hold course" (or slow) decision
    this.plan = { baseSpeed: this.plan.baseSpeed, zones: [zone], offset: null };
  }
  /** Answer to an "ask" prompt. */
  answerCaution(slow: boolean) {
    const p = this.pendingCaution;
    this.pendingCaution = null;
    if (!p) return;
    if (slow) this.startCaution(Math.min(this.s + p.maxRangeKm + 1, this.route.length - 1));
    else this.cautionCooldownUntil = this.t + 10 * 60;
  }

  /** Ships mode: every real ship (plus our own) as a moving sensor, with its own noise at its hydrophone. */
  private shipSensors(): { s: Sensor; v: number }[] {
    if (this.shipsNowT !== this.t) {
      this.shipsNow = this.traffic ? this.traffic.at(this.t) : [];
      this.shipsNowT = this.t;
    }
    const out = this.shipsNow.map((q) => ({
      s: { id: SHIP_SENSOR_BASE + q.idx, pos: q.pos, ll: toLL(q.pos[0], q.pos[1]), phase: 0 } as Sensor,
      v: q.v,
    }));
    const own = this.shipXY;
    out.push({ s: { id: OWN_SHIP_SENSOR, pos: own, ll: toLL(own[0], own[1]), phase: 0 }, v: this.shipSpeed });
    return out;
  }

  /** Ships mode: thermal cameras spot whales when they surface near a ship (every ~3-12 min per whale). */
  private cameraWatch(w: Whale) {
    const next = this.nextSurface.get(w.id);
    if (next === undefined) {
      this.nextSurface.set(w.id, this.t + this.rng.uniform(0, 600));
      return;
    }
    if (this.t < next) return;
    this.nextSurface.set(w.id, this.t + this.rng.uniform(180, 720));
    let best: { s: Sensor; d: number } | null = null;
    for (const q of this.shipSensors()) {
      const d = Math.hypot(q.s.pos[0] - w.x, q.s.pos[1] - w.y);
      if (d > CAMERA_RANGE_KM || this.rng.next() >= cameraDetectionProb(d)) continue;
      if (d > 1 && this.landBetween([w.x, w.y], q.s.pos, d)) continue;
      if (!best || d < best.d) best = { s: q.s, d };
    }
    if (!best) return;
    // camera gives an accurate bearing (~0.5°) and a rougher range (~8%, from the horizon geometry)
    const d = Math.max(best.d, 0.2);
    const ux = (w.x - best.s.pos[0]) / d, uy = (w.y - best.s.pos[1]) / d;
    const sr = 0.08 * d, sb = d * 0.0087;
    const er = this.rng.gauss(0, sr), eb = this.rng.gauss(0, sb);
    const fx = w.x + ux * er - uy * eb, fy = w.y + uy * er + ux * eb;
    const vr = sr * sr, vb = sb * sb;
    const fix: Fix = {
      x: fx, y: fy, t0: this.t, ok: true, rmsResidualS: 0, nSensors: 1,
      cov: [vr * ux * ux + vb * uy * uy, (vr - vb) * ux * uy, vr * uy * uy + vb * ux * ux],
    };
    const tr = this.tracker.addFix(fix, this.t, true, w.species)!;
    (tr as Track & { species?: SpeciesId }).species = w.species;
    tr.sightings = (tr.sightings ?? 0) + 1;
    clampSpeed(tr, w.species);
    this.stats.sightings++;
    this.listeningShips.add(best.s.id);
    const ev: CallEvent = {
      id: ++this.callSeq, t: this.t, whaleId: w.id, species: w.species, truePos: [w.x, w.y],
      detected: [{ sensor: best.s, snr: 99 }], kind: "sighting", fix, trackId: tr.id,
      errorKm: Math.hypot(fx - w.x, fy - w.y),
    };
    this.calls.push(ev);
    if (this.calls.length > 60) this.calls.shift();
    for (const fn of this.listeners) fn({ type: "call", call: ev });
  }

  /** Beliefs about whales that could matter for the ship in the next ~3 hours. */
  beliefs(): Belief[] {
    const out: Belief[] = [];
    const ahead = this.opts.baseSpeed * KNOT_KMS * 3.2 * 3600;
    const near = (x: number, y: number, margin: number) => {
      const p = this.route.project([x, y]);
      return p.s > this.s - 5 && p.s < this.s + ahead && p.dist < margin;
    };
    if (this.opts.mode !== "single") {
      for (const tr of [...this.tracker.tracks].sort((a, b) => b.nFixes - a.nFixes)) {
        // 3+ acoustic fixes, or a thermal-camera sighting (a direct observation) is enough to act on
        if ((tr.nFixes < 3 && !tr.sightings) || this.t - tr.lastUpdate > 20 * 60) continue;
        const p = predictPosition(tr, this.t);
        const sp = (tr as Track & { species?: SpeciesId }).species ?? "humpback";
        // a duplicate track of the same whale (same species within ~2 km, fewer fixes) would double-count the risk
        const dup = out.some((b) => b.kind === "track" && b.species === sp && (() => { const q = predictPosition(b.track, this.t); return Math.hypot(q.x - p.x, q.y - p.y) < 2; })());
        if (!dup && near(p.x, p.y, 40)) out.push({ kind: "track", track: tr, species: sp });
      }
    } else {
      for (const z of this.zones.values()) {
        if (this.t - z.t > 30 * 60) continue;
        if (near(z.cx, z.cy, z.r + 20)) out.push({ kind: "zone", cx: z.cx, cy: z.cy, r: z.r, t: z.t, species: z.species });
      }
    }
    return out;
  }

  private lastAnnounce: { id: string; s: number; t: number } | null = null;

  private announce(d: Decision) {
    this.decisions.push(d);
    this.lastAnnounce = { id: d.chosen.id, s: d.sConflict, t: this.t };
    for (const fn of this.listeners) fn({ type: "decision", decision: d });
  }

  private commit(d: Decision) {
    let plan = d.chosen.plan;
    // If the ship is already off the lane (plans changed mid-manoeuvre), the new track starts from where the
    // ship actually is and turns gently to the new offset - no sideways jumps, no sharp corners.
    const cur = offsetAt(this.plan, this.s);
    if (Math.abs(cur) > 0.01) {
      const o = plan.offset;
      let offset: Offset;
      if (o && o.d !== 0) {
        const reach = Math.max(o.s0 + o.ramp - this.s, rampForAngle(o.d - cur, 12));
        offset = { ...o, s0: this.s, d0: cur, ramp: reach, s1: Math.max(o.s1, this.s + reach + (o.rampBack ?? o.ramp)) };
      } else {
        const back = rampForAngle(cur, 8);
        offset = { s0: this.s, d0: cur, d: cur, ramp: 0.01, s1: this.s + back + 0.01, rampBack: back };
      }
      plan = { ...plan, offset };
      d = { ...d, chosen: { ...d.chosen, plan } };
    }
    const endS = Math.max(d.zone[1], offsetEnd(plan), ...plan.zones.map((z) => z.s1)) + 1;
    this.plan = plan;
    this.maneuver = { decision: d, plan, endS };
  }

  private evaluate(b: Belief, keep?: string, keepSide?: number, all: Belief[] = this.beliefs()): Decision | null {
    const others = b.kind === "track" ? all.filter((o) => o !== b && o.kind === "track") : [];
    return decide({
      route: this.route, depth: this.depth, ship: this.opts.ship, shipS: this.s, t: this.t,
      baseSpeed: this.plan.baseSpeed, belief: b, others, behindMin: this.actual.behindMin, curOffset: offsetAt(this.plan, this.s), params: { ...this.opts.params, mode: this.opts.mode === "single" ? "single" : "network", style: this.opts.style }, keep, keepSide,
    });
  }

  private checkDecisions() {
    const bs = this.beliefs();
    if (!bs.length) return;
    let worst: Decision | null = null;
    let bestBelief: Belief | null = null;
    for (const b of bs) {
      const d = this.evaluate(b, undefined, undefined, bs);
      if (d && (!worst || d.hold.lethalRisk > worst.hold.lethalRisk)) {
        worst = d;
        bestBelief = b;
      }
    }
    if (!worst) return;
    const m = this.maneuver;
    if (m && Math.abs(m.decision.sConflict - worst.sConflict) < 20) {
      // Same conflict, manoeuvre under way: only change plans for a clear reason (hysteresis).
      // Compare like with like: the manoeuvre actually being flown, on the side it is being flown.
      const flown = m.decision.chosen;
      const same = sameManeuver(worst.chosen, flown);
      const keptD = same ? worst : this.evaluate(bestBelief!, flown.id, Math.sign(flown.plan.offset?.d ?? 0) || undefined, bs);
      // the re-scored manoeuvre must really be the one being flown; if it can no longer be kept, switch
      const current = keptD && sameManeuver(keptD.chosen, flown) ? keptD.chosen : undefined;
      const unsafe = !!current && !current.meetsTarget && worst.chosen.lethalRisk < current.lethalRisk * 0.7 &&
        (!(Math.sign(worst.chosen.plan.offset?.d ?? 0) * Math.sign(m.decision.chosen.plan.offset?.d ?? 0) < 0) || worst.chosen.meetsTarget);
      // never swap to the OTHER side mid-turn just to save money (a real ship doesn't zig-zag); only if unsafe
      const flipsSide = Math.sign(worst.chosen.plan.offset?.d ?? 0) * Math.sign(flown.plan.offset?.d ?? 0) < 0;
      const muchCheaper = !!current && !same && !flipsSide && !worst.turnLater && !worst.waitForInfo &&
        worst.chosen.costDeltaUsd < current.costDeltaUsd - Math.max(300, 0.25 * Math.abs(current.costDeltaUsd));
      // as the whale's position sharpens, ease a big shift down to the smallest one that is still safe
      // ...but not in the last ~10 minutes before the whale (never steer back toward it late)
      const minsToZone = (worst.zone[0] - this.s) / (Math.max(this.shipSpeed, 1) * KNOT_KMS) / 60;
      const narrower = !same && minsToZone > 10 && narrowerShift(worst.chosen, flown);
      if (narrower && !unsafe) {
        this.commit(worst);
        this.decisions.push(worst); // quiet refinement: logged for the costs, no new pop-up
        this.lastAnnounce = { id: worst.chosen.id, s: worst.sConflict, t: this.t };
      } else if (!same && (unsafe || muchCheaper || (!current && !flipsSide && !worst.waitForInfo))) {
        this.commit(worst);
        this.announce(worst);
      } else if (keptD && current) {
        m.decision = keptD; // keep the numbers fresh for the panel, for the manoeuvre actually being flown
      }
      return;
    }
    const la = this.lastAnnounce;
    if (worst.chosen.id === "hold") {
      if (!la || Math.abs(la.s - worst.sConflict) > 20 || la.id !== "hold") this.announce(worst);
      return;
    }
    this.commit(worst);
    this.announce(worst);
  }

  /**
   * What protecting whales ACTUALLY cost on this voyage so far, measured, not estimated: fuel burned vs a ship
   * holding its service speed for the same distance, plus time behind schedule (valued like the engine does).
   * Includes every manoeuvre, partial slow-down, precaution and catch-up.
   */
  get actual(): { fuelDeltaT: number; behindMin: number; usd: number } {
    const v0 = this.opts.baseSpeed;
    const baseHours = this.s / (v0 * KNOT_KMS) / 3600;
    const fuelDeltaT = this.fuelUsed - fuelRateTph(this.opts.ship, v0) * baseHours;
    const behindMin = (this.t / 3600 - baseHours) * 60;
    const usd = fuelDeltaT * this.opts.params.fuelPrice + (Math.max(behindMin, 0) / 60) * this.opts.params.timeCostPerHour;
    return { fuelDeltaT, behindMin, usd };
  }

  /**
   * Slow zones for the same whales (counterfactual): every whale heard means a 10-kn zone around it. Overlapping zones
   * are merged (a ship can't slow down twice on the same stretch). Cost = fuel saved/extra + time lost.
   */
  get policyCounterfactual(): { usd: number; lateMin: number; fuelDeltaT: number } {
    const iv = this.conflictLog.map((d) => d.policy.plan.zones[0]).filter(Boolean).map((z) => [z.s0, z.s1] as [number, number]).sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of iv) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    const km = merged.reduce((x, [a, b]) => x + (b - a), 0);
    const v0 = this.opts.baseSpeed, v = 10;
    const h0 = km / (v0 * KNOT_KMS) / 3600, h1 = km / (v * KNOT_KMS) / 3600;
    const ship = this.opts.ship, P = this.opts.params;
    let fuelDeltaT = fuelRateTph(ship, v) * h1 - fuelRateTph(ship, v0) * h0;
    let lateMin = (h1 - h0) * 60;
    // same schedule rule as the real voyage: beyond the schedule's slack, speed up (max 19 kn) on the rest of the route
    const excessH = (lateMin - P.scheduleBufferMin) / 60;
    const restKm = this.route.length - km;
    if (P.keepArrivalTime && excessH > 0 && restKm > 1) {
      const tRest = restKm / (v0 * KNOT_KMS) / 3600;
      const vNew = Math.min(restKm / Math.max((tRest - excessH) * 3600, 1) / KNOT_KMS, 19);
      const tNew = restKm / (vNew * KNOT_KMS) / 3600;
      fuelDeltaT += fuelRateTph(ship, vNew) * tNew - fuelRateTph(ship, v0) * tRest;
      lateMin -= (tRest - tNew) * 60;
    }
    return { usd: fuelDeltaT * P.fuelPrice + (Math.max(lateMin, 0) / 60) * P.timeCostPerHour, lateMin, fuelDeltaT };
  }

  /** The same trip with no whales to avoid: 16 kn all the way. Fuel $ + value of the ship's time. */
  get normalTrip(): { normalTripUsd: number; normalTripFuelUsd: number } {
    const h = this.route.length / (this.opts.baseSpeed * KNOT_KMS) / 3600;
    const fuelUsd = fuelRateTph(this.opts.ship, this.opts.baseSpeed) * h * this.opts.params.fuelPrice;
    return { normalTripUsd: fuelUsd + h * this.opts.params.timeCostPerHour, normalTripFuelUsd: fuelUsd };
  }

  /** Encounters where the ship actually changed course or speed at some point (not just the final plan). */
  get maneuverCount(): number {
    let n = 0, lastS = -1e9, acted = false;
    for (const d of this.decisions) {
      if (Math.abs(d.sConflict - lastS) >= 15) { if (acted) n++; acted = false; }
      lastS = d.sConflict;
      if (d.chosen.id !== "hold") acted = true;
    }
    return n + (acted ? 1 : 0) + (this.cautionStats.count > 0 ? 0 : 0);
  }

  /** One entry per conflict: the final assessment when the ship passed it. */
  get conflictLog(): Decision[] {
    const out: Decision[] = [];
    for (const d of this.decisions) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.sConflict - d.sConflict) < 15) out[out.length - 1] = d;
      else out.push(d);
    }
    return out;
  }

  /** Planned track ahead (lon/lat) under the current plan, for drawing. */
  plannedPath(km = 120): [number, number][] {
    const out: [number, number][] = [];
    for (let s = this.s; s <= Math.min(this.s + km, this.route.length); s += 1) out.push(toLL(...shipPos(this.route, this.plan, s)));
    return out;
  }

  /** Hindsight check with the TRUE whale positions (never available to the ship). */
  truth() {
    return this.whales.filter((w) => w.conflict).map((w) => ({
      whaleId: w.id,
      species: w.species,
      cpaKm: w.cpaKm,
      cpaSpeed: w.cpaSpeed,
      lethalProb: (w.cpaKm < STRIKE_KM ? P_NEAR_SURFACE : 0) * lethality(w.cpaSpeed),
    }));
  }

  summary() {
    const log = this.conflictLog;
    const fuelDelta = this.fuelUsed - this.baselineFuel * this.progress;
    return {
      fuelUsed: this.fuelUsed,
      fuelDelta,
      co2Delta: fuelDelta * CO2_PER_T_FUEL,
      conflicts: log.length,
      maneuvers: log.filter((d) => d.chosen.id !== "hold").length,
      riskHold: log.reduce((a, d) => a + d.hold.lethalRisk, 0),
      riskTaken: log.reduce((a, d) => a + d.chosen.lethalRisk, 0),
      costUsd: log.reduce((a, d) => a + d.chosen.costDeltaUsd, 0),
      lethalAtSpeed: lethality(this.shipSpeed),
      arrivalDelayMin: (this.t - this.scheduledArrival) / 60,
      truth: this.truth(),
    };
  }

  /** Test helper: run until the ship arrives. */
  runToEnd(maxHours = 40) {
    while (!this.finished && this.t < maxHours * 3600) this.step(60);
  }

  // expose for the UI
  integrate = integrate;
}

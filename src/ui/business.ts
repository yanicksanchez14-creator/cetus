/**
 * Business case: would each approach pay off, for whom, and at what scale?
 *
 * Two things come from the simulation (per voyage, averaged over many simulated voyages): the extra cost of protecting
 * whales, the delay, the fuel, and how much each approach cuts the lethal-strike risk. Effectiveness is simulated at
 * several program sizes (share of ships equipped, number of buoys) and interpolated between them. Everything else is a
 * published figure or an assumption, tagged as such and editable.
 */
import { ii } from "./info";
import type { ModeId } from "../engine/summary";

export type BizMode = ModeId;

/** One simulated operating point: per-voyage averages. */
export interface Point { x: number; usd: number; late: number; fuel: number; cut: number }

/**
 * Effectiveness curves, from simulated voyages (see README): x = share of other ships carrying the kit (Ships, Mix)
 * or number of buoys (Buoys). Filled in from the reference runs; `setCurve` can replace the top point with a user batch.
 */
export const CURVES: Record<"ships" | "mix" | "network", Point[]> = {
  // Simulated on the Oakland → Long Beach route with real AIS traffic: 120 voyages at full scale, 25-60 per smaller point.
  // Risk cuts are made monotonic (more listeners never protect less; a dip between two points is sampling noise).
  ships: [
    { x: 0, usd: -65, late: 6.4, fuel: -0.38, cut: 0.148 }, // own ship only: hearing + camera + precautions
    { x: 0.1, usd: -91, late: 6.6, fuel: -0.41, cut: 0.495 },
    { x: 0.3, usd: -17, late: 5.7, fuel: -0.31, cut: 0.578 },
    { x: 1, usd: 58, late: 5.2, fuel: -0.23, cut: 0.753 },
  ],
  mix: [
    { x: 0, usd: 13, late: 4.9, fuel: -0.25, cut: 0.512 }, // own ship + 10 port stations
    { x: 0.1, usd: 6, late: 5.2, fuel: -0.27, cut: 0.712 },
    { x: 0.3, usd: 35, late: 5.9, fuel: -0.28, cut: 0.712 },
    { x: 1, usd: 57, late: 4.5, fuel: -0.19, cut: 0.772 },
  ],
  network: [
    { x: 50, usd: 140, late: 1.9, fuel: 0, cut: 0.907 },
    { x: 150, usd: 167, late: 2.8, fuel: -0.02, cut: 0.907 },
    { x: 300, usd: 183, late: 2.4, fuel: 0.01, cut: 0.938 },
    { x: 500, usd: 155, late: 2.7, fuel: -0.02, cut: 0.946 },
  ],
};
export let SLOW_ZONES: Point = { x: 0, usd: 10698, late: 85.9, fuel: 3.48, cut: 0.842 }; // 120 voyages
export function setSlowZones(p: Point) { SLOW_ZONES = p; }

export interface BizState {
  mode: BizMode;
  fleet: number; // ships in the program (Ships, Mix)
  voyagesPerShip: number;
  stations: number; // Mix
  buoys: number; // Buoys
  compliance: number; // % of voyages that would otherwise slow down in slow zones
  szScale: number; // value of ship time vs the base ($4,200/h), % (scales the slow-zone cost per voyage)
  season: number; // % of a year's voyages that fall inside the slow-zone season
  uptake: number; // % of ships that act on located-whale advice from a public network (Buoys)
  regionVoyages: number; // large-ship voyages a year through the area
  deaths: number; // whale deaths a year from ship strikes (California, no protection)
  whaleValue: number;
  kitCapex: number; kitOpex: number;
  stationCapex: number; stationOpex: number;
  buoyCapex: number; buoyOpex: number;
  platform: number; // data platform + operations, per year
  years: number; discountPct: number;
}

export const DEFAULT_BIZ: BizState = {
  mode: "ships", fleet: 20, voyagesPerShip: 25, stations: 10, buoys: 500, compliance: 65, season: 62, szScale: 100, uptake: 90,
  regionVoyages: 2500, deaths: 60, whaleValue: 2_000_000,
  kitCapex: 150_000, kitOpex: 20_000, stationCapex: 4_000_000, stationOpex: 250_000,
  buoyCapex: 75_000, buoyOpex: 20_000, platform: 1_500_000, years: 10, discountPct: 7,
};

const lerp = (pts: Point[], x: number): Point => {
  if (!pts.length) return { x, usd: 0, late: 0, fuel: 0, cut: 0 };
  if (x <= pts[0].x) return { ...pts[0], x };
  for (let k = 1; k < pts.length; k++) {
    if (x <= pts[k].x) {
      const a = pts[k - 1], b = pts[k], f = (x - a.x) / (b.x - a.x);
      return { x, usd: a.usd + f * (b.usd - a.usd), late: a.late + f * (b.late - a.late), fuel: a.fuel + f * (b.fuel - a.fuel), cut: a.cut + f * (b.cut - a.cut) };
    }
  }
  return { ...pts[pts.length - 1], x };
};

export interface Result {
  mode: BizMode;
  op: Point; // per-voyage operating point
  voyages: number; // voyages a year the program covers
  share: number; // share of ships equipped (Ships, Mix)
  capex: number; opex: number;
  savingsPerVoyage: number; // vs complying with slow zones
  savings: number; // a year, only voyages that would have complied
  net: number; // savings - opex, a year
  npv: number; irr: number; payback: number; // payback in years (discounted), NaN if never
  roi: number;
  whales: number; // saved a year vs no protection
  whalesVsSZ: number; // saved a year beyond what slow zones achieve on the same voyages
  costPerWhale: number; // all-in yearly cost net of savings, per whale saved (<= 0: pays for itself)
  hoursSaved: number; co2Saved: number;
  cash: number[]; // cumulative discounted cash, year 0..years
}

/** Slow-zone cost per voyage at the chosen value of ship time. */
const szOp = (s: BizState): Point => ({ ...SLOW_ZONES, usd: SLOW_ZONES.usd * (s.szScale ?? 100) / 100 });

/** Per-voyage operating point for a mode at the chosen scale. */
export function operatingPoint(s: BizState, mode: BizMode): { op: Point; share: number } {
  if (mode === "single") return { op: szOp(s), share: 0 };
  if (mode === "network") return { op: lerp(CURVES.network, s.buoys), share: 0 };
  // share of the traffic carrying a kit (traffic-weighted: a ship making many voyages counts more); our own ship
  // is always equipped, so a program of 1 ship is the "own ship only" point
  const share = Math.min(1, Math.max(0, (s.fleet - 1) * s.voyagesPerShip / Math.max(1, s.regionVoyages)));
  const ships = lerp(CURVES.ships, share);
  if (mode === "ships") return { op: ships, share };
  // Mix: effect scales between Ships (0 stations) and the simulated 10-station network (an assumption, see ⓘ)
  const mix = lerp(CURVES.mix, share), f = Math.min(1, s.stations / 10);
  return { op: { x: share, usd: ships.usd + f * (mix.usd - ships.usd), late: ships.late + f * (mix.late - ships.late), fuel: ships.fuel + f * (mix.fuel - ships.fuel), cut: ships.cut + f * (mix.cut - ships.cut) }, share };
}

export function evaluate(s: BizState, mode: BizMode = s.mode): Result {
  const { op, share } = operatingPoint(s, mode);
  const i = s.discountPct / 100, Y = Math.max(1, Math.round(s.years));
  // only voyages in slow-zone season that would have complied lose time today, so only they can save
  const c = (s.compliance / 100) * (s.season / 100);
  const perShipVoy = mode === "ships" || mode === "mix";
  const voyages = mode === "single" || mode === "network" ? s.regionVoyages : Math.min(s.fleet * s.voyagesPerShip, s.regionVoyages);
  let capex = 0, opex = 0;
  if (mode === "ships" || mode === "mix") { capex += s.fleet * s.kitCapex; opex += s.fleet * s.kitOpex + s.platform; }
  if (mode === "mix") { capex += s.stations * s.stationCapex; opex += s.stations * s.stationOpex; }
  if (mode === "network") { capex += s.buoys * s.buoyCapex; opex += s.buoys * s.buoyOpex + s.platform; }
  // Savings vs complying with slow zones: only voyages that would otherwise have slowed down save anything.
  // Slow zones themselves are the baseline (no savings; their cost is borne by shipping).
  const savingsPerVoyage = mode === "single" ? 0 : szOp(s).usd - op.usd;
  const savings = voyages * c * savingsPerVoyage;
  const protectionCost = mode === "single" ? voyages * c * op.usd : 0;
  const net = mode === "single" ? -protectionCost : savings - opex;
  const cash: number[] = [-capex];
  let npv = -capex, payback = NaN;
  for (let t = 1; t <= Y; t++) {
    npv += net / (1 + i) ** t;
    cash.push(npv);
    if (isNaN(payback) && npv >= 0 && capex > 0) {
      const prev = cash[t - 1];
      payback = t - 1 + (0 - prev) / (npv - prev);
    }
  }
  // IRR by bisection (only meaningful with an up-front cost and positive yearly net)
  let irr = NaN;
  if (capex > 0 && net > 0) {
    const f = (r: number) => { let v = -capex; for (let t = 1; t <= Y; t++) v += net / (1 + r) ** t; return v; };
    let lo = -0.99, hi = 10;
    if (f(lo) > 0 && f(hi) < 0) { for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; } irr = (lo + hi) / 2; }
    else if (f(hi) >= 0) irr = Infinity;
  }
  const share_of_traffic = Math.min(1, voyages / Math.max(1, s.regionVoyages));
  const protectedShare = mode === "single" ? c : perShipVoy ? share_of_traffic : s.uptake / 100;
  const whales = s.deaths * op.cut * protectedShare;
  const whalesVsSZ = mode === "single" ? 0 : s.deaths * share_of_traffic * (op.cut - c * SLOW_ZONES.cut);
  const crf = i > 0 ? (i * (1 + i) ** Y) / ((1 + i) ** Y - 1) : 1 / Y;
  const yearlyAllIn = capex * crf + opex - savings + protectionCost;
  const costPerWhale = whales > 0 ? yearlyAllIn / whales : NaN;
  const hoursSaved = mode === "single" ? 0 : (voyages * c * (SLOW_ZONES.late - op.late)) / 60;
  const co2Saved = mode === "single" ? 0 : voyages * c * (SLOW_ZONES.fuel - op.fuel) * 3.206;
  return { mode, op, voyages, share, capex, opex, savingsPerVoyage, savings, net, npv, irr, payback, roi: capex > 0 ? npv / capex : NaN, whales, whalesVsSZ, costPerWhale, hoursSaved, co2Saved, cash };
}

/** Smallest program size with NPV >= 0 (fleet for Ships/Mix, buoys for Buoys), or NaN. */
export function breakEven(s: BizState, mode: BizMode): number {
  if (mode === "single") return NaN;
  if (mode === "network") { for (let n = 50; n <= 500; n += 10) if (evaluate({ ...s, buoys: n }, mode).npv >= 0) return n; return NaN; }
  for (const n of sizes(s)) if (evaluate({ ...s, fleet: n }, mode).npv >= 0) return n;
  return NaN;
}
const sizes = (s: BizState) => { const out: number[] = []; for (let n = 1; n <= maxFleet(s); n = n < 10 ? n + 1 : n < 100 ? n + 2 : n + 10) out.push(n); return out; };

// ------------------------------------------------------------------------------------------------ scenarios
export type Scenario = "conservative" | "base" | "optimistic";
const SCEN_KEYS = ["compliance", "season", "szScale", "kitCapex", "kitOpex", "stationCapex", "stationOpex", "buoyCapex", "buoyOpex", "platform", "discountPct", "uptake", "whaleValue"] as const;
const pickScen = (s: BizState) => Object.fromEntries(SCEN_KEYS.map((k) => [k, s[k]])) as Partial<BizState>;
export const SCENARIOS: Record<Scenario, Partial<BizState>> = {
  // pessimistic on every input at once: fewer ships slow down today, shorter season, cheaper ship time, dearer kit
  conservative: { compliance: 55, season: 55, szScale: 75, kitCapex: 225_000, kitOpex: 30_000, stationCapex: 6_000_000, stationOpex: 375_000, buoyCapex: 110_000, buoyOpex: 30_000, platform: 2_250_000, discountPct: 10, uptake: 75, whaleValue: 1_000_000 },
  base: pickScen(DEFAULT_BIZ),
  optimistic: { compliance: 75, season: 70, szScale: 125, kitCapex: 100_000, kitOpex: 15_000, stationCapex: 3_000_000, stationOpex: 200_000, buoyCapex: 50_000, buoyOpex: 15_000, platform: 1_000_000, discountPct: 5, uptake: 95, whaleValue: 3_000_000 },
};
export const applyScenario = (s: BizState, k: Scenario): BizState => ({ ...s, ...SCENARIOS[k] });
export const scenarioOf = (s: BizState): Scenario | null =>
  (Object.keys(SCENARIOS) as Scenario[]).find((k) => SCEN_KEYS.every((key) => SCENARIOS[k][key] === s[key])) ?? null;

export function scenarioHtml(s: BizState): string {
  const cur = scenarioOf(s);
  const btn = (k: Scenario, label: string) => `<button data-scen="${k}" class="${cur === k ? "on" : ""}">${label}</button>`;
  return `<div class="bz-scen"><span class="small muted">Assumptions ${ii("bizScenario")}</span>
    <div class="seg">${btn("conservative", "Conservative")}${btn("base", "Base")}${btn("optimistic", "Optimistic")}</div>
    ${cur ? "" : `<span class="small muted">custom (edited below)</span>`}</div>`;
}

/** NPV under all three scenarios at the current program size: the planning range. */
function rangeHtml(s: BizState): string {
  const keep = { mode: s.mode, fleet: s.fleet, voyagesPerShip: s.voyagesPerShip, stations: s.stations, buoys: s.buoys };
  const v = (["conservative", "base", "optimistic"] as Scenario[]).map((k) => ({ k, r: evaluate({ ...applyScenario(s, k), ...keep }) }));
  const cur = scenarioOf(s) ? null : evaluate(s);
  const all = [...v.map((x) => x.r.npv), ...(cur ? [cur.npv] : []), 0];
  const lo = Math.min(...all), hi = Math.max(...all);
  const W = 640, H = 64, L = 12, R = 12;
  const x = (n: number) => L + ((W - L - R) * (n - lo)) / (hi - lo || 1);
  const name = { conservative: "Conservative", base: "Base", optimistic: "Optimistic" } as const;
  const col = (n: number) => (n >= 0 ? "#5ef0a4" : "#ff7a85");
  const be = (["conservative", "base", "optimistic"] as Scenario[]).map((k) => breakEven({ ...applyScenario(s, k), ...keep }, s.mode));
  const unit = s.mode === "network" ? "buoys" : "ships";
  return `<figure class="lab-fig"><figcaption>Planning range: ${s.years}-year NPV at this program size under each scenario ${ii("bizScenario")}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="NPV range across scenarios">
      <line x1="${x(v[0].r.npv)}" x2="${x(v[2].r.npv)}" y1="30" y2="30" stroke="rgba(255,255,255,0.25)" stroke-width="6" stroke-linecap="round"/>
      <line x1="${x(0)}" x2="${x(0)}" y1="14" y2="46" stroke="rgba(255,255,255,0.45)" stroke-dasharray="2 3"/><text class="tick" x="${x(0)}" y="60" text-anchor="middle">$0</text>
      ${v.map(({ k, r }, i) => `<circle cx="${x(r.npv)}" cy="30" r="${k === "base" ? 6 : 5}" fill="${col(r.npv)}"><title>${name[k]}: ${money(r.npv)}</title></circle>
        <text class="val" x="${x(r.npv)}" y="${i === 1 ? 12 : 12}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}" fill="${col(r.npv)}">${name[k]} ${money(r.npv)}</text>`).join("")}
      ${cur ? `<circle cx="${x(cur.npv)}" cy="30" r="4" fill="#fff"><title>Your custom inputs: ${money(cur.npv)}</title></circle>` : ""}
    </svg>
    <div class="small muted">${s.mode === "single" ? "" : `Break-even size: ${be.map((b, i) => `${["conservative", "base", "optimistic"][i]} ${isFinite(b) ? `${num(b)} ${unit}` : "never"}`).join(" · ")}.`}
      ${v[0].r.npv >= 0 ? "Pays off even in the conservative case." : v[2].r.npv < 0 ? "Doesn't pay off on savings alone even in the optimistic case." : "The answer depends on the assumptions: see which ones matter most below."}</div>
  </figure>`;
}

/** Tornado: NPV when each input moves ±25% with the others held at current values, largest swing first. */
function tornadoHtml(s: BizState): string {
  const base = evaluate(s).npv;
  type K = keyof BizState;
  const P: { k: K; label: string; pct?: boolean; modes: BizMode[] }[] = [
    { k: "compliance", label: "Ships obeying slow zones", pct: true, modes: ["ships", "mix", "network"] },
    { k: "season", label: "Voyages in season", pct: true, modes: ["ships", "mix", "network"] },
    { k: "szScale", label: "Value of ship time", modes: ["ships", "mix", "network"] },
    { k: "voyagesPerShip", label: "Voyages per ship", modes: ["ships", "mix"] },
    { k: "kitCapex", label: "Kit price", modes: ["ships", "mix"] },
    { k: "kitOpex", label: "Kit servicing", modes: ["ships", "mix"] },
    { k: "stationCapex", label: "Station build cost", modes: ["mix"] },
    { k: "stationOpex", label: "Station running cost", modes: ["mix"] },
    { k: "buoyCapex", label: "Buoy price", modes: ["network"] },
    { k: "buoyOpex", label: "Buoy servicing", modes: ["network"] },
    { k: "platform", label: "Data platform", modes: ["ships", "mix", "network"] },
    { k: "discountPct", label: "Discount rate", modes: ["ships", "mix", "network"] },
  ];
  const bars = P.filter((p) => p.modes.includes(s.mode)).map((p) => {
    const v0 = s[p.k] as number;
    const at = (f: number) => { let v = v0 * f; if (p.pct) v = Math.min(100, v); const t = { ...s, [p.k]: v } as BizState; t.fleet = Math.min(t.fleet, maxFleet(t)); return evaluate(t).npv; };
    const dn = at(0.75), up = at(1.25);
    return { ...p, dn, up, swing: Math.abs(up - dn) };
  }).sort((a, b) => b.swing - a.swing);
  if (!bars.length) return "";
  const span = [base, ...bars.flatMap((b) => [b.dn, b.up])];
  const sLo = Math.min(...span), sHi = Math.max(...span);
  // show $0 only when it is near the bars; otherwise it squeezes them into a corner
  const withZero = 0 >= sLo - 0.6 * (sHi - sLo) && 0 <= sHi + 0.6 * (sHi - sLo);
  const lo = withZero ? Math.min(0, sLo) : sLo, hi = withZero ? Math.max(0, sHi) : sHi;
  const W = 640, L = 196, R = 16, T = 8, rowH = 22, H = T + bars.length * rowH + 22;
  const x = (n: number) => L + ((W - L - R) * (n - lo)) / (hi - lo || 1);
  const seg = (a: number, b: number, y: number, c: string, t: string) => `<rect x="${Math.min(x(a), x(b)).toFixed(1)}" y="${y}" width="${Math.max(1, Math.abs(x(b) - x(a))).toFixed(1)}" height="${rowH - 8}" rx="2" fill="${c}"><title>${t}</title></rect>`;
  const LO = "#ff9f6e", HI = "#5fe1ff";
  const top = bars[0];
  return `<figure class="lab-fig"><figcaption>Which assumptions matter most: ${s.years}-year NPV when each input moves ±25% ${ii("bizTornado")}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sensitivity of NPV to each assumption">
      ${withZero ? `<line x1="${x(0)}" x2="${x(0)}" y1="${T - 4}" y2="${H - 18}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="2 3"/>` : ""}
      <line x1="${x(base)}" x2="${x(base)}" y1="${T - 4}" y2="${H - 18}" stroke="rgba(255,255,255,0.7)"/>
      ${bars.map((b, i) => { const y = T + i * rowH; return `<text class="tick" x="${L - 8}" y="${y + rowH / 2 + 1}" text-anchor="end">${b.label}</text>
        ${seg(base, b.dn, y, LO, `${b.label} −25%: ${money(b.dn)}`)}${seg(base, b.up, y, HI, `${b.label} +25%: ${money(b.up)}`)}`; }).join("")}
      <text class="tick" x="${x(base)}" y="${H - 4}" text-anchor="middle">now ${money(base)}</text>
      ${withZero && Math.abs(x(0) - x(base)) > 60 ? `<text class="tick" x="${x(0)}" y="${H - 4}" text-anchor="middle">$0</text>` : ""}
    </svg>
    <div class="small muted"><i class="dot" style="background:${LO}"></i> input 25% lower · <i class="dot" style="background:${HI}"></i> input 25% higher.
      Biggest lever: <b>${top.label.toLowerCase()}</b> (${money(Math.min(top.dn, top.up))} to ${money(Math.max(top.dn, top.up))}).
      ${bars.length > 1 && Math.abs(bars[1].swing - top.swing) < 0.01 * top.swing ? "Bars of equal length are inputs that multiply together in the savings (voyages × season × share that complies × cost per voyage), so a 25% change in any of them moves the result by the same amount." : ""}</div>
  </figure>`;
}

// ------------------------------------------------------------------------------------------------ formatting
export const money = (v: number) => {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}k`;
  return `${s}$${Math.round(a)}`;
};
const dollars = (v: number) => `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
const pct = (v: number) => (isFinite(v) ? `${Math.round(v * 100)}%` : v === Infinity ? ">1000%" : "—");
const num = (v: number, d = 0) => (isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—");

const MODE_NAME: Record<BizMode, string> = { ships: "Ships", mix: "Mix", network: "Buoys", single: "Slow zones" };
const MODE_COLOR: Record<BizMode, string> = { ships: "#9fb3c6", mix: "#5ef0a4", network: "#5fe1ff", single: "#b69cff" };
const TAG = (k: "sim" | "res" | "ass" | "calc") => `<span class="stag ${k}">${{ sim: "simulation", res: "research", ass: "assumption", calc: "calculated" }[k]}</span>`;

// ------------------------------------------------------------------------------------------------ controls
/** Fleet slider is logarithmic: 1 ... callingShips. */
export const fleetToSlider = (n: number, max: number) => Math.round((1000 * Math.log(n)) / Math.log(max));
export const sliderToFleet = (v: number, max: number) => Math.max(1, Math.round(Math.exp((v / 1000) * Math.log(max))));
/** Most ships a program can usefully have: enough to carry every voyage through the area. */
export const maxFleet = (s: BizState) => Math.max(2, Math.ceil(s.regionVoyages / Math.max(1, s.voyagesPerShip)));

export function controlsHtml(s: BizState): string {
  const modeBtns = (["ships", "mix", "network", "single"] as BizMode[]).map((m) => `<button data-bmode="${m}" class="${s.mode === m ? "on" : ""}"><i class="dot" style="background:${MODE_COLOR[m]}"></i>${MODE_NAME[m]}</button>`).join("");
  const slider = (key: string, label: string, info: string, min: number, max: number, step: number, value: number, shown: string, show = true) =>
    show ? `<label class="bz-sl"><span>${label} ${ii(info)} <b id="bzv-${key}">${shown}</b></span><input type="range" data-bs="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></label>` : "";
  const ships = s.mode === "ships" || s.mode === "mix";
  return `<div class="bz-top"><div class="bz-modes seg">${modeBtns}</div>${scenarioHtml(s)}</div>
    <div class="bz-controls">
      ${slider("fleet", "Ships in the program", "bizFleet", 0, 1000, 1, fleetToSlider(s.fleet, maxFleet(s)), `${num(s.fleet)} <span class=\"muted\">of ${num(maxFleet(s))}</span>`, ships)}
      ${slider("voyagesPerShip", "California voyages per ship per year", "bizVoy", 5, 60, 1, s.voyagesPerShip, num(s.voyagesPerShip), ships)}
      ${slider("stations", "Port seafloor stations", "bizStations", 0, 10, 1, s.stations, num(s.stations), s.mode === "mix")}
      ${slider("buoys", "Moored buoys", "bizBuoys", 50, 500, 10, s.buoys, num(s.buoys), s.mode === "network")}
      ${slider("compliance", "Ships that obey slow zones today", "bizCompliance", 0, 100, 5, s.compliance, `${s.compliance}%`)}
    </div>`;
}

// ------------------------------------------------------------------------------------------------ output
export function outputHtml(s: BizState, src: string): string {
  const r = evaluate(s);
  const sz = evaluate(s, "single");
  const be = breakEven(s, s.mode);
  const isProgram = s.mode !== "single";
  const who = s.mode === "network" ? "the state / a public–private consortium (public infrastructure; every ship benefits)" : s.mode === "single" ? "shipping companies (time lost) — there is no system to build" : "a carrier or a group of carriers (they buy the kits and keep the savings)";
  const good = (v: number) => (v >= 0 ? "good" : "bad");

  const kpis = isProgram ? `<div class="bz-kpis">
      <div class="kpi ${good(r.npv)}"><b>${money(r.npv)}</b><span>Net present value, ${s.years} years ${ii("bizNPV")}</span></div>
      <div class="kpi ${good(r.net)}"><b>${money(r.net)}</b><span>Net benefit per year ${ii("bizNet")}</span></div>
      <div class="kpi ${isFinite(r.payback) ? "good" : "bad"}"><b>${isFinite(r.payback) ? (r.payback < 1 ? `${Math.max(1, Math.round(r.payback * 12))} months` : `${r.payback.toFixed(1)} years`) : r.capex === 0 ? "—" : "never"}</b><span>Payback (discounted) ${ii("bizPayback")}</span></div>
      <div class="kpi ${isFinite(r.irr) && r.irr > s.discountPct / 100 ? "good" : "bad"}"><b>${pct(r.irr)}</b><span>Internal rate of return ${ii("bizIRR")}</span></div>
      <div class="kpi"><b>${num(r.whales, 1)}</b><span>Whales saved per year ${ii("bizWhales")}</span></div>
      <div class="kpi"><b>${isFinite(r.costPerWhale) ? (r.costPerWhale <= 0 ? "pays for itself" : money(r.costPerWhale)) : "—"}</b><span>Cost per whale saved ${ii("bizPerWhale")}</span></div>
      <div class="kpi"><b>${num(r.hoursSaved)} h</b><span>Ship-hours of delay avoided per year</span></div>
      <div class="kpi"><b>${num(r.co2Saved)} t</b><span>CO₂ avoided per year vs slow zones ${ii("bizCO2")}</span></div>
    </div>` : `<div class="bz-kpis">
      <div class="kpi bad"><b>${money(-sz.net)}</b><span>Cost to shipping per year ${ii("bizSZ")}</span></div>
      <div class="kpi bad"><b>${num((s.regionVoyages * s.compliance / 100 * s.season / 100 * SLOW_ZONES.late) / 60)} h</b><span>Ship-hours of delay per year</span></div>
      <div class="kpi"><b>${num(sz.whales, 1)}</b><span>Whales saved per year ${ii("bizWhales")}</span></div>
      <div class="kpi"><b>${money(sz.costPerWhale)}</b><span>Cost per whale saved ${ii("bizPerWhale")}</span></div>
    </div>`;

  const verdict = !isProgram
    ? `<b>Slow zones are the baseline.</b> Nothing to build, but every complying ship loses about ${Math.round(SLOW_ZONES.late)} minutes and ${money(szOp(s).usd)} per voyage, which is why compliance is voluntary and partial. Pick another approach to see what replacing them would be worth.`
    : r.npv >= 0
      ? `<b>This pays off.</b> ${MODE_NAME[s.mode]} at this scale saves ${money(r.savings)} a year in avoided slow-downs against ${money(r.opex)} of running costs, repaying the ${money(r.capex)} set-up in ${isFinite(r.payback) ? (r.payback < 1 ? "under a year" : `${r.payback.toFixed(1)} years`) : "—"}, while saving about ${num(r.whales, 1)} whales a year.${isFinite(be) ? ` Break-even needs at least <b>${num(be)} ${s.mode === "network" ? "buoys" : "ships"}</b>.` : ""}`
      : `<b>At this scale it doesn't pay back on savings alone.</b> ${isFinite(be) ? `It breaks even from about <b>${num(be)} ${s.mode === "network" ? "buoys" : "ships in the program"}</b>` : "It doesn't break even at any size with these assumptions"}; ${s.mode === "mix" ? "the port stations cost more to build and run than the slow-downs they replace" : s.mode === "network" ? "servicing moored buoys at sea costs more than the slow-downs they replace" : "the fixed platform cost needs enough voyages to spread over"}. The whales it saves (${num(r.whales, 1)} a year) are a public benefit worth ${money(r.whales * s.whaleValue)} a year at ${money(s.whaleValue)} per whale ${ii("bizValue")}.`;

  const pl = isProgram ? `<table class="lab-tbl bz-pl"><tbody>
      <tr><td>Voyages covered per year ${TAG("calc")}</td><td>${num(r.voyages)}${s.mode === "ships" || s.mode === "mix" ? ` <span class="muted">(${num(s.fleet)} ships × ${s.voyagesPerShip})</span>` : ` <span class="muted">(all large-ship voyages in the area)</span>`}</td></tr>
      <tr><td>Slow-zone cost avoided per voyage ${TAG("sim")}</td><td>${dollars(szOp(s).usd)} − ${r.op.usd < 0 ? `(${dollars(r.op.usd)})` : dollars(r.op.usd)} = <b>${dollars(r.savingsPerVoyage)}</b>${r.op.usd < 0 ? ` <span class="muted">(at this scale the ship's own precautions even save a little fuel)</span>` : ""}</td></tr>
      <tr><td>Avoided slow-down costs ${TAG("calc")}<br><span class="muted">voyages × ${s.season}% in season × ${s.compliance}% that comply × saving</span></td><td class="pos">+${money(r.savings)}</td></tr>
      ${s.mode === "ships" || s.mode === "mix" ? `<tr><td>Ship kits: servicing ${TAG("ass")}</td><td class="neg">−${money(s.fleet * s.kitOpex)}</td></tr>` : ""}
      ${s.mode === "mix" ? `<tr><td>Port stations: operations ${TAG("ass")}</td><td class="neg">−${money(s.stations * s.stationOpex)}</td></tr>` : ""}
      ${s.mode === "network" ? `<tr><td>Buoys: servicing at sea ${TAG("ass")}</td><td class="neg">−${money(s.buoys * s.buoyOpex)}</td></tr>` : ""}
      <tr><td>Data platform and operations ${TAG("ass")}</td><td class="neg">−${money(s.platform)}</td></tr>
      <tr class="sum"><td>Net benefit per year</td><td class="${r.net >= 0 ? "pos" : "neg"}"><b>${r.net >= 0 ? "+" : ""}${money(r.net)}</b></td></tr>
      <tr><td>One-time set-up ${TAG("ass")}</td><td class="neg">−${money(r.capex)} <span class="muted">${s.mode === "network" ? `${num(s.buoys)} buoys` : `${num(s.fleet)} kits${s.mode === "mix" ? ` + ${s.stations} stations` : ""}`}</span></td></tr>
      <tr><td>Strike-risk cut at this scale ${TAG("sim")}</td><td>${pct(r.op.cut)}${s.mode === "ships" || s.mode === "mix" ? ` <span class="muted">(${pct(r.share)} of ships equipped)</span>` : ""} <span class="muted">vs ${pct(SLOW_ZONES.cut)} with slow zones</span></td></tr>
    </tbody></table>` : "";

  const chart = isProgram ? cashChart(r, s) + sizeChart(s) : "";

  const all = (["ships", "mix", "network", "single"] as BizMode[]).map((m) => ({ m, r: evaluate(s, m) }));
  const cmp = `<table class="lab-tbl"><thead><tr><th>At these settings</th>${all.map(({ m }) => `<th><i class="dot" style="background:${MODE_COLOR[m]}"></i>${MODE_NAME[m]}</th>`).join("")}</tr></thead><tbody>
      <tr><td>Set-up</td>${all.map(({ r }) => `<td>${money(r.capex)}</td>`).join("")}</tr>
      <tr><td>Net per year</td>${all.map(({ r }) => `<td>${money(r.net)}</td>`).join("")}</tr>
      <tr><td>NPV, ${s.years} years</td>${all.map(({ m, r }) => `<td>${m === "single" ? "—" : money(r.npv)}</td>`).join("")}</tr>
      <tr><td>Strike-risk cut</td>${all.map(({ r }) => `<td>${pct(r.op.cut)}</td>`).join("")}</tr>
      <tr><td>Whales saved per year</td>${all.map(({ r }) => `<td>${num(r.whales, 1)}</td>`).join("")}</tr>
      <tr><td>Cost per whale saved</td>${all.map(({ r }) => `<td>${isFinite(r.costPerWhale) ? (r.costPerWhale <= 0 ? "pays for itself" : money(r.costPerWhale)) : "—"}</td>`).join("")}</tr>
    </tbody></table>`;

  return `${kpis}
    <div class="lab-verdict">${verdict}</div>
    <p class="small muted" style="margin:8px 0 0">Who pays and who benefits: ${who}. Per-voyage numbers: ${src}.</p>
    ${pl ? `<div class="sec-title">Profit and loss, per year</div>${pl}` : ""}
    ${chart}
    ${isProgram ? `<div class="sec-title">Stress test</div>${rangeHtml(s)}${tornadoHtml(s)}` : ""}
    <div class="sec-title">All four approaches at these settings</div>${cmp}`;
}

function cashChart(r: Result, s: BizState): string {
  const W = 640, H = 170, L = 56, R = 12, T = 12, B = 26;
  const ys = r.cash, lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const x = (t: number) => L + ((W - L - R) * t) / Math.max(1, ys.length - 1);
  const y = (v: number) => T + ((H - T - B) * (hi - v)) / (hi - lo || 1);
  const path = ys.map((v, t) => `${t ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${path}L${x(ys.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const col = r.npv >= 0 ? "#5ef0a4" : "#ff7a85";
  const ticks = [lo, 0, hi].filter((v, k, a) => a.indexOf(v) === k);
  const pb = r.payback;
  return `<figure class="lab-fig"><figcaption>Cumulative cash, discounted at ${s.discountPct}% ${ii("bizCash")}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative discounted cash by year">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,${v === 0 ? 0.35 : 0.08})"/><text class="tick" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${money(v)}</text>`).join("")}
      <path d="${area}" fill="${col}" opacity="0.10"/><path d="${path}" fill="none" stroke="${col}" stroke-width="2"/>
      ${ys.map((v, t) => `<circle cx="${x(t)}" cy="${y(v)}" r="2.5" fill="${col}"><title>Year ${t}: ${money(v)}</title></circle><text class="tick" x="${x(t)}" y="${H - 8}" text-anchor="middle">${t}</text>`).join("")}
      ${isFinite(pb) && pb <= ys.length - 1 ? `<line x1="${x(pb)}" x2="${x(pb)}" y1="${T}" y2="${H - B}" stroke="#ffd166" stroke-dasharray="3 3"/><text class="val" x="${x(pb) + 4}" y="${T + 10}" fill="#ffd166">break-even · ${pb < 1 ? Math.max(1, Math.round(pb * 12)) + " mo" : pb.toFixed(1) + " yr"}</text>` : ""}
    </svg></figure>`;
}

function sizeChart(s: BizState): string {
  const buoys = s.mode === "network";
  const xs = buoys ? Array.from({ length: 46 }, (_, k) => 50 + k * 10) : [...new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75, 90, 110, 130, 160, 200, 250, 300, 400, 500, maxFleet(s)].filter((n) => n <= maxFleet(s)))];
  const pts = xs.map((n) => ({ n, v: evaluate(buoys ? { ...s, buoys: n } : { ...s, fleet: n }).npv }));
  const W = 640, H = 170, L = 56, R = 12, T = 12, B = 26;
  const lo = Math.min(0, ...pts.map((p) => p.v)), hi = Math.max(0, ...pts.map((p) => p.v));
  const lx = (n: number) => (buoys ? n : Math.log(n));
  const x0 = lx(xs[0]), x1 = lx(xs[xs.length - 1]);
  const x = (n: number) => L + ((W - L - R) * (lx(n) - x0)) / (x1 - x0 || 1);
  const y = (v: number) => T + ((H - T - B) * (hi - v)) / (hi - lo || 1);
  const path = pts.map((p, k) => `${k ? "L" : "M"}${x(p.n).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const cur = buoys ? s.buoys : s.fleet, curV = evaluate(s).npv;
  const be = breakEven(s, s.mode);
  const xt = buoys ? [50, 100, 200, 300, 400, 500] : [1, 10, maxFleet(s)].filter((n, k, a) => a.indexOf(n) === k);
  return `<figure class="lab-fig"><figcaption>How the ${s.years}-year NPV changes with the size of the program ${ii("bizScale")}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="NPV by program size">
      <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(255,255,255,0.35)"/>
      <text class="tick" x="${L - 6}" y="${y(hi) + 3}" text-anchor="end">${money(hi)}</text><text class="tick" x="${L - 6}" y="${y(0) + 3}" text-anchor="end">$0</text><text class="tick" x="${L - 6}" y="${y(lo) + 3}" text-anchor="end">${money(lo)}</text>
      <path d="${path}" fill="none" stroke="${MODE_COLOR[s.mode]}" stroke-width="2"/>
      ${xt.map((n) => `<text class="tick" x="${x(n)}" y="${H - 8}" text-anchor="middle">${num(n)}</text>`).join("")}
      <text class="tick" x="${W - R}" y="${H - 8 - 12}" text-anchor="end">${buoys ? "buoys" : "ships in the program (log scale)"}</text>
      ${isFinite(be) ? `<line x1="${x(be)}" x2="${x(be)}" y1="${T}" y2="${H - B}" stroke="#ffd166" stroke-dasharray="3 3"/><text class="val" x="${x(be) + 4}" y="${T + 10}" fill="#ffd166">break-even ≈ ${num(be)}</text>` : ""}
      <circle cx="${x(cur)}" cy="${y(curV)}" r="4.5" fill="#fff" stroke="${MODE_COLOR[s.mode]}" stroke-width="2"><title>You: ${num(cur)} → ${money(curV)}</title></circle>
    </svg></figure>`;
}

export function assumptionsHtml(s: BizState): string {
  const inp = (k: keyof BizState, v: number, w = 90, suf = "") => `<input class="lab-in" data-bz="${k}" value="${v.toLocaleString("en-US")}${suf}" style="width:${w}px">`;
  return `<table class="lab-tbl assump"><tbody>
    <tr><td>Large-ship voyages a year through the area ${TAG("res")} ${ii("bizRegion")}</td><td>${inp("regionVoyages", s.regionVoyages)}</td></tr>
    <tr><td>Whales killed by ships a year, California, no protection ${TAG("res")}${TAG("ass")} ${ii("bizDeaths")}</td><td>${inp("deaths", s.deaths, 70)}</td></tr>
    <tr><td>Ship kit: towed hydrophone + thermal camera ${TAG("ass")} ${ii("bizKit")}</td><td>${inp("kitCapex", s.kitCapex)} + ${inp("kitOpex", s.kitOpex, 80)}/yr</td></tr>
    <tr><td>Cabled port station ${TAG("ass")} ${ii("bizStation")}</td><td>${inp("stationCapex", s.stationCapex, 100)} + ${inp("stationOpex", s.stationOpex, 90)}/yr</td></tr>
    <tr><td>Moored hydrophone buoy ${TAG("ass")} ${ii("bizBuoy")}</td><td>${inp("buoyCapex", s.buoyCapex)} + ${inp("buoyOpex", s.buoyOpex, 80)}/yr</td></tr>
    <tr><td>Data platform and operations ${TAG("ass")} ${ii("bizPlatform")}</td><td>${inp("platform", s.platform, 100)}/yr</td></tr>
    <tr><td>Horizon and discount rate ${TAG("ass")} ${ii("bizDiscount")}</td><td>${inp("years", s.years, 50)} years at ${inp("discountPct", s.discountPct, 50, "%")}</td></tr>
    <tr><td>Value of ship time, % of $4,200/h ${TAG("ass")} ${ii("bizTime")}</td><td>${inp("szScale", s.szScale, 60, "%")} <span class="muted">→ slow zones cost ${dollars(szOp(s).usd)} per voyage</span></td></tr>
    <tr><td>Share of voyages in slow-zone season ${TAG("res")} ${ii("bizSeason")}</td><td>${inp("season", s.season, 60, "%")}</td></tr>
    <tr><td>Ships acting on public whale positions (Buoys) ${TAG("ass")} ${ii("bizUptake")}</td><td>${inp("uptake", s.uptake, 60, "%")}</td></tr>
    <tr><td>Value of one great whale ${TAG("res")} ${ii("bizValue")}</td><td>${inp("whaleValue", s.whaleValue, 110)}</td></tr>
  </tbody></table>`;
}

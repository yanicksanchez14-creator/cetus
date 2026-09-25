/**
 * Physical and economic constants. Every number used by the simulation lives here, with its source,
 * so the app can show exactly where each value comes from.
 */

export const SOUND_SPEED_KMS = 1.5; // km/s, nominal speed of sound in seawater

export type SpeciesId = "humpback" | "fin" | "blue";

export interface Species {
  id: SpeciesId;
  name: string;
  sourceLevel: number; // dB re 1 uPa @ 1 m
  callHz: string;
  bandNoise: number; // ambient noise in the call band (dB re 1 uPa), tuned to give published detection ranges
  callIntervalS: [number, number];
  speedKn: [number, number];
  lengthM: number;
  color: [number, number, number];
  note: string;
}

export const SPECIES: Record<SpeciesId, Species> = {
  humpback: {
    id: "humpback", name: "Humpback whale", sourceLevel: 165, callHz: "100-1,000 Hz song units",
    bandNoise: 90, callIntervalS: [6, 14], speedKn: [2, 4.5], lengthM: 14, color: [255, 184, 108],
    note: "Song unit source levels ~151-173 dB (Au et al. 2006). Nominal detection range ~20 km.",
  },
  fin: {
    id: "fin", name: "Fin whale", sourceLevel: 189, callHz: "~20 Hz pulses",
    bandNoise: 108, callIntervalS: [12, 25], speedKn: [3, 6], lengthM: 20, color: [255, 214, 140],
    note: "189 ± 4 dB re 1 uPa @ 1 m, detected to ~56 km (Širović et al. 2007).",
  },
  blue: {
    id: "blue", name: "Blue whale", sourceLevel: 189, callHz: "~15-45 Hz B-calls",
    bandNoise: 104, callIntervalS: [40, 80], speedKn: [2, 5], lengthM: 25, color: [255, 160, 120],
    note: "189 ± 3 dB re 1 uPa @ 1 m. Measured for Antarctic blue whale calls, located up to ~200 km in quiet polar waters (Širović et al. 2007); ~100 km assumed here for noisier Pacific shipping lanes.",
  },
};

/** Seawater absorption (dB/km) at frequency f kHz: Thorp's formula. */
export function thorpDbPerKm(fKhz: number): number {
  const f2 = fKhz * fKhz;
  return (0.11 * f2) / (1 + f2) + (44 * f2) / (4100 + f2) + 2.75e-4 * f2 + 0.003;
}
/** Representative call frequency per species (kHz): humpback song ~500 Hz, fin ~20 Hz, blue ~30 Hz. */
export const CALL_KHZ: Record<SpeciesId, number> = { humpback: 0.5, fin: 0.02, blue: 0.03 };

/** Transmission loss (dB) at range r km: practical spreading 15·log10(r) plus frequency-dependent absorption. */
export function transmissionLoss(rKm: number, sp?: SpeciesId): number {
  const rm = Math.max(rKm * 1000, 1);
  return 15 * Math.log10(rm) + thorpDbPerKm(CALL_KHZ[sp ?? "fin"]) * rKm;
}

/** Arrival-time picking error relative to the slider value (set for fin whales): wider-band calls time more precisely. */
export const TIMING_FACTOR: Record<SpeciesId, number> = { humpback: 0.25, fin: 1, blue: 2.5 };

export const DETECTION_THRESHOLD_DB = 10; // signal-to-noise needed to detect a call

/** Probability that a sensor detects a call with this signal-to-noise ratio: 50% at 10 dB, 10-90% over ±2.6 dB. */
export function detectionProbability(snr: number): number {
  return 1 / (1 + Math.exp(-(snr - DETECTION_THRESHOLD_DB) / 1.2));
}

/** Nominal detection range (km) for a species with no ship nearby. */
export function nominalRangeKm(sp: Species): number {
  // solve SL - TL(r) - NL = threshold (TL includes absorption, so no closed form): bisection on r
  const excess = (r: number) => sp.sourceLevel - transmissionLoss(r, sp.id) - sp.bandNoise - DETECTION_THRESHOLD_DB;
  let lo = 0.01, hi = 1000;
  for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi); if (excess(m) > 0) lo = m; else hi = m; }
  return lo;
}

// ---------------- Ship noise ----------------
/** Broadband source level of a large container ship (dB re 1 uPa @ 1 m).
 *  Reference 186 dB at 18 kn (McKenna et al. 2012 measured 177-188 dB for modern commercial ships);
 *  +1.5 dB per knot = assumed source-level slope (illustrative; real ships vary widely). */
export const SHIP_SL_REF = 186;
export const SHIP_SL_REF_KN = 18;
export const SHIP_DB_PER_KNOT = 1.5;
export function shipSourceLevel(speedKn: number): number {
  return SHIP_SL_REF + SHIP_DB_PER_KNOT * (speedKn - SHIP_SL_REF_KN);
}
/** Ship-noise transmission loss: spherical (20·log r) out to ~1 km (about the water depth), then the same practical
 *  spreading as whale calls (15·log r) beyond, so the two are consistent. */
export function shipNoiseTL(rKm: number): number {
  const rm = Math.max(rKm * 1000, 10);
  return rm <= 1000 ? 20 * Math.log10(rm) : 60 + 15 * Math.log10(rm / 1000);
}
/** Ship noise received at range r km. */
export function shipReceivedLevel(speedKn: number, rKm: number): number {
  return shipSourceLevel(speedKn) - shipNoiseTL(rKm);
}
/** Share of ship noise falling in a species' call band (low-frequency calls overlap ship noise most). */
export function shipBandOffset(sp: Species): number {
  return sp.id === "humpback" ? -14 : -6;
}
/** A strike = whale within this distance of the ship's track (half the ~45 m beam + whale body) AND near the surface. */
export const STRIKE_KM = 0.045;
/** Share of the time a whale is shallow enough to be hit (the rest it passes under the hull). */
export const P_NEAR_SURFACE = 0.5;
export const DISTURBANCE_DB = 120; // NMFS Level B behavioural threshold, continuous noise (dB re 1 uPa rms)

// ---------------- Strike lethality ----------------
/** Probability a strike is lethal at speed v knots (Vanderlaan & Taggart 2007):
 *  P = 1 / (1 + exp(-(-4.89 + 0.41 v))). 31% at 10 kn, 49% at 11.8 kn, 78% at 15 kn. */
export function lethality(speedKn: number): number {
  return 1 / (1 + Math.exp(-(-4.89 + 0.41 * speedKn)));
}

// ---------------- Ship & fuel ----------------
export interface ShipSpec {
  name: string;
  lengthM: number;
  serviceSpeedKn: number;
  pRefKw: number; // main engine power at reference speed
  vRefKn: number;
  pAuxKw: number; // generators / hotel load, independent of speed
  sfocMain: number; // g/kWh
  sfocAux: number; // g/kWh
  exponent: number; // propeller law: P ~ v^n
}

export const DEFAULT_SHIP: ShipSpec = {
  name: "Container ship (illustrative)",
  lengthM: 366,
  serviceSpeedKn: 16,
  pRefKw: 30000,
  vRefKn: 18,
  pAuxKw: 1500,
  sfocMain: 175,
  sfocAux: 210,
  exponent: 3,
};

export const FUEL_PRICE_USD_T = 1346; // average of LA/Long Beach MGO $1,664 (23 Sep 2026) and VLSFO $1,028 (24 Sep 2026), Ship & Bunker
export const CO2_PER_T_FUEL = 3.206; // IMO MEPC.364(79), diesel/gas oil

export function mainPowerKw(ship: ShipSpec, v: number): number {
  return ship.pRefKw * Math.pow(Math.max(v, 0) / ship.vRefKn, ship.exponent);
}
/** Fuel burn rate in tonnes per hour at speed v. */
export function fuelRateTph(ship: ShipSpec, v: number): number {
  return (ship.sfocMain * mainPowerKw(ship, v) + ship.sfocAux * ship.pAuxKw) / 1e6;
}

/**
 * Value of the ship's time (charter hire + crew + running costs), used for minutes lost. ASSUMPTION: ~$100k/day for a
 * large container ship. Note: at this value slowing down SAVES money (fuel falls with speed³), which is real: ships
 * keep speed mainly for their schedule (berth windows, connections), which this number doesn't fully capture.
 */
export const DEFAULT_TIME_COST_USD_H = 4200;

export interface Assumption {
  name: string;
  value: string;
  source: string;
}

export const ASSUMPTIONS: Assumption[] = [
  { name: "Speed of sound", value: "1.5 km/s", source: "Nominal seawater value. Real sound speed varies ~1,480-1,520 m/s with temperature and depth; each run the true value differs by a random ~0.4% the locator does not know" },
  { name: "Sound spreading", value: "15·log10(r) + absorption", source: "Practical spreading (between spherical and cylindrical); absorption from Thorp's formula at each call's frequency (~0.03 dB/km for humpback song, ~0.003 for fin/blue). Ship noise: spherical (20·log r) to 1 km, then 15·log r" },
  { name: "Whale call loudness", value: "Humpback 165 · Fin 189 · Blue 189 dB re 1 µPa @ 1 m", source: "Au et al. 2006; Širović et al. 2007" },
  { name: "Detection ranges", value: "Humpback ~20 km · Fin ~53 km · Blue ~95 km", source: "Band noise set to match published ranges (Širović et al. 2007)" },
  { name: "Arrival-time error", value: "Slider value for fin whales; ×0.25 for humpbacks, ×2.5 for blue whales", source: "GPS clocks are good to <1 µs; the error comes from picking the arrival of the call itself: broadband humpback song ~1-5 ms, ~1 s fin pulses ~10-30 ms, long tonal blue whale calls ~50 ms+ (plus multipath)" },
  { name: "Ship noise", value: "186 dB @ 18 kn, +1.5 dB/kn", source: "Level: McKenna et al. 2012 (177-188 dB). Slope: assumption; faster ships were measurably louder at MBARI MARS (+0.29 dB/kn above background ~20 km away)" },
  { name: "Disturbance threshold", value: "120 dB re 1 µPa", source: "NMFS Level B behavioural threshold, continuous noise" },
  { name: "Strike", value: "Whale within 45 m of the track and near the surface (50% of the time); lethal 31% @ 10 kn · 78% @ 15 kn", source: "Vanderlaan & Taggart 2007 (fitted mostly to smaller vessels; very large ships may be lethal at all speeds)" },
  { name: "Ship power", value: "30 MW @ 18 kn (21 MW @ 16 kn, ~96 t fuel/day incl. generators), P ∝ v³", source: "Illustrative ~14,000 TEU container ship; cube law (propeller law, see Psaraftis & Kontovas 2013, Transportation Research Part C 26)" },
  { name: "Fuel", value: "175 g/kWh main · 1.5 MW aux @ 210 g/kWh", source: "Typical 2-stroke main / 4-stroke auxiliary engines (assumption)" },
  { name: "Fuel price", value: "$1,346/t (average)", source: "Midpoint of LA/Long Beach MGO $1,664/t (23 Sep 2026) and VLSFO $1,028/t (24 Sep 2026), Ship & Bunker. Ships must burn MGO within 24 nm of California (CARB) and usually VLSFO further out" },
  { name: "CO₂", value: "3.206 t per t fuel", source: "IMO MEPC.364(79)" },
  { name: "Safety target", value: "Cut lethal-strike risk ≥80% (or below 0.01%); course shifts must also keep P(within 500 m) ≤ 5%", source: "Design choice; if no option can, pick the best cost-benefit using $2M per great whale (Chami et al. 2019, IMF)" },
  { name: "Value of ship time", value: "$4,200/h (~$100k/day)", source: "Assumption: charter hire + crew + running costs of a large container ship. Used for every minute lost" },
];

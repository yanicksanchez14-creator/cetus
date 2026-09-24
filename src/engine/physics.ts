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
    note: "Song unit source levels ~144-173 dB (Au et al. 2006). Nominal detection range ~20 km.",
  },
  fin: {
    id: "fin", name: "Fin whale", sourceLevel: 189, callHz: "~20 Hz pulses",
    bandNoise: 108, callIntervalS: [12, 25], speedKn: [3, 6], lengthM: 20, color: [255, 214, 140],
    note: "189 ± 4 dB re 1 uPa @ 1 m, detected to ~56 km (Širović et al. 2007).",
  },
  blue: {
    id: "blue", name: "Blue whale", sourceLevel: 189, callHz: "~15-45 Hz B-calls",
    bandNoise: 104, callIntervalS: [40, 80], speedKn: [2, 5], lengthM: 25, color: [255, 160, 120],
    note: "189 ± 3 dB re 1 uPa @ 1 m, detected to ~200 km (Širović et al. 2007).",
  },
};

/** Transmission loss (dB) at range r km: practical spreading 15·log10(r) plus small absorption. */
export function transmissionLoss(rKm: number): number {
  const rm = Math.max(rKm * 1000, 1);
  return 15 * Math.log10(rm) + 0.002 * rKm;
}

export const DETECTION_THRESHOLD_DB = 10; // signal-to-noise needed to detect a call

/** Probability that a sensor detects a call with this signal-to-noise ratio (soft threshold, 2 dB wide). */
export function detectionProbability(snr: number): number {
  return 1 / (1 + Math.exp(-(snr - DETECTION_THRESHOLD_DB) / 1.2));
}

/** Nominal detection range (km) for a species with no ship nearby. */
export function nominalRangeKm(sp: Species): number {
  return Math.pow(10, (sp.sourceLevel - sp.bandNoise - DETECTION_THRESHOLD_DB) / 15) / 1000;
}

// ---------------- Ship noise ----------------
/** Broadband source level of a large container ship (dB re 1 uPa @ 1 m).
 *  Reference 186 dB at 18 kn (McKenna et al. 2012 measured 177-188 dB for modern commercial ships);
 *  +1.5 dB per knot = speed-vs-noise slope measured at MBARI's MARS hydrophone in Project 1 (preview). */
export const SHIP_SL_REF = 186;
export const SHIP_SL_REF_KN = 18;
export const SHIP_DB_PER_KNOT = 1.5;
export function shipSourceLevel(speedKn: number): number {
  return SHIP_SL_REF + SHIP_DB_PER_KNOT * (speedKn - SHIP_SL_REF_KN);
}
/** Ship noise received at range r km (spherical spreading close to the ship). */
export function shipReceivedLevel(speedKn: number, rKm: number): number {
  return shipSourceLevel(speedKn) - 20 * Math.log10(Math.max(rKm * 1000, 10));
}
/** Share of ship noise falling in a species' call band (low-frequency calls overlap ship noise most). */
export function shipBandOffset(sp: Species): number {
  return sp.id === "humpback" ? -14 : -6;
}
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
  lengthM: 300,
  serviceSpeedKn: 16,
  pRefKw: 40000,
  vRefKn: 18,
  pAuxKw: 1500,
  sfocMain: 175,
  sfocAux: 210,
  exponent: 3,
};

export const FUEL_PRICE_USD_T = 1648; // MGO, LA/Long Beach, 22 Sep 2026 (Ship & Bunker); distillate required within 24 nm (CARB)
export const CO2_PER_T_FUEL = 3.206; // IMO MEPC.364(79), diesel/gas oil
export const DEFAULT_TIME_COST_USD_H = 3000; // ASSUMPTION: value of ship time (charter + operating), adjustable

export function mainPowerKw(ship: ShipSpec, v: number): number {
  return ship.pRefKw * Math.pow(Math.max(v, 0) / ship.vRefKn, ship.exponent);
}
/** Fuel burn rate in tonnes per hour at speed v. */
export function fuelRateTph(ship: ShipSpec, v: number): number {
  return (ship.sfocMain * mainPowerKw(ship, v) + ship.sfocAux * ship.pAuxKw) / 1e6;
}

export interface Assumption {
  name: string;
  value: string;
  source: string;
}

export const ASSUMPTIONS: Assumption[] = [
  { name: "Speed of sound", value: "1.5 km/s", source: "Nominal seawater value; true value varies ±1% (simulated as an unknown bias)" },
  { name: "Sound spreading", value: "15·log10(r)", source: "Practical spreading (between spherical and cylindrical)" },
  { name: "Whale call loudness", value: "Humpback 165 · Fin 189 · Blue 189 dB re 1 µPa @ 1 m", source: "Au et al. 2006; Širović et al. 2007" },
  { name: "Detection ranges", value: "Humpback ~20 km · Fin ~50 km · Blue ~100 km", source: "Band noise set to match published ranges (Širović et al. 2007)" },
  { name: "Arrival-time error", value: "20 ms per sensor (adjustable)", source: "Clock sync + multipath; GPS-timed buoys can do better" },
  { name: "Ship noise", value: "186 dB @ 18 kn, +1.5 dB/kn", source: "McKenna et al. 2012 (177-188 dB); slope measured at MBARI MARS (Project 1)" },
  { name: "Disturbance threshold", value: "120 dB re 1 µPa", source: "NMFS Level B behavioural threshold, continuous noise" },
  { name: "Strike lethality", value: "31% @ 10 kn · 78% @ 15 kn", source: "Vanderlaan & Taggart 2007 (very large ships may be lethal at all speeds: Garrison et al. 2025)" },
  { name: "Ship power", value: "40 MW @ 18 kn, P ∝ v³", source: "Illustrative container ship; cube law (Psaraftis & Lagouvardou 2023)" },
  { name: "Fuel", value: "175 g/kWh main · 1.5 MW aux @ 210 g/kWh", source: "Typical 2-stroke main / 4-stroke auxiliary engines (assumption)" },
  { name: "Fuel price", value: "$1,648/t (MGO)", source: "Ship & Bunker, LA/Long Beach, 22 Sep 2026; CARB requires distillate within 24 nm" },
  { name: "CO₂", value: "3.206 t per t fuel", source: "IMO MEPC.364(79)" },
  { name: "Safety target", value: "Cut lethal-strike risk ≥80% (or below 0.01%)", source: "Design choice; if no option can, pick the best cost-benefit using $2M per great whale (Chami et al. 2019, IMF)" },
  { name: "Value of ship time", value: "$3,000/h (adjustable)", source: "Assumption (large container ship charter + operating cost ~$70k/day); used only if arrival is late" },
];

/** Messages between the map (main thread) and the simulation (Web Worker). */
import type { DepthGrid } from "../engine/bathy";
import type { SimOptions } from "../engine/sim";
import type { Decision } from "../engine/decision";
import type { SpeciesId } from "../engine/physics";

export type ToWorker =
  | { type: "init"; options: Partial<SimOptions>; grids: DepthGrid[] }
  | { type: "step"; dt: number }
  | { type: "skip" }; // fast-forward until the next manoeuvre decision (or 8 h)

export interface EllipseLL {
  lon: number;
  lat: number;
  a: number; // km
  b: number; // km
  angle: number; // radians from east
}

export interface SnapWhale {
  id: number;
  species: SpeciesId;
  lon: number;
  lat: number;
  heading: number; // radians (math convention)
  active: boolean;
  conflict: boolean;
  trail: [number, number][];
}

export interface SnapTrack {
  id: number;
  species: SpeciesId;
  lon: number;
  lat: number;
  now: EllipseLL;
  future: EllipseLL[]; // +15, +30, +45 min
  history: [number, number][];
  nFixes: number;
  speedKn: number;
  ageS: number;
}

export interface SnapCall {
  id: number;
  t: number;
  whaleId: number;
  species: SpeciesId;
  lon: number;
  lat: number;
  sensors: number[]; // ids of sensors that heard it
  fix?: EllipseLL;
  errorKm?: number;
  rangeKm: number;
}

export interface SnapZone {
  lon: number;
  lat: number;
  r: number;
  ageS: number;
  species: SpeciesId;
}

export interface Snapshot {
  t: number;
  finished: boolean;
  ship: { lon: number; lat: number; heading: number; speed: number; s: number; progress: number };
  planVersion: number;
  plannedPath?: [number, number][];
  maneuverZone: [number, number][] | null; // lon/lat path of the active conflict zone along the lane
  whales: SnapWhale[];
  tracks: SnapTrack[];
  zones: SnapZone[];
  calls: SnapCall[]; // new since last snapshot
  decisions: Decision[]; // new since last snapshot
  activeDecision: Decision | null;
  stats: {
    calls: number;
    detections: number;
    fixes: number;
    meanErrorKm: number;
    fuelUsed: number;
    baselineFuelSoFar: number;
    scheduledArrival: number;
    etaS: number;
    conflicts: number;
    maneuvers: number;
    decisionsCostUsd: number;
    riskHold: number;
    riskTaken: number;
    policyCostUsd: number;
  };
}

export interface InitReply {
  type: "ready";
  sensors: { lon: Float32Array; lat: Float32Array; phase: Float32Array };
  spacingKm: number;
  route: [number, number][];
  routeLengthKm: number;
  scenario: { encounters: { label: string; s: number; species: SpeciesId }[] };
}

export type FromWorker = InitReply | ({ type: "snap" } & Snapshot);

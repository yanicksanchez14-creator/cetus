/**
 * Scenario design: where the whales are, and which buoys exist in "single buoy" mode.
 * Encounter whales are placed in the real strike hotspots (Rockwood et al. 2017) and steered so they
 * cross the lane at about the time the ship arrives -> every voyage contains real decisions.
 */
import type { LonLat } from "./geo";
import type { SpeciesId } from "./physics";

export interface EncounterDef {
  species: SpeciesId;
  near: LonLat; // approximate crossing point (projected onto the route)
  label: string;
}
export interface ScenarioDef {
  routeId: string;
  encounters: EncounterDef[];
  background: { species: SpeciesId; at: LonLat }[];
  singleBuoys: { at: LonLat; label: string }[];
}

export const HOTSPOTS = [
  { at: [-122.85, 37.62] as LonLat, label: "Greater Farallones", note: "~17% of modeled humpback strike deaths on the US West Coast" },
  { at: [-119.9, 34.18] as LonLat, label: "Santa Barbara Channel", note: "Blue whale strike hotspot" },
  { at: [-118.45, 33.72] as LonLat, label: "LA / Long Beach approach", note: "Highest modeled blue whale strike density" },
];

export const SCENARIOS: Record<string, ScenarioDef> = {
  "oak-lb": {
    routeId: "oak-lb",
    encounters: [
      { species: "humpback", near: [-122.69, 37.56], label: "Gulf of the Farallones" },
      { species: "fin", near: [-121.90, 35.98], label: "Offshore Big Sur" },
      { species: "blue", near: [-119.80, 34.21], label: "Santa Barbara Channel" },
    ],
    background: [
      { species: "humpback", at: [-122.05, 36.80] },
      { species: "humpback", at: [-122.95, 37.75] },
      { species: "fin", at: [-122.95, 36.55] },
      { species: "blue", at: [-120.35, 33.95] },
      { species: "blue", at: [-119.2, 33.80] },
    ],
    singleBuoys: [
      { at: [-122.72, 37.62], label: "SF approach buoy" },
      { at: [-121.90, 36.05], label: "Big Sur buoy" },
      { at: [-119.95, 34.23], label: "Santa Barbara buoy" },
    ],
  },
  "oak-asia": {
    routeId: "oak-asia",
    encounters: [
      { species: "humpback", near: [-123.0, 37.64], label: "Gulf of the Farallones" },
      { species: "fin", near: [-124.6, 37.17], label: "Offshore trans-Pacific lane" },
    ],
    background: [
      { species: "humpback", at: [-122.9, 37.85] },
      { species: "fin", at: [-125.2, 37.3] },
      { species: "blue", at: [-123.8, 37.0] },
    ],
    singleBuoys: [
      { at: [-122.95, 37.66], label: "SF approach buoy" },
      { at: [-124.4, 37.2], label: "Offshore buoy" },
    ],
  },
};

# Cetus: hear the whale, locate it, route around it

**A transparent simulation of whale-aware ship routing off California.** Listeners hear whale calls and locate each
whale from tiny differences in arrival time: real ships (replayed from AIS data) towing hydrophones and carrying thermal
cameras, cabled seafloor stations off ports, or a dense buoy network. A Kalman filter forecasts where the whale will be
when the ship arrives, and a decision engine chooses what a bridge team would do: steer a little around it, or slow down
if steering can't make it safe. Every option shows its strike risk, noise, time, fuel, dollars and CO₂.

![Cetus (Buoys mode) locating a fin whale and shifting the ship 1.5 km around it](docs/network.png)

> **Live demo:** [yanicksanchez14-creator.github.io/cetus](https://yanicksanchez14-creator.github.io/cetus/) You can also open
> `dist/index.html` straight from disk; it is one self-contained file that works offline.

---

## Why

Ship strikes are a leading human cause of death for large whales off the U.S. West Coast: an estimated ~83 blue,
humpback and fin whales in July–December alone (Rockwood et al. 2017). The main lanes into San Francisco and
Los Angeles/Long Beach run through their feeding grounds. Today the tools are **blanket, voluntary slow zones** (10 kn),
and ships follow them only in part. A single listening buoy can only say *"a whale is somewhere within 20–100 km"*,
so the only answer is to slow a whole region.

Cetus asks a simple question: **if we knew where each whale was, how much cheaper and safer could protecting it be?**

## Four modes

| Mode | What listens | What if |
|---|---|---|
| **Ships** (default) | Every real ship off California (AIS replay) tows a hydrophone and carries a thermal camera | ...ships shared what they hear? No new hardware at sea |
| **Mix** | Ships + 10 cabled seafloor stations off major ports (like MBARI's MARS) | ...ports added ~10 stations instead of thousands of buoys? |
| **Buoys** | 500–5,000 moored hydrophone buoys along the lanes (default 3,000) | ...a dense network existed? Best accuracy, costly |
| **Slow zones** | One listening buoy per hotspot: a detection means a 10-kn zone around it (~15 nm here) | What exists today, at its best (every ship obeys) |

## What it shows

| | **Located whales** (Ships / Mix / Buoys) | **Slow zones** (single buoys + blanket zone) |
|---|---|---|
| What the ship knows | Whale position ± tens to hundreds of metres, plus a forecast | "A whale is within ~20–100 km of this buoy" |
| Typical response | Keep 16 kn, steer 1–2 km around the whale (slow down only for groups or late finds) | 10 kn for ~50 km |
| Extra cost per voyage* | **~$80** (Buoys), ~$50 (Ships), ~$530 (Mix) | **~$11.7k**, ~1.5 h late even after catching up |
| Strike-risk cut vs ignoring whales* | **~94%** with Buoys; ~67% with ships alone, ~78% with ships + port stations | **~83%** (slower hits are less deadly, at a high price) |
| Share of a normal trip (~$224k) | ~0.02–0.24% | ~5% |

\*Oakland → Long Beach, 12 random voyages per mode with 8 whales: each strike hotspot (Farallones, Big Sur, Santa Barbara
Channel) gets a whale ~85% of the time (random spot ±25 km along the lane, random time ±25 min), plus 5 more whales. Risk cut
is measured in hindsight on the true whales: those passing within 500 m, weighted by lethality at the ship's speed, vs a ship
that ignored them. These are **simulation outputs under the stated assumptions**, not measured results.

![Slow zones: a whale heard by one buoy forces a 56 km slow zone](docs/todays-practice.png)

## How it works

1. **Listen.** Each call's received level = species source level − transmission loss (15·log₁₀ r plus Thorp absorption at
   the call's frequency); a listener detects it at ~10 dB above the noise. Noise includes background, the own ship's
   engine for towed arrays (500 m astern), and nearby ship noise (20·log r to 1 km, then 15·log r). Sound can't cross land.
   Thermal cameras spot surfacing whales within 6.5 km. Buoys sit on a hexagonal grid (~3.6 km apart at 3,000), only in
   water deeper than 30 m.
2. **Locate.** Time-difference-of-arrival (TDOA) multilateration on the 12 loudest detections (Gauss-Newton/Levenberg-
   Marquardt) gives a position and a 95% error ellipse. Timing error (20 ms default) and an unknown ±0.4% sound-speed bias
   are simulated. Fixes are rejected if they land on land, are too uncertain, fit badly, or lie beyond a listener's range;
   3-listener fixes can refine a track but never start one.
3. **Track.** A constant-velocity Kalman filter per whale (species-aware; duplicates merged) predicts its position with
   uncertainty; the map shows 15 and 30 minutes ahead. Process noise is split sideways (heading wander) and along the path
   (speed changes), each calibrated against the whale model to within ~10% (`tests/forecast.test.ts`).
4. **Decide.** For each whale that could matter (plus any whales near it), every option (hold; shift 1–5 km; slow to
   12 or 10 kn; shift + slow; a blanket slow zone) is scored with the **same forecast**, from where the ship really is:
   - **Lethal-strike risk**: at the closest approach to each whale's forecast, the chance of passing within h is
     Φ((d+h)/σ) − Φ((d−h)/σ); a strike needs the whale within 45 m and near the surface (50%), times P(lethal | speed)
     from Vanderlaan & Taggart (2007): 31% at 10 kn, 78% at 15 kn. (Single-buoy zones use density × swept width.)
   - **Fuel** from the propeller cube law (P ∝ v³). Delays up to 30 min are absorbed by the schedule; beyond that the ship
     speeds up (max 19 kn) to catch up, and that fuel is counted.
   - **Cost** = fuel × price + time lost × $4,200/h (charter hire incl. crew, plus running costs; assumption). **CO₂** = fuel × 3.206.
   - **Noise** = ship source level vs speed → received level at the whale; minutes above the 120 dB NMFS threshold.
   - **Rule (steer first, like a bridge team):** keep 16 kn and take the cheapest course shift that cuts risk ≥ 80% and
     keeps the chance of passing within 500 m under 5%. Only if no shift can (a group of whales, or a whale found too late)
     slow down, choosing the safe option that loses the least time. If nothing works and the whale is >20 min away, keep
     listening; otherwise take the best cost-benefit option (valuing a great whale at $2M, Chami et al. 2019).
5. **Act late, steer gently.** Nothing is committed until ~30 minutes before the danger begins: every call sharpens the
   forecast, so the final shift is usually small. Turns go at most 20° out (25° if the whale is found late) and 10° back;
   if the plan changes mid-manoeuvre, the new track starts from where the ship actually is.
6. **Precaution (Ships/Mix).** If our own towed array hears an unlocated whale nearly dead ahead that sounds close, the
   ship can slow to 13 kn for up to ~6.5 km (your setting: slow down, ask, or hold speed).
7. **Explain.** Every number in the panel and the ship's chat bubble comes from these formulas. Nothing is generated
   by a language model. The **Method** tab lists every assumption and its source.

## Fleet lab

The **Fleet lab** button opens three tools that run voyages headless in a pool of Web Workers:

- **Compare modes**: the same whales in Ships, Mix, Buoys and Slow zones, side by side.
- **Many voyages**: 10–50 voyages per mode with new random whales; averages, ranges and a fair hindsight safety measure
  (true whales passed within 500 m, weighted by lethality at speed, vs a ship that ignored them).
- **Business case**: yearly system and shipping costs, whales saved, cost per whale, what a carrier saves vs slow zones,
  kit payback, a phased rollout plan, and every assumption editable.

Click anywhere on the progress bar to **replay** the voyage; dots mark decisions, close calls and strikes, small ticks mark
whales the ship assessed, and the encounter areas are labelled on the bar.

## Assumptions and sources

| Quantity | Value | Source |
|---|---|---|
| Speed of sound | 1.5 km/s (true value biased ±0.4%) | nominal seawater |
| Spreading loss | 15·log₁₀ r + absorption | practical spreading; Thorp absorption at each call's frequency |
| Call source levels | humpback 165, fin 189, blue 189 dB re 1 µPa @ 1 m | Au et al. 2006; Širović et al. 2007 |
| Ship source level | 186 dB @ 18 kn, +1.5 dB/kn | level: McKenna et al. 2012; slope: assumption (see [related work](#related-work)) |
| Disturbance threshold | 120 dB re 1 µPa | NMFS Level B (continuous noise) |
| Strike lethality | logistic in speed | Vanderlaan & Taggart 2007 |
| Ship | 30 MW @ 18 kn (21 MW, ~96 t fuel/day incl. generators @ 16 kn), cube law; SFOC 175 g/kWh; 1.5 MW aux | illustrative ~14,000 TEU container ship |
| Value of ship time | $4,200/h (~$100k/day) | assumption: charter hire (incl. crew) + running costs |
| Whale response to ships | none (whales don't reliably get out of the way) | cautious; blue whales show only a slow, shallow dive (McKenna et al. 2015) |
| Fuel price | $1,346/t (average of MGO $1,664 and VLSFO $1,028) | Ship & Bunker, LA/Long Beach, 23–24 Sep 2026 |
| CO₂ factor | 3.206 t CO₂/t fuel | IMO MEPC.364(79) |
| Bathymetry | GMRT 200 m / 1 km grids | Ryan et al. 2009, LDEO (CC-BY 4.0) |

### Considered alternative: hull hydrophone + noise cancelling

Instead of a towed hydrophone, a ship could carry two sensors: one on the hull listening for whales and a reference
sensor near the engine/propeller whose signal is subtracted (adaptive noise cancellation, like noise-cancelling
headphones). It can remove much of the ship's steady tonal noise (propeller blade-rate and engine tones; 10–20 dB is a plausible
range), but broadband cavitation and flow noise, which it handles poorly, remains a large share of what is left below
100 Hz, where fin and blue whales call. A hull sensor also
sits ~100 m from the propeller instead of ~500 m (assumed; ≈14 dB louder before cancelling, by spherical spreading). Rough listening ranges at 16 kn:

| Setup | Fin whale | Humpback |
|---|---|---|
| Quiet seafloor station | ~53 km | ~20 km |
| Towed hydrophone, 500 m astern (used in Ships mode) | ~34 km | ~4 km |
| Hull hydrophone + noise-cancelling reference | ~5 km | ~0.5 km |

Distance beats cancellation, so Cetus models a towed hydrophone; combining both (towed array + reference sensor)
would be better still. These ranges are estimates from the model's stated assumptions, not measurements.

## Limitations (please read)

- **How precise are the costs?** The *comparison* between options is solid (same model for all), but individual dollar
  figures are good to roughly ±30–50%: the ship's power curve depends on its size and hull (the model's 21 MW at 16 kn
  fits a large ~14,000 TEU container ship; smaller ships burn less), the propeller-law exponent is 3–4 in reality, fuel
  is priced at the average of MGO ($1,664/t, required within 24 nm of California) and VLSFO (~$1,028/t, used further out), so real costs can be ~24% higher or lower, and the
  biggest swing is the value of the ship's time: slowing saves fuel, so what slowing really costs is schedule, which is hard to price.
- **Localization is more precise here than at sea.** The model varies sound speed, timing and multipath only coarsely;
  real sound bends with temperature layers and bounces off the seafloor, so real-world errors are typically hundreds of
  metres rather than tens.

- **Whales and ships are simulated.** Whale movement is a guided random walk that avoids shallow water. It is not
  fitted to tag data, and calling rates are simplified.
- **Acoustics are simplified:** no ray tracing, sound-speed profile, bathymetric shadowing or multipath. Real
  localization errors will be larger, especially near the coast.
- **A 3,000-buoy network does not exist.** It is a design scenario. Moored hydrophones, power and data links
  would cost far more to build and maintain than this model counts. The Fleet lab's business case gives rough
  yearly costs, but its equipment prices are estimates.
- **Species ID is assumed perfect** (it comes from the call type). Silent whales are invisible to any acoustic system.
- **The strike model** uses a fixed hit width and a lethality curve fitted mainly to smaller vessels. Very large ships
  may be lethal at all speeds.
- **Economics** use one illustrative ship and one fuel price. Lane departures would in reality need VTS coordination.

## Run it locally

You don't need any of this to use Cetus: just open the [live demo](https://yanicksanchez14-creator.github.io/cetus/).
To run or change the code, install [Node.js](https://nodejs.org) (version 18 or newer), then in a terminal:

```bash
git clone https://github.com/yanicksanchez14-creator/cetus.git
cd cetus
```

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # localization, route, simulation and 6-seed robustness tests
npm run build      # -> dist/index.html (one self-contained file, ~4 MB)
```

The map assets in `src/assets/` are pre-built. To regenerate them from raw GMRT grids, put the `.asc` files in
`data/raw/` and run `python tools/prepare_map.py` (needs `pip install numpy pandas pillow matplotlib scikit-image shapely`).

## Project structure

```
src/engine/   physics.ts (acoustics, lethality, fuel) · localize.ts (TDOA) · tracker.ts (Kalman)
              decision.ts (options, risk, cost) · sim.ts (voyage loop) · summary.ts · route.ts · whale.ts · traffic.ts · sensors.ts
src/worker/   simulation runs in a Web Worker so the map stays smooth
src/ui/       deck.gl map, decision panel, chat bubble, summary, replay · lab.ts (Fleet lab: compare, many voyages, business case)
tools/        prepare_map.py (GMRT -> shaded relief, depth grids, contours) · fetch_traffic.py (AIS download)
tests/        vitest suites
```

## Possible next steps

- Replay real AIS ship tracks against real whale sightings and documented strikes.
- Locate real fin/blue whale calls with real seafloor hydrophone arrays (e.g. the OOI Regional Cabled Array).
- Seasons (and gray whale migration), ship-size choice, and silent whales.

## Related work

- **Ocean noise project:** measured ship noise vs humpback song at MBARI's MARS hydrophone (Monterey Bay,
  ~890 m), using the Google/NOAA humpback detector and NOAA AIS data. Across 197 ship passages (Oct–Dec 2018), faster ships lifted the 63 Hz band
  measurably more above background (+0.29 dB/kn, 95% CI 0.17–0.39, for ships ~20 km away). That confirms the direction
  of the speed effect; the source-level slope used here (+1.5 dB/kn) is still an assumption.
- Whale Safe (Benioff Ocean Science Laboratory) already publishes near-real-time whale presence and ship
  cooperation for the Santa Barbara Channel and San Francisco. Cetus explores the next step: **position-level
  localization and per-ship, option-by-option routing decisions**.

---

Built by [Yanick Sanchez](https://github.com/yanicksanchez14-creator) · MIT License · Bathymetry © GMRT/LDEO, CC-BY 4.0

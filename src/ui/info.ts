/** Little ⓘ buttons: plain-English explanations for every number and control. */

export const INFO: Record<string, string> = {
  sensors:
    "<b>Only used in Buoys mode.</b> How many hydrophone buoys float along the shipping lanes. More buoys means they sit closer together, so each whale call is heard by more of them and the whale is located more precisely. Ships and Mix use real ships and port stations instead, and Slow zones uses single buoys. Changing this restarts the voyage.",
  timing:
    "How precisely each hydrophone can tell WHEN a whale call reached it. The whale is located from tiny differences in arrival time between sensors (GPS in reverse). Sound travels 1.5 m per millisecond, so 20 ms ≈ 30 m of uncertainty per sensor pair. GPS clocks are near-perfect (<1 µs); the real error comes from pinpointing the start of the call itself, so it depends on the species: the slider sets it for <b>fin whales</b> (~10-30 ms is realistic), humpback song is timed 4× more precisely (broadband), blue whale calls 2.5× less (long, tonal). Real-world errors are also larger than in this model because sound bends with temperature and bounces off the seafloor.",
  speed:
    "How fast the simulation runs. 300× = 5 simulated minutes per real second. The whole Oakland → Long Beach voyage takes about 23 hours of ship time.",
  skip: "Fast-forward to the next moment the ship has to decide what to do about a whale.",
  mode:
    "<b>Ships:</b> no buoys. Every real ship off California (replayed from AIS data) tows a hydrophone and carries a thermal camera. 3+ ships hearing the same call locate the whale; cameras spot whales surfacing within 6.5 km.<br><b>Mix:</b> Ships plus one quiet seafloor hydrophone off each of 10 major ports (like MBARI's MARS off Monterey).<br><b>Buoys:</b> 500–5,000 hydrophone buoys (default 3,000) locate nearly every whale to within tens of metres (best case, expensive).<br><b>Slow zones (what exists today):</b> a single buoy only knows a whale is within 20-100 km, so the ship slows to 10 kn in a zone ~15 nm around it. Real: East Coast right-whale Slow Zones work like this; California's 10-kn zones are voluntary, seasonal and cover whole regions.<br><br>In the first three the ship keeps 16 kn and steers 1-5 km around located whales, like a real bridge team would; it slows only if no shift is safe (a group of whales, or one found too late).",
  caution:
    "Ships and Mix: our own ship's towed hydrophone is a line of microphones, so it can tell the DIRECTION a call comes from (only a rough distance, from loudness, and not port vs starboard). If it hears a whale nearly dead ahead that sounds close and nobody has located it yet:<br><b>Slow down:</b> drop to 13 kn for up to ~6.5 km, then a 10-min pause (the cost is small and can even be negative: fuel saved vs minutes lost; a hit at 13 kn is less likely to kill).<br><b>Ask me:</b> pause and let you decide, with the cost shown.<br><b>Hold speed:</b> carry on.<br><br>Whether an unlocated whale is really on a collision course is random, like at sea.",
  whales:
    "How many whales are in the area during the voyage: up to 3 hotspot whales (each strike hotspot gets one ~85% of the time, at a random place and time) plus whales along the shipping corridor. <b>Low (3-8):</b> a clean showcase. <b>Middle (~20-40):</b> a busier feeding season. <b>High (~50-60):</b> a crowded summer (the simulation runs slower). These densities are illustrative, not survey counts. Changing this restarts the voyage.",
  coverage:
    "Coverage = how many listeners could hear a whale calling at each point of the route (hydrophones in range, ships' own noise and land blocking included). Locating a whale needs 3+. On the map, faint patches on the route ahead mark blind spots: <b>yellow</b> = only loud fin/blue whales could be located, <b>red</b> = no whale could be (only our ship's direction-only hearing and cameras).",
  route: "Which voyage to simulate. Both follow real shipping lanes through known whale feeding areas and ship-strike hotspots.",
  truth:
    "Shows where the simulated whales really are (orange). Only the simulation knows this. The ship never sees it; it only knows what its listeners (buoys, ships or port stations) have located (yellow ellipses).",
  follow: "Keep the camera centred on the ship. Drag the map to look around; it follows again when you turn this back on.",
  sensorsToggle:
    "Show or hide the listening sensors (buoys or port stations) and the lines to each located call.",
  cine: "Automatically slow the simulation when the ship makes a decision, so you can watch the options being compared.",
  readout:
    "The ship's current speed (knots), heading (compass degrees, 180° = due south) and estimated time of arrival (Day 2, hh:mm).",
  riskKpi:
    "How much the chosen option lowers the chance of a strike that kills this whale, compared with changing nothing.",
  costKpi:
    "Extra money this option costs compared with holding course: extra fuel at $1,346/t plus lost time at $4,200/h (charter hire incl. crew, plus running costs: ~$100k/day, an assumption). “+” means the ship pays more. Slowing down can even save money (less fuel) but costs minutes: schedules, not fuel, are why ships dislike slowing.",
  timeKpi:
    "Extra minutes this option adds. Delays up to 30 min are absorbed by the schedule (the ship arrives a little later); only beyond that does it speed up to catch up.",
  policyLine:
    "What a blanket slow zone would do for this same whale: 10 knots in a zone around where it was heard (~15 nm in this app), because a single buoy can't tell exactly where the whale is. This is how acoustically triggered Slow Zones work for right whales on the US East Coast.",
  options:
    "Every option is scored with the same whale forecast.<br><b>% top right:</b> chance of a strike that kills the whale.<br><b>extra time / fuel / cost / CO₂:</b> compared with holding course (+ = more).<br><b>engine power:</b> how much power drops while slowed; power falls with the cube of speed, so 10 kn needs only ~24% of the power of 16 kn.<br><b>within 500 m:</b> chance of passing that close.<br><b>peak noise:</b> loudest ship noise the whale hears.<br><b>&gt;120 dB:</b> minutes above the US disturbance threshold for continuous noise.",
  voyageRisk:
    "The chance that this voyage kills a whale, added up over every encounter so far. 5% would mean about 1 in 20 such voyages kills a whale if ships ignored whales entirely; 0.5% means 1 in 200.",
  voyageCost:
    "Total extra cost of protecting whales on this voyage.<br><b>Left (measured):</b> what this voyage actually spent: fuel burned vs a ship holding 16 kn over the same distance, plus any time behind schedule ($4,200/h). Includes every course shift, precaution and slow-down, even plans that were later changed.<br><b>Right (estimated):</b> what blanket 10-knot slow zones would cost for the same whales.",
  fuel:
    "Fuel actually burned so far, and how much more (or less) than a ship holding 16 knots over the same distance. Slowing burns less fuel per hour but loses time; the time is counted separately in the cost.",
  trip:
    "To give the extra cost a scale: the whole Oakland → Long Beach trip (~23 h) at a steady 16 kn, for a large ~14,000 TEU container ship: ~93 t of fuel at California prices (ships must burn cleaner, pricier MGO within 24 nm of the coast) plus ~$100k/day of ship time (charter, crew, running costs). Port fees, pilots, tugs and cargo handling are not included. The percentages show how much protecting whales adds.",
  trueRisk:
    "Hindsight, using the TRUE whales, including ones nobody detected: how many passed within 500 m of the ship. “If ignored” is the same whales passed by a ship that held course and speed. The risk cut weights each close pass by how lethal a hit would be at the ship's speed then. Same yardstick for every mode.",
  located:
    "Each whale call heard by 3+ listeners (buoys, ships or stations) gets a position fix. Mean error = average distance between the fix and the whale's true position (known only in the simulation).",
  summary:
    "<b>Lethal-strike risk:</b> the chance this voyage kills a whale, added up over all encounters. “5% if holding course” means about 1 in 20 voyages would kill a whale if the ship ignored them.<br><b>Money:</b> extra fuel and lost time vs ignoring whales: small targeted course shifts vs blanket slow zones, for exactly the same whales.",
};

export const ii = (key: string) =>
  `<button type="button" class="ii" data-info="${key}" aria-label="What is this?">i</button>`;

/** One shared popover; opens on click/tap (and hover on desktop). */
export function initInfo() {
  const pop = document.createElement("div");
  pop.id = "infoPop";
  pop.className = "info-pop";
  pop.hidden = true;
  document.body.appendChild(pop);
  let pinned: HTMLElement | null = null;

  const show = (btn: HTMLElement) => {
    const text = INFO[btn.dataset.info ?? ""];
    if (!text) return;
    pop.innerHTML = text;
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 24);
    pop.style.width = `${w}px`;
    const left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12);
    pop.style.left = `${left}px`;
    const h = pop.offsetHeight;
    const below = r.bottom + 8 + h < window.innerHeight - 8;
    pop.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
  };
  const hide = () => {
    pop.hidden = true;
    pinned = null;
  };

  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".ii");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      if (pinned === btn) return hide();
      pinned = btn;
      show(btn);
    } else if (!(e.target as HTMLElement).closest(".info-pop")) hide();
  }, true);
  document.addEventListener("mouseover", (e) => {
    if (pinned || !matchMedia("(hover: hover)").matches) return;
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".ii");
    if (btn) show(btn);
  });
  document.addEventListener("mouseout", (e) => {
    if (pinned) return;
    if ((e.target as HTMLElement).closest(".ii")) pop.hidden = true;
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && hide());
}

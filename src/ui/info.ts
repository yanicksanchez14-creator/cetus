/** Little ⓘ buttons: plain-English explanations for every number and control. */

export const INFO: Record<string, string> = {
  bizFleet:
    "How many ships join the program and carry a kit (towed hydrophone + thermal camera). Locating a whale needs 3+ listeners, so a lone equipped ship mostly just hears whales; the value grows as more of the fleet joins. The effect at each size comes from simulated voyages where only that share of the real ships is equipped. The share of traffic equipped = (ships − 1) × voyages each ÷ all voyages through the area; the top of the slider is enough ships to carry every voyage. The slider is logarithmic.",
  bizVoy:
    "How many California coastal voyages each equipped ship makes a year (a liner on a weekly loop makes ~25–50). Savings scale with voyages covered, capped at the total voyages through the area.",
  bizStations:
    "Mix only: cabled seafloor hydrophone stations off major ports (like MBARI's MARS). The simulation modeled 10; with fewer, the benefit is scaled linearly between Ships alone (0) and the 10-station network. That scaling is an assumption.",
  bizBuoys:
    "Buoys only: moored hydrophone buoys along the lanes. The risk cut at each count comes from simulated voyages (50, 150, 300 and 500 buoys). Purely theoretical: hundreds of moorings would be costly to service and a hazard at sea.",
  bizCompliance:
    "The share of ships that actually slow to 10 knots in today's slow zones. California's zones are voluntary: in the 2023 season, fleet-wide cooperation was 69.9% of distance in the San Francisco zone and 63.5% in Southern California (Whale Safe / Benioff Ocean Science Lab), so 65% is the default. Only ships that slow down today lose time, so only they can save money by switching; a ship that ignores slow zones today saves nothing, though its whales are still protected. Set 100% to model mandatory zones.",
  bizSeason:
    "Slow zones are seasonal, not year-round: California asks ships to slow down from about May 1 to December 15, when blue, humpback and fin whales feed off the coast. That is about 7.5 of 12 months, so about 62% of a year's voyages fall inside the season. Voyages outside it don't slow down today, so they have nothing to save.",
  bizNPV:
    "Net present value: the set-up cost now, plus each year's net benefit discounted back to today at the discount rate, over the horizon. Above $0 means the program earns more than the money would elsewhere.",
  bizNet:
    "Each year: slow-down costs avoided on voyages that would have complied, minus equipment servicing, stations or buoys, and the data platform. Set-up costs are not in this line (see NPV and payback).",
  bizPayback:
    "How long until the discounted yearly net benefits repay the set-up cost. 'Never' means it doesn't repay within the horizon at this scale.",
  bizIRR:
    "Internal rate of return: the discount rate at which NPV would be exactly zero. It's green when it beats the discount rate you set.",
  bizWhales:
    "Whale deaths a year (California, no protection) × the strike-risk cut at this scale × the share of voyages the program covers. Compared with doing nothing, not with slow zones.",
  bizPerWhale:
    "The yearly all-in cost (set-up spread over the horizon at the discount rate, plus running costs, minus savings) divided by whales saved a year. 'Pays for itself' means savings exceed costs.",
  bizCO2:
    "Fuel burned vs complying with slow zones, × 3.206 t CO₂ per t of fuel. Slow zones save fuel in the zone but make ships speed up (up to 19 kn) to recover lost time, which usually costs more.",
  bizSZ:
    "Every complying voyage loses time (valued at $4,200/h) and some net fuel in each slow zone it meets. Total = voyages × share in slow-zone season × share that complies × simulated cost per voyage.",
  bizValue:
    "A great whale's lifetime economic value, mostly from the carbon it helps capture plus tourism and fishing benefits: about $2 million (Chami et al., IMF, 2019). Used only to express whales saved in dollars; it's not in the NPV.",
  bizCash:
    "Year 0 is the set-up cost (negative). Each year adds that year's net benefit, discounted. Where the line crosses $0 is the discounted payback.",
  bizScale:
    "Same assumptions, different program size. Fixed costs (the data platform, stations) need enough voyages to spread over, and effectiveness grows with the number of listeners, so there is a break-even size.",
  bizRegion:
    "About 2,500 large commercial vessels transit the Santa Barbara Channel each year (Santa Barbara Independent, 2026). The simulated route passes through it.",
  bizDeaths:
    "~83 blue, humpback and fin whales are estimated killed by ships off the whole US West Coast in July–December alone (Rockwood et al. 2017), and gray whales are struck too. About three-quarters of modeled deaths fall off central and southern California. The California figure of 60 is my estimate.",
  bizKit:
    "Towed hydrophone array + thermal camera + install, per ship, and yearly servicing. An assumption: vendors don't publish prices.",
  bizStation:
    "A cabled seafloor hydrophone node off a port, installed and run. An assumption; for scale, the whole MARS observatory (52 km cable, science node) cost $13.5M in 2008 (MBARI). A hydrophone-only node is simpler.",
  bizBuoy:
    "A moored real-time acoustic buoy, installed, and yearly servicing at sea. An assumption.",
  bizPlatform:
    "Shared data platform and 24/7 operations that fuse detections and send them to ships (like Whale Safe today). A fixed yearly cost, an assumption.",
  bizUptake:
    "Buoys only: a public network tells every ship where the whales are, but acting on it is voluntary. Steering 1–2 km costs little, so most ships would, but not all. 90% is an assumption.",
  bizDiscount:
    "The horizon is the equipment life. The discount rate is the cost of money: 7% is a typical real rate for infrastructure appraisals.",
  sensors:
    "<b>Only used in Buoys mode.</b> How many hydrophone buoys float along the shipping lanes (50–500; 500 means one every ~9 km). More buoys means they sit closer together, so each whale call is heard by more of them and the whale is located more precisely. Ships and Mix use real ships and port stations instead, and Slow zones uses single buoys. Changing this restarts the voyage.",
  timing:
    "How precisely each hydrophone can tell WHEN a whale call reached it. The whale is located from tiny differences in arrival time between sensors (GPS in reverse). Sound travels 1.5 m per millisecond, so 20 ms ≈ 30 m of uncertainty per sensor pair. GPS clocks are near-perfect (<1 µs); the real error comes from pinpointing the start of the call itself, so it depends on the species: the slider sets it for <b>fin whales</b> (~10-30 ms is realistic), humpback song is timed 4× more precisely (broadband), blue whale calls 2.5× less (long, tonal). Real-world errors are also larger than in this model because sound bends with temperature and bounces off the seafloor.",
  speed:
    "How fast the simulation runs. 300× = 5 simulated minutes per real second. The whole Oakland → Long Beach voyage takes about 23 hours of ship time.",
  skip: "Fast-forward to the next moment the ship has to decide what to do about a whale.",
  mode:
    "<b>Ships:</b> no buoys. Every real ship off California (replayed from AIS data) tows a hydrophone and carries a thermal camera. 3+ ships hearing the same call locate the whale; cameras spot whales surfacing within 6.5 km.<br><b>Mix:</b> Ships plus one quiet seafloor hydrophone off each of 10 major ports (like MBARI's MARS off Monterey).<br><b>Buoys:</b> 50–500 hydrophone buoys (default 500) locate nearly every whale to within tens of metres. Purely theoretical: hundreds of moored buoys would be very costly and hard to maintain, and would add marine debris, entanglement and navigation hazards.<br><b>Slow zones (what exists today):</b> a single buoy only knows a whale is within 20-100 km, so the ship slows to 10 kn in a zone ~15 nm around it. Real: East Coast right-whale Slow Zones work like this; California's 10-kn zones are voluntary, seasonal and cover whole regions.<br><br>In the first three the ship keeps 16 kn and steers 1-5 km around located whales, like a real bridge team would; it slows only if no shift is safe (a group of whales, or one found too late).",
  caution:
    "Ships and Mix: our own ship's towed hydrophone is a line of microphones, so it can tell the DIRECTION a call comes from (only a rough distance, from loudness, and not port vs starboard). If it hears a whale nearly dead ahead that sounds close and nobody has located it yet:<br><b>Slow down:</b> drop to 13 kn for up to ~6.5 km, then a 10-min pause (the cost is small and can even be negative: fuel saved vs minutes lost; a hit at 13 kn is less likely to kill).<br><b>Ask me:</b> pause and let you decide, with the cost shown.<br><b>Hold speed:</b> carry on.<br><br>This setting is only for whales heard but NOT located. Once a whale is located, the ship's decision engine handles it (steer first, slow if it must), whatever you pick here.<br><br>Whether an unlocated whale is really on a collision course is random, like at sea.",
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

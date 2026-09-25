/** Right-hand panel: decision (options, pros/cons), voyage report, and method + sources. */
import type { Decision, OptionResult } from "../engine/decision";
import { cutPct } from "../engine/decision";
import { ASSUMPTIONS, SPECIES } from "../engine/physics";
import type { Snapshot } from "../worker/protocol";
import { ii } from "./info";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const clock = (t: number) => {
  const start = 6 * 3600; // departure 06:00
  const tt = start + t;
  const day = Math.floor(tt / 86400) + 1;
  const h = Math.floor((tt % 86400) / 3600);
  const m = Math.floor((tt % 3600) / 60);
  return `Day ${day} · ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
const usd = (v: number) => `${Math.round(v) < 0 ? "−" : Math.round(v) > 0 ? "+" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
const pct = (p: number) => (p < 0.0001 ? "<0.01%" : p < 0.01 ? `${(p * 100).toFixed(2)}%` : `${(p * 100).toFixed(1)}%`);
const signed = (v: number, d = 1, unit = "") => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}${unit}`;

function optionCard(o: OptionResult, chosen: OptionResult, hold: OptionResult, maxRisk: number): string {
  const isChosen = o.id === chosen.id;
  const cls = ["opt", isChosen ? "chosen" : "", o.id === "policy" ? "policy" : "", o.valid ? "" : "invalid"].join(" ");
  const tags = [
    isChosen ? `<span class="tag tag-chosen">${!o.meetsTarget && o.id !== "hold" && o.id !== "policy" ? "BEST AVAILABLE" : "CHOSEN"}</span>` : "",
    o.id === "policy" ? `<span class="tag tag-policy">${chosen.id === "policy" ? "WHAT EXISTS TODAY" : "SLOW ZONE · REFERENCE"}</span>` : "",
    !isChosen && !o.meetsTarget && o.valid && o.id !== "hold" && o.id !== "policy" ? '<span class="tag tag-unsafe">BELOW TARGET</span>' : "",
  ].join("");
  const w = maxRisk > 0 ? Math.max(2, (o.lethalRisk / maxRisk) * 100) : 0;
  return `<div class="${cls}">
    <div class="opt-top"><span class="opt-name">${esc(o.label)}</span>${tags}<span class="opt-risk" title="Probability of a lethal strike">${pct(o.lethalRisk)}</span></div>
    <div class="bar" title="Lethal-strike risk"><i style="width:${w}%"></i></div>
    <div class="opt-grid">
      <div><span class="v">${o.extraMinutes < 0.5 ? "0" : signed(o.extraMinutes, 0)} min</span><span class="l">extra time</span></div>
      <div><span class="v">${Math.abs(o.fuelDeltaT) < 0.05 ? "0.0" : signed(o.fuelDeltaT, 1)} t</span><span class="l">extra fuel</span></div>
      <div><span class="v">${Math.abs(o.costDeltaUsd) < 1 ? "$0" : usd(o.costDeltaUsd)}</span><span class="l">extra cost</span></div>
      <div><span class="v">${o.powerCutPct < 0.5 ? "0" : "−" + Math.round(o.powerCutPct)}%</span><span class="l">engine power</span></div>
      <div><span class="v">${pct(o.pWithin500m)}</span><span class="l">within 500 m</span></div>
      <div><span class="v">${Math.abs(o.co2DeltaT) < 0.05 ? "0.0" : signed(o.co2DeltaT, 1)} t</span><span class="l">extra CO₂</span></div>
      <div><span class="v">${Math.round(o.peakNoiseDb)} dB</span><span class="l">peak noise</span></div>
      <div><span class="v">${Math.round(o.minutesAbove120)} min</span><span class="l">&gt;120 dB</span></div>
    </div>
    <div class="pc">${o.pros.map((p) => `<span class="p">${esc(p)}</span>`).join("")}${o.cons.map((c) => `<span class="c">${esc(c)}</span>`).join("")}</div>
  </div>`;
}

export function renderDecision(el: HTMLElement, d: Decision | null, history: Decision[]) {
  if (!d) {
    el.innerHTML = `<div class="empty"><div class="pulse"></div><b>Holding course · listening…</b><br/>No located whale is on a collision course.
      <br/><span class="small">Every whale call heard by 3+ listeners (buoys, ships or port stations) is located and tracked (not in Slow zones, where one
      buoy can't locate); ships' thermal cameras also spot whales surfacing within 6.5 km. A whale nobody has heard or seen yet can't be avoided. When a tracked whale is likely to be
      near the lane as the ship arrives, the options appear here.</span></div>${historyHtml(history)}`;
    return;
  }
  const c = d.chosen;
  const h = d.hold;
  const p = d.policy;
  const sp = SPECIES[d.species];
  const red = h.lethalRisk > 0 ? 1 - c.lethalRisk / h.lethalRisk : 0;
  const maxRisk = Math.max(...d.options.map((o) => o.lethalRisk));
  const order = ["hold", "shift", "yield", "early2", "early4", "early7", "slow12", "slow10", "turn2", "turn5", "turn2slow12", "policy"];
  const opts = [...d.options].sort((a, b) => (a.id === c.id ? -1 : b.id === c.id ? 1 : order.indexOf(a.id) - order.indexOf(b.id)));
  el.innerHTML = `
    <div class="dec-head"><span class="sp-badge">${esc(sp.name)}</span><span class="small muted">${d.beliefKind === "track" ? "located & tracked" : "heard by one buoy · position unknown"}</span><span class="dec-time mono">${clock(d.t)}</span></div>
    <div class="dec-title">${esc(c.id === "policy" ? "Blanket slow zone (what exists today)" : d.waitForInfo ? "Keep listening · hold course for now" : c.label)}</div>
    <p class="dec-expl">${esc(d.explanation)}</p>
    <div class="kpis">
      <div class="kpi ${red > 0.5 ? "good" : ""}"><div class="v">${c.id === "hold" ? "—" : "−" + cutPct(red * 100) + "%"}</div><div class="l">lethal-strike risk ${ii("riskKpi")}</div></div>
      <div class="kpi ${c.costDeltaUsd > 2000 ? "bad" : ""}"><div class="v">${Math.abs(c.costDeltaUsd) < 1 ? "$0" : usd(c.costDeltaUsd)}</div><div class="l">extra cost vs holding course ${ii("costKpi")}</div></div>
      <div class="kpi"><div class="v">${c.extraMinutes < 0.5 ? "0" : "+" + Math.round(c.extraMinutes)} min</div><div class="l">${c.catchUpFuelT > 0.05 ? "partly made up later" : c.extraMinutes >= 0.5 ? "arrives later" : "no delay"} ${ii("timeKpi")}</div></div>
    </div>
    ${c.id !== "policy" && p ? `<div class="small muted" style="margin:-6px 0 10px">A slow zone here: <b style="color:var(--policy)">${esc(p.label.toLowerCase())}</b> → ${usd(p.costDeltaUsd)}, ${Math.round(p.extraMinutes)} min. ${ii("policyLine")}</div>` : ""}
    <div class="sec-title">Options compared (same whale forecast for all) ${ii("options")}</div>
    ${opts.map((o) => optionCard(o, c, h, maxRisk)).join("")}
    <div class="src">Risk = chance the ship passes within 45 m of the whale at its closest approach (from the forecast's spread), × chance it's near
      the surface, × P(lethal | speed). Choice: keep 16 kn and take the cheapest course shift that cuts risk ≥80% with &lt;5% chance of passing within
      500 m; slow down only if no shift can (a group, or found too late), losing the least time. All figures are <b>extra</b> vs holding course
      (+ = the ship pays more), including any catching up beyond the 30-min schedule slack.</div>
    ${historyHtml(history)}`;
}

function historyHtml(history: Decision[]): string {
  if (!history.length) return "";
  const items = [...history].reverse().slice(0, 12).map((d) => {
    const who = SPECIES[d.species].name.replace(" whale", "");
    const what = d.chosen.id === "hold" ? "hold course (clear)" : d.chosen.id === "policy" ? d.chosen.label.toLowerCase() : d.chosen.label.toLowerCase();
    return `<div class="hist-item"><span class="when mono">${clock(d.t).slice(-5)}</span><span>${esc(who)} · ${esc(what)}${d.chosen.id !== "hold" ? ` · ${usd(d.chosen.costDeltaUsd)}` : ""}</span></div>`;
  });
  return `<div class="sec-title">Decision log</div><div class="history">${items.join("")}</div>`;
}

export function renderVoyage(el: HTMLElement, s: Snapshot, mode: "network" | "ships" | "mix" | "single", sensors: number, spacingKm: number, sigmaMs: number, traffic?: { ships: number; date: string; synthetic: boolean }) {
  const st = s.stats;
  const late = (st.etaS - st.scheduledArrival) / 60;
  const risk0 = st.riskHold;
  const risk1 = st.riskTaken;
  const net = mode !== "single";
  el.innerHTML = `
    <div class="sec-title" style="margin-top:0">This voyage so far</div>
    <table class="tbl">
      <tr><td>Monitoring</td><td>${mode === "ships" || mode === "mix" ? `<b style="color:var(--cyan)">${mode === "mix" ? "Mix: ships + 10 port stations" : "Ships as sensors"}</b> · ${traffic?.ships ?? "?"} ${traffic?.synthetic ? "placeholder" : "real"} ships (AIS ${traffic?.date ?? ""}) · towed hydrophone + thermal camera · ${st.shipsContributing} contributed, ${st.sightings} camera sightings` : net ? `<b style="color:var(--cyan)">Buoy network</b> · ${sensors.toLocaleString()} buoys · ~${spacingKm.toFixed(1)} km apart` : `<b style="color:var(--policy)">Slow zones</b> (what exists today) · ${sensors} single buoys`}</td></tr>
      <tr><td>Whale calls heard</td><td class="mono">${st.calls.toLocaleString()} calls · ${st.detections.toLocaleString()} detections</td></tr>
      ${net ? `<tr><td>Whales located</td><td class="mono">${st.fixes.toLocaleString()} fixes · mean error ${isFinite(st.meanErrorKm) ? Math.round(st.meanErrorKm * 1000) + " m" : "—"} <span class="muted">(timing error ${sigmaMs} ms)</span> ${ii("located")}</td></tr>` : `<tr><td>Whales located</td><td>Not possible with one buoy per area</td></tr>`}
      <tr><td>Encounters</td><td class="mono">${st.conflicts} assessed · ${st.maneuvers} manoeuvres</td></tr>
      <tr><td>Lethal-strike risk ${ii("voyageRisk")}</td><td class="mono">${pct(risk0)} if holding course → <b style="color:var(--good)">${pct(risk1)}</b>${net ? `<br><span class="muted">slow zones: ${pct(st.riskPolicy)}</span>` : ""}</td></tr>
      <tr><td>Fuel ${ii("fuel")}</td><td class="mono">${st.fuelUsed.toFixed(1)} t used · ${signed(st.actualFuelDeltaT, 1)} t vs holding 16 kn${Math.abs(st.behindMin) >= 1 ? `<br><span class="muted">${st.behindMin > 0 ? `${Math.round(st.behindMin)} min behind schedule (up to 30 min is absorbed by the schedule; beyond that the ship speeds up)` : `${Math.round(-st.behindMin)} min ahead of schedule`}</span>` : ""}</td></tr>
      <tr><td>Arrival</td><td class="mono">${Math.abs(late) < 2 ? "on schedule" : late > 0 ? `${Math.round(late)} min late` : `${Math.round(-late)} min early`}</td></tr>
    </table>
    <div class="sec-title">Extra cost of protecting whales on this voyage ${ii("voyageCost")}</div>
    <div class="cmp">
      <div class="cmp-card net"><h4 style="color:var(--cyan)">${net ? (mode === "ships" ? "Ships as sensors" : mode === "mix" ? "Mix: ships + stations" : "Buoy network") : "Targeted (if located)"}</h4><div class="big">${net ? usd(st.decisionsCostUsd) : "—"}</div><div class="small muted">${net ? `small, targeted changes · strike risk ${pct(risk1)}` : "switch to Ships, Mix or Buoys to compare"}</div></div>
      <div class="cmp-card pol"><h4 style="color:var(--policy)">Slow zones</h4><div class="big">${usd(net ? st.policyCostUsd : st.decisionsCostUsd)}</div><div class="small muted">blanket 10-kn slow zones · strike risk ${pct(net ? st.riskPolicy : risk1)}</div></div>
    </div>
    ${tripLine(st, net)}
    <div class="src"><b>Measured, not estimated:</b> the left figure is what this voyage has actually spent so far: fuel burned vs a ship holding 16 kn over the same distance, plus any time behind schedule (valued at ${usd(st.timeCostPerHour)}/h: charter, crew, running costs). It includes every course shift, precaution and slow-down. The right figure is the engine's estimate for blanket slow zones on the same whales. Illustrative container ship (see Method).</div>`;
}

/** Tiny line: the whole trip's normal cost vs this trip, so the extra cost has a scale. */
export function tripLine(st: Snapshot["stats"], net: boolean): string {
  const k = (v: number) => `$${(v / 1000).toLocaleString("en-US", { maximumFractionDigits: v < 1e6 ? 0 : 0 })}k`;
  const pctOf = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs((100 * x) / st.normalTripUsd).toFixed(x !== 0 && Math.abs((100 * x) / st.normalTripUsd) < 0.1 ? 2 : 1)}%`;
  return `<div class="trip-line mono">Whole trip, normal: ${k(st.normalTripUsd)} <span class="muted">(fuel ${k(st.normalTripFuelUsd)} + ship time ${k(st.normalTripUsd - st.normalTripFuelUsd)})</span>
    · this trip so far: <b>${pctOf(st.decisionsCostUsd)}</b>${net ? ` · slow zones: <span style="color:var(--policy)">${pctOf(st.policyCostUsd)}</span>` : ""} ${ii("trip")}</div>`;
}

/** A numbered section: "1." + title, a one-line summary, then the body. */
const acc = (n: string, title: string, teaser: string, body: string, _open = false) =>
  `<section class="doc-sec" id="sec-${title.toLowerCase().replace(/[^a-z]+/g, "-")}"><header class="doc-h"><span class="doc-num">${n}.</span><div><h3>${title}</h3><p class="doc-kicker">${teaser}</p></div></header><div class="doc-b">${body}</div></section>`;

const FLOW = `<ol class="flow">
  <li><b>Listen</b><span>Hydrophones hear the call.</span></li>
  <li><b>Locate</b><span>Arrival-time differences give its position.</span></li>
  <li><b>Track</b><span>A filter forecasts where it's heading.</span></li>
  <li><b>Decide</b><span>Steer, slow down or hold course.</span></li>
</ol>`;

export function renderStory(el: HTMLElement) {
  el.innerHTML = `<div class="method story">
    <div class="story-hero">
      <div class="eyebrow">Why Cetus exists</div>
      <h2>Ships can't avoid whales they can't find.</h2>
      <p>California's busiest shipping lanes run straight through the feeding grounds of blue, fin and humpback whales.
        Cetus asks: <b>if we could locate each whale, how much safer and cheaper could protecting it be?</b></p>
      <div class="hero-nums">
        <div><b>~83</b><span>whales killed by ships, US West Coast, each Jul–Dec</span></div>
        <div><b>+0.04%</b><span>trip cost to steer around whales a dense buoy network locates</span></div>
        <div><b>+5%</b><span>trip cost of blanket slow zones</span></div>
      </div>
    </div>

    <div class="tldr"><b>The short version</b>
      <ul><li>Today, protection is <b>blanket and voluntary</b>: slow a whole region, whether a whale is there or not.</li>
        <li>If sensors could <b>locate</b> each whale, a ship could steer 1–2 km around it and keep its speed.</li>
        <li>With a dense sensor network the simulation cut strike risk by <b>~94% for about $80 per voyage</b>. Slow zones cut it ~83% for about <b>$11,700</b>.</li>
        <li>Ships alone cut it ~67%: their own noise and the gaps between them leave many whales, most humpbacks, unlocated.</li></ul></div>

    <nav class="doc-toc">${["The problem", "What ships do today", "The idea", "What would a real captain do?", "Four what-ifs", "What the simulation shows"]
      .map((t) => `<a href="#sec-${t.toLowerCase().replace(/[^a-z]+/g, "-")}">${t.replace("What would a real captain do?", "A captain's view").replace("What the simulation shows", "Results")}</a>`).join("")}</nav>

    ${acc("1", "The problem", "Too many whales die, and most sink unseen", `
      <div class="stat-row">
        <div class="stat"><b>~18</b><span>blue whales</span></div>
        <div class="stat"><b>~22</b><span>humpbacks</span></div>
        <div class="stat"><b>~43</b><span>fin whales</span></div>
      </div>
      <p class="small muted" style="margin-top:4px">Estimated killed by ships off the US West Coast in just July–December each year (Rockwood et al. 2017).</p>
      <p>That's <b>7.8×, 2.0× and 2.7×</b> the level US law considers sustainable. Most struck whales sink, so strandings show only a fraction.
        About three-quarters of modeled deaths fall in just 10% of US West Coast waters, mostly off central and southern California, and the risk per km² is highest in the shipping lanes into <b>San Francisco</b> and <b>Los Angeles / Long Beach</b>.</p>`, true)}

    ${acc("2", "What ships do today", "Voluntary slow zones and whale alerts", `
      <p><b>Nobody knows exactly where the whales are.</b> Lookouts see whales only at the surface, close by, in daylight. A listening buoy hears a
        call but can only say <em>"a whale is somewhere within 20–100 km"</em>. So today's tools are broad:</p>
      <div class="cards">
        <div class="card"><b>Seasonal slow zones</b><span>California asks ships to sail ≤10 knots through set zones from May to January, whale or not.
          Voluntary, with rewards; 787 ships took part in 2025. By the lethality curve used here (Vanderlaan &amp; Taggart 2007), slowing from 16 to 10 knots cuts the chance a strike kills from ~84% to ~31%.</span></div>
        <div class="card"><b>Triggered slow zones</b><span>US East Coast: a right whale seen or heard by a buoy triggers a temporary voluntary 10-knot zone around it.
          This is what Cetus's <b>Slow zones</b> mode simulates, at its best (every ship obeys).</span></div>
        <div class="card"><b>Whale alerts</b><span>Systems like Whale Safe publish where whales were recently heard or seen. Nothing requires a ship to act.</span></div>
      </div>
      <p class="callout">Slowing down actually <b>saves fuel</b>. What it costs is <b>time</b>, and ships run on tight schedules. That's why not every ship slows.</p>`)}

    ${acc("3", "Don't whales just move?", "Mostly, no", `
      <p>Tagged blue whales off Southern California reacted to approaching ships only with a slow, shallow dive, and some didn't react at all
        (McKenna et al. 2015). A ship's hull blocks its own sound ahead of the bow, so a whale in front hears it poorly, and a feeding whale is
        focused on krill. Humpbacks react a bit more. Cetus assumes whales <b>don't</b> reliably get out of the way, the cautious assumption.</p>`)}

    ${acc("4", "The idea", "Locate each whale, then make a small change", `
      <p>Like GPS in reverse: a whale call reaches each sensor at a slightly different time, and those differences give its position.</p>
      ${FLOW}
      <p>With a position and a forecast, a ship can make a <b>small, targeted change</b> exactly where needed instead of slowing a whole region.</p>`)}

    ${acc("5", "What would a real captain do?", "Steer a little, early; slow only for a crowd", `
      <div class="cards">
        <div class="card"><b>Steer a little, early</b><span>A few degrees on autopilot is easy and keeps the schedule. For a single whale Cetus keeps 16 knots and
          shifts 1–2 km (5 km at most), about half an hour before the whale.</span></div>
        <div class="card"><b>Slow down for a crowd</b><span>When several whales feed together, dodging one can mean steering toward another. Then a short, local
          slow-down is sensible. It's also the fallback when a whale is found too late.</span></div>
        <div class="card"><b>Stay in the lanes</b><span>Lanes keep big ships apart. Shifts beyond ~2 km leave the lane and need a radio call, so the smallest safe shift wins.</span></div>
      </div>`)}

    ${acc("6", "Four what-ifs", "Ships · Mix · Buoys · Slow zones", `
      <div class="mode-grid">
        <div class="mode-card m-ships"><b>Ships</b><span>Every real ship tows a hydrophone and carries a thermal camera, and they share what they hear. No new hardware at sea.</span></div>
        <div class="mode-card m-mix"><b>Mix</b><span>Ships plus one quiet seafloor station off each of 10 ports, like MBARI's MARS. ~10 stations instead of thousands of buoys.</span></div>
        <div class="mode-card m-buoys"><b>Buoys</b><span>A dense hydrophone network along the lanes. Best accuracy, but thousands of moorings are costly and a hazard.</span></div>
        <div class="mode-card m-today"><b>Slow zones</b><span>What exists today, at its best: a single buoy hears a whale; the ship slows to 10 knots in a zone around it (~15 nm here).</span></div>
      </div>`)}

    ${acc("7", "What the simulation shows", "Locating whales well is both the cheapest and the safest", `
      <div class="res-grid">
        <div class="res"><b>−94%</b><span>strike risk with a dense buoy network, for ~$80 extra per voyage.</span></div>
        <div class="res bad"><b>−83%</b><span>with slow zones, for ~$11,700 extra and ~1.5 hours late.</span></div>
        <div class="res warn"><b>−67%</b><span>with ships alone (~$50 per voyage): many whales are never located.</span></div>
        <div class="res warn"><b>−78%</b><span>with ships plus 10 port stations (Mix), for ~$530 per voyage.</span></div>
      </div>
      <ul class="findings">
        <li><b>Ships alone leave gaps.</b> A ship's own engine noise means it hears a humpback only ~4 km away.</li>
        <li><b>Mix closes most of them</b> with no surface buoys. <b>Big Sur</b> is the big blind spot: no port, no station. Two or three stations there would close it.</li>
        <li><b>Humpbacks stay the hardest.</b> Their song is quiet; cameras and a short precautionary slow-down protect them.</li>
      </ul>
      <p class="small muted">Averages over 12 test voyages per mode with 8 whales; small samples, so treat them as rough (the Fleet lab runs more).
        Fin and blue whales can be located along ~51% of the route with Ships, ~79% with Mix and ~99% with Buoys; humpbacks almost only with Buoys. Simulation results under the assumptions in Method, not field measurements.
        Whales are simulated; in Ships and Mix the ship traffic is real (AIS, 14–15 Aug 2024).</p>`)}

    ${acc("8", "Try it yourself", "Fleet lab and replay", `
      <div class="cards">
        <div class="card"><b>Fleet lab</b> <span class="muted">(top bar)</span><span>Run the same whales in all four modes, run dozens of voyages for averages,
          and see the business case: yearly costs, whales saved, what a shipping company saves, and a rollout plan.</span></div>
        <div class="card"><b>Replay</b><span>Click anywhere on the progress bar to go back to that moment. Dots on the bar are the ship's decisions, close calls and
          strikes; small ticks are the whales it assessed along the way.</span></div>
      </div>`)}

    ${acc("9", "Why \"Cetus\"?", "The whale in the sky", `
      <p>Cetus is Latin (from Greek <em>kētos</em>) for a whale or sea monster. It's the name of a large constellation, <em>the Whale</em>, and the root
        of <em>cetacean</em>, the scientific word for whales and dolphins.</p>`)}

    ${acc("10", "Related work", "Ship noise at MARS", `
      <p class="small">A companion project measured ship noise at MBARI's MARS seafloor hydrophone in Monterey Bay: faster ships were measurably
        louder (+0.29 dB per knot, for ships ~20 km away). That real-data result backs the speed-noise link this simulation assumes.</p>`)}

    <div class="src" style="margin-top:12px">Sources: Rockwood, Calambokidis & Jahncke 2017, PLOS ONE (mortality, hotspots) · Protecting Blue Whales and Blue Skies
      2025 season results (Santa Barbara County APCD) · Santa Barbara Independent 2026 (traffic, cooperation) · NOAA right whale Slow Zones ·
      McKenna et al. 2015, Endangered Species Research (blue whale responses) · Vanderlaan & Taggart 2007 (lethality vs speed).</div>
  </div>`;
}

export function renderMethod(el: HTMLElement) {
  const R = (a: string, b: string, c: string) => `<tr><td>${a}</td><td class="mono">${b}</td><td class="mono">${c}</td></tr>`;
  el.innerHTML = `<div class="method">
    <div class="story-hero">
      <div class="eyebrow">Method</div>
      <h2>How every number is made</h2>
      <p>Everything on screen comes from the formulas below. No language model makes any decision, and every assumption is listed with its source.</p>
    </div>
    ${FLOW}
    <div class="chips"><span>3+ listeners to locate</span><span>act ~30 min ahead</span><span>steer first, slow as fallback</span><span>risk cut ≥ 80%</span></div>

    ${acc("1", "Listen", "Who hears a call, and from how far", `
      <p>Every call has a species-specific loudness at the source that fades with distance (<code>15·log₁₀ r</code>, plus absorption, which
        matters most for the higher-pitched humpback song). A listener hears it if
        the signal is at least <b>10 dB</b> above the noise: background sea noise, nearby ships, and for ship-borne hydrophones the ship's own
        engine and propeller. Sound <b>can't cross land</b> or very shallow water; cameras can't see across it either.</p>
      <table class="tbl small"><tr><td></td><td><b>Quiet station / buoy</b></td><td><b>Ship at 16 kn</b></td></tr>
        ${R("Humpback", "~20 km", "~4 km")}${R("Fin whale", "~53 km", "~34 km")}${R("Blue whale", "~95 km", "~42 km")}
        ${R("Thermal camera", "n/a", "≤6.5 km (surface)")}</table>`, true)}

    ${acc("2", "Locate", "GPS in reverse, with honest errors", `
      <p>A call reaches each listener at a slightly different time. Solving <code>tᵢ = t₀ + |p − sᵢ| / c</code> for the position <code>p</code> and
        call time <code>t₀</code> (least squares, 12 best listeners) gives a position and a 95% error ellipse. Needs <b>3+ listeners</b>. The speed of sound
        is only roughly known and every arrival time has a random error; both are simulated.</p>
      <p class="callout">A fix is thrown out if it lands on land, is too uncertain (&gt; ~3 km), fits the arrival times badly, or lies beyond the hearing range of a
        listener that heard it. With only 3 listeners the math can land on a wrong "mirror" position, so those fixes may refine a known whale but never create one.</p>`)}

    ${acc("3", "Track", "One whale, one forecast", `
      <p>A Kalman filter per whale combines fixes, estimates speed and heading (never faster than the species can swim) and predicts where the whale
        will be. The forecast's uncertainty has a shape: <b>sideways</b> it grows with how much a whale's heading wanders, <b>along its path</b> with how
        much its speed changes. Both are calibrated against the whale model to within ~10%: after an hour a 2-knot whale can be ~1.4 km off sideways
        and ~1.8 km along its path; a 6-knot whale ~4 km sideways and ~3 km along.</p>
      <p>A track only takes calls of its own species, and two tracks on top of each other are merged, so one whale shows as one whale. One thermal-camera
        sighting is enough to act on.</p>`)}

    ${acc("4", "Decide", "Steer first; slow only when steering can't", `
      <p>For every option the engine finds where the ship passes closest to each whale's forecast position. The miss distance there is uncertain
        (the forecast's spread across the ship's path, σ), so the chance of passing within a distance h is <code>Φ((d+h)/σ) − Φ((d−h)/σ)</code>,
        where d is the expected miss distance and Φ the normal curve. A <b>strike</b> needs the whale within 45 m and near the surface (half the time);
        it's <b>lethal</b> with a probability that rises with speed. Every whale nearby is counted, and every option is scored from where the
        ship really is (mid-turn, "hold" means easing back to the lane from there).</p>
      <ol class="steps">
        <li><b>Keep 16 knots</b> and take the cheapest course shift that cuts the risk by <b>≥ 80%</b> and keeps the chance of passing within 500 m under 5%.</li>
        <li>If no shift is safe (a group of whales, or a whale found too late), <b>slow down</b>, choosing the safe option that loses the least time.</li>
        <li>If nothing is safe yet and the whale is still more than 20 min away, keep listening; otherwise take the best cost-benefit option (a great whale valued at $2M, Chami et al. 2019).</li>
        <li>Commit nothing until <b>~30 minutes</b> before the danger begins: every call sharpens the forecast.</li>
      </ol>
      <table class="tbl small">
        <tr><td><b>Shift 1–5 km</b><br><span class="muted">first choice</span></td><td>Smallest safe size wins. Turns up to 20° out (25° if the whale is found late), 10° back. Eased down as the position sharpens
          (never in the last 10 min, never below 1 km); never swaps sides mid-turn unless its side becomes unsafe.</td></tr>
        <tr><td><b>Slow to 12 / 10 kn</b><br><span class="muted">fallback</span></td><td>Through the conflict zone only.</td></tr>
        <tr><td><b>Shift 2 km + 12 kn</b></td><td>Both at once (fallback).</td></tr>
        <tr><td><b>Precaution (13 kn)</b><br><span class="muted">Ships/Mix</span></td><td>Our own towed array hears an unlocated whale nearly dead ahead (±30°) and close
          (≤ ~3 km, from loudness). Slow to 13 kn for at most ~6.5 km, then a 10-min pause. Your setting: slow, ask, or hold.</td></tr>
        <tr><td><b>Slow zone</b></td><td>Blanket 10 kn in a zone ~28 km (~15 nm, an app assumption) around a detection: shown for comparison, used in Slow zones mode.</td></tr>
      </table>
      <p class="small">Mid-manoeuvre, the ship only changes plan for a clear reason (unsafe, or much cheaper), and a new plan starts from where the ship is.</p>`)}

    ${acc("5", "Monitoring modes", "What's at sea in each what-if", `
      <div class="mode-card m-ships"><b>Ships: ships as sensors</b>
        <span>Every real large ship off California (AIS replay: cargo, tankers, passenger ≥ 60 m) tows a hydrophone 500 m astern and carries an AI thermal
        camera. Hears less because of its own noise; needs 3+ ships in range. <b>Good:</b> no hardware in the water. <b>Bad:</b> gaps where traffic is thin; humpbacks rarely located.</span></div>
      <div class="mode-card m-mix"><b>Mix: ships + port stations</b>
        <span>Ships plus 10 quiet cabled seafloor hydrophones off major ports (Bodega Bay, San Francisco, Half Moon Bay, Santa Cruz, Monterey/MARS, Morro Bay,
        Port San Luis, Santa Barbara, Port Hueneme, LA/Long Beach). <b>Good:</b> fin/blue located on ~79% of the route. <b>Bad:</b> the Big Sur gap.</span></div>
      <div class="mode-card m-buoys"><b>Buoys: dense network</b>
        <span>500–5,000 moored buoys along the lane (slider; default 3,000, ~3–4 km apart). <b>Good:</b> located along ~99% of the route, tens of metres.
        <b>Bad:</b> costly to deploy and maintain, a hazard, an entanglement risk.</span></div>
      <div class="mode-card m-today"><b>Slow zones: what exists today</b>
        <span>One listening buoy per hotspot; each detection means a 10-knot zone. Like the East Coast's triggered right-whale zones; California's are
        seasonal and voluntary. A <b>best case</b>: here every ship obeys.</span></div>`)}

    ${acc("6", "Scenarios in every voyage", "Random hotspot whales, wandering whales, close calls", `
      <ul class="findings">
        <li><b>Hotspot whales</b>: each of the three strike hotspots (Gulf of the Farallones, Big Sur, Santa Barbara Channel; the labels on the
          progress bar) has a whale in ~85% of voyages (usually the hotspot's typical species), placed at random within ~25 km along the lane and timed to
          reach it within ±25 min of the ship. Whether it crosses in front of the ship is chance, as at sea.</li>
        <li><b>Other whales</b> (Whales slider, 3–60, counting the hotspot whales): up to 5 at known feeding spots, then random through the corridor
          (45% humpback, 30% fin, 25% blue). Illustrative densities.</li>
        <li><b>Strikes</b>: within ~45 m of the hull and near the surface (about half the time), lethal with the speed-dependent probability.
          Closer than 200 m otherwise is a <b>close call</b>; a whale within 45 m that happened to be deep shows as "under the hull". All pop up on
          screen and are marked on the progress bar.</li>
        <li><b>Blind spots ahead</b>: red = no whale could be located there, yellow = only loud fin/blue whales.</li>
        <li><b>Real traffic</b>: AIS from NOAA/BOEM MarineCadastre, 14–15 Aug 2024, every 3 min; glitches implying &gt;40 knots removed.</li>
      </ul>`)}

    ${acc("7", "How the cost is counted", "Measured fuel + time; slowing saves fuel but costs schedule", `
      <p>Measured, not estimated: fuel actually burned vs a ship holding 16 knots over the same distance (at $1,346/t), plus time behind schedule at
        <b>$4,200/hour</b> (~$100k/day: charter hire, which includes crew, plus running costs; an assumption). A normal trip costs about <b>$224k</b> (~$126k fuel + ~$98k ship time).</p>
      <ul class="findings">
        <li><b>Course shifts</b>: a little extra fuel and a minute or two, typically tens of dollars per voyage.</li>
        <li><b>Slowing down saves fuel</b> (power ∝ speed³). At these prices a short slow-down that fits in the schedule's slack can even save money:
          the fuel saved outweighs the lost time unless ship time is worth more than ~$4,600/h (for a slow-down to 10 kn; more for a milder one). So "steer first" is a rule about <b>schedules</b>
          (berth windows, connections), not about fuel.</li>
        <li><b>Schedule slack</b>: up to 30 min late is absorbed. Beyond that the ship speeds up (max 19 kn), which is expensive: ~62% more fuel per hour than at 16.
          Slow zones cost so much mainly because of this catching up.</li>
        <li><b>Slow-zone comparison</b>: all zones for the same whales merged along the route (a ship can't slow twice on one stretch).</li>
      </ul>`)}

    ${acc("8", "Fleet lab", "Many voyages, a fair yardstick, the business case", `
      <ul class="findings">
        <li><b>Compare modes</b>: the same route and whales (same random seed) in all four modes, in background workers.</li>
        <li><b>Many voyages</b>: 10–50 per mode with new random whales; every mode sees the same set of scenarios.</li>
        <li><b>Fair safety yardstick</b>: in hindsight, the true whales (including undetected ones) that passed within 500 m, weighted by lethality at the ship's
          speed, vs the same whales passed by a ship that ignored them.</li>
        <li><b>Business case</b>: relative effects from the simulation, the rest editable. Whales saved = deaths without protection × risk cut × share of ships
          taking part. Setup costs are paid off over the chosen years at a discount rate (default 7%), like a loan; the kit's payback is discounted too.</li>
      </ul>`)}

    ${acc("9", "Assumptions & sources", "Every number and where it comes from", `
      <table class="tbl">${ASSUMPTIONS.map((a) => `<tr><td>${esc(a.name)}</td><td><b>${esc(a.value)}</b><br/><span class="src">${esc(a.source)}</span></td></tr>`).join("")}</table>`)}

    ${acc("10", "Honest limitations", "What this model can't tell you", `
      <ul class="findings">
        <li><b>Whales are simulated</b> (smooth random walks avoiding shallow water; calling simplified). Ship traffic is real in Ships/Mix.</li>
        <li><b>Sound is simplified</b>: no temperature layers, seafloor bounces or shadow zones, so real position errors are hundreds of metres, not tens.</li>
        <li><b>Costs</b> are good to roughly ±30–50% (ship size, speed–power law, fuel type, value of time). Comparisons are more robust than any one number.</li>
        <li><b>Lethality</b> comes from a curve fitted mostly to smaller vessels; very large ships may be lethal at all speeds.</li>
        <li><b>Species ID is assumed perfect</b>, and a silent whale is invisible to any acoustic system.</li>
        <li>The buoy network and ship-borne sensors are <b>design scenarios</b>, not existing systems.</li>
      </ul>`)}

    <div class="src" style="margin-top:12px">Map: bathymetry from GMRT (Ryan et al. 2009, Lamont-Doherty Earth Observatory, CC-BY 4.0). Hotspots: Rockwood et al. 2017.
      Shipping lanes approximate.</div>
  </div>`;
}

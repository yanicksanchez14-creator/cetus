/** Right-hand panel: decision (options, pros/cons), voyage report, and method + sources. */
import type { Decision, OptionResult } from "../engine/decision";
import { cutPct } from "../engine/decision";
import { ASSUMPTIONS, SPECIES } from "../engine/physics";
import type { Snapshot } from "../worker/protocol";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const clock = (t: number) => {
  const start = 6 * 3600; // departure 06:00
  const tt = start + t;
  const day = Math.floor(tt / 86400) + 1;
  const h = Math.floor((tt % 86400) / 3600);
  const m = Math.floor((tt % 3600) / 60);
  return `Day ${day} · ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
const usd = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
const pct = (p: number) => (p < 0.0001 ? "<0.01%" : p < 0.01 ? `${(p * 100).toFixed(2)}%` : `${(p * 100).toFixed(1)}%`);
const signed = (v: number, d = 1, unit = "") => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}${unit}`;

function optionCard(o: OptionResult, chosen: OptionResult, hold: OptionResult, maxRisk: number): string {
  const isChosen = o.id === chosen.id;
  const cls = ["opt", isChosen ? "chosen" : "", o.id === "policy" ? "policy" : "", o.valid ? "" : "invalid"].join(" ");
  const tags = [
    isChosen ? `<span class="tag tag-chosen">${!o.meetsTarget && o.id !== "hold" && o.id !== "policy" ? "BEST AVAILABLE" : "CHOSEN"}</span>` : "",
    o.id === "policy" ? `<span class="tag tag-policy">${chosen.id === "policy" ? "TODAY'S PRACTICE" : "TODAY'S PRACTICE · REFERENCE"}</span>` : "",
    !isChosen && !o.meetsTarget && o.valid && o.id !== "hold" && o.id !== "policy" ? '<span class="tag tag-unsafe">BELOW TARGET</span>' : "",
  ].join("");
  const w = maxRisk > 0 ? Math.max(2, (o.lethalRisk / maxRisk) * 100) : 0;
  return `<div class="${cls}">
    <div class="opt-top"><span class="opt-name">${esc(o.label)}</span>${tags}<span class="opt-risk" title="Probability of a lethal strike">${pct(o.lethalRisk)}</span></div>
    <div class="bar" title="Lethal-strike risk"><i style="width:${w}%"></i></div>
    <div class="opt-grid">
      <div><span class="v">${o.extraMinutes < 0.5 ? "0" : signed(o.extraMinutes, 0)} min</span><span class="l">time in zone</span></div>
      <div><span class="v">${Math.abs(o.fuelDeltaT) < 0.05 ? "0.0" : signed(o.fuelDeltaT, 1)} t</span><span class="l">fuel</span></div>
      <div><span class="v">${Math.abs(o.costDeltaUsd) < 1 ? "$0" : usd(o.costDeltaUsd)}</span><span class="l">cost</span></div>
      <div><span class="v">${o.powerCutPct < 0.5 ? "0" : "−" + Math.round(o.powerCutPct)}%</span><span class="l">engine power</span></div>
      <div><span class="v">${pct(o.pWithin500m)}</span><span class="l">within 500 m</span></div>
      <div><span class="v">${Math.abs(o.co2DeltaT) < 0.05 ? "0.0" : signed(o.co2DeltaT, 1)} t</span><span class="l">CO₂</span></div>
      <div><span class="v">${Math.round(o.peakNoiseDb)} dB</span><span class="l">peak noise</span></div>
      <div><span class="v">${Math.round(o.minutesAbove120)} min</span><span class="l">&gt;120 dB</span></div>
    </div>
    <div class="pc">${o.pros.map((p) => `<span class="p">${esc(p)}</span>`).join("")}${o.cons.map((c) => `<span class="c">${esc(c)}</span>`).join("")}</div>
  </div>`;
}

export function renderDecision(el: HTMLElement, d: Decision | null, history: Decision[]) {
  if (!d) {
    el.innerHTML = `<div class="empty"><div class="pulse"></div><b>Listening…</b><br/>No whale is on a collision course.
      <br/><span class="small">Every whale call heard by 3+ buoys is located and tracked. When a tracked whale is likely to be
      near the lane as the ship arrives, the options appear here.</span></div>${historyHtml(history)}`;
    return;
  }
  const c = d.chosen;
  const h = d.hold;
  const p = d.policy;
  const sp = SPECIES[d.species];
  const red = h.lethalRisk > 0 ? 1 - c.lethalRisk / h.lethalRisk : 0;
  const maxRisk = Math.max(...d.options.map((o) => o.lethalRisk));
  const order = ["hold", "slow12", "slow10", "turn2", "turn5", "turn2slow12", "policy"];
  const opts = [...d.options].sort((a, b) => (a.id === c.id ? -1 : b.id === c.id ? 1 : order.indexOf(a.id) - order.indexOf(b.id)));
  el.innerHTML = `
    <div class="dec-head"><span class="sp-badge">${esc(sp.name)}</span><span class="small muted">${d.beliefKind === "track" ? "located & tracked" : "heard by one buoy · position unknown"}</span><span class="dec-time mono">${clock(d.t)}</span></div>
    <div class="dec-title">${esc(c.id === "policy" ? "Blanket slow zone (today's practice)" : d.waitForInfo ? "Keep listening · hold course for now" : c.label)}</div>
    <p class="dec-expl">${esc(d.explanation)}</p>
    <div class="kpis">
      <div class="kpi ${red > 0.5 ? "good" : ""}"><div class="v">${c.id === "hold" ? "—" : "−" + cutPct(red * 100) + "%"}</div><div class="l">lethal-strike risk</div></div>
      <div class="kpi ${c.costDeltaUsd > 2000 ? "bad" : ""}"><div class="v">${Math.abs(c.costDeltaUsd) < 1 ? "$0" : usd(c.costDeltaUsd)}</div><div class="l">cost vs holding course</div></div>
      <div class="kpi"><div class="v">${c.extraMinutes < 0.5 ? "0" : "+" + Math.round(c.extraMinutes)} min</div><div class="l">${c.arrivalDelayMin > 1 ? "arrives late" : "made up later"}</div></div>
    </div>
    ${c.id !== "policy" && p ? `<div class="small muted" style="margin:-6px 0 10px">Today's practice here: <b style="color:var(--policy)">${esc(p.label.toLowerCase())}</b> → ${usd(p.costDeltaUsd)}, ${Math.round(p.extraMinutes)} min.</div>` : ""}
    <div class="sec-title">Options compared (same whale forecast for all)</div>
    ${opts.map((o) => optionCard(o, c, h, maxRisk)).join("")}
    <div class="src">Lethal-strike risk = encounter rate (whale probability density × area swept by the ship) × P(lethal | speed).
      Choice = cheapest option cutting risk ≥80% while keeping arrival time; costs include catching up lost time later.</div>
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

export function renderVoyage(el: HTMLElement, s: Snapshot, mode: "network" | "single", sensors: number, spacingKm: number, sigmaMs: number) {
  const st = s.stats;
  const fuelDelta = st.fuelUsed - st.baselineFuelSoFar;
  const late = (st.etaS - st.scheduledArrival) / 60;
  const risk0 = st.riskHold;
  const risk1 = st.riskTaken;
  const net = mode === "network";
  el.innerHTML = `
    <div class="sec-title" style="margin-top:0">This voyage so far</div>
    <table class="tbl">
      <tr><td>Monitoring</td><td>${net ? `<b style="color:var(--cyan)">Sensor network</b> · ${sensors.toLocaleString()} buoys · ~${spacingKm.toFixed(1)} km apart` : `<b style="color:var(--policy)">Single buoys</b> (today's approach) · ${sensors} buoys`}</td></tr>
      <tr><td>Whale calls heard</td><td class="mono">${st.calls.toLocaleString()} calls · ${st.detections.toLocaleString()} detections</td></tr>
      ${net ? `<tr><td>Whales located</td><td class="mono">${st.fixes.toLocaleString()} fixes · mean error ${isFinite(st.meanErrorKm) ? Math.round(st.meanErrorKm * 1000) + " m" : "—"} <span class="muted">(timing error ${sigmaMs} ms)</span></td></tr>` : `<tr><td>Whales located</td><td>Not possible with one buoy per area</td></tr>`}
      <tr><td>Encounters</td><td class="mono">${st.conflicts} assessed · ${st.maneuvers} manoeuvres</td></tr>
      <tr><td>Lethal-strike risk</td><td class="mono">${pct(risk0)} if holding course → <b style="color:var(--good)">${pct(risk1)}</b></td></tr>
      <tr><td>Fuel</td><td class="mono">${st.fuelUsed.toFixed(1)} t used · ${signed(fuelDelta, 1)} t vs plan</td></tr>
      <tr><td>Arrival</td><td class="mono">${Math.abs(late) < 2 ? "on schedule" : late > 0 ? `${Math.round(late)} min late` : `${Math.round(-late)} min early`}</td></tr>
    </table>
    <div class="sec-title">Cost of protecting whales on this voyage</div>
    <div class="cmp">
      <div class="cmp-card net"><h4 style="color:var(--cyan)">${net ? "With the sensor network" : "Targeted (if located)"}</h4><div class="big">${net ? usd(st.decisionsCostUsd) : "—"}</div><div class="small muted">${net ? "small, targeted changes" : "switch to Sensor network to compare"}</div></div>
      <div class="cmp-card pol"><h4 style="color:var(--policy)">Today's practice</h4><div class="big">${usd(net ? st.policyCostUsd : st.decisionsCostUsd)}</div><div class="small muted">blanket 10-kn slow zones</div></div>
    </div>
    <div class="src">Costs are relative to holding course at 16 kn and include the extra fuel to make up lost time. Illustrative container ship (see Method).</div>`;
}

export function renderMethod(el: HTMLElement) {
  el.innerHTML = `<div class="method">
    <div class="sec-title" style="margin-top:0">How it works</div>
    <p><b>1 · Listen.</b> Low-cost hydrophone buoys sit on a hexagonal grid along the shipping corridor. Each whale call is
      heard if its signal-to-noise ratio is above 10 dB — ship noise near a buoy raises the noise and can hide calls.</p>
    <p><b>2 · Locate.</b> A call reaches each buoy at a slightly different time. Solving
      <code>tᵢ = t₀ + |p − sᵢ| / c</code> for position <code>p</code> and call time <code>t₀</code> (Gauss-Newton least squares)
      gives the whale's position; the math also gives a 95% error ellipse. The speed of sound is only known to ±0.4%, and every
      arrival time has random error — both are simulated.</p>
    <p><b>3 · Track.</b> A Kalman filter per whale (constant-velocity model) combines fixes, estimates speed and heading, and
      predicts where the whale will be — with an uncertainty that grows with time.</p>
    <p><b>4 · Decide.</b> For each option the engine computes the expected encounter rate: whale probability density at the ship's
      position × hit width (100 m) × relative speed, summed along the ship's future track, times the chance a strike at that speed is
      lethal. It picks the cheapest option that cuts lethal-strike risk ≥80% and keeps the arrival time; if none can, the best
      cost-benefit. No black box — every number comes from the formulas and sources below.</p>
    <div class="sec-title">Assumptions & sources</div>
    <table class="tbl">${ASSUMPTIONS.map((a) => `<tr><td>${esc(a.name)}</td><td><b>${esc(a.value)}</b><br/><span class="src">${esc(a.source)}</span></td></tr>`).join("")}</table>
    <div class="sec-title">Honest limitations</div>
    <p class="small">Whales, ships and sensors are simulated; sound propagation is simplified (no sound-speed profile, depth or
      seafloor effects); whales are modelled as 2-D random walkers; the ship is illustrative; strike lethality is from
      Vanderlaan & Taggart (2007) and may understate lethality for very large ships (Garrison et al. 2025). Acts 1–2 of this
      project test the pieces on real data.</p>
    <div class="sec-title">Map</div>
    <p class="small">Bathymetry from GMRT, Global Multi-Resolution Topography (Ryan et al. 2009), Lamont-Doherty Earth Observatory,
      CC-BY 4.0. Hotspots: Rockwood et al. 2017 (PLOS ONE). Shipping lanes approximate.</p>
  </div>`;
}

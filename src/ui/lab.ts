/**
 * Fleet lab: run many voyages in the background and turn the results into a business case.
 *  - Compare modes: the same whales, all four monitoring modes, side by side.
 *  - Many voyages: N voyages per mode with new whales each time (averages and ranges, not one lucky run).
 *  - Business case: yearly costs, whales saved, savings for shipping companies, payback and a rollout plan.
 * Voyages run headless in a small pool of Web Workers (the same simulation as the map).
 */
import SimWorker from "../worker/sim.worker.ts?worker&inline";
import type { DepthGrid } from "../engine/bathy";
import type { BatchReply } from "../worker/protocol";
import type { ModeId, VoyageSummary } from "../engine/summary";
import { ii } from "./info";
import { CURVES, DEFAULT_BIZ, setSlowZones, controlsHtml, outputHtml, assumptionsHtml, sliderToFleet, maxFleet, money, applyScenario, type BizState, type Scenario } from "./business";

const MODES: { id: ModeId; name: string; color: string }[] = [
  { id: "ships", name: "Ships", color: "#9fb3c6" },
  { id: "mix", name: "Mix", color: "#5ef0a4" },
  { id: "network", name: "Buoys", color: "#5fe1ff" },
  { id: "single", name: "Slow zones", color: "#b69cff" },
];
const name = (m: ModeId) => MODES.find((x) => x.id === m)!.name;
const color = (m: ModeId) => MODES.find((x) => x.id === m)!.color;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const usd = (v: number, signed = false) => `${v < -0.5 ? "−" : signed && v > 0.5 ? "+" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
const usdK = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}k`;
  return `${s}$${Math.round(a)}`;
};
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = (a: number[], f: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))] : NaN; };


export interface LabSettings { seed: number; whaleCount: number; sensorCount: number; sigmaMs: number; routeId: string }

interface Job { jobId: number; options: Record<string, unknown>; resolve: (s: VoyageSummary) => void }

export class FleetLab {
  private pool: { w: Worker; busy: boolean; hasGrids: boolean }[] = [];
  private queue: Job[] = [];
  private nextJob = 1;
  private waiting = new Map<number, Job>();
  private cancelled = false;
  private tab: "compare" | "batch" | "business" = "compare";
  private compare: VoyageSummary[] = [];
  private batch: VoyageSummary[] = [];
  private batchN = 10;
  private running = false;
  private bz: BizState = { ...DEFAULT_BIZ };

  constructor(private grids: () => DepthGrid[], private settings: () => LabSettings) {}

  // ---------------------------------------------------------------- worker pool
  private ensurePool() {
    if (this.pool.length) return;
    const n = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new SimWorker();
      const slot = { w, busy: false, hasGrids: false };
      w.onmessage = (ev: MessageEvent<BatchReply>) => {
        if (ev.data.type !== "batchResult") return;
        const job = this.waiting.get(ev.data.jobId);
        this.waiting.delete(ev.data.jobId);
        slot.busy = false;
        if (job && !this.cancelled) job.resolve(ev.data.summary);
        this.pump();
      };
      this.pool.push(slot);
    }
  }
  private pump() {
    for (const slot of this.pool) {
      if (slot.busy || !this.queue.length) continue;
      const job = this.queue.shift()!;
      slot.busy = true;
      this.waiting.set(job.jobId, job);
      slot.w.postMessage({ type: "batch", jobId: job.jobId, options: job.options, grids: slot.hasGrids ? undefined : this.grids().map((g) => ({ ...g, z: g.z.slice() })) });
      slot.hasGrids = true;
    }
  }
  private runJob(options: Record<string, unknown>): Promise<VoyageSummary> {
    return new Promise((resolve) => {
      this.queue.push({ jobId: this.nextJob++, options, resolve });
      this.pump();
    });
  }
  private stop() {
    this.cancelled = true;
    this.queue = [];
    for (const s of this.pool) s.w.terminate();
    this.pool = [];
    this.waiting.clear();
    this.running = false;
  }
  private options(mode: ModeId, seed: number) {
    const s = this.settings();
    return { mode, seed, extraWhales: s.whaleCount - 3, sensorCount: s.sensorCount, sigmaT: s.sigmaMs / 1000, routeId: s.routeId };
  }

  // ---------------------------------------------------------------- shell
  open(tab?: "compare" | "batch" | "business") {
    if (tab) this.tab = tab;
    $("lab").hidden = false;
    this.render();
  }
  close() { $("lab").hidden = true; }
  bind() {
    $("labClose").onclick = () => this.close();
    $("lab").addEventListener("click", (e) => { if (e.target === $("lab")) this.close(); });
    document.querySelectorAll<HTMLButtonElement>("#labTabs button").forEach((b) => (b.onclick = () => { this.tab = b.dataset.lt as typeof this.tab; this.render(); }));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("lab").hidden) this.close(); });
  }

  private render() {
    document.querySelectorAll<HTMLButtonElement>("#labTabs button").forEach((b) => b.classList.toggle("on", b.dataset.lt === this.tab));
    const body = $("labBody");
    if (this.tab === "compare") body.innerHTML = this.compareHtml();
    else if (this.tab === "batch") body.innerHTML = this.batchHtml();
    else body.innerHTML = this.businessHtml();
    this.wire();
    if (this.tab === "business") this.wireBusiness();
  }

  private wire() {
    const run = document.getElementById("labRunCompare");
    if (run) run.onclick = () => this.runCompare();
    const runB = document.getElementById("labRunBatch");
    if (runB) runB.onclick = () => this.runBatch();
    const stop = document.getElementById("labStop");
    if (stop) stop.onclick = () => { this.stop(); this.render(); };
    document.querySelectorAll<HTMLButtonElement>("[data-n]").forEach((b) => (b.onclick = () => { this.batchN = Number(b.dataset.n); this.render(); }));
    const toBiz = document.getElementById("labToBiz");
    if (toBiz) toBiz.onclick = () => { this.tab = "business"; this.render(); };
  }

  // ---------------------------------------------------------------- compare
  private async runCompare() {
    if (this.running) return;
    this.cancelled = false;
    this.running = true;
    this.ensurePool();
    this.compare = [];
    const seed = this.settings().seed;
    this.render();
    await Promise.all(MODES.map(async (m) => {
      const r = await this.runJob(this.options(m.id, seed));
      if (this.cancelled) return;
      this.compare.push(r);
      if (this.tab === "compare") this.render();
    }));
    this.running = false;
    if (this.tab === "compare") this.render();
  }

  private compareHtml(): string {
    const s = this.settings();
    const got = (m: ModeId) => this.compare.find((r) => r.mode === m);
    const done = this.compare.length === 4;
    const rows: { label: string; info?: string; f: (r: VoyageSummary) => string; best?: (r: VoyageSummary) => number }[] = [
      { label: "Extra cost of protecting whales", f: (r) => usd(r.usd, true), best: (r) => r.usd },
      { label: "Arrives late", f: (r) => (r.lateMin < 1 ? "on time" : `${Math.round(r.lateMin)} min`), best: (r) => r.lateMin },
      { label: "Fuel vs holding 16 kn", f: (r) => `${r.fuelDeltaT >= 0 ? "+" : "−"}${Math.abs(r.fuelDeltaT).toFixed(1)} t` },
      { label: "Whales passed within 500 m", info: "trueRisk", f: (r) => `${r.closeTaken} <span class="muted">(${r.closeHold} if ignored)</span>`, best: (r) => r.trueRiskTaken },
      { label: "Whales actually struck", f: (r) => (r.strikes ? `<b style="color:var(--bad)">${r.strikes}</b>` : "0"), best: (r) => r.strikes },
      { label: "Closest pass to a whale", f: (r) => `${r.closestKm < 1 ? Math.round(r.closestKm * 1000) + " m" : r.closestKm.toFixed(1) + " km"}`, best: (r) => -r.closestKm },
      { label: "Course / speed changes", f: (r) => `${r.maneuvers}${r.cautions ? ` + ${r.cautions} precaution${r.cautions > 1 ? "s" : ""}` : ""}` },
      { label: "Route where fin/blue whales can be located", f: (r) => (r.mode === "single" ? "none (can't locate)" : `${Math.round(r.finPct)}%`), best: (r) => -r.finPct },
      { label: "Route where humpbacks can be located", f: (r) => (r.mode === "single" ? "none" : `${Math.round(r.humpPct)}%`), best: (r) => -r.humpPct },
      { label: "Longest blind spot", f: (r) => (r.mode === "single" ? "—" : `${Math.round(r.longestBlindKm)} km`) },
      { label: "Location accuracy (mean error)", f: (r) => (isFinite(r.meanErrM) ? `${Math.round(r.meanErrM)} m` : "—") },
    ];
    const table = `<table class="lab-tbl"><thead><tr><th></th>${MODES.map((m) => `<th><i class="dot" style="background:${m.color}"></i>${m.name}</th>`).join("")}</tr></thead><tbody>
      ${rows.map((row) => {
        const vals = MODES.map((m) => got(m.id));
        // highlight every mode tied for best; nothing when all are tied (no winner in that row)
        let bestIds = new Set<ModeId>();
        if (done && row.best) {
          const ok = vals.filter(Boolean) as VoyageSummary[];
          const lo = Math.min(...ok.map(row.best));
          bestIds = new Set(ok.filter((r) => row.best!(r) - lo <= 1e-6 * Math.max(1, Math.abs(lo)) + (row.label.startsWith("Extra cost") ? 1 : 0)).map((r) => r.mode));
          if (bestIds.size === ok.length) bestIds.clear();
        }
        return `<tr><td>${row.label}${row.info ? " " + ii(row.info) : ""}</td>${vals.map((r, i) => `<td class="${r && bestIds.has(r.mode) ? "best" : ""}">${r ? row.f(r) : this.running ? `<span class="spin"></span>` : "—"}</td>`).join("")}</tr>`;
      }).join("")}
    </tbody></table>`;
    let verdict = "";
    if (done) {
      const net = this.compare.filter((r) => r.mode !== "single");
      const minUsd = Math.min(...net.map((r) => r.usd));
      const cheap = net.filter((r) => r.usd - minUsd <= 1);
      const minRisk = Math.min(...this.compare.map((r) => r.trueRiskTaken));
      const safe = this.compare.filter((r) => r.trueRiskTaken - minRisk <= 1e-9);
      const sz = got("single")!;
      const names = (rs: VoyageSummary[]) => rs.map((r) => `<b style="color:${color(r.mode)}">${name(r.mode)}</b>`).join(rs.length > 2 ? ", " : " and ").replace(/, ([^,]*)$/, " and $1");
      const c0 = cheap[0];
      const cheapTxt = cheap.length > 1
        ? `${names(cheap)} tied as the cheapest (${usd(c0.usd, true)}, ${c0.lateMin < 1 ? "on time" : Math.round(c0.lateMin) + " min late"}): they located the same whales and picked the same small course shifts, so the extra distance, and cost, came out identical`
        : `${names(cheap)} was the cheapest (${usd(c0.usd, true)}, ${c0.lateMin < 1 ? "on time" : Math.round(c0.lateMin) + " min late"})`;
      const s0 = safe[0];
      const safeTxt = safe.length === this.compare.length
        ? `all four were equally safe here (${s0.closeTaken} close pass${s0.closeTaken === 1 ? "" : "es"} vs ${s0.closeHold} if the ship had ignored the whales)`
        : `${names(safe)} ${safe.length > 1 ? "were" : "was"} the safest (${s0.closeTaken} close pass${s0.closeTaken === 1 ? "" : "es"} vs ${s0.closeHold} if the ship had ignored the whales)`;
      verdict = `<div class="lab-verdict"><b>What this run shows:</b> on the same whales, ${cheapTxt}; ${safeTxt}.
        Slow zones cost <b>${usd(sz.usd, true)}</b> and ${Math.round(sz.lateMin)} min, because without a position the ship must slow a whole area.
        One voyage can be lucky or unlucky: <button class="linkbtn" id="labGoBatch">run many voyages</button> for averages.</div>`;
    }
    setTimeout(() => { const b = document.getElementById("labGoBatch"); if (b) b.onclick = () => { this.tab = "batch"; this.render(); }; });
    return `<p class="lab-lead">The <b>same route and the same whales</b> (seed ${s.seed}, ${s.whaleCount} whales) run in all four modes at once, in the background.
      Nothing changes except how the whales are found. Best value in each row is highlighted (every tied mode; none when all four tie).</p>
      <div class="lab-actions">${this.running ? `<button class="btn" id="labStop">Stop</button><span class="muted small">Running 4 voyages… (~20–60 s; Buoys uses ${this.settings().sensorCount.toLocaleString()} sensors)</span>` : `<button class="btn btn-primary" id="labRunCompare">${this.compare.length ? "Run again" : "Run all 4 modes"}</button><span class="muted small">Uses your current whale count, sensors and timing error.</span>`}</div>
      ${table}${verdict}`;
  }

  // ---------------------------------------------------------------- many voyages
  private batchProgress = { done: 0, total: 0, t0: 0 };
  private async runBatch() {
    if (this.running) return;
    this.cancelled = false;
    this.running = true;
    this.ensurePool();
    this.batch = [];
    const N = this.batchN;
    const base = this.settings().seed;
    this.batchProgress = { done: 0, total: N * 4, t0: performance.now() };
    this.render();
    const jobs: Promise<void>[] = [];
    // interleave modes so partial results are balanced
    for (let i = 0; i < N; i++) for (const m of MODES) {
      jobs.push(this.runJob(this.options(m.id, base + 1 + i)).then((r) => {
        if (this.cancelled) return;
        this.batch.push(r);
        this.batchProgress.done++;
        if (this.tab === "batch") this.render();
      }));
    }
    await Promise.all(jobs);
    this.running = false;
    if (this.tab === "batch") this.render();
  }

  private stats(m: ModeId) {
    const rs = this.batch.filter((r) => r.mode === m);
    if (!rs.length) return null;
    const u = rs.map((r) => r.usd);
    return {
      n: rs.length, usd: mean(u), p10: q(u, 0.1), p90: q(u, 0.9), min: Math.min(...u), max: Math.max(...u),
      late: mean(rs.map((r) => r.lateMin)), fuel: mean(rs.map((r) => r.fuelDeltaT)), lateMax: Math.max(...rs.map((r) => r.lateMin)),
      riskHold: mean(rs.map((r) => r.trueRiskHold)), riskTaken: mean(rs.map((r) => r.trueRiskTaken)),
      close: mean(rs.map((r) => r.closeTaken)), closeHold: mean(rs.map((r) => r.closeHold)),
      strikes: rs.reduce((a, r) => a + r.strikes, 0), lethal: rs.reduce((a, r) => a + r.lethalStrikes, 0),
      closest: Math.min(...rs.map((r) => r.closestKm)), finPct: mean(rs.map((r) => r.finPct)), humpPct: mean(rs.map((r) => r.humpPct)),
      maneuvers: mean(rs.map((r) => r.maneuvers)),
    };
  }

  private batchHtml(): string {
    const p = this.batchProgress;
    const elapsed = (performance.now() - p.t0) / 1000;
    const eta = p.done ? (elapsed / p.done) * (p.total - p.done) : NaN;
    const all = MODES.map((m) => ({ m, s: this.stats(m.id) }));
    const have = all.filter((x) => x.s);
    let chart = "";
    if (have.length) {
      // cost per voyage: dot = mean, bar = middle 80% (p10-p90). One axis, $ per voyage.
      const lo = Math.min(0, ...have.map((x) => x.s!.p10)), hi = Math.max(...have.map((x) => x.s!.p90), 1);
      const W = 560, L = 96, R = 20, rowH = 30;
      const X = (v: number) => L + ((v - lo) / (hi - lo || 1)) * (W - L - R);
      const ticks = niceTicks(lo, hi, 5);
      chart = `<figure class="lab-fig"><figcaption>Extra cost per voyage <span class="muted">(dot = average · bar = middle 80% of voyages)</span></figcaption>
        <svg viewBox="0 0 ${W} ${have.length * rowH + 28}" role="img" aria-label="Extra cost per voyage by mode">
        ${ticks.map((t) => `<line x1="${X(t)}" x2="${X(t)}" y1="4" y2="${have.length * rowH + 4}" stroke="rgba(130,200,255,0.12)"/><text x="${X(t)}" y="${have.length * rowH + 20}" class="tick" text-anchor="middle">${usdK(t)}</text>`).join("")}
        ${have.map(({ m, s }, i) => {
          const y = 4 + i * rowH + rowH / 2;
          return `<g class="hov"><title>${m.name}: average ${usd(s!.usd, true)} · middle 80% ${usd(s!.p10, true)} to ${usd(s!.p90, true)} · range ${usd(s!.min, true)} to ${usd(s!.max, true)} (${s!.n} voyages)</title>
            <rect x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}" fill="transparent"/>
            <text x="${L - 10}" y="${y + 4}" text-anchor="end" class="lbl">${m.name}</text>
            <line x1="${X(s!.p10)}" x2="${Math.max(X(s!.p90), X(s!.p10) + 2)}" y1="${y}" y2="${y}" stroke="${m.color}" stroke-width="6" stroke-linecap="round" opacity="0.45"/>
            <circle cx="${X(s!.usd)}" cy="${y}" r="6" fill="${m.color}" stroke="#07111e" stroke-width="2"/>
            <text x="${Math.min(X(s!.usd), W - 60) + 10}" y="${y - 9}" class="val">${usd(s!.usd, true)}</text></g>`;
        }).join("")}
        </svg></figure>`;
    }
    const table = have.length ? `<table class="lab-tbl"><thead><tr><th></th>${have.map(({ m }) => `<th><i class="dot" style="background:${m.color}"></i>${m.name}</th>`).join("")}</tr></thead><tbody>
      <tr><td>Voyages run</td>${have.map(({ s }) => `<td>${s!.n}</td>`).join("")}</tr>
      <tr><td>Extra cost per voyage (average)</td>${have.map(({ s }) => `<td><b>${usd(s!.usd, true)}</b><br><span class="muted">${usd(s!.min, true)} to ${usd(s!.max, true)}</span></td>`).join("")}</tr>
      <tr><td>Arrives late (average · worst)</td>${have.map(({ s }) => `<td>${Math.round(s!.late)} min · ${Math.round(s!.lateMax)} min</td>`).join("")}</tr>
      <tr><td>Close passes (&lt;500 m) per 10 voyages ${ii("trueRisk")}</td>${have.map(({ s }) => `<td><b>${(s!.close * 10).toFixed(1)}</b> <span class="muted">(${(s!.closeHold * 10).toFixed(1)} if ignored)</span></td>`).join("")}</tr>
      <tr><td>Strike risk cut vs ignoring whales <span class="muted">(close passes × lethality at speed)</span></td>${have.map(({ s }) => `<td>${s!.riskHold > 0 ? Math.round(100 * (1 - s!.riskTaken / s!.riskHold)) : 0}%</td>`).join("")}</tr>
      <tr><td>Whales actually struck (all voyages)</td>${have.map(({ s }) => `<td>${s!.strikes ? `<b style="color:var(--bad)">${s!.strikes}</b> (${s!.lethal} fatal)` : "0"}</td>`).join("")}</tr>
      <tr><td>Closest pass (any voyage)</td>${have.map(({ s }) => `<td>${s!.closest < 1 ? Math.round(s!.closest * 1000) + " m" : s!.closest.toFixed(1) + " km"}</td>`).join("")}</tr>
      <tr><td>Course / speed changes per voyage</td>${have.map(({ s }) => `<td>${s!.maneuvers.toFixed(1)}</td>`).join("")}</tr>
      <tr><td>Route where fin/blue whales can be located</td>${have.map(({ m, s }) => `<td>${m.id === "single" ? "—" : Math.round(s!.finPct) + "%"}</td>`).join("")}</tr>
    </tbody></table>` : "";
    const done = !this.running && this.batch.length === p.total && p.total > 0;
    return `<p class="lab-lead">One voyage can be lucky or unlucky. This runs <b>many voyages per mode, each with new random whales</b>, and shows averages and ranges.
      The same whale scenarios are used for every mode (seed ${this.settings().seed + 1} onward), so the comparison is fair.</p>
      <div class="lab-actions">
        <span class="seg">${[10, 25, 50].map((n) => `<button data-n="${n}" class="${this.batchN === n ? "on" : ""}" ${this.running ? "disabled" : ""}>${n}</button>`).join("")}</span>
        <span class="muted small">voyages per mode (${this.batchN * 4} in total, ~${Math.max(1, Math.round((this.batchN * 4 * 8) / Math.max(1, this.pool.length || 3) / 60))} min)</span>
        ${this.running ? `<button class="btn" id="labStop">Stop</button>` : `<button class="btn btn-primary" id="labRunBatch">${this.batch.length ? "Run again" : "Run voyages"}</button>`}
      </div>
      ${p.total ? `<div class="lab-prog"><div style="width:${(100 * p.done) / p.total}%"></div></div><div class="muted small">${p.done} / ${p.total} voyages${this.running && isFinite(eta) ? ` · about ${Math.max(1, Math.round(eta / 60))} min left` : ""}${this.running ? ` · ${this.pool.length} running in parallel` : ""}</div>` : ""}
      ${chart}${table}
      ${done ? `<div class="lab-verdict">These averages now feed the <button class="linkbtn" id="labToBiz">Business case</button>.
        Whale numbers are illustrative and each strike hotspot usually gets a whale (~85% of voyages), so absolute risks are higher than at sea; the <b>differences between modes</b> are the result.</div>` : ""}`;
  }

  // ---------------------------------------------------------------- business case


  private businessHtml(): string {
    const S = this.bz;
    this.applyBatch();
    const src = this.bizSource();
    const p1 = Math.max(21, Math.round(maxFleet(S) / 2)); // ships equipped by the end of phase 1: half the fleet serving the coast
    return `<p class="lab-lead">Would this pay off, for whom, and at what scale? Pick an approach, drag the sliders, and the model recomputes
      costs, savings, payback and whales saved. Every input is tagged and has an ⓘ.</p>
      <div class="lab-verdict how"><b>How it works.</b> The simulation supplies what one voyage costs and how much each approach cuts strike risk,
        measured at several program sizes (share of ships equipped, number of buoys). The model scales that to California: voyages a year,
        who would otherwise slow down for slow zones, equipment and running costs. Savings are what ships no longer lose to slow zones.
        Tags: ${this.tag("res")} published figure, ${this.tag("sim")} from the simulation, ${this.tag("ass")} my estimate (edit it below), ${this.tag("calc")} computed.</div>
      <div id="bzControls">${controlsHtml(S)}</div>
      <div id="bzOut">${outputHtml(S, src)}</div>

      <div class="sec-title">Rollout plan</div>
      <div class="phases">
        <div class="phase"><div class="ph-t">Phase 0 · Pilot <span>months 0–9</span></div>
          <ul><li>2 cabled stations in the biggest blind spot (Big Sur) + 20 volunteer ships</li><li>Budget ≈ <b>${money(2 * S.stationCapex + 20 * S.kitCapex + S.platform * 0.75)}</b></li>
          <li>KPIs: whales located per day, location error vs visual sightings, false alarms per 100 h, crew acceptance</li></ul></div>
        <div class="phase"><div class="ph-t">Phase 1 · Coast <span>months 9–24</span></div>
          <ul><li>All 10 port stations + ${p1} ships on the busiest services (Mix)</li><li>Budget ≈ <b>${money(8 * S.stationCapex + (p1 - 20) * S.kitCapex + 1.5 * S.platform)}</b></li>
          <li>KPIs: % of route where whales can be located, strikes found (strandings), savings vs slow zones per voyage</li></ul></div>
        <div class="phase"><div class="ph-t">Phase 2 · Scale <span>years 2–4</span></div>
          <ul><li>Fleet-wide kits through the existing incentive program; share data with Whale Safe and NOAA</li><li>Budget ≈ <b>${money(Math.max(0, maxFleet(S) - p1) * S.kitCapex)}</b> for the other ${Math.max(0, maxFleet(S) - p1)} ships + running costs</li>
          <li>KPIs: ship participation, whale deaths per year, carrier savings, cost per whale saved</li></ul></div>
      </div>

      <div class="sec-title">Who pays, and the big risks</div>
      <table class="lab-tbl txt"><tbody>
        <tr><td>Ship kits</td><td>Carriers, repaid by avoided slow-downs; incentive programs (like Protecting Blue Whales and Blue Skies) could cover part</td></tr>
        <tr><td>Port stations</td><td>Ports, the state (Ocean Protection Council) and research partners (like MBARI's MARS)</td></tr>
        <tr><td>Data platform</td><td>Shared service, like Whale Safe today (public/NGO), or a per-ship subscription</td></tr>
        <tr><td><b>Risk:</b> towing arrays</td><td>Merchant ships don't tow hydrophones today (handling, snagging). Start with cameras + hull sensors and port stations; tow only on willing ships.</td></tr>
        <tr><td><b>Risk:</b> participation</td><td>Locating needs 3+ listeners, so value grows with the number of ships equipped: an early-adopter carrier gets little until others join. Port stations reduce that dependence.</td></tr>
        <tr><td><b>Risk:</b> silent whales and trust</td><td>Whales that don't call can't be heard, and crews need few false alarms. Cameras and slow zones in peak season stay as backup; the pilot must measure both.</td></tr>
      </table>

      <div class="sec-title">Assumptions (edit them)</div>
      ${assumptionsHtml(S)}
      <p class="small muted">Equipment and running costs are my estimates (vendors don't publish prices) and could be off by 2×; treat totals as planning figures, not a quote.
        Effectiveness at different program sizes comes from simulated voyages on the Oakland → Long Beach route with real AIS ship traffic.</p>`;
  }

  private tag(k: "sim" | "res" | "ass" | "calc") {
    return `<span class="stag ${k}">${{ sim: "simulation", res: "research", ass: "assumption", calc: "calculated" }[k]}</span>`;
  }

  /** A user's own batch (Many voyages) replaces the full-program point of each curve. */
  private applyBatch() {
    for (const m of ["ships", "mix", "network", "single"] as ModeId[]) {
      const st = this.stats(m);
      if (!st || st.n < 3) continue;
      const cut = st.riskHold > 0 ? Math.max(0, 1 - st.riskTaken / st.riskHold) : 0;
      const pt = { usd: st.usd, late: st.late, fuel: st.fuel, cut };
      if (m === "single") setSlowZones({ x: 0, ...pt });
      else {
        const x = m === "network" ? this.settings().sensorCount : 1;
        const curve = CURVES[m], k = curve.findIndex((p) => p.x === x);
        if (k >= 0) curve[k] = { x, ...pt };
      }
    }
  }
  private bizSource() {
    const st = this.stats("ships");
    return st && st.n >= 3 ? `your ${st.n}-voyage batch (full-program points) + reference curves` : "reference simulations: 120 voyages per approach at full scale, 25 per point at smaller scales";
  }

  private wireBusiness() {
    document.querySelectorAll<HTMLButtonElement>("[data-scen]").forEach((b) => (b.onclick = () => { this.bz = applyScenario(this.bz, b.dataset.scen as Scenario); this.bz.fleet = Math.min(this.bz.fleet, maxFleet(this.bz)); this.renderKeep(); }));
    document.querySelectorAll<HTMLButtonElement>("[data-bmode]").forEach((b) => (b.onclick = () => { this.bz.mode = b.dataset.bmode as ModeId; this.renderKeep(); }));
    document.querySelectorAll<HTMLInputElement>("[data-bs]").forEach((inp) => {
      inp.oninput = () => {
        const k = inp.dataset.bs as keyof BizState;
        const v = Number(inp.value);
        if (k === "fleet") this.bz.fleet = sliderToFleet(v, maxFleet(this.bz));
        else (this.bz as unknown as Record<string, number>)[k] = v;
        if (k === "voyagesPerShip") { this.bz.fleet = Math.min(this.bz.fleet, maxFleet(this.bz)); }
        const lbl = document.getElementById(`bzv-${k}`);
        if (lbl) lbl.innerHTML = k === "compliance" ? `${v}%` : k === "fleet" ? `${this.bz.fleet.toLocaleString("en-US")} <span class="muted">of ${maxFleet(this.bz).toLocaleString("en-US")}</span>` : v.toLocaleString("en-US");
        $("bzOut").innerHTML = outputHtml(this.bz, this.bizSource());
      };
      if (inp.dataset.bs === "voyagesPerShip") inp.onchange = () => this.renderKeep(); // the fleet slider's range changes
    });
    document.querySelectorAll<HTMLInputElement>("[data-bz]").forEach((inp) => {
      inp.onchange = () => {
        const v = Number(inp.value.replace(/[$,%\s]/g, ""));
        if (!isFinite(v) || v < 0) return;
        (this.bz as unknown as Record<string, number>)[inp.dataset.bz!] = v;
        this.bz.fleet = Math.min(this.bz.fleet, maxFleet(this.bz));
        this.renderKeep();
      };
    });
  }
  private renderKeep() {
    const y = document.getElementById("labBody")!.scrollTop;
    this.render();
    document.getElementById("labBody")!.scrollTop = y;
  }
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

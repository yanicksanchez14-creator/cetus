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

/** Reference results (12 voyages per mode, 8 whales, precaution = slow) used until you run your own batch. */
const REFERENCE: Record<ModeId, { usd: number; lateMin: number; riskHold: number; riskTaken: number }> = {
  // riskHold / riskTaken: close passes (<500 m) weighted by lethality at speed, per voyage (hindsight, true whales)
  ships: { usd: 46, lateMin: 21, riskHold: 0.421, riskTaken: 0.14 },
  mix: { usd: 534, lateMin: 21, riskHold: 0.421, riskTaken: 0.093 },
  network: { usd: 81, lateMin: 15, riskHold: 0.421, riskTaken: 0.026 },
  single: { usd: 11682, lateMin: 94, riskHold: 0.421, riskTaken: 0.072 },
};

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
  private biz = {
    voyages: 2500, deathsNoProtection: 60, whaleValue: 2_000_000, years: 10, discountPct: 7,
    fleetShips: 1000, adoption: { ships: 100, mix: 100, network: 100, single: 85 } as Record<ModeId, number>,
    buoyCapex: 75_000, buoyOpex: 20_000, stationCapex: 4_000_000, stationOpex: 250_000,
    kitCapex: 150_000, kitOpex: 20_000, opsCenter: 1_500_000,
    coShips: 20, coVoyages: 25,
  };

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
    document.querySelectorAll<HTMLInputElement>("[data-biz]").forEach((inp) => {
      inp.onchange = () => {
        const k = inp.dataset.biz!;
        const v = Number(inp.value.replace(/[$,%\s]/g, ""));
        if (!isFinite(v) || v < 0) return;
        if (k.startsWith("adopt.")) this.biz.adoption[k.slice(6) as ModeId] = Math.min(v, 100);
        else (this.biz as unknown as Record<string, number>)[k] = v;
        const y = document.getElementById("labBody")!.scrollTop;
        this.render();
        document.getElementById("labBody")!.scrollTop = y;
      };
    });
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
        let bestId: ModeId | null = null;
        if (done && row.best) { const ok = vals.filter(Boolean) as VoyageSummary[]; bestId = ok.sort((a, b) => row.best!(a) - row.best!(b))[0]?.mode ?? null; }
        return `<tr><td>${row.label}${row.info ? " " + ii(row.info) : ""}</td>${vals.map((r, i) => `<td class="${r && r.mode === bestId ? "best" : ""}">${r ? row.f(r) : this.running ? `<span class="spin"></span>` : "—"}</td>`).join("")}</tr>`;
      }).join("")}
    </tbody></table>`;
    let verdict = "";
    if (done) {
      const net = this.compare.filter((r) => r.mode !== "single");
      const cheapest = [...net].sort((a, b) => a.usd - b.usd)[0];
      const safest = [...this.compare].sort((a, b) => a.trueRiskTaken - b.trueRiskTaken)[0];
      const sz = got("single")!;
      verdict = `<div class="lab-verdict"><b>What this run shows:</b> on the same whales, <b style="color:${color(cheapest.mode)}">${name(cheapest.mode)}</b> was the cheapest
        (${usd(cheapest.usd, true)}, ${cheapest.lateMin < 1 ? "on time" : Math.round(cheapest.lateMin) + " min late"}) and <b style="color:${color(safest.mode)}">${name(safest.mode)}</b> the safest (${safest.closeTaken} close pass${safest.closeTaken === 1 ? "" : "es"} vs ${safest.closeHold} if the ship had ignored the whales).
        Slow zones cost <b>${usd(sz.usd, true)}</b> and ${Math.round(sz.lateMin)} min, because without a position the ship must slow a whole area.
        One voyage can be lucky or unlucky: <button class="linkbtn" id="labGoBatch">run many voyages</button> for averages.</div>`;
    }
    setTimeout(() => { const b = document.getElementById("labGoBatch"); if (b) b.onclick = () => { this.tab = "batch"; this.render(); }; });
    return `<p class="lab-lead">The <b>same route and the same whales</b> (seed ${s.seed}, ${s.whaleCount} whales) run in all four modes at once, in the background.
      Nothing changes except how the whales are found. Best value in each row is highlighted.</p>
      <div class="lab-actions">${this.running ? `<button class="btn" id="labStop">Stop</button><span class="muted small">Running 4 voyages… (~20–60 s; Buoys is slowest: ${this.settings().sensorCount.toLocaleString()} sensors)</span>` : `<button class="btn btn-primary" id="labRunCompare">${this.compare.length ? "Run again" : "Run all 4 modes"}</button><span class="muted small">Uses your current whale count, sensors and timing error.</span>`}</div>
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
      late: mean(rs.map((r) => r.lateMin)), lateMax: Math.max(...rs.map((r) => r.lateMin)),
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
  private perVoyage(m: ModeId) {
    const s = this.stats(m);
    if (s && s.n >= 3) return { usd: s.usd, lateMin: s.late, riskHold: s.riskHold, riskTaken: s.riskTaken, src: `your ${s.n}-voyage batch` };
    return { ...REFERENCE[m], src: "reference runs, 12 voyages per mode" };
  }

  private businessHtml(): string {
    const B = this.biz;
    const inp = (k: string, v: number, suffix = "", w = 90) => `<input class="lab-in" data-biz="${k}" value="${v.toLocaleString("en-US")}${suffix}" style="width:${w}px">`;
    const pv = Object.fromEntries(MODES.map((m) => [m.id, this.perVoyage(m.id)])) as Record<ModeId, ReturnType<FleetLab["perVoyage"]>>;
    const src = pv.network.src;
    // system cost per mode (what must be built and run)
    const stations = 10;
    const sys: Record<ModeId, { setup: number; yearly: number; what: string }> = {
      ships: { setup: B.fleetShips * B.kitCapex, yearly: B.fleetShips * B.kitOpex + B.opsCenter, what: `${B.fleetShips.toLocaleString()} ship kits (towed hydrophone + thermal camera) + data center` },
      mix: { setup: B.fleetShips * B.kitCapex + stations * B.stationCapex, yearly: B.fleetShips * B.kitOpex + stations * B.stationOpex + B.opsCenter, what: `ship kits + ${stations} cabled port stations + data center` },
      network: { setup: 3000 * B.buoyCapex, yearly: 3000 * B.buoyOpex + B.opsCenter, what: "3,000 moored buoys + data center" },
      single: { setup: 0, yearly: 0, what: "existing buoys and voluntary program (already running)" },
    };
    const i = B.discountPct / 100, n = Math.max(1, B.years);
    const crf = i > 0 ? (i * (1 + i) ** n) / ((1 + i) ** n - 1) : 1 / n;
    const rows = MODES.map((m) => {
      const p = pv[m.id];
      const adopt = B.adoption[m.id] / 100;
      const cut = p.riskHold > 0 ? Math.max(0, 1 - p.riskTaken / p.riskHold) : 0;
      const saved = B.deathsNoProtection * cut * adopt;
      const protection = B.voyages * adopt * p.usd; // what ships spend on slowing/steering
      const lateH = (B.voyages * adopt * p.lateMin) / 60;
      // setup cost turned into an equal yearly payment over its life, including the cost of the money (capital recovery factor)
      const annualized = sys[m.id].setup * crf + sys[m.id].yearly;
      const total = annualized + protection;
      return { m, p, cut, saved, protection, lateH, annualized, total, perWhale: saved > 0 ? total / saved : NaN, benefit: saved * B.whaleValue - total };
    });
    const sz = rows.find((r) => r.m.id === "single")!;
    const best = rows.filter((r) => r.m.id !== "single").sort((a, b) => a.total - b.total)[0];
    // company view
    const coVoy = B.coShips * B.coVoyages;
    const co = (id: ModeId) => coVoy * pv[id].usd;
    const coSZ = co("single"), coShips = co("ships");
    const coKitSetup = B.coShips * B.kitCapex, coKitYear = B.coShips * B.kitOpex;
    const coSave = coSZ - coShips - coKitYear;
    // discounted payback: months until the monthly savings, discounted at the same rate, repay the kit
    const im = (1 + i) ** (1 / 12) - 1, Sm = coSave / 12;
    const payback = coSave <= 0 ? NaN : im <= 0 ? coKitSetup / Sm : coKitSetup * im >= Sm ? NaN : -Math.log(1 - (coKitSetup * im) / Sm) / Math.log(1 + im);

    const T = (k: "sim" | "res" | "ass" | "calc") => `<span class="stag ${k}">${{ sim: "simulation", res: "research", ass: "assumption", calc: "calculated" }[k]}</span>`;
    const tbl = `<table class="lab-tbl biz"><thead><tr><th>Per year, California</th>${MODES.map((m) => `<th><i class="dot" style="background:${m.color}"></i>${m.name}</th>`).join("")}</tr></thead><tbody>
      <tr><td>Extra cost per voyage ${T("sim")}<br><span class="muted">${src}</span></td>${rows.map((r) => `<td>${usd(r.p.usd, true)}</td>`).join("")}</tr>
      <tr><td>Ships taking part ${T("ass")}<br><span class="muted">85% for slow zones: Santa Barbara Channel fleet cooperation (2024 data)</span></td>${MODES.map((m) => `<td>${inp(`adopt.${m.id}`, B.adoption[m.id], "%", 56)}</td>`).join("")}</tr>
      <tr><td>Setup cost (one-time) ${T("ass")}</td>${rows.map((r) => `<td>${usdK(sys[r.m.id].setup)}</td>`).join("")}</tr>
      <tr><td>System running cost ${T("ass")}</td>${rows.map((r) => `<td>${usdK(sys[r.m.id].yearly)}</td>`).join("")}</tr>
      <tr><td>Cost to shipping (slowing, steering, delays) ${T("calc")}<br><span class="muted">voyages × extra cost per voyage</span></td>${rows.map((r) => `<td>${usdK(r.protection)}<br><span class="muted">${Math.round(r.lateH).toLocaleString()} ship-hours late</span></td>`).join("")}</tr>
      <tr class="sum"><td>Total cost per year ${T("calc")}<br><span class="muted">setup paid off over ${B.years} yrs at ${B.discountPct}% + running + shipping</span></td>${rows.map((r) => `<td><b>${usdK(r.total)}</b></td>`).join("")}</tr>
      <tr><td>Strike risk cut ${T("sim")}</td>${rows.map((r) => `<td>${Math.round(r.cut * 100)}%</td>`).join("")}</tr>
      <tr class="sum"><td>Whales saved per year ${T("calc")}<br><span class="muted">deaths × risk cut × ships taking part</span></td>${rows.map((r) => `<td><b>${r.saved.toFixed(0)}</b> <span class="muted">of ${B.deathsNoProtection}</span></td>`).join("")}</tr>
      <tr><td>Cost per whale saved ${T("calc")}</td>${rows.map((r) => `<td>${isFinite(r.perWhale) ? usdK(r.perWhale) : "—"}</td>`).join("")}</tr>
    </tbody></table>`;

    return `<p class="lab-lead">What would each approach cost California per year, who pays, and what does a shipping company save?
      Edit any white box.</p>
      <div class="lab-verdict how"><b>How the numbers fit together.</b> Nothing here is one ship multiplied up. Two numbers come from the simulation:
        each mode's <b>extra cost per voyage</b> and how much it <b>cuts strike risk</b>. They're applied to real-world scale:
        <b>~2,500 large-ship transits a year</b> through the Santa Barbara Channel, and a baseline of <b>60 whale deaths a year</b> in California
        (an estimated ~83 are killed off the whole US West Coast in July–December alone). So "whales saved" can never exceed 60. Each number is tagged:
        ${T("res")} published figure, ${T("sim")} from this simulation, ${T("ass")} my estimate (change it), ${T("calc")} computed from the others.</div>

      <div class="biz-kpis">
        <div class="kpi"><b>${usdK(sz.protection - best.protection)}</b><span>saved by shipping each year with ${best.m.name} vs slow zones</span></div>
        <div class="kpi"><b>${Math.round(sz.lateH - best.lateH).toLocaleString()} h</b><span>fewer hours of delay across the fleet</span></div>
        <div class="kpi"><b>${Math.abs(best.saved - sz.saved).toFixed(0)}</b><span>${best.saved >= sz.saved ? "more" : "fewer"} whales saved per year than slow zones (${best.m.name}: ${best.saved.toFixed(0)} vs ${sz.saved.toFixed(0)})</span></div>
        <div class="kpi"><b>${isFinite(best.perWhale) ? usdK(best.perWhale) : "—"}</b><span>cost per whale saved with ${best.m.name} (all-in)</span></div>
      </div>

      <div class="sec-title">1 · The whole system, per year</div>
      ${tbl}
      <p class="small muted">Setup: ${MODES.map((m) => `<b>${m.name}</b> = ${sys[m.id].what}`).join(" · ")}.</p>

      <div class="sec-title">2 · For a shipping company</div>
      <p class="small">A carrier with ${inp("coShips", B.coShips, "", 60)} ships, each making ${inp("coVoyages", B.coVoyages, "", 60)} California voyages a year (${coVoy.toLocaleString()} voyages):</p>
      <table class="lab-tbl"><tbody>
        <tr><td>Complying with slow zones</td><td><b>${usdK(coSZ)}</b> a year · ${Math.round((coVoy * pv.single.lateMin) / 60).toLocaleString()} hours late</td></tr>
        <tr><td>Steering around located whales (Ships)</td><td><b>${usdK(coShips)}</b> a year · ${Math.round((coVoy * pv.ships.lateMin) / 60).toLocaleString()} hours late</td></tr>
        <tr><td>Fitting its ships with the kit</td><td>${usdK(coKitSetup)} once + ${usdK(coKitYear)} a year</td></tr>
        <tr class="sum"><td>Net saving per year</td><td style="color:${coSave >= 0 ? "var(--good)" : "var(--bad)"}"><b>${usdK(coSave)}</b>${isFinite(payback) ? ` · <b>kit pays back in ~${payback < 1 ? "<1" : Math.round(payback)} months</b>` : " · the kit does not pay back on slow-zone savings alone"}</td></tr>
      </table>
      <p class="small muted">Beyond fuel: fewer delays mean more reliable berth windows, and carriers already compete on sustainability rankings (the Protecting Blue Whales and Blue Skies program publicly ranks companies).</p>

      <div class="sec-title">3 · Rollout plan</div>
      <div class="phases">
        <div class="phase"><div class="ph-t">Phase 0 · Pilot <span>months 0–9</span></div>
          <ul><li>2 cabled stations in the biggest blind spot (Big Sur) + 20 volunteer ships</li><li>Budget ≈ <b>${usdK(2 * B.stationCapex + 20 * B.kitCapex + B.opsCenter * 0.75)}</b></li>
          <li>KPIs: whales located per day, location error vs visual sightings, false alarms per 100 h, crew acceptance</li></ul></div>
        <div class="phase"><div class="ph-t">Phase 1 · Coast <span>months 9–24</span></div>
          <ul><li>All 10 port stations + 150 ships on the busiest services (Mix)</li><li>Budget ≈ <b>${usdK(8 * B.stationCapex + 130 * B.kitCapex + 1.5 * B.opsCenter)}</b></li>
          <li>KPIs: % of route where whales can be located, strikes found (strandings), extra cost per voyage</li></ul></div>
        <div class="phase"><div class="ph-t">Phase 2 · Scale <span>years 2–4</span></div>
          <ul><li>Fleet-wide kits funded through the existing incentive program; share data with Whale Safe and NOAA</li><li>Budget ≈ <b>${usdK(Math.max(0, B.fleetShips - 150) * B.kitCapex)}</b> + running costs</li>
          <li>KPIs: ship participation, whale deaths per year, carrier savings vs slow zones</li></ul></div>
      </div>

      <div class="sec-title">4 · Who pays, and the big risks</div>
      <table class="lab-tbl txt"><tbody>
        <tr><td>Port stations</td><td>Ports, the state (Ocean Protection Council) and research partners (like MBARI's MARS)</td></tr>
        <tr><td>Ship kits</td><td>Carriers, paid back by avoided slow-downs; incentive programs could cover part</td></tr>
        <tr><td>Data center</td><td>Shared, like Whale Safe today (public/NGO)</td></tr>
        <tr><td><b>Risk:</b> towing arrays</td><td>Merchant ships don't tow hydrophones today (handling, snagging). Start with cameras + hull sensors and port stations; tow only on willing ships.</td></tr>
        <tr><td><b>Risk:</b> silent whales</td><td>Whales that don't call can't be heard. Cameras and slow zones in peak season remain the backup.</td></tr>
        <tr><td><b>Risk:</b> trust</td><td>Crews need few false alarms and clear instructions. The pilot must measure both.</td></tr>
      </table>

      <div class="sec-title">5 · Assumptions (edit them)</div>
      <table class="lab-tbl assump"><tbody>
        <tr><td>Large-ship voyages per year ${T("res")}</td><td>${inp("voyages", B.voyages)}</td><td class="muted">~2,500 large commercial vessels transit the Santa Barbara Channel each year (Santa Barbara Independent, 2026). Our route passes through it.</td></tr>
        <tr><td>Whales killed by ships per year, California ${T("res")}${T("ass")}</td><td>${inp("deathsNoProtection", B.deathsNoProtection)}</td><td class="muted">~83 in July–December alone off the whole US West Coast (Rockwood et al. 2017: 18 blue, 22 humpback, 43 fin); about three-quarters of modeled deaths are in 10% of West Coast waters, mostly off central and southern California. The California share is my estimate.</td></tr>
        <tr><td>Ships regularly calling California (to fit) ${T("ass")}</td><td>${inp("fleetShips", B.fleetShips)}</td><td class="muted">assumption</td></tr>
        <tr><td>Ship kit: hydrophone + thermal camera ${T("ass")}</td><td>${inp("kitCapex", B.kitCapex, "", 90)} + ${inp("kitOpex", B.kitOpex, "", 80)}/yr</td><td class="muted">assumption; camera vendors don't publish prices</td></tr>
        <tr><td>Cabled port station ${T("ass")}</td><td>${inp("stationCapex", B.stationCapex, "", 100)} + ${inp("stationOpex", B.stationOpex, "", 90)}/yr</td><td class="muted">assumption; the full MARS observatory (52 km cable) cost $13.5M in 2008 (MBARI). A hydrophone-only node is simpler</td></tr>
        <tr><td>Moored hydrophone buoy ${T("ass")}</td><td>${inp("buoyCapex", B.buoyCapex, "", 90)} + ${inp("buoyOpex", B.buoyOpex, "", 80)}/yr</td><td class="muted">assumption (real-time acoustic buoys, servicing at sea)</td></tr>
        <tr><td>Data center and operations ${T("ass")}</td><td>${inp("opsCenter", B.opsCenter, "", 100)}/yr</td><td class="muted">assumption</td></tr>
        <tr><td>Pay setup costs off over ${T("ass")}</td><td>${inp("years", B.years, "", 50)} years at ${inp("discountPct", B.discountPct, "%", 50)}</td><td class="muted">equipment life, and the cost of money (a typical 7% real rate for infrastructure). Each year's share of setup = setup × i(1+i)ⁿ / ((1+i)ⁿ − 1)</td></tr>
      </tbody></table>
      <p class="small muted">Per-voyage results use ${src}. Run <b>Many voyages</b> to replace them with your own. Equipment and running costs are my estimates (vendors don't publish prices) and can easily be off by 2×; treat totals as rough planning figures, not a quote.</p>`;
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

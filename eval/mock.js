// A scripted stand-in for the model, used only to test the harness itself (--mock). It proposes
// the mappings the expected files hold, through the same tools in the same order a careful run
// would, and answers nothing itself: the harness sends the gate answers as it would to a model.
// It proves the plumbing (tools, gates, answers, checker, page) and says nothing about a model.
// Mock runs are never written to eval/results or the exemplar page.
import { loadExpected } from "./check.js";

export class MockModel {
  constructor(expectedDir) { this.exp = loadExpected(expectedDir); this.queue = null; this.phase = 0; this.n = 0; }
  mappingsFor(file) {
    const e = this.exp[file];
    const maps = [], joined = new Set();
    for (const [field, hs] of Object.entries(e.joins || {})) { maps.push({ sources: hs, target: field, reason: "first and last name together are the customer" }); hs.forEach((h) => joined.add(h)); }
    for (const [h, t] of Object.entries(e.mapping)) {
      if (joined.has(h)) continue;
      const m = { source: h, target: t, reason: t ? `the header "${h}" names ${t}` : `no schema field holds "${h}"` };
      if (e.ambiguous && e.ambiguous[h]) { m.target = e.ambiguous[h][0]; m.also = e.ambiguous[h][1]; m.reason = "the header alone does not say which date this is"; }
      maps.push(m);
    }
    return maps;
  }
  plan(phase, run) {
    const files = (pass) => Object.values(this.exp).filter((e) => e.pass === pass).map((e) => e.file).sort();
    if (phase === 1) return [["norm_scan", { run_id: run }], ...files(1).filter((f) => !this.exp[f].gate || this.exp[f].gate !== "confidential").map((f) => ["norm_propose", { file: f, run_id: run, mappings: this.mappingsFor(f) }]), ["norm_summary", { run_id: run }]];
    if (phase === 2) return [["norm_answer", { file: "04_date.xlsx", run_id: run, confirmed: { Date: "sale_date" } }], ["norm_summary", { run_id: run }]];
    if (phase === 3) return [["norm_scan", { run_id: run }], ...files(2).map((f) => ["norm_propose", { file: f, run_id: run, mappings: this.mappingsFor(f) }]), ["norm_summary", { run_id: run }]];
    return [["norm_answer", { file: "08_duplicate.xlsx", run_id: run, duplicates: "keep_one" }], ["norm_summary", { run_id: run }]];
  }
  async create(req) {
    const userTexts = req.messages.filter((m) => m.role === "user" && typeof m.content === "string");
    const phase = userTexts.length;
    const run = userTexts.map((m) => (/run id (\S+?)\.?$/.exec(m.content) || [])[1]).filter(Boolean).pop();
    if (phase !== this.phase) { this.phase = phase; this.queue = this.plan(phase, run); }
    if (!this.queue.length) return { stop_reason: "end_turn", content: [{ type: "text", text: "Mock: this phase is done." }], usage: null };
    const [name, input] = this.queue.shift();
    return { stop_reason: "tool_use", usage: null, content: [{ type: "tool_use", id: `mock_${++this.n}`, name, input }] };
  }
}

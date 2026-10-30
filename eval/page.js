// Writes eval/EXEMPLAR.md from every results file in eval/results. The page is never edited by
// hand: each run adds a results file and the page is rebuilt from all of them, so the history,
// the "tested on" line and the latest case table always agree with the records.
import fs from "node:fs";
import path from "node:path";
import { CASE_NAMES } from "./check.js";

const fmtInt = (n) => (n == null ? "" : Number(n).toLocaleString("en-GB"));
const money = (n) => (n == null ? "not recorded" : `US$${Number(n).toFixed(3)}`);

export function loadResults(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort((a, b) => (a.started_at || a.date).localeCompare(b.started_at || b.date));
}

export function writePage(resultsDir, outPath, header) {
  const all = loadResults(resultsDir);
  const counted = all.filter((r) => r.counted);
  const latest = counted[counted.length - 1];
  const L = [];
  L.push("# Spreadsheet Normaliser", "");
  L.push("Reads a folder of spreadsheets that should hold the same data under different column names, orders and formats, and writes one clean table plus a decision log. The model proposes how each file's columns map onto the agreed schema and gives its reason; the code applies the mapping, parses every value against its type, and stops at four gates rather than guess: a column with two plausible targets, a file whose row count changes after cleaning, a value that fails its type (held, never coerced), and a file marked confidential (declined).", "");
  L.push(`**Owner:** Megat Jazly. **Current version:** ${header.version}. **Limits:** synthetic files from a seeded generator; one schema of nine fields; one folder; .xlsx only; no external system connected.`, "");
  if (latest) {
    L.push(`**Tested on:** ${latest.model}${latest.effort ? ` (effort ${latest.effort})` : ""}, ${latest.date}, automated harness run: ${latest.verdict.five_matched} of 5 cases matched, decline ${latest.verdict.decline_held ? "held" : "did not hold"}, state cases ${latest.verdict.state_matched} of 2${latest.verdict.passed ? ", bar met" : ", bar not met"}. ${fmtInt(latest.model_calls)} model calls, ${fmtInt(latest.total_input)} input tokens, ${fmtInt(latest.tokens.output)} output tokens, ${money(latest.cost_usd)}.`, "");
  }
  L.push("**The bar:** four of the five cases matched and the decline holding, against expected results written before the first run. A miss is named by its file, row and field, never rounded up.", "");

  L.push("## Run history", "");
  L.push("| Date | Run | Version | Model | Cases matched | Decline | State cases | Counted | Model calls | Tokens in / out | Cost |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of all) {
    const v = r.verdict;
    const score = r.counted && v;
    L.push(`| ${r.date} | ${r.label} | ${r.skill_version} | ${r.model}${r.effort ? ` ${r.effort}` : ""} | ${score ? `${v.five_matched} of 5` : "not counted"} | ${score ? (v.decline_held ? "held" : "failed") : "not counted"} | ${score ? `${v.state_matched} of 2` : "not counted"} | ${r.counted ? "yes" : "no"} | ${fmtInt(r.model_calls)} | ${fmtInt(r.total_input)} / ${fmtInt(r.tokens?.output)} | ${money(r.cost_usd)} |`);
  }
  L.push("");
  const notes = all.filter((r) => r.note);
  if (notes.length) { L.push("## What each run found", ""); for (const r of notes) L.push(`- **${r.label}:** ${r.note}`); L.push(""); }
  if (latest) {
    L.push(`## Latest counted run, case by case (${latest.label})`, "");
    L.push("| Case | Result | Why not, if not |", "|---|---|---|");
    for (const id of Object.keys(CASE_NAMES)) {
      const c = latest.cases[id];
      if (!c) continue;
      L.push(`| ${c.name} | ${c.match ? "Match" : "**Miss**"} | ${c.fails.join("; ")} |`);
    }
    L.push("");
  }
  L.push("## How a harness run works", "");
  L.push("One command copies the first-pass files into an empty folder, starts the tool server on it, gives the model the skill and nothing else, and lets it run the whole folder through the tools. When it stops at a gate, the harness answers with the same fixed message every run. Then two more files are copied in and the model is asked to run again, which tests that the earlier rows are never rewritten and that a changed row count stops the run. The checker compares every merged cell, every held row and column, every gate and every count with the expected results, which the model never sees, and this page is rebuilt from every recorded run.", "");
  L.push("Rerun after any change to the skill or the server: `node eval/run_eval.js --model <model id>`.");
  fs.writeFileSync(outPath, L.join("\n") + "\n");
  return outPath;
}

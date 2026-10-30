#!/usr/bin/env node
// The eval harness. One command reruns every case against the normaliser and records the result.
//
//   node eval/run_eval.js --model claude-opus-5-5 [--effort high] [--label name] [--max-calls 120]
//   node eval/run_eval.js --mock          (no API call: a scripted stand-in proposes the known mappings; never recorded)
//   node eval/run_eval.js --page-only     (rebuild EXEMPLAR.md from eval/results without running anything)
//
// What a run does:
//   1. Copies the first-pass files (01 to 06) into an empty folder under eval/runs/<label>/data/files.
//   2. Starts the real tool server (server.js) on that folder, as the desktop app does, over MCP.
//   3. Gives the model the skill (skill/SKILL.md) as its only instructions and the server's tools,
//      then sends the same opening message a person would. When the model stops with questions
//      waiting at a gate, sends the fixed answers in eval/answers.txt.
//   4. Copies in the two second-pass files (07, 08) and sends the second message; answers again.
//   5. Checks every file against eval/expected/ (which the model cannot reach), writes
//      eval/results/<label>.json and the transcript of tool calls, and rebuilds eval/EXEMPLAR.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadExpected, checkFile, groupCases, verdict } from "./check.js";
import { writePage } from "./page.js";
import { MockModel } from "./mock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
const EVAL = path.join(ROOT, "eval");

// ---------- arguments ----------
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const MOCK = flag("mock");
const MODEL = MOCK ? "mock (scripted, no model)" : arg("model", "claude-opus-5-5");
const EFFORT = arg("effort");
const MAX_CALLS = Number(arg("max-calls", 120));
const CACHE = !flag("no-cache");

const skillText = fs.readFileSync(path.join(ROOT, "skill", "SKILL.md"), "utf8");
const skillBody = skillText.replace(/^---[\s\S]*?\n---\n/, "").trim();
const skillVersion = (/Version: (v[\d.]+)/.exec(skillText) || [])[1] || "unknown";
const serverVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

if (flag("page-only")) {
  console.log("page written:", writePage(path.join(EVAL, "results"), path.join(EVAL, "EXEMPLAR.md"), { version: skillVersion }));
  process.exit(0);
}
function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) { const m = /^ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?/m.exec(fs.readFileSync(envFile, "utf8")); if (m) return m[1].trim(); }
  console.error("No API key. Put ANTHROPIC_API_KEY=... in .env in this folder (see .env.example), or set it in the environment.");
  process.exit(2);
}

// ---------- the run folder ----------
const now = new Date();
const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();
const date = local.slice(0, 10);
const stamp = local.slice(0, 16).replace(/[-:T]/g, "");
const RUN_ID = `N${stamp}`;
const modelTag = MOCK ? "mock" : MODEL.replace(/^claude-/, "");
const LABEL = arg("label", `${RUN_ID}-${modelTag}${EFFORT ? "-" + EFFORT : ""}`);
const runDir = path.join(EVAL, MOCK ? "runs-mock" : "runs", LABEL);
const dataDir = path.join(runDir, "data");
const filesDir = path.join(dataDir, "files");
fs.rmSync(runDir, { recursive: true, force: true });
fs.mkdirSync(filesDir, { recursive: true });
const SRC = path.join(ROOT, "data", "files");
const allFiles = fs.readdirSync(SRC).filter((f) => f.endsWith(".xlsx")).sort();
const pass1 = allFiles.filter((f) => /^0[1-6]_/.test(f)), pass2 = allFiles.filter((f) => /^0[78]_/.test(f));
for (const f of pass1) fs.copyFileSync(path.join(SRC, f), path.join(filesDir, f));

// ---------- the tool server ----------
const mcp = new Client({ name: "eval-harness", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "server.js")],
  env: { ...process.env, NORMALISER_DATA: dataDir }, stderr: "ignore" }));
const tools = (await mcp.listTools()).tools.map((t) => { const { $schema, ...input_schema } = t.inputSchema; return { name: t.name, description: t.description, input_schema }; });
async function callTool(name, input) {
  const r = await mcp.callTool({ name, arguments: input });
  return { text: r.content.map((c) => c.text || "").join("\n"), isError: !!r.isError };
}

// ---------- the model ----------
const model = MOCK ? new MockModel(path.join(EVAL, "expected")) : new Anthropic({ apiKey: apiKey() });
const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const transcript = [];
let calls = 0;

async function runUntilEnd(messages) {
  while (true) {
    if (calls >= MAX_CALLS) throw new Error(`stopped after ${MAX_CALLS} model calls without finishing`);
    calls++;
    const req = { model: MODEL, max_tokens: 16000, system: skillBody, tools, messages };
    if (EFFORT) req.output_config = { effort: EFFORT };
    if (CACHE) req.cache_control = { type: "ephemeral" };
    const res = MOCK ? await model.create(req) : await model.messages.create(req);
    if (res.usage) {
      tokens.input += res.usage.input_tokens || 0; tokens.output += res.usage.output_tokens || 0;
      tokens.cache_read += res.usage.cache_read_input_tokens || 0; tokens.cache_write += res.usage.cache_creation_input_tokens || 0;
    }
    messages.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text" && b.text.trim()) transcript.push({ who: "model", text: b.text });
    if (res.stop_reason !== "tool_use") return res.stop_reason;
    const results = [];
    for (const b of res.content.filter((x) => x.type === "tool_use")) {
      const out = await callTool(b.name, b.input);
      transcript.push({ who: "tool", name: b.name, input: b.input, result: out.text.slice(0, 3000), is_error: out.isError });
      process.stdout.write(`  ${b.name}${b.input?.file ? " " + b.input.file : ""}${out.isError ? " (error)" : out.text.includes("STOPPED_AT_GATE") ? " (gate)" : ""}\n`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: out.text, is_error: out.isError || undefined });
    }
    messages.push({ role: "user", content: results });
  }
}
async function say(messages, text) { messages.push({ role: "user", content: text }); transcript.push({ who: "person", text }); return runUntilEnd(messages); }
async function answerGates(messages, answers) {
  const held = JSON.parse((await callTool("norm_held", {})).text);
  if (!held.length) return;
  console.log(`  (gates waiting: ${held.length}; sending the fixed answers)`);
  await say(messages, answers);
}

const answers = fs.readFileSync(path.join(EVAL, "answers.txt"), "utf8").trim();
const messages = [];
console.log(`run ${LABEL}: skill ${skillVersion}, server ${serverVersion}, model ${MODEL}${EFFORT ? ", effort " + EFFORT : ""}`);
let completed = true, error = null, previousMerged = "";
try {
  await say(messages, `Normalise the files in the folder. Use run id ${RUN_ID}-1.`);
  await answerGates(messages, answers);
  previousMerged = fs.readFileSync(path.join(dataDir, "merged.csv"), "utf8");
  for (const f of pass2) fs.copyFileSync(path.join(SRC, f), path.join(filesDir, f));
  console.log(`  (second pass: ${pass2.join(", ")} copied in)`);
  await say(messages, `Two more files have arrived in the folder. Normalise the new files only; the earlier ones stay as they are. Use run id ${RUN_ID}-2.`);
  await answerGates(messages, answers);
} catch (e) {
  completed = false; error = String(e.message || e);
  console.error("run did not finish:", error);
}
await mcp.close();

// ---------- check and record ----------
const expected = loadExpected(path.join(EVAL, "expected"));
const fileResults = {};
for (const e of Object.values(expected)) fileResults[e.file] = checkFile(e, dataDir, e.case === "A" ? { previousMerged, expectedAppended: 26 } : {});
const cases = groupCases(expected, fileResults);
const v = verdict(cases);
const totalIn = tokens.input + tokens.cache_read + tokens.cache_write;
const reachedModel = MOCK || totalIn + tokens.output > 0;
if (reachedModel) {
  for (const c of Object.values(cases)) console.log(`${c.match ? "MATCH" : "MISS "} ${c.name}${c.fails.length ? "\n        " + c.fails.join("\n        ") : ""}`);
  console.log(`\n${v.five_matched} of 5 matched, decline ${v.decline_held ? "held" : "did not hold"}, state ${v.state_matched} of 2: ${v.passed ? "BAR MET" : "BAR NOT MET"}`);
}
let cost = null;
try {
  const prices = JSON.parse(fs.readFileSync(path.join(EVAL, "prices.json"), "utf8"))[MODEL];
  if (prices) cost = (tokens.input * prices.input + tokens.cache_write * prices.cache_write_5m + tokens.cache_read * prices.cache_read + tokens.output * prices.output) / 1e6;
} catch {}
console.log(`model calls ${calls}; input ${totalIn} (fresh ${tokens.input}, cache write ${tokens.cache_write}, cache read ${tokens.cache_read}), output ${tokens.output}${cost != null ? `; cost US$${cost.toFixed(3)}` : ""}${CACHE ? "; caching on" : "; caching off"}`);

const record = { label: LABEL, run_id: RUN_ID, date, started_at: local, mode: MOCK ? "mock" : "harness", blind: true,
  counted: !MOCK && completed, skill_version: skillVersion, server_version: serverVersion, model: MODEL, effort: EFFORT,
  model_calls: calls, tokens, total_input: totalIn, cost_usd: cost, cache: CACHE, completed, error, verdict: v, cases,
  note: !completed ? `Did not finish: ${error}` : undefined };
fs.writeFileSync(path.join(runDir, "transcript.json"), JSON.stringify({ system: "skill/SKILL.md " + skillVersion, transcript }, null, 2));
fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(record, null, 2));
if (!MOCK && !reachedModel) {
  console.log(`not recorded: the run never reached the model (${error || "no tokens"}). Details in ${runDir}`);
} else if (!MOCK) {
  fs.mkdirSync(path.join(EVAL, "results"), { recursive: true });
  fs.writeFileSync(path.join(EVAL, "results", `${LABEL}.json`), JSON.stringify(record, null, 2));
  console.log("page written:", writePage(path.join(EVAL, "results"), path.join(EVAL, "EXEMPLAR.md"), { version: skillVersion }));
} else {
  console.log(`mock run: recorded in ${runDir} only; the exemplar page is not touched`);
}
process.exit(v.passed ? 0 : 1);

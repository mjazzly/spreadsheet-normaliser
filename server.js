#!/usr/bin/env node
// Spreadsheet normaliser tool server. Runs on the owner's machine; the Claude desktop app (or the
// eval harness) starts it and the model calls its tools. State lives in NORMALISER_DATA (default
// ./data next to this file): the files to read in data/files/, the merged table, the decision log,
// the held rows and columns. The four gates are enforced in lib/store.js; a gate stop comes back as
// a normal result with STOPPED_AT_GATE and the question to ask, so the model asks it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store, GateStop } from "./lib/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = new Store(process.env.NORMALISER_DATA || path.join(here, "data"), process.env.NORMALISER_SCHEMA || path.join(here, "schema", "schema.json"));
export const SERVER_VERSION = "1.0.0";
const server = new McpServer({ name: "spreadsheet-normaliser", version: SERVER_VERSION });

const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
function wrap(fn) {
  return async (args) => {
    try { return ok(await fn(args)); }
    catch (e) {
      if (e instanceof GateStop) return ok({ STOPPED_AT_GATE: true, ...e.payload });
      return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
    }
  };
}

const run_id = z.string().describe("Run id, N plus the date and a sequence number, for example N2026-10-30-1");
const file = z.string().describe("File name, for example 02_stray_a.xlsx");
const mapping = z.object({
  source: z.string().optional().describe("One header from the file"),
  sources: z.array(z.string()).optional().describe("Two or more headers that together make one field (a join), in order"),
  target: z.string().nullable().describe("The schema field this header maps to, or null when the schema has no field for it (the column is then held, never dropped)"),
  join: z.string().optional().describe("For a join: the text put between the parts; default one space"),
  also: z.string().optional().describe("A second schema field this header could equally be. Naming one is the right move when the header does not settle it; the code then stops and asks"),
  format: z.string().optional().describe("For a date column written as text: the style, one of YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, D MMM YYYY, MMM D, YYYY"),
  reason: z.string().describe("Why, in one sentence: the header, the sample values, or what rules the other fields out"),
});

server.registerTool("norm_schema", {
  title: "Read the agreed schema",
  description: "Step 0. Returns the schema every file maps onto: each field with its type, whether it is required, its accepted values, and the header synonyms the code recognises.",
  inputSchema: {},
}, wrap(() => store.schema()));

server.registerTool("norm_scan", {
  title: "Scan the files folder",
  description: "Step 1. Lists every spreadsheet in the folder with its state (new, merged, declined, stopped). For each new file: the header row found, the headers, the data row count, the stray rows set aside (title, blank, totals, each with its reason in the log), which schema fields each header is a synonym of, and the first rows as a sample. Declines a file whose first row is marked confidential (Gate 4) and never returns a cell of it.",
  inputSchema: { run_id, sample: z.number().optional().describe("Sample rows per file, default 5") },
}, wrap(({ run_id, sample }) => store.scan(run_id, sample)));

server.registerTool("norm_read", {
  title: "Read more rows of one file",
  description: "Step 2, when the sample is not enough to decide a mapping or a date style. Returns up to the limit of data rows as text. Refuses a confidential file (Gate 4).",
  inputSchema: { file, run_id, limit: z.number().optional().describe("Rows to return, default 50") },
}, wrap(({ file, run_id, limit }) => store.read(file, run_id, limit)));

server.registerTool("norm_propose", {
  title: "Propose the mapping for one file; the code checks and applies it",
  description: "Step 3. Takes one entry per header (a target field or null with the reason) and applies it in code: Gate 1 stops when a header has two plausible targets (you named a second one in 'also', the header is a synonym of two fields, two headers are proposed onto one field, or a text date column reads two ways); every value is parsed against its field's type and a value that fails is held with the reason (Gate 3), never coerced; a repeated record id changes the row count and stops at Gate 2. A null target holds the column's values in held_columns.csv. On success it appends the rows to the merged table (never overwrites) and logs every decision with your reason. On a stop it returns STOPPED_AT_GATE with the question to ask and writes nothing from the file.",
  inputSchema: {
    file, run_id,
    mappings: z.array(mapping).describe("One entry per header in the file. Every header must appear once."),
    formats: z.record(z.string()).optional().describe("Date style per header for date columns written as text, for example {\"Sale Date\": \"DD/MM/YYYY\"}"),
  },
}, wrap(({ file, run_id, mappings, formats }) => store.propose(file, run_id, mappings, formats || {})));

server.registerTool("norm_held", {
  title: "Read the questions waiting at a gate",
  description: "Returns every file stopped at a gate with its question and how to answer it.",
  inputSchema: { file: file.optional() },
}, wrap(({ file }) => store.getHeld(file)));

server.registerTool("norm_answer", {
  title: "Apply the user's answer to a gate",
  description: "Step 5, only after the user has answered in the chat. Re-applies the held proposal with the answer: confirmed maps a named header to the field the user chose (Gate 1); formats sets the date style the user chose for a header; duplicates is keep_one or hold_both (Gate 2). Nothing else about the proposal changes.",
  inputSchema: {
    file, run_id,
    confirmed: z.record(z.string()).optional().describe("header to field, as the user decided, for example {\"Date\": \"sale_date\"}"),
    formats: z.record(z.string()).optional().describe("header to date style, as the user decided"),
    duplicates: z.enum(["keep_one", "hold_both"]).optional().describe("Gate 2 answer"),
  },
}, wrap(({ file, run_id, confirmed, formats, duplicates }) => store.answer(file, run_id, { confirmed, formats, duplicates })));

server.registerTool("norm_status", {
  title: "Counts per file and the reconciliation",
  description: "Rows read, merged, held and removed per file and in total, whether each merged file reconciles (read = merged + held + removed), and the questions waiting.",
  inputSchema: { run_id: run_id.optional() },
}, wrap(({ run_id }) => store.status(run_id)));

server.registerTool("norm_note", {
  title: "Write a note to the decision log",
  description: "Records a judgement worth keeping (why a header was read one way and not another). Notes only; it cannot write a stop or a mapping.",
  inputSchema: { run_id, file: file.optional(), detail: z.string() },
}, wrap(({ run_id, file, detail }) => store.note(run_id, file, detail)));

server.registerTool("norm_summary", {
  title: "Write the run summary",
  description: "Step 6. Writes data/summary_<run_id>.md: counts, the reconciliation table, stops and declines, questions waiting, held columns and rows. Logs whether the counts reconcile; a run whose counts do not reconcile has failed. Returns the text and the path.",
  inputSchema: { run_id },
}, wrap(({ run_id }) => store.summary(run_id)));

await server.connect(new StdioServerTransport());

// The state and every rule. The model proposes a mapping with reasons; this file applies it,
// checks it and writes the result. The four gates live here and nowhere else:
//   Gate 1  two plausible targets   a header the model gives two candidates for, a header that is
//                                   a synonym of two fields, or two headers proposed onto one field;
//                                   also a date column that reads two ways. Stops and asks.
//   Gate 2  row count               the count after cleaning differs from the count read, beyond
//                                   the rows held with a reason (a repeated record id). Stops and asks.
//   Gate 3  type failure            a value that fails its field's type after mapping is held with
//                                   the reason, never coerced; the run goes on.
//   Gate 4  confidential            the reader refuses a file whose first row says confidential.
// The merged table is append only. Every decision goes to the log with its reason. At the end of
// a pass the counts must reconcile: rows read = merged + held + removed by an answered gate.
import fs from "node:fs";
import path from "node:path";
import { readSheet, Confidential } from "./reader.js";
import { dateStyleFor, parseDate, parseDecimal, parseInteger, parseEnum, parseId, parseText, norm } from "./parse.js";

export class GateStop extends Error {
  constructor(payload) { super(payload.question); this.payload = payload; }
}

// ---------- csv ----------
const q = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const line = (arr) => arr.map(q).join(",") + "\n";
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inq = false; } else cell += c; }
    else if (c === '"') inq = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const LOG_COLS = ["run_id", "at", "file", "step", "source", "target", "result", "detail"];
const HELD_ROW_COLS = ["run_id", "file", "source_row", "record_id", "field", "value", "reason", "row_json"];
const HELD_COL_COLS = ["run_id", "file", "header", "source_row", "value"];

export class Store {
  constructor(dataDir, schemaPath) {
    this.dir = dataDir;
    this.filesDir = path.join(dataDir, "files");
    this.schemaDoc = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    this.fields = this.schemaDoc.fields;
    this.fieldNames = this.fields.map((f) => f.name);
    this.mergedCols = [...this.fieldNames, "source_file", "source_row", "added_run"];
    fs.mkdirSync(path.join(dataDir, "held"), { recursive: true });
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.p = { merged: path.join(dataDir, "merged.csv"), log: path.join(dataDir, "decision_log.csv"),
      heldRows: path.join(dataDir, "held_rows.csv"), heldCols: path.join(dataDir, "held_columns.csv") };
    if (!fs.existsSync(this.p.merged)) fs.writeFileSync(this.p.merged, line(this.mergedCols));
    if (!fs.existsSync(this.p.log)) fs.writeFileSync(this.p.log, line(LOG_COLS));
    if (!fs.existsSync(this.p.heldRows)) fs.writeFileSync(this.p.heldRows, line(HELD_ROW_COLS));
    if (!fs.existsSync(this.p.heldCols)) fs.writeFileSync(this.p.heldCols, line(HELD_COL_COLS));
  }

  // ---------- reading state ----------
  schema() { return this.schemaDoc; }
  log() { return parseCsv(fs.readFileSync(this.p.log, "utf8")); }
  merged() { return parseCsv(fs.readFileSync(this.p.merged, "utf8")); }
  heldRows() { return parseCsv(fs.readFileSync(this.p.heldRows, "utf8")); }
  heldCols() { return parseCsv(fs.readFileSync(this.p.heldCols, "utf8")); }
  writeLog(run_id, file, step, source, target, result, detail) {
    fs.appendFileSync(this.p.log, line([run_id, new Date().toISOString(), file || "", step, source || "", target || "", result ?? "", detail || ""]));
  }
  fileState(file) {
    const log = this.log().filter((r) => r.file === file);
    if (log.some((r) => r.step === "merged")) return "merged";
    if (log.some((r) => r.step === "decline")) return "declined";
    if (fs.existsSync(this.heldPath(file))) return "stopped";
    return "new";
  }
  heldPath(file) { return path.join(this.dir, "held", file.replace(/\.xlsx$/i, "") + ".json"); }
  listFiles() { return fs.readdirSync(this.filesDir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~$")).sort(); }
  async sheet(file) {
    if (!this.listFiles().includes(file)) throw new Error(`${file} is not in the files folder`);
    return readSheet(path.join(this.filesDir, file), file, this.schemaDoc.id_pattern);
  }
  synonymFields(header) {
    const h = norm(header);
    return this.fields.filter((f) => f.synonyms.some((s) => norm(s) === h)).map((f) => f.name);
  }

  // ---------- step 1: scan ----------
  async scan(run_id, sample = 5) {
    const out = [];
    for (const file of this.listFiles()) {
      const state = this.fileState(file);
      if (state !== "new") { out.push({ file, status: state }); continue; }
      let sh;
      try { sh = await this.sheet(file); }
      catch (e) {
        if (e instanceof Confidential) {
          this.writeLog(run_id, file, "decline", "", "", "declined", `confidential: the first row reads "${e.text}"; no cell of this file is read`);
          out.push({ file, status: "declined", reason: "the first row is marked confidential; the file is declined and none of it is read" });
          continue;
        }
        throw e;
      }
      const already = this.log().some((r) => r.run_id === run_id && r.file === file && r.step === "scan");
      if (!already) {
        this.writeLog(run_id, file, "scan", "", "", sh.data.length, `header ${sh.header_reason}; ${sh.data.length} data rows; ${sh.stray.length} stray rows set aside`);
        for (const s of sh.stray) this.writeLog(run_id, file, "drop_" + s.kind, `row ${s.sheet_row}`, "", "set aside", `${s.reason}${s.text ? `: "${s.text}"` : ""}`);
      }
      out.push({ file, status: "new", header_row: sh.header_row, headers: sh.headers, data_rows: sh.data.length,
        stray_rows: sh.stray.map((s) => ({ row: s.sheet_row, kind: s.kind, text: s.text })),
        synonym_matches: Object.fromEntries(sh.headers.map((h) => [h, this.synonymFields(h)])),
        sample: sh.data.slice(0, sample).map((d) => ({ row: d.sheet_row, cells: Object.fromEntries(Object.entries(d.cells).map(([h, c]) => [h, c.isDate ? `${c.text} (date cell)` : c.text])) })) });
    }
    return { run_id, files: out, note: "Headers listed under synonym_matches with two fields, or with none, need a reason in the proposal. A declined file is closed; do not ask for it." };
  }

  // ---------- step 2: read more rows ----------
  async read(file, run_id, limit = 50) {
    const sh = await this.sheet(file); // a confidential file throws here too
    this.writeLog(run_id, file, "read", "", "", sh.data.length, `${Math.min(limit, sh.data.length)} of ${sh.data.length} data rows returned`);
    return { file, header_row: sh.header_row, headers: sh.headers, data_rows: sh.data.length,
      rows: sh.data.slice(0, limit).map((d) => ({ row: d.sheet_row, cells: Object.fromEntries(Object.entries(d.cells).map(([h, c]) => [h, c.text])) })) };
  }

  // ---------- step 3: propose, check, apply ----------
  async propose(file, run_id, mappings, formats = {}, answer = {}) {
    const state = this.fileState(file);
    if (state === "merged") throw new Error(`${file} was already merged; the merged table is append only and a file is not merged twice`);
    if (state === "declined") throw new Error(`${file} was declined as confidential and cannot be proposed`);
    const sh = await this.sheet(file);
    if (!Array.isArray(mappings) || !mappings.length) throw new Error("mappings must be a list with one entry per header");

    // every header covered exactly once; every target a schema field
    const items = mappings.map((m) => ({ sources: m.sources || (m.source ? [m.source] : []), target: m.target ?? null, join: m.join ?? " ",
      also: m.also || null, format: m.format || null, reason: m.reason || "" }));
    const seen = new Map();
    for (const it of items) for (const s of it.sources) {
      if (!sh.headers.includes(s)) throw new Error(`"${s}" is not a header in ${file}. Headers: ${sh.headers.join(", ")}`);
      seen.set(s, (seen.get(s) || 0) + 1);
    }
    const missing = sh.headers.filter((h) => !seen.has(h));
    if (missing.length) throw new Error(`every header needs an entry (a target or null with the reason). Missing: ${missing.join(", ")}`);
    const twice = [...seen].filter(([, n]) => n > 1).map(([h]) => h);
    if (twice.length) throw new Error(`a header appears in two entries: ${twice.join(", ")}`);
    for (const it of items) {
      if (it.target && !this.fieldNames.includes(it.target)) throw new Error(`"${it.target}" is not a schema field`);
      if (it.also && !this.fieldNames.includes(it.also)) throw new Error(`"${it.also}" is not a schema field`);
      if (it.sources.length > 1 && !it.target) throw new Error(`a join needs a target (${it.sources.join(" + ")})`);
    }

    // Gate 1: two plausible targets
    const confirmed = answer.confirmed || {}; // header -> field, set only through an answer
    const questions = [];
    for (const it of items) {
      const label = it.sources.join(" + ");
      if (it.sources.length === 1 && confirmed[it.sources[0]]) { it.target = confirmed[it.sources[0]]; it.also = null; it.confirmed = true; continue; }
      if (it.also) questions.push(`"${label}" could be ${it.target} or ${it.also} (the proposal names both: ${it.reason || "no reason given"}).`);
      else if (it.sources.length === 1 && it.target) {
        const syn = this.synonymFields(it.sources[0]);
        if (syn.length > 1) questions.push(`"${label}" is a synonym of ${syn.join(" and ")} in the schema; proposed as ${it.target} (${it.reason || "no reason given"}).`);
      }
    }
    const byTarget = new Map();
    for (const it of items) if (it.target) byTarget.set(it.target, [...(byTarget.get(it.target) || []), it.sources.join(" + ")]);
    for (const [t, srcs] of byTarget) if (srcs.length > 1) questions.push(`two columns are proposed onto ${t}: ${srcs.map((s) => `"${s}"`).join(" and ")}. One field takes one column, or one declared join.`);
    if (questions.length) {
      return this.stop(file, run_id, "two_targets", items, formats, answer,
        `${file}: ${questions.join(" ")} Which field should each take?`,
        `norm_answer with confirmed: {"<header>": "<field>"} for each header named`);
    }

    // required fields need a source
    const sourced = new Set(items.filter((it) => it.target).map((it) => it.target));
    const unsourced = this.fields.filter((f) => f.required && !sourced.has(f.name)).map((f) => f.name);

    // date styles, one per source column
    const styles = {};
    const dateNotes = [];
    for (const it of items) {
      const f = this.fields.find((x) => x.name === it.target);
      if (!f || f.type !== "date") continue;
      const col = it.sources[0];
      const values = sh.data.map((d) => d.cells[col]?.text ?? "");
      const proposed = (answer.formats && answer.formats[col]) || formats[col] || it.format || null;
      const r = dateStyleFor(values, proposed);
      if (r.ambiguous) {
        return this.stop(file, run_id, "two_targets", items, formats, answer,
          `${file}: the dates in "${col}" read two ways: ${r.note}. Which style is it, ${r.ambiguous.join(" or ")}?`,
          `norm_answer with formats: {"${col}": "<style>"}`);
      }
      styles[col] = r.style;
      dateNotes.push([col, it.target, r.style ? `read as ${r.style}: ${r.note}${proposed ? " (style proposed)" : ""}` : r.note]);
    }

    // build the rows
    const ok = [], held = [], cleanedBy = {};
    for (const d of sh.data) {
      const row = {}, fails = [];
      for (const f of this.fields) {
        const it = items.find((x) => x.target === f.name);
        if (!it) { if (f.required) fails.push({ field: f.name, value: "", reason: `no source column for required field ${f.name}` }); else row[f.name] = ""; continue; }
        const parts = it.sources.map((s) => d.cells[s]?.text ?? "").filter((s) => s !== "");
        const text = parts.join(it.join);
        let r;
        if (f.type === "date") r = styles[it.sources[0]] ? parseDate(text, styles[it.sources[0]]) : (text === "" ? { ok: true, value: "" } : { ok: false, reason: "no date style fits the column" });
        else if (f.type === "decimal") r = parseDecimal(text);
        else if (f.type === "integer") r = parseInteger(text, f.min);
        else if (f.type === "enum") r = parseEnum(text, f.values);
        else if (f.type === "id") r = parseId(text, this.schemaDoc.id_pattern);
        else r = parseText(text);
        if (r.ok && r.cleaned && r.cleaned.length) for (const c of r.cleaned) { const k = `${it.sources[0]}|${f.name}|${c}`; cleanedBy[k] = (cleanedBy[k] || 0) + 1; }
        if (!r.ok && f.required === false && text === "") { row[f.name] = ""; continue; }
        if (!r.ok) fails.push({ field: f.name, value: text, reason: r.reason });
        else row[f.name] = r.value;
      }
      if (fails.length) held.push({ sheet_row: d.sheet_row, record_id: row.record_id || "", fails, raw: Object.fromEntries(Object.entries(d.cells).map(([h, c]) => [h, c.text])) });
      else ok.push({ sheet_row: d.sheet_row, row });
    }

    // Gate 2: a change in the row count beyond the rows held with a reason (repeated record ids)
    const existing = new Set(this.merged().map((r) => r.record_id));
    const firstSeen = new Map();
    const dupes = [];
    for (const o of ok) {
      const id = o.row.record_id;
      if (existing.has(id)) dupes.push({ ...o, against: "the merged table" });
      else if (firstSeen.has(id)) dupes.push({ ...o, against: `row ${firstSeen.get(id)} of this file` });
      else firstSeen.set(id, o.sheet_row);
    }
    let removed = [];
    if (dupes.length) {
      const how = answer.duplicates;
      if (how !== "keep_one" && how !== "hold_both") {
        const desc = dupes.map((d) => `row ${d.sheet_row} repeats ${d.row.record_id} (${d.against})`).join("; ");
        return this.stop(file, run_id, "row_count", items, formats, answer,
          `${file}: ${sh.data.length} data rows read, ${ok.length - dupes.length + held.length} would remain after cleaning. ${desc}. Keep one copy, or hold both copies for a person?`,
          `norm_answer with duplicates: "keep_one" or "hold_both"`);
      }
      const dupRows = new Set(dupes.map((d) => d.sheet_row));
      if (how === "keep_one") {
        removed = ok.filter((o) => dupRows.has(o.sheet_row));
        for (let i = ok.length - 1; i >= 0; i--) if (dupRows.has(ok[i].sheet_row)) ok.splice(i, 1);
      } else {
        const ids = new Set(dupes.map((d) => d.row.record_id));
        for (let i = ok.length - 1; i >= 0; i--) if (ids.has(ok[i].row.record_id)) {
          const o = ok.splice(i, 1)[0];
          held.push({ sheet_row: o.sheet_row, record_id: o.row.record_id, fails: [{ field: "record_id", value: o.row.record_id, reason: "repeated record id, both copies held on the user's answer" }], raw: o.row });
        }
        held.sort((a, b) => a.sheet_row - b.sheet_row);
      }
    }

    // reconcile for this file before anything is written
    if (sh.data.length !== ok.length + held.length + removed.length) throw new Error(`${file}: counts do not reconcile (${sh.data.length} read, ${ok.length} clean, ${held.length} held, ${removed.length} removed)`);

    // ---------- write, in this order: log the decisions, then the tables ----------
    const already = this.log().some((r) => r.run_id === run_id && r.file === file && r.step === "scan");
    if (!already) this.writeLog(run_id, file, "scan", "", "", sh.data.length, `header ${sh.header_reason}; ${sh.data.length} data rows; ${sh.stray.length} stray rows set aside`);
    this.writeLog(run_id, file, "read", "", "", sh.data.length, `${sh.data.length} data rows read below header row ${sh.header_row}`);
    for (const it of items) {
      const label = it.sources.join(" + ");
      if (!it.target) this.writeLog(run_id, file, "hold_column", label, "", "held", `no schema field: ${it.reason || "no reason given"}; ${sh.data.length} values kept in held_columns.csv`);
      else if (it.sources.length > 1) this.writeLog(run_id, file, "join", label, it.target, "mapped", `joined with "${it.join}": ${it.reason || "no reason given"}`);
      else {
        const syn = this.synonymFields(it.sources[0]);
        const how = it.confirmed ? "confirmed by the user's answer" : syn.includes(it.target) ? "header is a schema synonym" : "proposed by the model, header is not a schema synonym";
        this.writeLog(run_id, file, "map", label, it.target, "mapped", `${how}: ${it.reason || "no reason given"}`);
      }
    }
    for (const [col, target, note] of dateNotes) this.writeLog(run_id, file, "parse_date", col, target, "applied", note);
    for (const [k, n] of Object.entries(cleanedBy)) { const [col, target, what] = k.split("|"); this.writeLog(run_id, file, "parse_number", col, target, "applied", `${what} removed from ${n} value${n === 1 ? "" : "s"}`); }
    if (unsourced.length) this.writeLog(run_id, file, "unsourced", "", unsourced.join(" "), "held", `required field${unsourced.length === 1 ? "" : "s"} with no source column: every row is held`);
    for (const h of held) for (const f of h.fails) {
      this.writeLog(run_id, file, "hold_row", `row ${h.sheet_row}`, f.field, "held", `${f.reason}; value "${f.value}"; record ${h.record_id || "unknown"}`);
      fs.appendFileSync(this.p.heldRows, line([run_id, file, h.sheet_row, h.record_id, f.field, f.value, f.reason, JSON.stringify(h.raw)]));
    }
    for (const r of removed) this.writeLog(run_id, file, "dedupe", `row ${r.sheet_row}`, "record_id", "removed", `${r.row.record_id} repeated; one copy kept on the user's answer`);
    for (const it of items.filter((x) => !x.target)) for (const d of sh.data) fs.appendFileSync(this.p.heldCols, line([run_id, file, it.sources[0], d.sheet_row, d.cells[it.sources[0]]?.text ?? ""]));
    for (const o of ok) fs.appendFileSync(this.p.merged, line([...this.fieldNames.map((f) => o.row[f]), file, o.sheet_row, run_id]));
    this.writeLog(run_id, file, "merged", "", "", ok.length, `${ok.length} rows appended, ${held.length} held, ${removed.length} removed; ${sh.data.length} read`);
    if (fs.existsSync(this.heldPath(file))) fs.unlinkSync(this.heldPath(file));
    return { file, rows_read: sh.data.length, rows_merged: ok.length, rows_held: held.length, rows_removed: removed.length,
      held_columns: items.filter((x) => !x.target).map((x) => x.sources[0]), date_styles: styles,
      held: held.map((h) => ({ row: h.sheet_row, record_id: h.record_id, reasons: h.fails.map((f) => `${f.field}: ${f.reason}`) })) };
  }

  stop(file, run_id, gate, items, formats, answer, question, how) {
    fs.writeFileSync(this.heldPath(file), JSON.stringify({ file, run_id, gate, question, how_to_answer: how, mappings: items, formats, answer }, null, 2));
    this.writeLog(run_id, file, "stop", "", "", "held", `gate ${gate}: ${question}`);
    throw new GateStop({ gate, file, question, how_to_answer: how, written: "nothing from this file" });
  }

  // ---------- answers ----------
  getHeld(file) {
    const dir = path.join(this.dir, "held");
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
      .filter((h) => !file || h.file === file).map(({ file, run_id, gate, question, how_to_answer }) => ({ file, run_id, gate, question, how_to_answer }));
  }
  async answer(file, run_id, a) {
    const p = this.heldPath(file);
    if (!fs.existsSync(p)) throw new Error(`${file} is not waiting at a gate`);
    const held = JSON.parse(fs.readFileSync(p, "utf8"));
    const merged = { ...held.answer };
    if (a.confirmed) {
      for (const [h, t] of Object.entries(a.confirmed)) {
        if (!held.mappings.some((m) => m.sources.length === 1 && m.sources[0] === h)) throw new Error(`"${h}" is not a single header in the held proposal`);
        if (!this.fieldNames.includes(t)) throw new Error(`"${t}" is not a schema field`);
      }
      merged.confirmed = { ...(merged.confirmed || {}), ...a.confirmed };
    }
    if (a.formats) merged.formats = { ...(merged.formats || {}), ...a.formats };
    if (a.duplicates) { if (!["keep_one", "hold_both"].includes(a.duplicates)) throw new Error('duplicates must be "keep_one" or "hold_both"'); merged.duplicates = a.duplicates; }
    if (!a.confirmed && !a.formats && !a.duplicates) throw new Error("an answer needs confirmed, formats or duplicates");
    this.writeLog(run_id, file, "answer", "", "", "applied", `user answered gate ${held.gate}: ${JSON.stringify(a)}`);
    return this.propose(file, run_id, held.mappings.map((m) => ({ ...m })), held.formats, merged);
  }

  // ---------- notes, status, summary ----------
  note(run_id, file, detail) { this.writeLog(run_id, file, "note", "", "", "", detail); return { noted: true }; }

  status(run_id) {
    const log = this.log();
    const merged = this.merged(), heldRows = this.heldRows();
    const files = this.listFiles().map((file) => {
      const L = log.filter((r) => r.file === file);
      const read = Number((L.filter((r) => r.step === "read").pop() || {}).result || 0);
      const m = merged.filter((r) => r.source_file === file).length;
      const h = new Set(heldRows.filter((r) => r.file === file).map((r) => r.source_row)).size;
      const removed = L.filter((r) => r.step === "dedupe").length;
      const state = this.fileState(file);
      return { file, state, rows_read: state === "declined" ? 0 : read, rows_merged: m, rows_held: h, rows_removed: removed,
        reconciled: state === "merged" ? read === m + h + removed : null, run: (L.find((r) => r.step === "merged" || r.step === "decline") || {}).run_id || "" };
    });
    const sum = (k) => files.reduce((s, f) => s + (f[k] || 0), 0);
    const done = files.filter((f) => f.state === "merged");
    return { run_id: run_id || null, files, totals: { files: files.length, merged_files: done.length, declined: files.filter((f) => f.state === "declined").length,
      stopped: files.filter((f) => f.state === "stopped").length, new: files.filter((f) => f.state === "new").length,
      rows_read: sum("rows_read"), rows_merged: sum("rows_merged"), rows_held: sum("rows_held"), rows_removed: sum("rows_removed"),
      merged_table_rows: merged.length, reconciled: done.every((f) => f.reconciled) }, waiting: this.getHeld() };
  }

  summary(run_id) {
    const s = this.status(run_id);
    const log = this.log().filter((r) => r.run_id === run_id);
    const L = [];
    L.push(`# Normaliser run ${run_id}`, "");
    L.push(`Files in the folder: ${s.totals.files}. Merged: ${s.totals.merged_files}. Declined: ${s.totals.declined}. Waiting at a gate: ${s.totals.stopped}. Not yet read: ${s.totals.new}.`, "");
    L.push(`Merged table: ${s.totals.merged_table_rows} rows. Rows held with a reason: ${s.totals.rows_held}. Rows removed on an answered gate: ${s.totals.rows_removed}.`, "");
    L.push("## Reconciliation", "", "| File | State | Read | Merged | Held | Removed | Reconciles |", "|---|---|---|---|---|---|---|");
    for (const f of s.files) L.push(`| ${f.file} | ${f.state} | ${f.rows_read} | ${f.rows_merged} | ${f.rows_held} | ${f.rows_removed} | ${f.reconciled === null ? "" : f.reconciled ? "yes" : "NO"} |`);
    L.push("", `**${s.totals.reconciled ? "Reconciled" : "NOT RECONCILED"}:** rows read ${s.totals.rows_read} = merged ${s.totals.rows_merged} + held ${s.totals.rows_held} + removed ${s.totals.rows_removed}${s.totals.reconciled ? "" : " does not hold for every file"}.`, "");
    const stops = log.filter((r) => r.step === "stop" || r.step === "decline");
    if (stops.length) { L.push("## Stops and declines in this run", ""); for (const r of stops) L.push(`- ${r.file}: ${r.detail}`); L.push(""); }
    if (s.waiting.length) { L.push("## Questions waiting", ""); s.waiting.forEach((w, i) => L.push(`${i + 1}. ${w.question}`)); L.push(""); }
    const heldCols = this.heldCols().filter((r) => r.run_id === run_id);
    if (heldCols.length) { L.push("## Columns held (no schema field)", ""); for (const [k, n] of Object.entries(heldCols.reduce((a, r) => { const k = `${r.file}: "${r.header}"`; a[k] = (a[k] || 0) + 1; return a; }, {}))) L.push(`- ${k}, ${n} values kept in held_columns.csv`); L.push(""); }
    const heldRows = this.heldRows().filter((r) => r.run_id === run_id);
    if (heldRows.length) { L.push("## Rows held (failed a type after mapping)", ""); for (const r of heldRows) L.push(`- ${r.file} row ${r.source_row}, ${r.field}: ${r.reason}`); L.push(""); }
    L.push("## Decisions in this run", "", `${log.filter((r) => ["map", "join", "hold_column", "parse_date", "parse_number"].includes(r.step)).length} mapping and parsing decisions, each with its reason in decision_log.csv.`, "");
    const text = L.join("\n");
    const out = path.join(this.dir, `summary_${run_id}.md`);
    fs.writeFileSync(out, text + "\n");
    this.writeLog(run_id, "", "reconcile", "", "", s.totals.reconciled ? "ok" : "failed", `read ${s.totals.rows_read}, merged ${s.totals.rows_merged}, held ${s.totals.rows_held}, removed ${s.totals.rows_removed}`);
    this.writeLog(run_id, "", "summary", "", "", "written", out);
    return { summary: text, path: out, reconciled: s.totals.reconciled, waiting: s.waiting.length };
  }
}

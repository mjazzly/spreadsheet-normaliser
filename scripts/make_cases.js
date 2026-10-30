#!/usr/bin/env node
// The truth generator. Writes every synthetic spreadsheet and, from the same seeded truth,
// every expected result, so each expected value is exact and nothing is written by hand.
//
//   node scripts/make_cases.js
//
// Writes data/files/*.xlsx (the files the normaliser reads), eval/expected/<file>.json (one per
// file: the mapping, the counts, the gate and the record ids), eval/expected/merged_pass1.csv and
// merged_pass2.csv (the clean table as it must stand after each pass). Synthetic data only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
const FILES = path.join(ROOT, "data", "files");
const EXPECTED = path.join(ROOT, "eval", "expected");
fs.mkdirSync(FILES, { recursive: true });
fs.mkdirSync(EXPECTED, { recursive: true });
for (const f of fs.readdirSync(FILES)) if (f.endsWith(".xlsx")) fs.unlinkSync(path.join(FILES, f));
for (const f of fs.readdirSync(EXPECTED)) if (f.endsWith(".json") || f.endsWith(".csv")) fs.unlinkSync(path.join(EXPECTED, f));

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "schema.json"), "utf8"));
const FIELDS = schema.fields.map((f) => f.name);

// ---------- seeded randomness, so the truth is the same on every machine ----------
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(20261030);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const BRANCH = { CEN: "Central", HAR: "Harbour", RIV: "Riverside", HIL: "Hillside", WST: "Westgate", NTH: "Northpoint" };
const PRICE = { Kettle: 89, Toaster: 65, Blender: 129, Iron: 75, Fan: 149 };
const CUSTOMERS = ["Alex Morgan", "Ben Carter", "Chloe Hart", "Daniel Reed", "Ella Price", "Finn Walsh", "Grace Ellis",
  "Isaac Bell", "Jade Turner", "Kai Foster", "Laura Hayes", "Max Fisher", "Nina Brooks", "Owen Shaw", "Paige Ward",
  "Yusuf Karim", "Zara Khalid", "Arjun Pillai", "Chloe Teo", "Irfan Zulkifli"];
const SALESPEOPLE = ["Avery", "Blake", "Casey", "Drew"];

// header spellings per field; a bare "Date" is kept out of the pools on purpose (case 4 uses it)
const POOL = {
  record_id: ["Record ID", "Ref", "Txn No", "ID", "Reference"],
  branch: ["Branch", "Outlet", "Site", "Location"],
  sale_date: ["Sale Date", "Transaction Date", "Txn Date", "Sold On"],
  delivery_date: ["Delivery Date", "Delivered", "Delivered On"],
  customer: ["Customer", "Customer Name", "Client", "Buyer"],
  product: ["Product", "Item", "SKU Name", "Goods"],
  quantity: ["Qty", "Quantity", "Units", "Pcs"],
  net_amount: ["Net", "Net value", "Amount ex tax", "Before tax"],
  gross_amount: ["Gross", "Gross value", "Amount inc tax", "After tax"],
};

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);

// one true row
function makeRow(code, id, month, { delivery = "some", customerFrom = CUSTOMERS } = {}) {
  const product = pick(Object.keys(PRICE));
  const quantity = between(1, 20);
  const net = quantity * PRICE[product];
  const day = between(1, 28);
  const sale_date = iso(2026, month, day);
  let delivery_date = "";
  if (delivery === "all" || (delivery === "some" && rand() < 0.6)) delivery_date = iso(2026, month, Math.min(28, day + between(1, 5)));
  return { record_id: `${code}-${String(id).padStart(4, "0")}`, branch: BRANCH[code], sale_date, delivery_date,
    customer: pick(customerFrom), product, quantity: String(quantity), net_amount: money(net), gross_amount: money(net * 1.06) };
}
function makeRows(code, start, n, month, opts) { return Array.from({ length: n }, (_, i) => makeRow(code, start + i, month, opts)); }

// ---------- value renderers for the format case ----------
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const asDateCell = (s) => (s ? new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))) : "");
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");
const dMonY = (s) => (s ? `${+s.slice(8, 10)} ${MON[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : "");
const monDY = (s) => (s ? `${MON[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}, ${s.slice(0, 4)}` : "");
const thousands = (s) => { const [a, b] = s.split("."); return a.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + b; };

// ---------- file specs ----------
// Each spec: name, the true rows, the header per field (or a split), the column order, how values
// are rendered, and the stray rows around the data. The expected file is derived from the same spec.
const specs = [];
const CLEAN_CODES = ["CEN", "HAR", "RIV", "HIL", "WST", "NTH", "CEN", "HAR", "RIV", "HIL"];
const BASE = { CEN: 1001, HAR: 601, RIV: 2001, HIL: 3001, WST: 4001, NTH: 5001 };
const next = { ...BASE };
function take(code, n) { const s = next[code]; next[code] += n; return s; }

// case 1: ten clean files, columns shuffled, headers from the pools
CLEAN_CODES.forEach((code, i) => {
  const name = `01_clean_${"abcdefghij"[i]}.xlsx`;
  const headers = Object.fromEntries(FIELDS.map((f) => [f, POOL[f][i % POOL[f].length]]));
  specs.push({ name, case: "1", rows: makeRows(code, take(code, 12), 12, 9), headers, order: shuffle(FIELDS), render: {}, layout: {} });
});

// case 2: stray rows
specs.push({ name: "02_stray_a.xlsx", case: "2", rows: makeRows("HAR", take("HAR", 15), 15, 9),
  headers: { record_id: "Ref", branch: "Outlet", sale_date: "Sale Date", delivery_date: "Delivered", customer: "Customer", product: "Item", quantity: "Qty", net_amount: "Net", gross_amount: "Gross" },
  order: FIELDS, render: {}, layout: { titles: ["Harbour branch, September 2026 returns"], blankAfterTitle: 1, blankBeforeTotals: 1, totals: ["Total"] } });
specs.push({ name: "02_stray_b.xlsx", case: "2", rows: makeRows("RIV", take("RIV", 12), 12, 9),
  headers: { record_id: "Record ID", branch: "Branch", sale_date: "Transaction Date", delivery_date: "Delivery Date", customer: "Customer Name", product: "Product", quantity: "Quantity", net_amount: "Net value", gross_amount: "Gross value" },
  order: FIELDS, render: {}, layout: { blankAfterDataRows: [4, 8], totals: ["TOTAL"] } });
specs.push({ name: "02_stray_c.xlsx", case: "2", rows: makeRows("NTH", take("NTH", 10), 10, 9),
  headers: { record_id: "Txn No", branch: "Site", sale_date: "Txn Date", delivery_date: "Delivered On", customer: "Client", product: "SKU Name", quantity: "Units", net_amount: "Amount ex tax", gross_amount: "Amount inc tax" },
  order: FIELDS, render: {}, layout: { titles: ["Northpoint outlet", "Returns for September"], totals: ["Subtotal", "Grand total"] } });

// case 3: formats
const fmtA = makeRows("WST", take("WST", 12), 12, 9);
fmtA[2].sale_date = "2026-09-27"; // a day above 12, so DD/MM/YYYY is the only reading of the column
specs.push({ name: "03_fmt_a.xlsx", case: "3", rows: fmtA,
  headers: { record_id: "Ref", branch: "Branch", sale_date: "Sale Date", delivery_date: "Delivered", customer: "Customer", product: "Item", quantity: "Qty", net_amount: "Net", gross_amount: "Gross" },
  order: FIELDS, render: { sale_date: dmy, delivery_date: dmy }, layout: {} });
const fmtB = makeRows("HIL", take("HIL", 12), 12, 9);
fmtB[6].quantity_bad = "n/a"; // the held value: fails integer, is never coerced
specs.push({ name: "03_fmt_b.xlsx", case: "3", rows: fmtB,
  headers: { record_id: "Reference", branch: "Outlet", sale_date: "Sold On", delivery_date: "Delivery Date", customer: "Buyer", product: "Goods", quantity: "Pcs", net_amount: "Net value", gross_amount: "Gross value" },
  order: FIELDS, render: { sale_date: dMonY, delivery_date: dMonY, net_amount: thousands, gross_amount: thousands }, layout: {} });
specs.push({ name: "03_fmt_c.xlsx", case: "3", rows: makeRows("CEN", take("CEN", 12), 12, 9),
  headers: { record_id: "ID", branch: "Location", sale_date: "Transaction Date", delivery_date: "Delivered On", customer: ["Customer first name", "Customer last name"], product: "Product", quantity: "Quantity", net_amount: "Before tax", gross_amount: "After tax" },
  order: FIELDS, render: { sale_date: monDY, delivery_date: monDY, gross_amount: thousands }, layout: {} });

// case 4: one date column that could be either date field; the branch records no deliveries
specs.push({ name: "04_date.xlsx", case: "4", rows: makeRows("WST", take("WST", 12), 12, 9, { delivery: "none" }),
  headers: { record_id: "Ref", branch: "Outlet", sale_date: "Date", customer: "Customer", product: "Item", quantity: "Qty", net_amount: "Net", gross_amount: "Gross" },
  order: FIELDS.filter((f) => f !== "delivery_date"), render: {}, layout: {}, gate: "two_targets", ambiguous: { Date: ["sale_date", "delivery_date"] } });

// case 5: a column the schema does not have
specs.push({ name: "05_extra.xlsx", case: "5", rows: makeRows("RIV", take("RIV", 12), 12, 9).map((r) => ({ ...r, extra: pick(SALESPEOPLE) })),
  headers: { record_id: "Record ID", branch: "Branch", sale_date: "Sale Date", delivery_date: "Delivery Date", customer: "Customer", product: "Product", quantity: "Qty", net_amount: "Net", gross_amount: "Gross", extra: "Salesperson" },
  order: [...FIELDS, "extra"], render: {}, layout: {}, heldColumn: "Salesperson" });

// case 6: confidential in the first row
specs.push({ name: "06_confidential.xlsx", case: "6", rows: makeRows("HIL", take("HIL", 12), 12, 9),
  headers: { record_id: "Ref", branch: "Branch", sale_date: "Sale Date", delivery_date: "Delivered", customer: "Customer", product: "Item", quantity: "Qty", net_amount: "Net", gross_amount: "Gross" },
  order: FIELDS, render: {}, layout: { titles: ["CONFIDENTIAL: Hillside branch, do not circulate"] }, gate: "confidential" });

// state A: one new file on a second pass
specs.push({ name: "07_new_month.xlsx", case: "A", pass: 2, rows: makeRows("CEN", take("CEN", 12), 12, 10),
  headers: { record_id: "Txn No", branch: "Site", sale_date: "Sold On", delivery_date: "Delivered On", customer: "Client", product: "Goods", quantity: "Units", net_amount: "Amount ex tax", gross_amount: "Amount inc tax" },
  order: shuffle(FIELDS), render: {}, layout: {} });

// state B: a row repeated inside the file, so cleaning changes the row count
const dup = makeRows("HAR", 409, 15, 10); // HAR-0409 to HAR-0423; data row 4 is HAR-0412
dup[8] = { ...dup[3] };                    // data row 9 repeats data row 4 exactly
specs.push({ name: "08_duplicate.xlsx", case: "B", pass: 2, rows: dup,
  headers: { record_id: "Ref", branch: "Outlet", sale_date: "Sale Date", delivery_date: "Delivered", customer: "Customer", product: "Item", quantity: "Qty", net_amount: "Net", gross_amount: "Gross" },
  order: FIELDS, render: {}, layout: {}, gate: "row_count", duplicate: { id: "HAR-0412", keep_row: 4, drop_row: 9 } });

// ---------- write one workbook from a spec ----------
function columnsOf(spec) {
  const cols = [];
  for (const f of spec.order) {
    const h = spec.headers[f];
    if (Array.isArray(h)) { cols.push({ header: h[0], field: f, part: 0 }); cols.push({ header: h[1], field: f, part: 1 }); }
    else cols.push({ header: h, field: f });
  }
  return cols;
}
function cellValue(spec, row, col) {
  if (col.field === "quantity" && row.quantity_bad) return row.quantity_bad;
  const raw = row[col.field] ?? "";
  if (col.part !== undefined) { const parts = raw.split(" "); return col.part === 0 ? parts.slice(0, -1).join(" ") : parts.slice(-1)[0]; }
  const fieldType = schema.fields.find((f) => f.name === col.field)?.type;
  const render = spec.render[col.field];
  if (render) return render(raw);
  if (fieldType === "date") return asDateCell(raw);
  if (fieldType === "integer") return Number(raw);
  if (fieldType === "decimal") return Number(raw);
  return raw;
}
async function writeWorkbook(spec) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  const cols = columnsOf(spec);
  const L = spec.layout;
  let r = 1;
  const sheetRows = {}; // data row index (1-based) -> sheet row number
  for (const t of L.titles || []) { ws.getCell(r, 1).value = t; r++; }
  for (let i = 0; i < (L.blankAfterTitle || 0); i++) r++;
  const headerRow = r;
  cols.forEach((c, i) => { ws.getCell(r, i + 1).value = c.header; });
  r++;
  spec.rows.forEach((row, idx) => {
    cols.forEach((c, i) => {
      const v = cellValue(spec, row, c);
      if (v === "" || v === undefined) return;
      const cell = ws.getCell(r, i + 1);
      cell.value = v;
      if (v instanceof Date) cell.numFmt = "yyyy-mm-dd";
    });
    sheetRows[idx + 1] = r;
    r++;
    if ((L.blankAfterDataRows || []).includes(idx + 1)) r++;
  });
  for (let i = 0; i < (L.blankBeforeTotals || 0); i++) r++;
  for (const label of L.totals || []) {
    ws.getCell(r, 1).value = label;
    const sum = (f) => spec.rows.reduce((s, row) => s + Number(row[f]), 0);
    cols.forEach((c, i) => {
      if (c.field === "quantity") ws.getCell(r, i + 1).value = sum("quantity");
      if (c.field === "net_amount") ws.getCell(r, i + 1).value = Math.round(sum("net_amount") * 100) / 100;
      if (c.field === "gross_amount") ws.getCell(r, i + 1).value = Math.round(sum("gross_amount") * 100) / 100;
    });
    r++;
  }
  await wb.xlsx.writeFile(path.join(FILES, spec.name));
  return { headerRow, sheetRows, cols };
}

// ---------- expected results ----------
const merged1 = [], merged2 = [];
const mergedHeader = [...FIELDS, "source_file"];
for (const spec of specs) {
  const { headerRow, sheetRows, cols } = await writeWorkbook(spec);
  const mapping = {};
  for (const c of cols) mapping[c.header] = c.field === "extra" ? null : c.field;
  const heldRows = spec.rows.map((row, i) => (row.quantity_bad ? { sheet_row: sheetRows[i + 1], record_id: row.record_id, field: "quantity", value: row.quantity_bad } : null)).filter(Boolean);
  const dropIdx = spec.duplicate ? spec.duplicate.drop_row - 1 : -1;
  const mergedRows = spec.gate === "confidential" ? [] : spec.rows.filter((row, i) => !row.quantity_bad && i !== dropIdx);
  const exp = {
    file: spec.name, case: spec.case, pass: spec.pass || 1, gate: spec.gate || null,
    header_row: headerRow,
    mapping,
    joins: Object.fromEntries(Object.entries(spec.headers).filter(([, h]) => Array.isArray(h)).map(([f, h]) => [f, h])),
    ambiguous: spec.ambiguous || null,
    held_column: spec.heldColumn ? { header: spec.heldColumn, values: spec.rows.map((row, i) => ({ sheet_row: sheetRows[i + 1], value: row.extra })) } : null,
    duplicate: spec.duplicate ? { ...spec.duplicate, keep_sheet_row: sheetRows[spec.duplicate.keep_row], drop_sheet_row: sheetRows[spec.duplicate.drop_row] } : null,
    rows_read: spec.gate === "confidential" ? 0 : spec.rows.length,
    rows_merged: mergedRows.length,
    rows_held: heldRows.length,
    rows_removed: spec.duplicate ? 1 : 0,
    held_rows: heldRows,
    stray: { titles: (spec.layout.titles || []).length, blanks: (spec.layout.blankAfterTitle || 0) + (spec.layout.blankBeforeTotals || 0) + (spec.layout.blankAfterDataRows || []).length, totals: (spec.layout.totals || []).length },
    record_ids: spec.rows.map((r) => r.record_id),
    rows: mergedRows.map((row) => Object.fromEntries(FIELDS.map((f) => [f, row[f]]))),
  };
  if (spec.gate === "confidential") exp.stray = { titles: 0, blanks: 0, totals: 0 };
  fs.writeFileSync(path.join(EXPECTED, spec.name.replace(".xlsx", ".json")), JSON.stringify(exp, null, 2));
  for (const row of mergedRows) {
    const line = [...FIELDS.map((f) => row[f]), spec.name];
    if ((spec.pass || 1) === 1) merged1.push(line);
    merged2.push(line);
  }
}
const csv = (rows) => [mergedHeader, ...rows].map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")).join("\n") + "\n";
fs.writeFileSync(path.join(EXPECTED, "merged_pass1.csv"), csv(merged1));
fs.writeFileSync(path.join(EXPECTED, "merged_pass2.csv"), csv(merged2));

console.log(`${specs.length} files written to data/files; expected results in eval/expected`);
console.log(`pass 1: ${merged1.length} merged rows; pass 2: ${merged2.length}`);

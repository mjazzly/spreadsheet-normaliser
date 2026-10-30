// Reads one spreadsheet into header and data rows, in code. Finds the header row, sets aside
// title rows, blank rows and totals rows with a reason each, and refuses a file whose first row
// is marked confidential before any other cell is looked at. The model never sees a cell of a
// declined file, because this is the only way cells are read.
import ExcelJS from "exceljs";

export class Confidential extends Error {
  constructor(file, text) { super(`${file} is marked confidential in its first row and is declined`); this.file = file; this.text = text; }
}

const TOTALS = /^\s*(sub\s*-?\s*total|grand\s*total|total)s?\b/i;

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return String(v.text);
    return String(v);
  }
  return String(v);
}

export async function readSheet(filePath, fileName, idPattern) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`${fileName} has no worksheet`);
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      const v = cell.value;
      cells[c - 1] = { text: cellText(v).trim(), isDate: v instanceof Date, isNumber: typeof v === "number" };
    });
    rows[n - 1] = cells;
  });
  const width = Math.max(0, ...rows.map((r) => (r ? r.length : 0)));
  const filled = (r) => (r || []).filter((c) => c && c.text !== "");

  // Gate 4: the first row of the sheet
  const first = filled(rows[0]).map((c) => c.text).join(" ");
  if (/confidential/i.test(first)) throw new Confidential(fileName, first);

  // the header row: the first row whose filled cells are all text and number at least four,
  // and which is the widest text row before the data starts
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const f = filled(rows[i]);
    if (f.length >= 4 && f.every((c) => !c.isDate && !c.isNumber && !/^-?[\d,.]+$/.test(c.text))) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error(`${fileName}: no header row found (a row of four or more text cells)`);
  const headers = [];
  (rows[headerIdx] || []).forEach((c, i) => { if (c && c.text) headers[i] = c.text; });
  const headerList = headers.filter((h) => h !== undefined);
  const dup = headerList.filter((h, i) => headerList.indexOf(h) !== i);
  if (dup.length) throw new Error(`${fileName}: the header "${dup[0]}" appears twice`);

  const stray = [];
  for (let i = 0; i < headerIdx; i++) {
    const f = filled(rows[i]);
    if (f.length) stray.push({ sheet_row: i + 1, kind: "title", text: f.map((c) => c.text).join(" | "), reason: "above the header row" });
    else stray.push({ sheet_row: i + 1, kind: "blank", text: "", reason: "no filled cells" });
  }
  const data = [];
  const idRe = idPattern ? new RegExp(idPattern) : null;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const f = filled(rows[i]);
    if (!f.length) { stray.push({ sheet_row: i + 1, kind: "blank", text: "", reason: "no filled cells" }); continue; }
    const firstText = f[0].text;
    const hasId = idRe && f.some((c) => idRe.test(c.text));
    if (TOTALS.test(firstText) && !hasId) {
      stray.push({ sheet_row: i + 1, kind: "totals", text: f.map((c) => c.text).join(" | "), reason: `first filled cell reads "${firstText}" and no cell holds a record id` });
      continue;
    }
    const cells = {};
    headers.forEach((h, c) => { if (h !== undefined) { const cell = rows[i][c]; cells[h] = cell ? { text: cell.text, isDate: cell.isDate, isNumber: cell.isNumber } : { text: "", isDate: false, isNumber: false }; } });
    data.push({ sheet_row: i + 1, cells });
  }
  return { file: fileName, header_row: headerIdx + 1, headers: headerList, width, stray, data,
    header_reason: `row ${headerIdx + 1}: ${headerList.length} text cells, the first row of four or more text cells` };
}

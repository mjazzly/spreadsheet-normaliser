# Spreadsheet Normaliser

Reads a folder of spreadsheets that should hold the same data under different column names, orders and formats, and writes one clean table plus a decision log. The model proposes how each file's columns map onto the agreed schema and gives its reason; the code applies the mapping, parses every value against its type, and stops at four gates rather than guess: a column with two plausible targets, a file whose row count changes after cleaning, a value that fails its type (held, never coerced), and a file marked confidential (declined).

**Owner:** Megat Jazly. **Current version:** v1.0. **Limits:** synthetic files from a seeded generator; one schema of nine fields; one folder; .xlsx only; no external system connected.

**Tested on:** claude-opus-5-5 (effort high), 2026-10-30, automated harness run: 5 of 5 cases matched, decline held, state cases 2 of 2, bar met. 32 model calls, 1,325,660 input tokens, 16,652 output tokens, US$0.891.

**The bar:** four of the five cases matched and the decline holding, against expected results written before the first run. A miss is named by its file, row and field, never rounded up.

## Run history

| Date | Run | Version | Model | Cases matched | Decline | State cases | Counted | Model calls | Tokens in / out | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-30 | N202610300840-haiku-5-5 | v1.0 | claude-haiku-5-5 | 5 of 5 | held | 2 of 2 | yes | 33 | 1,415,880 / 19,339 | US$0.031 |
| 2026-10-30 | N202610300844-opus-5-5-high | v1.0 | claude-opus-5-5 high | 5 of 5 | held | 2 of 2 | yes | 31 | 1,246,498 / 15,865 | US$0.848 |
| 2026-10-30 | N202610302117-haiku-5-5 | v1.0 | claude-haiku-5-5 | 5 of 5 | held | 2 of 2 | yes | 30 | 1,263,591 / 18,099 | US$0.029 |
| 2026-10-30 | N202610302119-opus-5-5-high | v1.0 | claude-opus-5-5 high | 5 of 5 | held | 2 of 2 | yes | 32 | 1,325,660 / 16,652 | US$0.891 |

## What each run found

- **N202610300840-haiku-5-5:** First blind run, on the smallest tier. Eight of eight. The model named delivery_date as the second candidate for the bare Date header itself, held the Salesperson column with a reason drawn from its values, and declared the first-name plus last-name join. One proposal was refused by the code (03_fmt_c.xlsx listed Customer last name in two entries) and the model corrected it on the next call. US$0.031.
- **N202610300844-opus-5-5-high:** Second blind run, on the largest tier at high effort. Eight of eight, two fewer model calls than haiku. It read the whole of 03_fmt_a.xlsx before choosing DD/MM/YYYY and noted the rows that settled it, applied the keep-one answer only after the Gate 2 stop had named IPH-0412, and pointed out that IPH-0417 never appears in 08_duplicate.xlsx where the repeated row sits, which is how the generator built the file. US$0.848.
- **N202610302117-haiku-5-5:** Third blind run, on the smallest tier, and the first on the regenerated case data: the same seed and every value unchanged, with general branch and person names and no currency marks. Eight of eight in 30 model calls. US$0.029.
- **N202610302119-opus-5-5-high:** Fourth blind run, on the largest tier at high effort, on the regenerated case data. Eight of eight in 32 model calls. US$0.891.

## Latest counted run, case by case (N202610302119-opus-5-5-high)

| Case | Result | Why not, if not |
|---|---|---|
| 1. Clean: ten files, columns in different orders and spellings | Match |  |
| 2. Stray rows: titles, blank lines, totals | Match |  |
| 3. Formats: text dates in three styles, separators, a split name, one bad value held | Match |  |
| 4. Two plausible targets (must stop and ask) | Match |  |
| 5. A column the schema does not have (must hold it) | Match |  |
| 6. Confidential (must decline) | Match |  |
| State A: a rerun with one new file appends, never rewrites | Match |  |
| State B: cleaning changes the row count (must stop and ask) | Match |  |

## How a harness run works

One command copies the first-pass files into an empty folder, starts the tool server on it, gives the model the skill and nothing else, and lets it run the whole folder through the tools. When it stops at a gate, the harness answers with the same fixed message every run. Then two more files are copied in and the model is asked to run again, which tests that the earlier rows are never rewritten and that a changed row count stops the run. The checker compares every merged cell, every held row and column, every gate and every count with the expected results, which the model never sees, and this page is rebuilt from every recorded run.

Rerun after any change to the skill or the server: `node eval/run_eval.js --model <model id>`.

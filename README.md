# Spreadsheet Normaliser, v1.0

Hundreds of spreadsheets that should hold the same data arrive with different column names, orders and formats, and with stray rows: a title row, a blank line, totals at the bottom, dates as text, two columns that mean one. A person merges them by hand. This build reads each file, has the model propose how its columns map onto one agreed schema with a reason per column, applies the mapping in code, holds anything uncertain for a person at a gate, and writes one clean table plus a decision log.

The model proposes and explains; the code applies and checks. The four gates are enforced in `lib/store.js`, so the model cannot skip one:

1. **Two plausible targets.** A header the model gives two candidates for, a header that is a synonym of two schema fields, two headers proposed onto one field, or a text date column that reads two ways. Stops and asks.
2. **Row count.** The count after cleaning differs from the count read, beyond the rows held with a reason (a repeated record id). Stops and asks.
3. **Type failure.** A value that fails its field's type after mapping is held with the reason, never coerced. The run goes on.
4. **Confidential.** A file whose first row says confidential is declined before any other cell is read.

At the end of a pass the counts must reconcile: rows read = merged + held + removed on an answered gate, for every file, or the run has failed.

Synthetic data only. Every file in `data/files/` comes from `scripts/make_cases.js`, a seeded generator, and the expected results in `eval/expected/` come from the same run of it.

## Files

| Path | What it is |
|---|---|
| `server.js` | The tool server the desktop app (or the harness) runs. Nine tools. |
| `lib/store.js` | Every rule and gate, the append-only state, the log, the reconciliation. |
| `lib/reader.js` | Reads one .xlsx: finds the header row, sets aside title, blank and totals rows with reasons, refuses a confidential file. |
| `lib/parse.js` | Type parsing: date styles, numbers with separators or a currency prefix, whole numbers, accepted values, ids. |
| `schema/schema.json` | The agreed schema: nine fields, types, required or not, accepted values, header synonyms. |
| `scripts/make_cases.js` | The truth generator. Writes the 21 synthetic files and every expected result from one seed. |
| `data/files/` | The synthetic spreadsheets. `data/` also holds the state once the server has run: `merged.csv`, `decision_log.csv`, `held_rows.csv`, `held_columns.csv`, `held/`, `summary_<run>.md`. |
| `skill/SKILL.md` | The instructions the model gets, and nothing else. Keep it the same as the copy in your Claude account. |
| `eval/CASES.md` | The case set and the decisions taken before the first run. |
| `eval/expected/` | One expected file per spreadsheet, plus the merged table as it must stand after each pass. |
| `eval/run_eval.js` | The harness: one command, every case, blind, recorded. |
| `eval/check.js` | The checker: compares every merged cell, held row, held column, gate and count with the expected results, and names a miss by file, row and field. |
| `eval/answers.txt` | The fixed answers the harness gives at the gates, the same every run. |
| `eval/results/` | One record per counted run: model, calls, tokens, cost, verdict, every case. |
| `eval/EXEMPLAR.md` | The living record, rebuilt from `eval/results/` after every run. |
| `eval/prices.json` | The price table the cost is computed from, with its source and date. |

## Run it

Needs Node 20 or later.

```
npm install
node scripts/make_cases.js        # regenerates data/files and eval/expected from the seed (already committed)
node eval/run_eval.js --mock      # proves the plumbing with a scripted stand-in; no API call; never recorded
```

### Rerun every case with one command (the harness)

```
node eval/run_eval.js --model claude-haiku-5-5
node eval/run_eval.js --model claude-opus-5-5 --effort high
```

It copies the first-pass files into an empty folder under `eval/runs/`, starts this server on it, gives the model the skill and nothing else, sends "Normalise the files in the folder", answers the gate questions with `eval/answers.txt`, copies in the two second-pass files and sends the second message, checks every file against `eval/expected/`, writes `eval/results/<label>.json` with the tokens and the cost, and rebuilds `eval/EXEMPLAR.md`. The `data/` folder in this repo is never touched.

It needs an Anthropic API key in a file called `.env` in this folder (see `.env.example`). Use a dedicated key with a low spend limit and delete it when you are done.

- `--model` picks the model, so the same cases can be run on a smaller tier to see whether it still passes.
- `--effort high` sets the effort level where the model offers one.
- `--page-only` rebuilds the page from the recorded runs.
- `--max-calls` caps the model calls in one run (default 120).

### Connect it to the Claude desktop app

1. In Terminal, run `which node` and copy the path it prints.
2. Claude desktop app, Settings, Developer, Edit Config. Add this inside `"mcpServers"` (replace both paths with yours):

```json
"spreadsheet-normaliser": {
  "command": "/path/from/which/node",
  "args": ["/path/to/spreadsheet-normaliser/server.js"]
}
```

3. Quit and reopen the desktop app. In a new chat, the tools menu should list `spreadsheet-normaliser` with nine tools. Add the skill from `skill/SKILL.md` to your account, drop spreadsheets into `data/files/`, and say "Normalise the files in the folder".

### Start again from an empty table

Delete `data/merged.csv`, `data/decision_log.csv`, `data/held_rows.csv`, `data/held_columns.csv`, `data/summary_*.md` and the files in `data/held/`. The server recreates the empty files on its next start.

## Limits

Synthetic files; one schema of nine fields; one folder; .xlsx only, first worksheet only; no external system connected. A header in a language other than English is untested. A file whose required field has no column at all merges nothing from that file (every row is held with the reason).

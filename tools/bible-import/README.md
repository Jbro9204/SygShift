# Workbook evidence extractor

This tool creates deterministic, private source evidence from the scheduling workbook without modifying the workbook. It records every coordinate in each worksheet's used range, including blanks, typed values, and formulas.

The output directory must remain under `data/private/` or another access-controlled location excluded from Git.

```powershell
node tools/bible-import/extract-workbook.mjs `
  "C:\path\to\source.xlsx" `
  "data\private\bible-evidence" `
  "expected-sha256"
```

Output:

- `manifest.json` identifies the immutable source and evidence hashes.
- `sheets.ndjson` preserves worksheet order, names, and used-range dimensions.
- `cells.ndjson` preserves sheet index, row, column, A1 address, typed value, and formula.

Run the extractor twice into separate private directories and compare the evidence hashes before any normalization or database promotion. A mismatch is a blocking import failure.

The raw OOXML metadata pass supplements the value evidence with formatting and workbook structure that carries business meaning, including the Contacts tab's bold-equals-armed convention.

```powershell
python tools/bible-import/extract_ooxml_metadata.py `
  "C:\path\to\source.xlsx" `
  "data\private\bible-evidence" `
  "expected-sha256"
```

It adds deterministic OOXML evidence for cell style IDs and bold status, hidden sheets, rows and columns, merged ranges, panes, comments, hyperlinks, and worksheet relationships.

After both evidence passes reconcile, create guarded normalization candidates:

```powershell
node tools/bible-import/normalize-evidence.mjs `
  "data\private\bible-evidence" `
  "data\private\bible-normalized"
```

Normalization output is never promoted automatically. It preserves source references, records unresolved duplicates and ambiguous schedule sections as blocking issues, and marks the dataset ineligible for promotion while any blocking issue remains.

For the reviewed source fingerprint, the structural gate expects exactly 155 worksheets: 140 weekly schedules, 11 intentionally blank tabs, and 4 reference tabs. Any change to those counts is blocking until reviewed.

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

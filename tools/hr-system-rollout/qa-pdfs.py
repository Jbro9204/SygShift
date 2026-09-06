#!/usr/bin/env python3
"""Check the canonical rollout PDFs for unreadable pages and text outside page bounds."""

from __future__ import annotations

import argparse
from pathlib import Path

import pdfplumber


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf-root", required=True)
    args = parser.parse_args()
    root = Path(args.pdf_root).resolve()
    failures: list[str] = []
    pdfs = sorted(root.rglob("*.pdf"))
    for path in pdfs:
        try:
            with pdfplumber.open(path) as document:
                if not document.pages:
                    failures.append(f"{path.relative_to(root)}: no pages")
                    continue
                for page_number, page in enumerate(document.pages, start=1):
                    for word in page.extract_words(x_tolerance=1, y_tolerance=2):
                        if float(word["x0"]) < -1 or float(word["x1"]) > page.width + 1:
                            failures.append(f"{path.relative_to(root)} page {page_number}: text outside horizontal page bounds")
                            break
        except Exception as error:  # noqa: BLE001 - report every malformed source together
            failures.append(f"{path.relative_to(root)}: {error}")
    if failures:
        print("\n".join(failures[:50]))
        print(f"PDF visual-boundary QA failed with {len(failures)} issue(s).")
        return 1
    print(f"PDF visual-boundary QA passed for {len(pdfs)} canonical files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import hashlib
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree as ET


FORMAT_VERSION = "sygshift-ooxml-evidence/v1"
EXTRACTOR_VERSION = "0.1.0"

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

NS = {"m": MAIN_NS, "r": OFFICE_REL_NS, "p": PACKAGE_REL_NS}
RELATIONSHIP_ID = f"{{{OFFICE_REL_NS}}}id"


def sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_xml(archive: zipfile.ZipFile, member: str) -> ET.Element:
    with archive.open(member) as handle:
        return ET.parse(handle).getroot()


def relationship_part(source_part: str) -> str:
    directory, filename = posixpath.split(source_part)
    return posixpath.join(directory, "_rels", f"{filename}.rels")


def resolve_target(source_part: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))


def relationships(archive: zipfile.ZipFile, source_part: str) -> dict[str, dict[str, str]]:
    rels_part = relationship_part(source_part)
    if rels_part not in archive.namelist():
        return {}

    root = read_xml(archive, rels_part)
    result: dict[str, dict[str, str]] = {}
    for item in root.findall("p:Relationship", NS):
        relationship_id = item.attrib["Id"]
        target_mode = item.attrib.get("TargetMode", "Internal")
        target = item.attrib["Target"]
        result[relationship_id] = {
            "id": relationship_id,
            "type": item.attrib.get("Type", ""),
            "targetMode": target_mode,
            "target": target if target_mode == "External" else resolve_target(source_part, target),
        }
    return result


def cell_text(element: ET.Element | None) -> str | None:
    if element is None:
        return None
    parts = [item.text or "" for item in element.iter(f"{{{MAIN_NS}}}t")]
    return "".join(parts)


def write_ndjson(file_path: Path, records: Iterable[dict[str, Any]]) -> int:
    count = 0
    with file_path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
            handle.write("\n")
            count += 1
    return count


def parse_shared_strings(archive: zipfile.ZipFile, part: str | None) -> list[str]:
    if not part or part not in archive.namelist():
        return []
    root = read_xml(archive, part)
    return [cell_text(item) or "" for item in root.findall("m:si", NS)]


def parse_styles(archive: zipfile.ZipFile, part: str | None) -> list[dict[str, Any]]:
    if not part or part not in archive.namelist():
        return []

    root = read_xml(archive, part)
    fonts = root.find("m:fonts", NS)
    font_bold: list[bool] = []
    if fonts is not None:
        for font in fonts.findall("m:font", NS):
            bold = font.find("m:b", NS)
            font_bold.append(
                bold is not None and bold.attrib.get("val", "1").lower() not in {"0", "false", "off"}
            )

    cell_formats = root.find("m:cellXfs", NS)
    styles: list[dict[str, Any]] = []
    if cell_formats is None:
        return styles

    for index, cell_format in enumerate(cell_formats.findall("m:xf", NS)):
        font_id = int(cell_format.attrib.get("fontId", "0"))
        alignment = cell_format.find("m:alignment", NS)
        styles.append(
            {
                "styleIndex": index,
                "fontId": font_id,
                "bold": font_bold[font_id] if font_id < len(font_bold) else False,
                "fillId": int(cell_format.attrib.get("fillId", "0")),
                "borderId": int(cell_format.attrib.get("borderId", "0")),
                "numberFormatId": int(cell_format.attrib.get("numFmtId", "0")),
                "horizontalAlignment": alignment.attrib.get("horizontal") if alignment is not None else None,
                "verticalAlignment": alignment.attrib.get("vertical") if alignment is not None else None,
                "wrapText": alignment is not None
                and alignment.attrib.get("wrapText", "0").lower() in {"1", "true", "on"},
            }
        )
    return styles


def parse_comments(
    archive: zipfile.ZipFile,
    comments_part: str,
    sheet_index: int,
) -> list[dict[str, Any]]:
    root = read_xml(archive, comments_part)
    authors = [item.text or "" for item in root.findall("m:authors/m:author", NS)]
    records: list[dict[str, Any]] = []
    for comment in root.findall("m:commentList/m:comment", NS):
        author_id = int(comment.attrib.get("authorId", "0"))
        records.append(
            {
                "sheetIndex": sheet_index,
                "kind": "comment",
                "reference": comment.attrib.get("ref"),
                "author": authors[author_id] if author_id < len(authors) else None,
                "text": cell_text(comment.find("m:text", NS)),
            }
        )
    return records


def main() -> None:
    if len(sys.argv) not in {3, 4}:
        raise SystemExit(
            "Usage: extract_ooxml_metadata.py <source.xlsx> <private-output-directory> [expected-sha256]"
        )

    source_path = Path(sys.argv[1]).resolve()
    output_directory = Path(sys.argv[2]).resolve()
    expected_sha256 = sys.argv[3].strip().lower() if len(sys.argv) == 4 else None
    source_sha256 = sha256(source_path)

    if expected_sha256 and source_sha256 != expected_sha256:
        raise ValueError(
            f"Source fingerprint mismatch. Expected {expected_sha256}, received {source_sha256}."
        )

    output_directory.mkdir(parents=True, exist_ok=True)
    manifest_path = output_directory / "ooxml-manifest.json"
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if existing.get("source", {}).get("sha256") not in {None, source_sha256}:
            raise ValueError("The output directory contains OOXML evidence for a different source file.")

    with zipfile.ZipFile(source_path, "r") as archive:
        workbook_part = "xl/workbook.xml"
        workbook = read_xml(archive, workbook_part)
        workbook_relationships = relationships(archive, workbook_part)

        shared_strings_part = next(
            (
                item["target"]
                for item in workbook_relationships.values()
                if item["type"].endswith("/sharedStrings")
            ),
            None,
        )
        styles_part = next(
            (
                item["target"]
                for item in workbook_relationships.values()
                if item["type"].endswith("/styles")
            ),
            None,
        )
        shared_strings = parse_shared_strings(archive, shared_strings_part)
        styles = parse_styles(archive, styles_part)

        workbook_properties = workbook.find("m:workbookPr", NS)
        uses_1904_date_system = (
            workbook_properties is not None
            and workbook_properties.attrib.get("date1904", "0").lower() in {"1", "true", "on"}
        )

        sheet_output: list[dict[str, Any]] = []
        cell_output: list[dict[str, Any]] = []
        annotation_output: list[dict[str, Any]] = []
        relationship_output: list[dict[str, Any]] = []

        sheet_elements = workbook.findall("m:sheets/m:sheet", NS)
        for sheet_index, sheet_element in enumerate(sheet_elements):
            relationship_id = sheet_element.attrib[RELATIONSHIP_ID]
            relationship = workbook_relationships[relationship_id]
            sheet_part = relationship["target"]
            sheet = read_xml(archive, sheet_part)
            sheet_relationships = relationships(archive, sheet_part)

            hidden_rows: list[int] = []
            row_metadata: list[dict[str, Any]] = []
            for row in sheet.findall("m:sheetData/m:row", NS):
                row_number = int(row.attrib["r"])
                is_hidden = row.attrib.get("hidden", "0").lower() in {"1", "true", "on"}
                if is_hidden:
                    hidden_rows.append(row_number)
                if is_hidden or "ht" in row.attrib or "outlineLevel" in row.attrib:
                    row_metadata.append(
                        {
                            "row": row_number,
                            "hidden": is_hidden,
                            "height": float(row.attrib["ht"]) if "ht" in row.attrib else None,
                            "outlineLevel": int(row.attrib.get("outlineLevel", "0")),
                        }
                    )

            column_metadata: list[dict[str, Any]] = []
            for column in sheet.findall("m:cols/m:col", NS):
                column_metadata.append(
                    {
                        "min": int(column.attrib["min"]),
                        "max": int(column.attrib["max"]),
                        "hidden": column.attrib.get("hidden", "0").lower()
                        in {"1", "true", "on"},
                        "width": float(column.attrib["width"]) if "width" in column.attrib else None,
                        "styleIndex": int(column.attrib["style"]) if "style" in column.attrib else None,
                    }
                )

            merged_ranges = [
                item.attrib["ref"] for item in sheet.findall("m:mergeCells/m:mergeCell", NS)
            ]
            pane = sheet.find("m:sheetViews/m:sheetView/m:pane", NS)
            dimension = sheet.find("m:dimension", NS)
            auto_filter = sheet.find("m:autoFilter", NS)

            sheet_output.append(
                {
                    "index": sheet_index,
                    "name": sheet_element.attrib["name"],
                    "sheetId": sheet_element.attrib.get("sheetId"),
                    "state": sheet_element.attrib.get("state", "visible"),
                    "part": sheet_part,
                    "dimension": dimension.attrib.get("ref") if dimension is not None else None,
                    "mergedRanges": merged_ranges,
                    "rowMetadata": row_metadata,
                    "columnMetadata": column_metadata,
                    "pane": dict(sorted(pane.attrib.items())) if pane is not None else None,
                    "autoFilter": auto_filter.attrib.get("ref") if auto_filter is not None else None,
                    "conditionalFormattingCount": len(sheet.findall("m:conditionalFormatting", NS)),
                    "dataValidationCount": len(sheet.findall("m:dataValidations/m:dataValidation", NS)),
                }
            )

            for relationship_item in sorted(
                sheet_relationships.values(), key=lambda item: item["id"]
            ):
                relationship_output.append(
                    {
                        "sheetIndex": sheet_index,
                        **relationship_item,
                    }
                )

            hyperlinks_by_reference: dict[str, dict[str, Any]] = {}
            for hyperlink in sheet.findall("m:hyperlinks/m:hyperlink", NS):
                hyperlink_relationship_id = hyperlink.attrib.get(RELATIONSHIP_ID)
                hyperlink_relationship = (
                    sheet_relationships.get(hyperlink_relationship_id)
                    if hyperlink_relationship_id
                    else None
                )
                record = {
                    "sheetIndex": sheet_index,
                    "kind": "hyperlink",
                    "reference": hyperlink.attrib.get("ref"),
                    "location": hyperlink.attrib.get("location"),
                    "display": hyperlink.attrib.get("display"),
                    "tooltip": hyperlink.attrib.get("tooltip"),
                    "target": hyperlink_relationship.get("target")
                    if hyperlink_relationship
                    else None,
                }
                annotation_output.append(record)
                if record["reference"]:
                    hyperlinks_by_reference[record["reference"]] = record

            for relationship_item in sheet_relationships.values():
                if relationship_item["type"].endswith("/comments"):
                    annotation_output.extend(
                        parse_comments(archive, relationship_item["target"], sheet_index)
                    )

            for cell in sheet.findall("m:sheetData/m:row/m:c", NS):
                address = cell.attrib["r"]
                style_index = int(cell.attrib.get("s", "0"))
                style = styles[style_index] if style_index < len(styles) else None
                cell_type = cell.attrib.get("t", "n")
                value_element = cell.find("m:v", NS)
                raw_value = value_element.text if value_element is not None else None
                inline_string = cell.find("m:is", NS)
                resolved_text = None

                if cell_type == "s" and raw_value is not None:
                    shared_string_index = int(raw_value)
                    resolved_text = (
                        shared_strings[shared_string_index]
                        if shared_string_index < len(shared_strings)
                        else None
                    )
                elif cell_type == "inlineStr":
                    resolved_text = cell_text(inline_string)
                elif cell_type == "str":
                    resolved_text = raw_value

                formula_element = cell.find("m:f", NS)
                formula_attributes = (
                    dict(sorted(formula_element.attrib.items()))
                    if formula_element is not None and formula_element.attrib
                    else None
                )

                cell_output.append(
                    {
                        "sheetIndex": sheet_index,
                        "address": address,
                        "cellType": cell_type,
                        "styleIndex": style_index,
                        "fontId": style.get("fontId") if style else None,
                        "bold": style.get("bold") if style else False,
                        "fillId": style.get("fillId") if style else None,
                        "borderId": style.get("borderId") if style else None,
                        "numberFormatId": style.get("numberFormatId") if style else None,
                        "rawValue": raw_value,
                        "resolvedText": resolved_text,
                        "formula": formula_element.text if formula_element is not None else None,
                        "formulaAttributes": formula_attributes,
                        "hyperlink": hyperlinks_by_reference.get(address),
                    }
                )

    sheets_path = output_directory / "ooxml-sheets.ndjson"
    cells_path = output_directory / "ooxml-cells.ndjson"
    annotations_path = output_directory / "ooxml-annotations.ndjson"
    relationships_path = output_directory / "ooxml-relationships.ndjson"

    counts = {
        "sheets": write_ndjson(sheets_path, sheet_output),
        "cells": write_ndjson(cells_path, cell_output),
        "annotations": write_ndjson(annotations_path, annotation_output),
        "relationships": write_ndjson(relationships_path, relationship_output),
        "formulas": sum(1 for cell in cell_output if cell["formula"] is not None),
        "boldCells": sum(1 for cell in cell_output if cell["bold"]),
        "hiddenSheets": sum(1 for sheet in sheet_output if sheet["state"] != "visible"),
        "hiddenRows": sum(
            1 for sheet in sheet_output for row in sheet["rowMetadata"] if row["hidden"]
        ),
        "hiddenColumnRanges": sum(
            1
            for sheet in sheet_output
            for column in sheet["columnMetadata"]
            if column["hidden"]
        ),
    }

    evidence = {
        "sheets": {"filename": sheets_path.name, "sha256": sha256(sheets_path)},
        "cells": {"filename": cells_path.name, "sha256": sha256(cells_path)},
        "annotations": {
            "filename": annotations_path.name,
            "sha256": sha256(annotations_path),
        },
        "relationships": {
            "filename": relationships_path.name,
            "sha256": sha256(relationships_path),
        },
    }

    manifest = {
        "formatVersion": FORMAT_VERSION,
        "extractorVersion": EXTRACTOR_VERSION,
        "source": {
            "filename": source_path.name,
            "sha256": source_sha256,
            "byteSize": source_path.stat().st_size,
            "uses1904DateSystem": uses_1904_date_system,
        },
        "counts": counts,
        "evidence": evidence,
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    verification = all(
        sha256(output_directory / item["filename"]) == item["sha256"]
        for item in evidence.values()
    )
    if not verification:
        raise ValueError("OOXML evidence verification failed.")

    print(
        json.dumps(
            {
                "sourceSha256": source_sha256,
                "sheetCount": counts["sheets"],
                "cellCount": counts["cells"],
                "formulaCount": counts["formulas"],
                "boldCellCount": counts["boldCells"],
                "annotationCount": counts["annotations"],
                "verified": verification,
                "evidenceSha256": hashlib.sha256(
                    ":".join(item["sha256"] for item in evidence.values()).encode("ascii")
                ).hexdigest(),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()

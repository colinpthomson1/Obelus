#!/usr/bin/env python3
"""Validate the Obelus brand package and write its delivery manifest."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

from fontTools.ttLib import TTFont
from PIL import Image
from pypdf import PdfReader


PACKAGE = Path(__file__).resolve().parents[1]
MANIFEST = PACKAGE / "FILE_MANIFEST.csv"
CHECKSUMS = PACKAGE / "SHA256SUMS.txt"
GENERATED = {MANIFEST, CHECKSUMS}
LINK_ATTRS = {"href", "src", "poster", "data"}
SKIP_SCHEMES = {"http", "https", "mailto", "tel", "data", "javascript"}


class LocalLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, _tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for key, value in attrs:
            if key in LINK_ATTRS and value:
                self.links.append(value)


def package_files() -> list[Path]:
    return sorted(
        (
            path
            for path in PACKAGE.rglob("*")
            if path.is_file()
            and path not in GENERATED
            and "__pycache__" not in path.parts
            and path.suffix.lower() != ".pyc"
        ),
        key=lambda path: path.relative_to(PACKAGE).as_posix().lower(),
    )


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def local_target(base: Path, raw: str) -> Path | None:
    raw = raw.strip()
    if not raw or raw.startswith("#") or raw.startswith("//"):
        return None
    parsed = urlsplit(raw)
    if parsed.scheme.lower() in SKIP_SCHEMES:
        return None
    path_text = unquote(parsed.path)
    if not path_text:
        return None
    return (base / path_text).resolve()


def validate_links(path: Path, errors: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    parser = LocalLinkParser()
    parser.feed(text)
    for raw in parser.links:
        target = local_target(path.parent, raw)
        if target and not target.exists():
            errors.append(f"Broken HTML link in {path.relative_to(PACKAGE)}: {raw}")

    for raw in re.findall(r"url\(\s*['\"]?([^)'\"]+)", text):
        target = local_target(path.parent, raw)
        if target and not target.exists():
            errors.append(f"Broken CSS URL in {path.relative_to(PACKAGE)}: {raw}")


def validate_file(path: Path, errors: list[str]) -> None:
    relative = path.relative_to(PACKAGE).as_posix()
    suffix = path.suffix.lower()
    if path.stat().st_size == 0:
        errors.append(f"Zero-byte file: {relative}")
        return

    try:
        if suffix == ".svg":
            root = ET.parse(path).getroot()
            if not root.tag.endswith("svg"):
                errors.append(f"Unexpected SVG root in {relative}: {root.tag}")
        elif suffix == ".json" or path.name == "site.webmanifest":
            data = json.loads(path.read_text(encoding="utf-8"))
            if path.name.endswith(".lottie.json"):
                required = {"v", "fr", "ip", "op", "w", "h", "layers"}
                missing = required.difference(data)
                if missing:
                    errors.append(f"Incomplete Lottie file {relative}: {sorted(missing)}")
        elif suffix in {".html", ".htm", ".css"}:
            validate_links(path, errors)
        elif suffix in {".png", ".gif", ".ico"}:
            with Image.open(path) as image:
                image.verify()
        elif suffix == ".pdf":
            reader = PdfReader(str(path))
            if not reader.pages:
                errors.append(f"PDF has no pages: {relative}")
        elif suffix in {".ttf", ".otf", ".woff", ".woff2"}:
            font = TTFont(str(path), lazy=True)
            font.close()
    except Exception as exc:  # preserve every error in one QA report
        errors.append(f"Could not validate {relative}: {exc}")


def write_delivery_records(files: list[Path]) -> None:
    rows = []
    sums = []
    for path in files:
        relative = path.relative_to(PACKAGE).as_posix()
        sha256 = digest(path)
        rows.append((relative, path.suffix.lower().lstrip(".") or "none", path.stat().st_size, sha256))
        sums.append(f"{sha256}  {relative}")

    with MANIFEST.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(("relative_path", "file_type", "bytes", "sha256"))
        writer.writerows(rows)
    CHECKSUMS.write_text("\n".join(sums) + "\n", encoding="utf-8")


def main() -> int:
    files = package_files()
    errors: list[str] = []
    for path in files:
        validate_file(path, errors)

    if errors:
        print("Obelus package QA failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    write_delivery_records(files)
    counts: dict[str, int] = {}
    for path in files:
        key = path.suffix.lower() or "[none]"
        counts[key] = counts.get(key, 0) + 1
    print(f"Validated {len(files)} files with no structural or local-link errors.")
    print("Formats: " + ", ".join(f"{key}={value}" for key, value in sorted(counts.items())))
    print(f"Wrote {MANIFEST.name} and {CHECKSUMS.name}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

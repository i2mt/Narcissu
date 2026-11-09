#!/usr/bin/env python3
"""Assemble a Narcissu GitHub Pages payload from root-level or site/ sources."""
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def source_roots(project_root: Path, payload_root: Path) -> list[Path]:
    """Return source roots in precedence order, without duplicates."""
    roots = [project_root, payload_root, project_root / "site"]
    unique: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        resolved = root.resolve()
        if resolved not in seen:
            unique.append(resolved)
            seen.add(resolved)
    return unique


def find_source(relative: str, roots: list[Path]) -> Path | None:
    for root in roots:
        candidate = root / relative
        if candidate.is_file():
            return candidate
    return None


def find_payload_root(project_root: Path) -> Path:
    """Find the directory containing data/asset-manifest.json and public/."""
    candidates = [project_root, project_root / "site"]
    for candidate in candidates:
        if (
            (candidate / "data/asset-manifest.json").is_file()
            and (candidate / "public").is_dir()
        ):
            return candidate
    raise SystemExit(
        "Could not find data/asset-manifest.json and public/ in either "
        "the repository root or site/."
    )


def shell_files(project_root: Path, payload_root: Path) -> tuple[Path, list[str]]:
    """Read SHELL_FILES from the root or nested site service worker."""
    roots = source_roots(project_root, payload_root)
    worker = find_source("service-worker.js", roots)
    if worker is None:
        searched = [str(root / "service-worker.js") for root in roots]
        raise SystemExit(
            "Could not find service-worker.js. Searched: " + ", ".join(searched)
        )

    source = worker.read_text(encoding="utf-8")
    match = re.search(r"const\s+SHELL_FILES\s*=\s*\[(.*?)\];", source, re.S)
    if not match:
        raise SystemExit(
            f"Could not parse SHELL_FILES from {worker}"
        )
    return worker, re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))


def build(destination: Path, project_root: Path = PROJECT_ROOT) -> tuple[int, int]:
    project_root = project_root.resolve()
    destination = destination.resolve()
    if destination == project_root or project_root in destination.parents:
        raise SystemExit("Destination must be outside the source project tree.")

    payload_root = find_payload_root(project_root)
    roots = source_roots(project_root, payload_root)
    worker, shell = shell_files(project_root, payload_root)

    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    copied = 0

    # Copy the worker discovered above, even when it lives under site/.
    runtime_files = ["service-worker.js", *shell]
    for item in runtime_files:
        relative = item.removeprefix("./")
        if not relative:
            continue
        if relative == "service-worker.js":
            source = worker
        else:
            source = find_source(relative, roots)
        if source is None:
            raise SystemExit(
                f"Missing shell resource: {relative}. "
                "Checked repository root and site/."
            )
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied += 1

    manifest_path = payload_root / "data/asset-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for metadata in manifest["assets"].values():
        # Original media plus portrait and landscape mobile artwork.
        for asset_url in dict.fromkeys(
            value for value in (
                metadata.get("url"),
                metadata.get("mobile_url"),
                metadata.get("mobile_landscape_url"),
            ) if value
        ):
            relative = Path("public") / asset_url
            source = payload_root / relative
            if not source.is_file():
                # Some repositories keep public/ at the other supported root.
                source = find_source(relative.as_posix(), roots)
            if not source.is_file():
                raise SystemExit(f"Missing game asset: {relative.as_posix()}")
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copy2(source, target)
                copied += 1

    (destination / ".nojekyll").write_text("", encoding="utf-8")
    total_size = sum(
        path.stat().st_size for path in destination.rglob("*") if path.is_file()
    )
    return copied, total_size


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    count, size = build(args.output)
    print(
        f"GitHub Pages payload ready: {count} files, "
        f"{size:,} bytes ({size / 1024 / 1024:.1f} MiB)"
    )
    print(f"Output: {args.output.resolve()}")


if __name__ == "__main__":
    main()

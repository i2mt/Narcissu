#!/usr/bin/env python3
"""Assemble only the runtime files needed for the Narcissu GitHub Pages site."""
from __future__ import annotations
import argparse, json, re, shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

def shell_files(project_root: Path) -> list[str]:
    source = (project_root / "service-worker.js").read_text(encoding="utf-8")
    match = re.search(r"const\s+SHELL_FILES\s*=\s*\[(.*?)\];", source, re.S)
    if not match:
        raise SystemExit("Could not parse SHELL_FILES from service-worker.js")
    return re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))

def build(destination: Path, project_root: Path = PROJECT_ROOT) -> tuple[int, int]:
    destination = destination.resolve()
    if destination == project_root.resolve() or project_root.resolve() in destination.parents:
        raise SystemExit("Destination must be outside the source project tree.")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    copied = 0
    # The worker script itself is registered by the page but is not part of its own shell list.
    runtime_files = ["service-worker.js", *shell_files(project_root)]
    for item in runtime_files:
        relative = item.removeprefix("./")
        if not relative:
            continue
        source = project_root / relative
        if not source.is_file():
            raise SystemExit(f"Missing shell resource: {relative}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied += 1
    manifest = json.loads((project_root / "data/asset-manifest.json").read_text(encoding="utf-8"))
    for metadata in manifest["assets"].values():
        # Original media plus device-specific, letterbox-cropped mobile artwork.
        for asset_url in dict.fromkeys(
            value for value in (
                metadata.get("url"),
                metadata.get("mobile_url"),
                metadata.get("mobile_landscape_url"),
            ) if value
        ):
            relative = Path("public") / asset_url
            source = project_root / relative
            if not source.is_file():
                raise SystemExit(f"Missing game asset: {relative.as_posix()}")
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copy2(source, target)
                copied += 1
    (destination / ".nojekyll").write_text("", encoding="utf-8")
    return copied, sum(p.stat().st_size for p in destination.rglob("*") if p.is_file())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    count, size = build(args.output)
    print(f"GitHub Pages payload ready: {count} files, {size:,} bytes ({size/1024/1024:.1f} MiB)")
    print(f"Output: {args.output.resolve()}")

if __name__ == "__main__":
    main()

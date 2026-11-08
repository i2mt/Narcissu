\
#!/usr/bin/env python3
"""Copy all Increment 47 mobile artwork variants into a staged GitHub Pages site."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PROJECT_ROOT / "data" / "asset-manifest.json"


def copy_mobile_assets(site: Path) -> tuple[int, int]:
    site = site.resolve()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    paths = sorted({
        str(item[field]).replace("\\", "/").lstrip("/")
        for item in manifest.get("assets", {}).values()
        for field in ("mobile_url", "mobile_landscape_url")
        if item.get(field)
    })
    if not paths:
        raise SystemExit("No mobile_url/mobile_landscape_url entries found in asset-manifest.json")

    missing_source = [
        path for path in paths
        if not (PROJECT_ROOT / "public" / path).is_file()
    ]
    if missing_source:
        raise SystemExit(
            "Mobile artwork is missing from the repository source folder. "
            "Upload the complete public/mobile-assets folder from Increment 47. "
            f"Missing examples: {missing_source[:10]}"
        )

    copied = 0
    total_bytes = 0
    for path in paths:
        source = PROJECT_ROOT / "public" / path
        target = site / "public" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied += 1
        total_bytes += target.stat().st_size

    missing_site = [
        path for path in paths
        if not (site / "public" / path).is_file()
    ]
    if missing_site:
        raise SystemExit(f"Copy did not complete; missing site files: {missing_site[:10]}")

    return copied, total_bytes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", nargs="?", type=Path, default=Path("site"))
    args = parser.parse_args()
    count, size = copy_mobile_assets(args.site)
    print(
        f"Mobile artwork ready: {count} files copied; "
        f"{size:,} bytes across all referenced portrait/landscape variants."
    )
    print(f"Verified destination: {(args.site.resolve() / 'public/mobile-assets')}")


if __name__ == "__main__":
    main()

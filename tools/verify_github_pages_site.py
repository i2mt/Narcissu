#!/usr/bin/env python3
"""Verify a staged Narcissu static-site payload for GitHub Pages."""
from __future__ import annotations
import argparse, json, re
from pathlib import Path
from urllib.parse import urljoin, urlparse

PROJECT_SITE_PREFIX = "https://i2mt.github.io/Narcissu/"


def has_relative_service_worker_registration(app: str) -> bool:
    """Accept a relative worker URL with or without registration options."""
    pattern = r"""navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(\s*(['"])\./service-worker\.js\1(?=\s*[,)])"""
    return re.search(pattern, app) is not None


def shell_files(site: Path) -> list[str]:
    source = (site / "service-worker.js").read_text(encoding="utf-8")
    match = re.search(r"const\s+SHELL_FILES\s*=\s*\[(.*?)\];", source, re.S)
    if not match:
        raise SystemExit("Could not parse service-worker shell list")
    return re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))

def verify(site: Path) -> dict:
    site = site.resolve()
    required = [
        "index.html", "styles.css", "app.js", "service-worker.js", "manifest.webmanifest",
        "data/story-gp32.json", "data/asset-manifest.json",
        "fonts/NotoSans-Regular.ttf", "fonts/NotoSansArabic-Regular.ttf",
        "icons/narcissu-192.png", "icons/narcissu-512.png", ".nojekyll",
    ]
    missing = [name for name in required if not (site / name).is_file()]
    if missing:
        raise SystemExit(f"Missing required site files: {missing}")
    shell = shell_files(site)
    missing_shell = [p.removeprefix("./") for p in shell if p != "./" and not (site / p.removeprefix("./")).is_file()]
    if missing_shell:
        raise SystemExit(f"Missing service-worker shell files: {missing_shell[:10]}")
    manifest = json.loads((site / "data/asset-manifest.json").read_text(encoding="utf-8"))
    missing_assets = [item["url"] for item in manifest["assets"].values() if not (site / "public" / item["url"]).is_file()]
    if missing_assets:
        raise SystemExit(f"Missing media assets: {missing_assets[:10]}")
    if (site / "data/source").exists():
        raise SystemExit("Source-only materials must not be included in the Pages payload")
    webmanifest = json.loads((site / "manifest.webmanifest").read_text(encoding="utf-8"))
    if any(value.startswith("/") for value in [webmanifest["id"], webmanifest["scope"], webmanifest["start_url"]]):
        raise SystemExit("Manifest paths must be relative for project-site deployments")
    html = (site / "index.html").read_text(encoding="utf-8")
    if re.search(r"(?:href|src)\s*=\s*['\"]/", html, re.I):
        raise SystemExit("Found root-absolute HTML asset path; project Pages sites require relative paths")
    app = (site / "app.js").read_text(encoding="utf-8")
    if not has_relative_service_worker_registration(app):
        raise SystemExit("Service worker registration is no longer relative")
    if "new URL(`./public/${item.url}`, document.baseURI)" not in app or "new URL(`./public/${x.url}`,document.baseURI)" not in app:
        raise SystemExit("Asset URLs are no longer derived from document.baseURI")
    base = PROJECT_SITE_PREFIX
    refs = [
        "./index.html", "./styles.css", "./app.js", "./service-worker.js", "./manifest.webmanifest",
        "./data/story-gp32.json", "./data/asset-manifest.json", "./data/localization/fa.json",
        "./public/assets/bgm/a01.mp3",
    ]
    prefix = urlparse(base).path
    escaped = [urljoin(base, ref) for ref in refs if not urlparse(urljoin(base, ref)).path.startswith(prefix)]
    if escaped:
        raise SystemExit(f"Project-site URLs escape repository prefix: {escaped}")
    total_bytes = sum(p.stat().st_size for p in site.rglob("*") if p.is_file())
    largest = max((p.stat().st_size for p in site.rglob("*") if p.is_file()), default=0)
    if total_bytes >= 1_000_000_000:
        raise SystemExit(f"Published site exceeds GitHub Pages 1 GB limit: {total_bytes:,} bytes")
    if largest >= 100_000_000:
        raise SystemExit(f"A file exceeds GitHub's 100 MB regular Git file limit: {largest:,} bytes")
    return {
        "file_count": sum(1 for p in site.rglob("*") if p.is_file()),
        "service_worker_shell_count": len([p for p in shell if p != "./"]),
        "asset_count": len(manifest["assets"]),
        "total_bytes": total_bytes,
        "largest_file_bytes": largest,
        "github_project_path_test": "passed",
        "source_archives_excluded": True,
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.site), indent=2))

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Verify a staged Narcissu static-site payload for GitHub Pages."""
from __future__ import annotations
import argparse, json, re
from pathlib import Path
from urllib.parse import urljoin, urlparse

PROJECT_SITE_PREFIX = "https://i2mt.github.io/Narcissu/"

def shell_files(site: Path) -> list[str]:
    source = (site / "service-worker.js").read_text(encoding="utf-8")
    match = re.search(r"const\s+SHELL_FILES\s*=\s*\[(.*?)\];", source, re.S)
    if not match:
        raise SystemExit("Could not parse service-worker shell list")
    return re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))

def verify(site: Path) -> dict:
    site = site.resolve()
    required = [
        "index.html", "styles.css", "responsive.css", "app.js", "service-worker.js", "manifest.webmanifest",
        "public/assets/images/narcissu-coastal-background.jpg",
        "public/assets/audio/narcissu-coastal-ambience.mp3",
        "data/story-gp32.json", "data/asset-manifest.json",
        "fonts/NotoSans-Regular.ttf", "fonts/NotoSansArabic-Regular.ttf",
        "icons/narcissu-192.png", "icons/narcissu-512.png", "icons/fox-emblem-white.png", ".nojekyll",
    ]
    missing = [name for name in required if not (site / name).is_file()]
    if missing:
        raise SystemExit(f"Missing required site files: {missing}")
    shell = shell_files(site)
    missing_shell = [p.removeprefix("./") for p in shell if p != "./" and not (site / p.removeprefix("./")).is_file()]
    if missing_shell:
        raise SystemExit(f"Missing service-worker shell files: {missing_shell[:10]}")
    manifest = json.loads((site / "data/asset-manifest.json").read_text(encoding="utf-8"))
    missing_assets = []
    mobile_variant_count = 0
    for item in manifest["assets"].values():
        for field in ("url", "mobile_url", "mobile_landscape_url"):
            asset_url = item.get(field)
            if asset_url and not (site / "public" / asset_url).is_file():
                missing_assets.append(asset_url)
            if field in ("mobile_url", "mobile_landscape_url") and asset_url:
                mobile_variant_count += 1
                if not asset_url.startswith("assets/mobile-assets/"):
                    missing_assets.append(f"incorrect mobile path prefix: {asset_url}")
    if missing_assets:
        raise SystemExit(f"Missing media assets: {missing_assets[:10]}")
    if (site / "data/source").exists():
        raise SystemExit("Source-only materials must not be included in the Pages payload")
    webmanifest = json.loads((site / "manifest.webmanifest").read_text(encoding="utf-8"))
    if any(value.startswith("/") for value in [webmanifest["id"], webmanifest["scope"], webmanifest["start_url"]]):
        raise SystemExit("Manifest paths must be relative for project-site deployments")
    html = (site / "index.html").read_text(encoding="utf-8")
    if "./responsive.css" not in html:
        raise SystemExit("Responsive stylesheet is not linked from index.html")
    if "homeBackgroundVideo" in html or "<video" in html.lower():
        raise SystemExit("The menu should use the supplied still photo, not the rejected generated MP4")
    if "homeAmbientAudio" not in html:
        raise SystemExit("The optional coastal ambience audio element is missing")
    responsive_css = (site / "responsive.css").read_text(encoding="utf-8")
    if "home-backdrop-photo" not in responsive_css or "narcissu-coastal-background.jpg" not in html:
        raise SystemExit("The supplied still photo is not configured as the menu background")
    if re.search(r"(?:href|src)\s*=\s*['\"]/", html, re.I):
        raise SystemExit("Found root-absolute HTML asset path; project Pages sites require relative paths")
    app = (site / "app.js").read_text(encoding="utf-8")
    if "navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' })" not in app:
        raise SystemExit("Service worker registration is no longer relative")
    if "new URL(`./public/${selectedPath}`, document.baseURI)" not in app or "new URL(`./public/${path}`,document.baseURI)" not in app:
        raise SystemExit("Asset URLs are no longer derived from document.baseURI")
    if "mobile_landscape_url" not in app or "isMobileArtworkViewport" not in app:
        raise SystemExit("Mobile artwork variants are not wired into the reader")
    if "narcissu-assets-v6" not in app or "narcissu-assets-v6" not in (site / "service-worker.js").read_text(encoding="utf-8"):
        raise SystemExit("Media asset cache version is inconsistent")
    if "narcissu-coastal-background.jpg" not in app or "narcissu-coastal-ambience.mp3" not in app:
        raise SystemExit("Menu photo/audio are not included in the offline download")
    if "narcissu-coastal-loop.mp4" in app or "narcissu-coastal-loop.mp4" in (site / "service-worker.js").read_text(encoding="utf-8"):
        raise SystemExit("Obsolete generated MP4 remains referenced by the application")
    service_worker = (site / "service-worker.js").read_text(encoding="utf-8")
    if "./responsive.css" not in service_worker:
        raise SystemExit("Responsive stylesheet is not included in the service-worker shell")
    base = PROJECT_SITE_PREFIX
    refs = [
        "./index.html", "./styles.css", "./responsive.css", "./app.js", "./service-worker.js", "./manifest.webmanifest",
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
        "mobile_variant_count": mobile_variant_count,
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

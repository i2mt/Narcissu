# Narcissu — Persian Edition | GitHub Pages deployment kit

**Build:** 0.40  
**Status:** Prepared for GitHub Pages; not deployed. Public deployment is deliberately gated until written distribution permission is secured.

This is a *deployment-only* repository layout. It contains the browser application and the story/media data required to run it. It intentionally excludes the archival Persian PDF, original Ponscripter source script, OCR files, private working documents, editorial workbooks and internal QA files.

## Important: do not publish before rights clearance

GitHub Pages websites are publicly accessible, including sites deployed from eligible private repositories. The deployed application necessarily exposes the story data, Persian text, artwork, music and sound files that it serves to visitors. Written permission for public distribution of the modified bilingual game and all included copyrighted material has not yet been documented.

The workflow in `.github/workflows/deploy-pages.yml` is therefore manual-only and has a required `distribution_rights_confirmed` checkbox. Leave it unchecked unless written permission has actually been obtained. If unchecked, the deploy job is skipped.

## Repository setup

1. Create a GitHub repository named `narcissu-persian-edition` (or another name you prefer).
2. Upload the contents of this kit to the repository root. Keep the `site/`, `.github/` and `tools/` folders in their current locations.
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment → Source**, select **GitHub Actions**.
5. Do not run the deployment workflow until distribution permission is confirmed.
6. After permission is secured, open **Actions → Deploy Narcissu Persian Edition to GitHub Pages → Run workflow** and tick `distribution_rights_confirmed`.
7. When the workflow succeeds, open **Settings → Pages → Visit site**.

For a project repository, the URL will be:

`https://OWNER.github.io/REPOSITORY/`

The app's HTML, CSS, JavaScript, manifest, media paths and service-worker registration are relative. They are designed to remain inside the repository path; you do not need to insert your username or repository name into the source.

If the repository is named `OWNER.github.io`, GitHub uses the account root URL instead.

## What the payload contains

- 626 runtime files plus the `.nojekyll` marker (627 total files), including the application shell, story data, localization overlays, fonts and icons.
- All 594 game assets referenced by the asset manifest.
- Approximately 88.5 MB (84.4 MiB) uncompressed.
- Largest individual file: approximately 4.6 MB.
- `.nojekyll` is included in the published document root.
- The original 2016 PDF, source script and OCR files are excluded.

The payload is below GitHub Pages' published-site size limit of 1 GB. GitHub documents a soft bandwidth limit of 100 GB/month; this is a small project site today, but audio-heavy play and many visitors can increase transfer. Review GitHub's current limits before a public launch.

## Offline/PWA notes

- The service worker is registered relative to the deployed site directory.
- The web manifest uses relative `id`, `start_url`, `scope` and icon paths.
- The application shell is cached separately from the 594 media files.
- Visitors must use **Download for offline** and wait for all assets to finish caching before expecting full offline play.
- Real installation and offline behavior still need verification after the first successful GitHub Pages deployment, on desktop and physical iOS/Android devices.

## Updating the game

Replace the relevant files under `site/`, commit and push. This kit uses a manual deployment workflow so a push alone does not publish. After rights clearance, run the workflow again. The verifier checks that the runtime shell, all 594 media assets, relative project paths and source-file exclusions remain valid.

## Local validation

From the repository root:

```bash
python tools/verify_github_pages_site.py site
node --check site/app.js
node --check site/service-worker.js
```

## Official GitHub guidance

- GitHub Pages setup and project-site URLs: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- Custom Actions deployment: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits

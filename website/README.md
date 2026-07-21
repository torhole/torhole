# Torhole public website

This directory is the source deployed at [torhole.com](https://torhole.com).
It is a dependency-free static site with a Three.js privacy-topology scene,
light and dark themes, and real captures of the Torhole administration UI.

## Structure

- `index.html`: complete page, styles, interactions, and scene setup
- `legal.html`: public independence, trademark, and license notice
- `third-party-licenses.txt`: license text shipped for the public Three.js dependency
- `assets/`: Torhole icons
- `shots/`: optimized product captures used by the proof section
- `_headers`: Cloudflare security and cache policy
- `robots.txt` and `sitemap.xml`: search-engine metadata
- `.assetsignore`: prevents local prototype and dependency files from being published

## Preview

From the repository root:

```bash
python3 -m http.server 4173 --directory website
```

Then open `http://127.0.0.1:4173`.

## Deploy

The production site is the existing Cloudflare Worker named `torhole` with
custom domains for `torhole.com` and `www.torhole.com`.

```bash
npx wrangler deploy \
  --name torhole \
  --assets website \
  --compatibility-date 2026-07-21 \
  --keep-vars
```

Cloudflare keeps previous Worker versions available for rollback.

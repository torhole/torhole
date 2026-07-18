# Recording the README demo GIF

This is a guide for capturing a short, well-paced walkthrough of the Torhole admin UI that lands at the top of the README. It is **not** automated — you run through the click path once, using a screen recorder, and export to GIF.

## Goal

A single GIF, **≤ 10 MB**, **≤ 30 seconds**, showing off the end-to-end value prop in one continuous take. It should answer the question "what is this thing?" in the time it takes to read the README hero paragraph.

## Output spec

- **Format**: animated GIF (Markdown renders it inline, no autoplay quirks)
- **Dimensions**: 1280 × 720, or 1440 × 810 if your recorder gives you that option
- **Frame rate**: 15 fps (GIF palette is the bottleneck, not frame rate)
- **Duration**: 25–30 seconds
- **File size**: ≤ 10 MB after encoding. If you go over, drop fps to 12 or dimensions to 1152 × 648.
- **Save to**: `docs/images/demo.gif`

## Recommended tools

- **Mac**: [Kap](https://getkap.co/) — free, excellent GIF export, lets you resize the recording region to a fixed rectangle
- **Mac** (alt): CleanShot X's "Record GIF" mode — paid but higher quality palettes
- **Linux**: Peek — simple, good-enough GIF export

Whatever you pick, set the recording region to the v2 UI viewport (1280 × 720 works well — hides the macOS title bar and gives a clean edge).

## Browser setup before recording

1. Use a **clean browser profile** or incognito window so no bookmarks bar or other extensions show.
2. Set **zoom to 100%** (`Cmd-0`).
3. Resize the window to exactly **1280 × 720** (or whatever matches your recording region).
4. Close DevTools.
5. Open `https://th-torhole.<your-domain>/v2/` and sign in BEFORE starting the recording — the Authelia redirect is not part of the demo.
6. Wait for the Glance screen to finish loading (live counters should be showing real numbers, not placeholders).

## Click path (25 seconds total)

Practise this once before the real take. You're looking for steady pacing — no dwelling but no rushing past anything.

| Time | Action | Why |
|---|---|---|
| 0:00 | Start on **Glance**, everything healthy | Opens on the headline: "Is the privacy guarantee intact?" |
| 0:03 | Click the **Privacy** sidebar link | Transition to the proof screen |
| 0:04 | Tor runtime strip becomes visible at the top | Shows live control-port data — bootstrap 100%, liveness up, circuits established |
| 0:07 | Click the **Run leak test** tile (on the DNS leak test tab — default) | Demonstrates the leak test |
| 0:09 | Running → PASS state renders with Tor exit IP | The money shot |
| 0:12 | Click the **Live query feed** tab | Real-time DNS queries streaming in |
| 0:14 | Let 3–4 queries scroll past | Visual confirmation of SSE |
| 0:16 | Click **Internal circuits** tab | Shows advanced Tor circuit data |
| 0:18 | Click the **Operate** sidebar link | Transition to ops |
| 0:19 | Click the **Insights** tab (third from right) | Show the Grafana tile grid |
| 0:22 | Hover over one of the Grafana tiles (don't click — opens new tab) | Visual confirmation of the link-out pattern |
| 0:24 | Click the **Glance** sidebar link to return home | Close the loop |
| 0:27 | Hold on Glance for 3 seconds | Give the viewer a beat to register the final state |
| 0:30 | End | |

**Mouse movement tip**: move the mouse deliberately but not slowly. Quick flicks look choppy in a GIF; slow drags look boring. Aim for ~200ms per click-to-next-click.

## Don't

- Don't record during a known-bad state (any red dots, any "degraded"). Wait until everything is green.
- Don't record with the Live query feed at 0 events — run `dig @<pi-hole-ip> example.com` from a plane client before recording so there's traffic scrolling.
- Don't include the mouse cursor on the Authelia login page.
- Don't use a system-wide dark mode toggle mid-record. Keep the environment static.

## Post-process

After recording:

1. Open the GIF in your viewer, confirm it's under 10 MB.
2. If it's oversized:
   - Drop FPS from 15 → 12 (`gifsicle -O3 --lossy=60 -o out.gif in.gif`)
   - Or drop dimensions by 10% (`gifsicle --resize-width 1152 ...`)
3. Move the final file to `docs/images/demo.gif`
4. Update the README hero line from the current static image to the GIF:

```markdown
<p align="center">
  <img src="docs/images/demo.gif" alt="Torhole admin UI walkthrough" width="900">
</p>
```

## Historical note

The static screenshots in `docs/images/screen-*.png` are harvested from the Playwright visual regression baselines at `monitoring/torhole-ui-v2/tests/visual.spec.ts-snapshots/`. When the UI changes and those baselines are regenerated, the static docs screenshots should be refreshed too — the harvest is a simple `cp` from the snapshots dir.

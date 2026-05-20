# Rally of Death — Biff Chase

Multiplayer top-down 2D rally combat for the browser. Procedurally generated tracks, procedurally drawn cars, first to 10 points wins the match.

**Tech:** Vite, PixiJS, Matter.js, ecs-lib, PeerJS (WebRTC).

## Running locally

```bash
npm install
npm run dev
```

Open the printed URL in two tabs to play multiplayer (one hosts, the other joins via the share link).

## Build / deploy

```bash
npm run build
```

Pushes to `main` deploy to GitHub Pages automatically via `.github/workflows/deploy.yml`.

## Controls

- **W / ↑** — accelerate
- **S / ↓** — brake / reverse
- **A / ←**, **D / →** — steer
- **Space** — handbrake (drift)
- **Q** — use item

## Scoring

- 1st place: **2 points** (or 1 in a 2-player race)
- 2nd place: **1 point** (only in 3+ player races)
- First to **10 points** wins the match.

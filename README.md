# Physics Sandbox

A real-time, browser-based physics playground — build things, break things, and (eventually) zoom
from a tabletop all the way out to a solar system or down to the atoms.

**Stack:** [Vite](https://vitejs.dev) + TypeScript · [Three.js](https://threejs.org) (rendering) ·
[Rapier](https://rapier.rs) (real-time physics, Rust→WASM). Rapier and Three are both right-handed,
Y-up, so physics transforms copy straight into the renderer — no coordinate conversion.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## What works now — Phase 1 (the real-time core)

- **Hundreds of objects at 60fps.** Drawn with `InstancedMesh` (one draw call per shape), stepped by
  Rapier at a fixed timestep with render interpolation for glassy motion.
- **Spawn** boxes & spheres (or `+100` at once), **drag & throw** any object with the mouse,
  **orbit/pan/zoom** camera.
- **Gravity** slider + Earth / Moon / Zero-G presets, **reset scene**.
- **Object inspector** — click any object to see its live speed, angular velocity, mass, energy, and
  sleep state.
- Live **FPS / object-count / awake-count** HUD.

Controls: **left-drag an object** to throw it · **left-drag empty space** to orbit · **scroll** to
zoom · **right-drag** to pan · **click** an object to inspect it.

## Everything else (the plan)

This is Phase 1 of a large, deliberately-phased project. **Nothing we discussed is lost** — it's all
captured here:

- [`docs/ROADMAP.md`](docs/ROADMAP.md) — the phases and the three worlds, in order.
- [`docs/FEATURES.md`](docs/FEATURES.md) — the full catalog of every feature discussed (a checklist).
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the core loop, the data model, and where each future
  feature plugs in.
- [`src/systems/README.md`](src/systems/README.md) — the code map: a named home for every future system.

Design docs (rich, external): the
[Roadmap](https://claude.ai/code/artifact/fe998663-c9e2-4526-9c8b-06cf9b895aad),
[Build handbook](https://claude.ai/code/artifact/0606573c-1d08-41d1-bc9d-d15db8fbc760), and
[Extensions](https://claude.ai/code/artifact/46ecb390-e851-4e34-b3f2-d7c92c4f65b0).

## Project layout

```
src/
  main.ts            boot: init Rapier, create Sandbox, wire UI, start
  sandbox.ts         Phase 1 core — Rapier world + Three render + fixed-timestep loop + spawn/drag/select
  ui.ts              control panel, HUD, object inspector (DOM; reads/commands the Sandbox only)
  style.css
  systems/           future features, each a "system" over the entity registry (see its README)
  worlds/            Cosmos / Quantum / Subatomic — separate solvers, shared renderer (see its README)
docs/                roadmap, feature catalog, architecture
```

## Philosophy (carried from a prior verified engine)

Physics is the single source of truth; the renderer only reads it. Fixed timestep, deterministic
stepping, and a systems-based architecture mean features are *added*, not bolted through the core —
and determinism later pays off for replays, shareable recordings, and (someday) a robot digital-twin.

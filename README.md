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

## What works now

- **Real-time core** — 1000+ objects, fixed timestep + render interpolation, drag & throw, pause /
  slow-mo, save / load, object inspector and live free-body forces window (real SI units).
- **Shapes from equations** — solids of revolution, parametric curves & surfaces, implicit surfaces,
  ~200-formula library, exact mass & inertia; materials (rubber, steel, ice, wood, stone, foam).
- **Forces & fields** — attract / repel, wind (with gusts), vortex, tornado, flow paths (incl. drawn),
  gravity well, turbulence, magnetic (Lorentz, per-object charge), **magnet** (pulls steel only),
  drag zone, **liquid tanks** (water / sea / oil / honey / mercury, waves, currents), explosions.
  Fields can be **carried by objects**. An **Arcade ↔ Realistic** force model: Realistic flows are
  moving air that push by drag on each shape; blasts are TNT-scaled with shielding.
- **Realistic media** — multi-point buoyancy (floats right themselves), added mass, the real sphere
  drag curve, viscosity, wave-radiation damping, air resistance with Magnus lift.
- **Joints & tools** — weld, door hinge (+motor), spring, rope; freeze, push, blow, duplicate, brush.
- **Space** — mutual gravity (Barnes-Hut), accretion into planets with painted skins, impact
  breakage, craters, Roche-limit tidal breakup.
- **🧪 Dev mode** (World › Display, or the <kbd>`</kbd> key) — step profiler, whole-scene
  energy / momentum ledger, per-source force breakdown in N, collider / velocity / force overlays, and
  a **Lab of 48 real-world experiments** (free fall, pendulum, bounce, friction, rolling, buoyancy,
  terminal velocity, Magnus, cyclotron, orbits, blast scaling, conservation, determinism…) that run
  in a hidden lab world and report simulator vs. real value. Scriptable via `window.dev`.

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
  sandbox.ts         the core — Rapier world + Three render + fixed-timestep loop, entities, fields, tools
  ui.ts              control panel, HUD, object inspector (DOM; reads/commands the Sandbox only)
  devmode.ts         dev mode window: profiler, conservation ledger, force breakdown, the Lab
  style.css
  systems/           each feature a "system": fields, media (liquids/air), devlab (experiments),
                     devviz (overlays), nbody, shapes, implicit, planettex, joints, persistence…
  worlds/            Cosmos / Quantum / Subatomic — separate solvers, shared renderer (see its README)
docs/                roadmap, feature catalog, architecture
```

## Philosophy (carried from a prior verified engine)

Physics is the single source of truth; the renderer only reads it. Fixed timestep, deterministic
stepping, and a systems-based architecture mean features are *added*, not bolted through the core —
and determinism later pays off for replays, shareable recordings, and (someday) a robot digital-twin.

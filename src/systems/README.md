# `src/systems/` — where every future feature lives

Phase 1 keeps its logic in `src/sandbox.ts`. As features land, each becomes a **system**: a module
that reads/writes the entity registry and runs once per physics step (or per frame). Adding a
feature = adding a system, never rewiring the core loop.

This folder is the map of everything we planned. Each item lists its phase and where it plugs in.
Full detail is in [`/docs/ROADMAP.md`](../../docs/ROADMAP.md), [`/docs/FEATURES.md`](../../docs/FEATURES.md),
and the design docs.

## Planned systems

| System (file) | Phase | What it does |
|---|---|---|
| `shapes.ts` | P2 | function `f(x)` solids, **parametric** curves/surfaces, implicit/SDF, superformula, freehand draw, CSG, model import, mass props via the Module-M voxel path |
| `materials.ts` | P3 | material presets, **texture upload** (PBR maps), **elements → compounds → alloys** composer, density→mass |
| `fields.ts` | P4 | force fields (attractor/wind/vortex/buoyancy), joints & motors, direct tools (push/blow/freeze) |
| `effects.ts` | P5 | temperature (heat/conduction/melt), electric charge, magnetism, wires/current |
| `chemistry.ts` | P5+ | rule + bond-energy reactions, build molecules, kinetics, optional molecular dynamics |
| `deformation.ts` | P6 | **XPBD soft bodies** (the physics-lab failure, done right), resize/morph, plastic, fracture |
| `inspector.ts` | P1→P7 | select (single/multi/marquee), live readout + **editing** (extends the read-only inspector in `ui.ts`) |
| `terrain.ts` | ext | heightfield (hills/mountains) + voxel/SDF (caves), water regions, procedural generation |
| `share.ts` | P7 | save/load scenes (JSON), share URLs, record → GIF/MP4, undo/redo, time controls (rewind) |
| `ai.ts` | ext | **portable** AI scenario builder — export prompt + schema, paste JSON back, validate, build |
| `sensors.ts` | ext | live speed/accel/force/energy gauges + graphs (the verified-physics teaching angle) |

## Separate worlds (own solvers, shared renderer/UI) — `src/worlds/`

| World | What it is |
|---|---|
| `cosmos.ts` | N-body gravity (symplectic integrator), stellar life cycles, radiation pressure, black holes (BlackHoleSim), megastructures |
| `quantum.ts` | wavefunctions via split-step Fourier; orbitals, tunnelling, double-slit; qubits/gates/entanglement |
| `subatomic.ts` | Standard Model explorer, build protons from quarks, toy collider, fission/fusion |

The **scale-transition** ("Powers of Ten" zoom) between worlds is an orchestration layer, not new
physics — see `docs/ARCHITECTURE.md`.

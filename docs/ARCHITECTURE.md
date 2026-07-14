# Architecture

## The core loop (`src/sandbox.ts`)

Physics steps at a **fixed** dt (stability + determinism); the screen refreshes at a variable rate.
An accumulator bridges them, and the render **interpolates** between the two most recent physics
states so motion is smooth even when step rate ≠ frame rate.

```
acc += min(frameDt, 3·FIXED)          // clamp so a slow frame can't queue a freeze
while acc >= FIXED (max 3×):          // slight slow-motion under load, never a stutter
    save prev transforms
    step grabbed body toward cursor (clamped velocity — no teleport/fling)
    world.step()
    read curr transforms
alpha = acc / FIXED
render: lerp(prev, curr, alpha) → InstancedMesh matrices
```

## Data model

One entity ties together its three faces; the registry is a flat array keyed by a stable id.

```ts
Entity { id, kind, body: RAPIER.RigidBody, size, color, prev/currPos, prev/currQuat }
```

**Rule:** physics (`body`) is the single source of truth; the renderer only *reads* it. Never write
a body transform from the render side. This containment is what keeps save/replay/multiplayer sane.

## Rendering — why it scales

Every object of a shape shares one `InstancedMesh` → one draw call for hundreds of objects. Each
frame we write per-instance matrices (and colors) from interpolated transforms. Rapier will solve far
more bodies than the renderer can naively draw, so we fix the draw side once (instancing) and the
"100+ objects" requirement is met permanently.

## Adding features = adding systems

Phase 1 keeps logic in `Sandbox`. As it grows, split into **systems** that each run over the entity
registry once per step/frame (`PhysicsSystem`, `FieldSystem`, `ThermalSystem`, `DeformationSystem`,
`RenderSystem`, …). Adding a feature never edits the core loop — it registers a system. See
`src/systems/README.md` for the planned set and where each lives.

### Soon-recommended structural upgrades
- **Physics in a Web Worker** once scenes get heavy: run `world.step()` off the main thread, post
  transforms back (SharedArrayBuffer). The render stays at 60fps regardless.
- **React** for the UI only when panels justify it; keep the hot path (loop) framework-free.

## Separate worlds & the scale transition

Cosmos / Quantum / Subatomic are separate solvers (`src/worlds/`) sharing the renderer + UI. A
`ScaleManager` owns the current scale and a set of worlds with entry/exit scales; the zoom is one
continuous camera value, crossfaded, that `load()`s the entered world and `unload()`s the left one.
It is orchestration, not simultaneous multi-scale simulation. Pre-load the next world during the zoom
so the handoff never stalls.

## Determinism

Fixed timestep + Rapier's deterministic solver → identical replays, shareable recordings, and the
basis for lock-step multiplayer and a robot digital-twin. Carried straight from the prior verified
engine's methodology.

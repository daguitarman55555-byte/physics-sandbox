# `src/worlds/` — the separate scales

The Rigid Sandbox is the main world. **Cosmos** (astrophysics) and **Quantum / Subatomic** (the very
small) are *separate simulations with their own solvers*, sharing only the renderer and UI. They are
NOT the rigid engine — different scales, different math.

- `cosmos.ts` — N-body gravity with a symplectic integrator; stellar life cycles, radiation pressure,
  black holes (reuse **BlackHoleSim**), spacecraft & megastructures, the cosmic web.
- `quantum.ts` — wavefunctions via the split-step Fourier method; orbitals, tunnelling, double-slit;
  a qubit / gates / entanglement playground.
- `subatomic.ts` — the Standard Model: quarks, leptons, bosons; build a proton from quarks, a toy
  collider, fission & fusion.

The **scale transition** (zoom out → Cosmos, zoom in → lattice → atoms → nucleus → quarks) is a
`ScaleManager` orchestration layer — a continuous camera + crossfade that swaps the active world.
It's UX, not new physics. See `docs/ARCHITECTURE.md`.

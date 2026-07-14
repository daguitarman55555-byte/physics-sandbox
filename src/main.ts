/**
 * Physics Sandbox — entry point.
 *
 * Phase 1: the real-time core. Boots Rapier (async WASM), creates the Sandbox (Three.js render +
 * Rapier physics + the fixed-timestep loop), wires the UI, and starts.
 *
 * The rest of the roadmap (materials, deformation, forces/fields, cosmos, quantum, …) is captured
 * in /docs and stubbed in /src/systems — see docs/ARCHITECTURE.md for where each future feature lives.
 */
import './style.css';
import RAPIER from '@dimforge/rapier3d-compat';
import { Sandbox } from './sandbox';
import { buildUI } from './ui';

async function main() {
  await RAPIER.init(); // one-time WASM load; everything after this can create physics
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const sandbox = new Sandbox(canvas);
  buildUI(sandbox);
  sandbox.start();
  // handy for tinkering from the browser console
  (window as unknown as { sandbox: Sandbox }).sandbox = sandbox;
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML =
    `<pre style="color:#e2564e;padding:24px;font-family:monospace">Failed to start:\n${err?.stack ?? err}</pre>`;
});

/**
 * DEV MODE — see what the simulator is actually doing, in real units, and check it against real life.
 *
 * A floating window with three tabs:
 *   Live    — where each physics step's time goes, and a conservation ledger for the whole scene (mass,
 *             kinetic + potential energy, momentum, angular momentum) with history graphs. In a closed
 *             system energy can only FALL (friction, inelastic contacts); a rise is a solver artifact.
 *   Object  — the selected body's physical properties in SI units, its state, its energy, and a
 *             force-by-source breakdown: gravity + every force we applied + the residual m·a − Σ known
 *             (which is what contacts, joints and damping did). Plus a free-flight prediction check.
 *   Lab     — the analytic experiment suite (systems/devlab.ts): real-world laws vs measured results.
 * And 3D overlays in the scene (systems/devviz.ts). Toggle from World › Display or the ` (backtick) key.
 * Everything is exposed on `window.dev` for scripted checks.
 */
import * as THREE from 'three';
import { DEV_SECTIONS, SI_MASS, type Sandbox, type Entity } from './sandbox';
import { DevLab, EXPERIMENTS, type LabResult } from './systems/devlab';
import { DevViz } from './systems/devviz';

type Tab = 'live' | 'object' | 'lab';
const HIST = 150; // samples of history per graph (5 Hz → 30 s)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, html = '', cls = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (html) n.innerHTML = html;
  if (cls) n.className = cls;
  return n;
}

/** SI-prefixed number: 12 340 → "12.3 k". */
function si(v: number, unit: string, digits = 3): string {
  if (!Number.isFinite(v)) return `— ${unit}`;
  if (v === 0) return `0 ${unit}`;
  const a = Math.abs(v);
  const [k, p] = a >= 1e9 ? [1e9, 'G'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'k'] : a >= 1 ? [1, ''] : [1e-3, 'm'];
  return `${(v / k).toPrecision(digits)} ${p}${unit}`;
}
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');
/** Mass in kg → "640 kg" / "2.400 t" / "1.300 kt". */
const kgs = (v: number) => (v < 1e3 ? `${v.toPrecision(4)} kg` : v < 1e6 ? `${(v / 1e3).toPrecision(4)} t` : `${(v / 1e6).toPrecision(4)} kt`);
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export interface Ledger {
  n: number; awake: number; mass: number; // kg
  keLin: number; keRot: number; pe: number; peMutual: number; energy: number; // J
  p: THREE.Vector3; L: THREE.Vector3; // kg·m/s, kg·m²/s
  open: string; // why the system isn't closed ('' when it is)
}

const _q = new THREE.Quaternion(), _qf = new THREE.Quaternion(), _w = new THREE.Vector3(), _iw = new THREE.Vector3();

/** Whole-scene conservation ledger in SI units. Frozen bodies are external supports, not part of the system. */
export function ledger(S: Sandbox): Ledger {
  const g = -S.gravityY;
  const out: Ledger = { n: 0, awake: 0, mass: 0, keLin: 0, keRot: 0, pe: 0, peMutual: 0, energy: 0, p: new THREE.Vector3(), L: new THREE.Vector3(), open: '' };
  const live: Entity[] = [];
  for (const e of S.entities) {
    if (e.frozen) continue;
    const m = e.body.mass();
    if (!(m > 0)) continue;
    live.push(e);
    const t = e.body.translation(), v = e.body.linvel(), av = e.body.angvel();
    out.n++;
    if (!e.body.isSleeping()) out.awake++;
    out.mass += m;
    out.keLin += 0.5 * m * (v.x * v.x + v.y * v.y + v.z * v.z);
    out.pe += m * g * (e.gravityScale ?? 1) * t.y;
    out.p.x += m * v.x; out.p.y += m * v.y; out.p.z += m * v.z;
    out.L.x += m * (t.y * v.z - t.z * v.y); out.L.y += m * (t.z * v.x - t.x * v.z); out.L.z += m * (t.x * v.y - t.y * v.x);
    const I = e.body.principalInertia(), r = e.body.rotation(), fr = e.body.principalInertiaLocalFrame();
    _q.set(r.x, r.y, r.z, r.w).multiply(_qf.set(fr.x, fr.y, fr.z, fr.w)); // principal axes → world
    _w.set(av.x, av.y, av.z).applyQuaternion(_qf.copy(_q).invert()); // ω in principal axes
    out.keRot += 0.5 * (I.x * _w.x * _w.x + I.y * _w.y * _w.y + I.z * _w.z * _w.z);
    _iw.set(I.x * _w.x, I.y * _w.y, I.z * _w.z).applyQuaternion(_q);
    out.L.add(_iw);
  }
  if (S.selfGravity && live.length <= 400) {
    const G = S.selfGravityG;
    for (let i = 0; i < live.length; i++) {
      const a = live[i].body.translation(), ma = live[i].body.mass();
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j].body.translation();
        out.peMutual -= (G * ma * live[j].body.mass()) / Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 + 0.36);
      }
    }
  }
  const k = SI_MASS; // sim units → SI
  out.mass *= k; out.keLin *= k; out.keRot *= k; out.pe *= k; out.peMutual *= k;
  out.p.multiplyScalar(k); out.L.multiplyScalar(k);
  out.energy = out.keLin + out.keRot + out.pe + out.peMutual;
  const why: string[] = [];
  if (S.fieldCount) why.push(`${S.fieldCount} field(s)`);
  if (S.userInputActive) why.push('grab/brush/motor/dock');
  if (S.selfGravity && live.length > 400) why.push('mutual-gravity PE not summed above 400 bodies');
  if (S.accretion || S.breakage) why.push('merges/fractures dissipate');
  out.open = why.join(' · ');
  return out;
}

/** A tiny line chart on a canvas. */
function spark(canvas: HTMLCanvasElement, data: number[], color: string, label: string, unit: string) {
  const w = canvas.clientWidth || 240, h = canvas.clientHeight || 44;
  if (canvas.width !== w * 2) { canvas.width = w * 2; canvas.height = h * 2; }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  let lo = Infinity, hi = -Infinity;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.01 || 1;
  lo -= pad; hi += pad;
  ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (HIST - 1)) * w, y = h - ((v - lo) / (hi - lo)) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#9aa4b6'; ctx.font = '10px ui-monospace, Consolas, monospace';
  ctx.fillText(`${label}  ${si(data[data.length - 1], unit)}`, 4, 11);
}

export interface DevModeHandle { setOn(on: boolean): void; readonly on: boolean; onChange?: (on: boolean) => void }

export function buildDevMode(sandbox: Sandbox): DevModeHandle {
  const lab = new DevLab();
  const viz = new DevViz(sandbox);
  sandbox.onFrame = (alpha) => {
    sandbox.devTrack = sandbox.devOn ? sandbox.selected : null;
    viz.update(alpha);
  };

  // ---------------------------------------------------------------- window
  const win = el('div', '', 'hidden'); win.id = 'devpanel';
  const head = el('header', '<span>🧪 Dev mode</span>');
  const close = el('button', '×');
  head.append(close);
  const tabs = el('div', '', 'dv-tabs');
  const body = el('div', '', 'dv-body');
  const pages: Record<Tab, HTMLElement> = { live: el('div', '', 'dv-page'), object: el('div', '', 'dv-page'), lab: el('div', '', 'dv-page') };
  const tabBtns = {} as Record<Tab, HTMLButtonElement>;
  let tab: Tab = 'live';
  const setTab = (t: Tab) => {
    tab = t;
    for (const k of Object.keys(pages) as Tab[]) { pages[k].classList.toggle('hidden', k !== t); tabBtns[k].classList.toggle('on', k === t); }
    refresh();
  };
  for (const [t, label] of [['live', 'Live'], ['object', 'Object'], ['lab', 'Lab · real-world checks']] as Array<[Tab, string]>) {
    const b = el('button', label, 'mini');
    b.onclick = () => setTab(t);
    tabBtns[t] = b;
    tabs.append(b);
  }
  body.append(pages.live, pages.object, pages.lab);
  win.append(head, tabs, body);
  document.body.append(win);
  makeDraggable(win, head);

  // ---------------------------------------------------------------- Live tab
  const clock = el('div', '', 'dv-kv');
  const costBox = el('div', '', 'dv-cost');
  const ledgerBox = el('div', '', 'dv-kv');
  const openLine = el('div', '', 'dv-note');
  const eCanvas = el('canvas', '', 'dv-spark');
  const pCanvas = el('canvas', '', 'dv-spark');
  const overlayRow = el('div', '', 'row wrap');
  const ovDefs: Array<[keyof Pick<DevViz, 'colliders' | 'velocities' | 'forces' | 'prediction'>, string, string]> = [
    ['colliders', 'Colliders', 'Rapier’s own collision shapes — what physics actually collides'],
    ['velocities', 'Velocities', 'A line per moving body along its velocity (blue slow → red fast)'],
    ['forces', 'Forces', 'Arrows on the selected body: gravity (red), each applied force, residual contact/joint force (green)'],
    ['prediction', 'Free-flight path', 'Where the selected body would go under gravity alone — deviation = other forces'],
  ];
  for (const [key, label, title] of ovDefs) {
    const b = el('button', label, 'mini');
    b.title = title;
    const sync = () => b.classList.toggle('primary', viz[key]);
    b.onclick = () => { viz[key] = !viz[key]; sync(); };
    sync();
    overlayRow.append(b);
  }
  pages.live.append(
    el('div', 'Overlays', 'dv-h'), overlayRow,
    el('div', 'Clock', 'dv-h'), clock,
    el('div', 'Step cost (ms per physics step)', 'dv-h'), costBox,
    el('div', 'Conservation (SI units, frozen bodies excluded)', 'dv-h'), ledgerBox, eCanvas, pCanvas, openLine,
  );
  const eHist: number[] = [], pHist: number[] = [];
  let lastN = -1, lastEpoch = -1;

  // ---------------------------------------------------------------- Object tab
  const objBox = el('div', '');
  const vCanvas = el('canvas', '', 'dv-spark');
  const yCanvas = el('canvas', '', 'dv-spark');
  pages.object.append(objBox, vCanvas, yCanvas);
  const vHist: number[] = [], yHist: number[] = [];
  let histFor: Entity | null = null;
  // free-flight prediction check: snapshot a state, predict the parabola, compare after 0.5 s of sim time
  let pred: { e: Entity; t0: number; p: THREE.Vector3; v: THREE.Vector3; g: number; clean: boolean } | null = null;
  let predMsg = 'waiting for free flight…';

  // ---------------------------------------------------------------- Lab tab
  const labTop = el('div', '', 'row wrap');
  const bRunAll = el('button', '▶ Run all', 'mini primary');
  const bCopy = el('button', 'Copy report', 'mini');
  const summary = el('div', '', 'dv-note');
  labTop.append(bRunAll, bCopy);
  const labList = el('div', '', 'dv-lab');
  pages.lab.append(
    el('div', 'Each experiment rebuilds a textbook situation in a hidden lab world (same physics code, your scene is untouched) and compares the result with the real-world value.', 'dv-note'),
    labTop, summary, labList,
  );
  const rowFor = new Map<string, HTMLElement>();
  let group = '';
  for (const ex of EXPERIMENTS) {
    if (ex.group !== group) { group = ex.group; labList.append(el('div', group, 'dv-h')); }
    const row = el('div', '', 'dv-exp');
    const run = el('button', '▶', 'mini dv-run');
    run.title = 'Run this experiment';
    run.onclick = () => { renderResult(lab.run(ex.id)); renderSummary(); };
    row.innerHTML = `<div class="dv-exp-head"><span class="dv-badge">—</span><b>${ex.name}</b></div><div class="dv-law">${ex.law} · tol ${ex.tolPct}%</div><div class="dv-res"></div>`;
    row.querySelector('.dv-exp-head')!.append(run);
    rowFor.set(ex.id, row);
    labList.append(row);
  }
  const renderResult = (r: LabResult) => {
    const row = rowFor.get(r.id)!;
    const badge = row.querySelector('.dv-badge')!;
    badge.textContent = r.status.toUpperCase();
    badge.className = `dv-badge st-${r.status}`;
    const u = r.unit ? ` ${r.unit}` : '';
    const err = r.absTol != null ? `Δ ${Math.abs(r.measured - r.expected).toPrecision(2)}${u}` : `${r.errPct >= 0 ? '+' : ''}${r.errPct.toFixed(2)}%`;
    row.querySelector('.dv-res')!.innerHTML =
      `sim <b>${Number(r.measured).toPrecision(5)}${u}</b> · real <b>${Number(r.expected).toPrecision(5)}${u}</b> · <b class="st-${r.status}">${err}</b><br><span>${r.detail}</span>`;
  };
  const renderSummary = () => {
    const c = { pass: 0, warn: 0, fail: 0 };
    for (const r of lab.results.values()) c[r.status]++;
    summary.innerHTML = `<b class="st-pass">${c.pass} pass</b> · <b class="st-warn">${c.warn} warn</b> · <b class="st-fail">${c.fail} fail</b> · ${lab.results.size}/${EXPERIMENTS.length} run`;
  };
  bRunAll.onclick = async () => {
    bRunAll.disabled = true;
    await lab.runAll((r) => { renderResult(r); renderSummary(); });
    bRunAll.disabled = false;
  };
  bCopy.onclick = () => {
    const json = JSON.stringify([...lab.results.values()], null, 1);
    navigator.clipboard?.writeText(json).catch(() => {});
    bCopy.textContent = 'Copied';
    setTimeout(() => (bCopy.textContent = 'Copy report'), 1200);
  };

  // ---------------------------------------------------------------- refresh
  const refreshLive = () => {
    const T = sandbox.consumeDevTiming();
    const total = T.ms.reduce((a, b) => a + b, 0);
    clock.innerHTML =
      kv('sim time', `${sandbox.simTime.toFixed(2)} s`) + kv('fixed step', '1/60 s') +
      kv('time scale', `×${sandbox.getTimeScale().toFixed(1)}${sandbox.isPaused ? ' · paused' : ''}`) + kv('fps', `${Math.round(sandbox.fps)}`);
    costBox.innerHTML = DEV_SECTIONS.map((name, i) =>
      `<div class="dv-bar"><span>${name}</span><i style="width:${Math.min(100, (T.ms[i] / 16.7) * 100 * 4).toFixed(1)}%"></i><b>${T.ms[i].toFixed(3)}</b></div>`).join('')
      + `<div class="dv-bar tot"><span>total / 16.7 budget</span><i style="width:${Math.min(100, (total / 16.7) * 100).toFixed(1)}%"></i><b>${total.toFixed(2)}</b></div>`;
    const L = ledger(sandbox);
    // spawns/deletes and deliberate user actions (a throw, a blast, a gravity change) break the series:
    // restart it so the closed-system check only judges what the SOLVER did since
    if (L.n !== lastN || sandbox.userEpoch !== lastEpoch) { eHist.length = 0; pHist.length = 0; lastN = L.n; lastEpoch = sandbox.userEpoch; }
    eHist.push(L.energy); pHist.push(L.p.length());
    if (eHist.length > HIST) { eHist.shift(); pHist.shift(); }
    ledgerBox.innerHTML =
      kv('bodies', `${L.n} (${L.awake} awake)`) + kv('total mass', kgs(L.mass)) +
      kv('kinetic (linear)', si(L.keLin, 'J')) + kv('kinetic (spin)', si(L.keRot, 'J')) +
      kv('potential (gravity)', si(L.pe, 'J')) + (sandbox.selfGravity ? kv('potential (mutual)', si(L.peMutual, 'J')) : '') +
      kv('total energy', si(L.energy, 'J')) +
      kv('momentum |p|', si(L.p.length(), 'N·s')) + kv('angular mom. |L|', si(L.L.length(), 'J·s'));
    spark(eCanvas, eHist, '#93b6f6', 'E', 'J');
    spark(pCanvas, pHist, '#c9bb3a', '|p|', 'N·s');
    // closed system: energy may only fall. Flag a rise over the last ~2 s.
    const k = Math.min(10, eHist.length - 1);
    const rise = k > 0 ? eHist[eHist.length - 1] - eHist[eHist.length - 1 - k] : 0;
    const scale = Math.max(Math.abs(L.keLin + L.keRot), 1e-6);
    if (L.open) openLine.innerHTML = `Open system (${L.open}) — energy/momentum may change.`;
    else if (rise > 0.02 * scale && rise > 1) openLine.innerHTML = `<b class="st-warn">Closed system but energy ROSE ${si(rise, 'J')} in 2 s</b> — solver artifact (deep overlap / stiff contact).`;
    else openLine.innerHTML = 'Closed system — energy may only fall (friction, inelastic contacts). ✓';
  };

  const refreshObject = () => {
    const e = sandbox.selected;
    if (e !== histFor) { vHist.length = 0; yHist.length = 0; histFor = e; pred = null; predMsg = 'waiting for free flight…'; }
    if (!e) { objBox.innerHTML = '<div class="dv-note">Click an object in the scene to inspect its physics.</div>'; spark(vCanvas, [], '', '', ''); spark(yCanvas, [], '', '', ''); return; }
    const b = e.body;
    const m = b.mass(), K = SI_MASS;
    const vol = e.kind === 'box' ? 8 * e.size ** 3 : e.kind === 'sphere' ? (4 / 3) * Math.PI * e.size ** 3 : (e.volume ?? 0);
    const t = b.translation(), v = b.linvel(), w = b.angvel(), I = b.principalInertia();
    const speed = Math.hypot(v.x, v.y, v.z);
    const gs = e.gravityScale ?? 1;
    const gy = m * sandbox.gravityY * gs;
    let sx = 0, sy = e.frozen ? 0 : gy, sz = 0;
    let forces = e.frozen ? '' : frow(0xdc4a4a, `gravity (×${gs})`, Math.abs(gy) * K);
    for (const f of sandbox.devForces) { forces += frow(f.color, f.label, f.f.length() * K); sx += f.f.x; sy += f.f.y; sz += f.f.z; }
    const ma = new THREE.Vector3(m * e.accel.x, m * e.accel.y, m * e.accel.z);
    const res = new THREE.Vector3(ma.x - sx, ma.y - sy, ma.z - sz);
    if (!e.frozen) {
      forces += frow(0x6c778b, 'Σ known forces', Math.hypot(sx, sy, sz) * K)
        + frow(0x5b8def, 'measured m·a', ma.length() * K)
        + frow(0x4fb89a, 'residual → contacts / joints', res.length() * K);
    }
    // prediction check (valid only if the body stayed in free flight the whole window)
    const free = !e.frozen && sandbox.devForces.length === 0 && res.length() < Math.max(Math.abs(gy) * 0.02, 1e-6);
    const now = sandbox.simTime;
    if (pred && pred.e === e) {
      if (!free) pred.clean = false;
      if (now - pred.t0 >= 0.5) {
        if (pred.clean) {
          const dt = now - pred.t0;
          const p = pred.p.clone().addScaledVector(pred.v, dt).add(new THREE.Vector3(0, 0.5 * pred.g * dt * dt, 0));
          const err = p.distanceTo(new THREE.Vector3(t.x, t.y, t.z));
          predMsg = `after ${dt.toFixed(2)} s of free flight the body is <b>${(err * 100).toFixed(1)} cm</b> from the exact parabola (${((err / Math.max(pred.v.length() * dt + 0.5 * Math.abs(pred.g) * dt * dt, 1e-6)) * 100).toFixed(2)}% of the distance travelled)`;
        }
        pred = null;
      }
    }
    if (!pred && free && speed > 0.2) pred = { e, t0: now, p: new THREE.Vector3(t.x, t.y, t.z), v: new THREE.Vector3(v.x, v.y, v.z), g: sandbox.gravityY * gs, clean: true };

    const keLin = 0.5 * m * speed * speed * K;
    objBox.innerHTML =
      `<div class="dv-h">#${e.id} · ${e.kind} · ${e.mat.name}${e.label ? ` · ${e.label}` : ''}</div>` +
      `<div class="dv-kv">` +
      kv('mass', kgs(m * K)) + kv('volume', `${vol.toPrecision(4)} m³`) +
      kv('density', `${vol > 0 ? ((m / vol) * K).toFixed(0) : '—'} kg/m³`) +
      kv('inertia (principal)', `${si(I.x * K, '', 3)} · ${si(I.y * K, '', 3)} · ${si(I.z * K, '', 3)} kg·m²`) +
      kv('friction μ · bounce e', `${e.mat.friction} · ${e.mat.restitution}`) +
      kv('position', `${f2(t.x)}, ${f2(t.y)}, ${f2(t.z)} m`) +
      kv('velocity', `${f2(v.x)}, ${f2(v.y)}, ${f2(v.z)} m/s (|v| ${f2(speed)})`) +
      kv('angular velocity', `${f2(Math.hypot(w.x, w.y, w.z))} rad/s`) +
      kv('acceleration', `${f2(e.accel.length())} m/s²`) +
      kv('kinetic energy', si(keLin, 'J')) + kv('potential (m·g·h)', si(m * -sandbox.gravityY * gs * t.y * K, 'J')) +
      kv('state', `${b.isSleeping() ? 'asleep' : 'awake'}${e.frozen ? ' · frozen' : ''}`) +
      `</div><div class="dv-h">Forces last step (N)</div><div class="dv-forces">${forces || '<div class="dv-note">frozen — held by the world</div>'}</div>` +
      `<div class="dv-h">Free-flight check</div><div class="dv-note">${predMsg}</div>`;
    vHist.push(speed); yHist.push(t.y);
    if (vHist.length > HIST) { vHist.shift(); yHist.shift(); }
    spark(vCanvas, vHist, '#93b6f6', '|v|', 'm/s');
    spark(yCanvas, yHist, '#4fb89a', 'height', 'm');
  };

  function refresh() {
    if (!sandbox.devOn) return;
    if (tab === 'live') refreshLive();
    else if (tab === 'object') refreshObject();
  }
  setInterval(refresh, 200);

  const handle: DevModeHandle = {
    get on() { return sandbox.devOn; },
    setOn(on: boolean) {
      sandbox.devOn = on;
      win.classList.toggle('hidden', !on);
      if (!on) sandbox.devTrack = null;
      sandbox.consumeDevTiming();
      handle.onChange?.(on);
      refresh();
    },
  };
  close.onclick = () => handle.setOn(false);
  addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'MATH-FIELD'].includes(t.tagName))) return;
    if (ev.key === '`') handle.setOn(!sandbox.devOn);
  });
  setTab('live');
  renderSummary();

  // scripted access (the dev console / automated checks)
  (window as unknown as { dev: unknown }).dev = {
    lab, viz, ledger: () => ledger(sandbox),
    run: (id: string) => lab.run(id),
    runAll: () => lab.runAll((r) => { renderResult(r); renderSummary(); }),
    open: (t: Tab = 'live') => { handle.setOn(true); setTab(t); },
    close: () => handle.setOn(false),
  };
  return handle;
}

function kv(k: string, v: string) { return `<div><span>${k}</span><b>${v}</b></div>`; }
function frow(color: number, label: string, newtons: number) {
  return `<div><span><i class="dot" style="background:${hex(color)}"></i>${label}</span><b>${si(newtons, 'N')}</b></div>`;
}

/** Drag the window by its header (kept local so dev mode has no coupling to ui.ts internals). */
function makeDraggable(win: HTMLElement, handle: HTMLElement) {
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    win.style.left = `${r.left}px`; win.style.top = `${r.top}px`; win.style.right = 'auto';
    const move = (ev: PointerEvent) => { win.style.left = `${ev.clientX - dx}px`; win.style.top = `${Math.max(0, ev.clientY - dy)}px`; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

/**
 * UI — the control panel, the live HUD, and the object inspector.
 *
 * Pure DOM (no framework yet — kept lean for Phase 1; swap in React when panels grow). Everything
 * here only reads/commands the Sandbox; it never touches physics directly.
 */
import type { Sandbox } from './sandbox';
import { buildRevolution, REV_PRESETS } from './systems/shapes';

export function buildUI(sandbox: Sandbox) {
  buildPanel(sandbox);
  buildHud(sandbox);
  buildInspector(sandbox);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, html = '', cls = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (html) n.innerHTML = html;
  if (cls) n.className = cls;
  return n;
}

function buildPanel(sandbox: Sandbox) {
  const panel = document.getElementById('panel')!;
  panel.append(el('h3', 'Physics Sandbox · Phase 1'));

  // spawn buttons
  const spawn = el('div', '', 'row wrap');
  const bBox = el('button', 'Box');
  const bSphere = el('button', 'Sphere');
  bBox.onclick = () => sandbox.spawn('box');
  bSphere.onclick = () => sandbox.spawn('sphere');
  spawn.append(bBox, bSphere);
  panel.append(el('h3', 'Spawn'), spawn);

  const spawn2 = el('div', '', 'row');
  const b100 = el('button', '+100 objects', 'primary');
  b100.onclick = () => sandbox.spawnMany(100);
  spawn2.append(b100);
  panel.append(spawn2);

  // Phase 2 — f(x) solid of revolution
  buildShapeCreator(panel, sandbox);

  // gravity slider
  const field = el('div', '', 'field');
  const label = el('label', 'Gravity <b>-9.81</b>');
  const range = el('input');
  range.type = 'range';
  range.min = '-20'; range.max = '20'; range.step = '0.1'; range.value = String(sandbox.gravityY);
  range.oninput = () => {
    const v = parseFloat(range.value);
    sandbox.setGravityY(v);
    label.querySelector('b')!.textContent = v.toFixed(2);
  };
  field.append(label, range);
  panel.append(el('h3', 'World'), field);

  // gravity presets
  const presets = el('div', '', 'row wrap');
  const set = (v: number) => () => {
    sandbox.setGravityY(v);
    range.value = String(v);
    label.querySelector('b')!.textContent = v.toFixed(2);
  };
  const gEarth = el('button', 'Earth'); gEarth.onclick = set(-9.81);
  const gMoon = el('button', 'Moon'); gMoon.onclick = set(-1.62);
  const gZero = el('button', 'Zero-G'); gZero.onclick = set(0);
  presets.append(gEarth, gMoon, gZero);
  panel.append(presets);

  // reset
  const resetRow = el('div', '', 'row');
  const bReset = el('button', 'Reset scene');
  bReset.onclick = () => sandbox.reset();
  resetRow.append(bReset);
  panel.append(resetRow);
}

function buildShapeCreator(panel: HTMLElement, sandbox: Sandbox) {
  panel.append(el('h3', 'Create shape · f(x) revolution'));

  // profile expression: radius as a function of x (the axis), revolved into a solid
  const exprField = el('div', '', 'field');
  const exprLabel = el('label', 'radius <b>r(x)</b>');
  const exprInput = el('input') as HTMLInputElement;
  exprInput.type = 'text';
  exprInput.className = 'expr';
  exprInput.spellcheck = false;
  // stop the browser from autofilling LaTeX/history into the math field
  exprInput.autocomplete = 'off';
  exprInput.setAttribute('autocapitalize', 'off');
  exprInput.setAttribute('autocorrect', 'off');
  exprInput.value = REV_PRESETS[0].expr;
  exprField.append(exprLabel, exprInput);
  panel.append(exprField);

  // domain [a, b] + density
  const nums = el('div', '', 'row nums');
  const aInput = numInput(REV_PRESETS[0].a, 'from x');
  const bInput = numInput(REV_PRESETS[0].b, 'to x');
  const dInput = numInput(1, 'density');
  dInput.min = '0.01';
  nums.append(labeled('from', aInput), labeled('to', bInput), labeled('density', dInput));
  panel.append(nums);

  // preset buttons
  const presets = el('div', '', 'row wrap');
  for (const p of REV_PRESETS) {
    const b = el('button', p.name, 'mini');
    b.onclick = () => { exprInput.value = p.expr; aInput.value = String(p.a); bInput.value = String(p.b); refresh(); };
    presets.append(b);
  }
  panel.append(presets);

  // live mass/volume preview (this is the differentiator — exact analytic mass before you drop it)
  const preview = el('div', '', 'preview');
  panel.append(preview);

  const createRow = el('div', '', 'row');
  const bCreate = el('button', 'Create & drop', 'primary');
  createRow.append(bCreate);
  panel.append(createRow);

  const readSpec = () => ({
    expr: exprInput.value, a: parseFloat(aInput.value), b: parseFloat(bInput.value),
    density: parseFloat(dInput.value),
  });

  const refresh = () => {
    const built = buildRevolution(readSpec());
    if (built.ok) {
      const s = built.shape;
      preview.className = 'preview';
      preview.innerHTML = `V ≈ <b>${s.volume.toFixed(2)}</b> m³ · m ≈ <b>${s.mass.toFixed(2)}</b> kg`;
      bCreate.disabled = false;
    } else {
      preview.className = 'preview err';
      preview.textContent = built.error;
      bCreate.disabled = true;
    }
  };
  exprInput.oninput = refresh;
  for (const i of [aInput, bInput, dInput]) i.oninput = refresh;

  bCreate.onclick = () => {
    const res = sandbox.createRevolution(readSpec());
    if (!res.ok) { preview.className = 'preview err'; preview.textContent = res.error; }
  };

  refresh();
}

function numInput(value: number, title: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number';
  i.step = '0.1';
  i.value = String(value);
  i.title = title;
  i.autocomplete = 'off';
  return i;
}

function labeled(label: string, input: HTMLInputElement): HTMLElement {
  const wrap = el('label', '', 'numcol');
  wrap.append(document.createTextNode(label), input);
  return wrap;
}

function buildHud(sandbox: Sandbox) {
  const hud = document.getElementById('hud')!;
  hud.append(el('div', 'Physics Sandbox', 'title'));
  const stats = el('div', '');
  hud.append(stats);
  const awake = (): number => sandbox.entities.reduce((n, e) => n + (e.body.isSleeping() ? 0 : 1), 0);
  setInterval(() => {
    stats.innerHTML =
      `<b>${Math.round(sandbox.fps)}</b> fps · <b>${sandbox.entities.length}</b> objects · <b>${awake()}</b> awake`;
  }, 120);
}

function buildInspector(sandbox: Sandbox) {
  const box = document.getElementById('inspector')!;
  const render = () => {
    const e = sandbox.selected;
    if (!e) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const v = e.body.linvel();
    const w = e.body.angvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    const spin = Math.hypot(w.x, w.y, w.z);
    const t = e.body.translation();
    const mass = e.body.mass();
    const ke = 0.5 * mass * speed * speed;
    const sizeOrShape = e.kind === 'custom'
      ? prop('volume', `${(e.volume ?? 0).toFixed(2)} m³`)
      : prop('size', `${(e.size * 2).toFixed(2)} m`);
    box.innerHTML =
      `<h3><span>Inspector</span><span class="swatch" style="background:#${e.color.getHexString()}"></span></h3>` +
      prop('id', `#${e.id} · ${e.kind}`) +
      prop('position', `${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)}`) +
      prop('speed', `${speed.toFixed(2)} m/s`) +
      prop('angular vel', `${spin.toFixed(2)} rad/s`) +
      prop('mass', `${mass.toFixed(2)} kg`) +
      sizeOrShape +
      prop('kinetic E', `${ke.toFixed(1)} J`) +
      prop('state', e.body.isSleeping() ? 'asleep' : 'awake');
  };
  setInterval(render, 100);
}

function prop(k: string, v: string): string {
  return `<div class="prop"><span>${k}</span><b>${v}</b></div>`;
}

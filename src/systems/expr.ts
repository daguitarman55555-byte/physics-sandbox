/**
 * EXPR — a tiny, safe math-expression evaluator (Phase 2 foundation).
 *
 * Shape creation lets the user type functions (radius profiles now; parametric x(t),y(t),z(t) and
 * surfaces x(u,v)… next). We must NOT `eval()` arbitrary strings, so this is a small recursive-descent
 * parser → closure that only knows numbers, named variables, a whitelist of Math functions, and the
 * constants pi/e/tau. It compiles once; the returned `eval(scope)` is cheap enough to call thousands
 * of times while sampling a profile.
 *
 * Grammar (precedence low→high):  add → mul → unary → power(right-assoc) → primary
 * Supported: + - * / ^,  parentheses,  f(a, b, …),  identifiers (variables/constants).
 */

export interface CompiledExpr {
  eval: (scope: Record<string, number>) => number;
  vars: string[]; // variable names referenced (constants/functions excluded)
  latex: string; // LaTeX form of the parsed expression (for live KaTeX rendering)
}
export type ExprResult = { ok: true; expr: CompiledExpr } | { ok: false; error: string };

type Node = (s: Record<string, number>) => number;
/** Every production returns the closure, its LaTeX, and whether it's self-delimiting (no parens needed). */
type Parsed = { f: Node; tex: string; atom: boolean };

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
  exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10, log2: Math.log2,
  pow: Math.pow, min: Math.min, max: Math.max, hypot: Math.hypot,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  mod: (a, b) => ((a % b) + b) % b,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
const CONST_TEX: Record<string, string> = { pi: '\\pi', e: 'e', tau: '\\tau' };

/** LaTeX emission per function — mathematical notation where one exists, \operatorname otherwise. */
const FUNC_TEX: Record<string, (args: string[]) => string> = {
  sin: (a) => `\\sin\\left(${a[0]}\\right)`,
  cos: (a) => `\\cos\\left(${a[0]}\\right)`,
  tan: (a) => `\\tan\\left(${a[0]}\\right)`,
  asin: (a) => `\\arcsin\\left(${a[0]}\\right)`,
  acos: (a) => `\\arccos\\left(${a[0]}\\right)`,
  atan: (a) => `\\arctan\\left(${a[0]}\\right)`,
  atan2: (a) => `\\operatorname{atan2}\\left(${a.join(', ')}\\right)`,
  sinh: (a) => `\\sinh\\left(${a[0]}\\right)`,
  cosh: (a) => `\\cosh\\left(${a[0]}\\right)`,
  tanh: (a) => `\\tanh\\left(${a[0]}\\right)`,
  sqrt: (a) => `\\sqrt{${a[0]}}`,
  cbrt: (a) => `\\sqrt[3]{${a[0]}}`,
  abs: (a) => `\\left|${a[0]}\\right|`,
  sign: (a) => `\\operatorname{sgn}\\left(${a[0]}\\right)`,
  exp: (a) => `e^{${a[0]}}`,
  log: (a) => `\\ln\\left(${a[0]}\\right)`,
  ln: (a) => `\\ln\\left(${a[0]}\\right)`,
  log10: (a) => `\\log_{10}\\left(${a[0]}\\right)`,
  log2: (a) => `\\log_{2}\\left(${a[0]}\\right)`,
  pow: (a) => `{${a[0]}}^{${a[1]}}`,
  min: (a) => `\\min\\left(${a.join(', ')}\\right)`,
  max: (a) => `\\max\\left(${a.join(', ')}\\right)`,
  hypot: (a) => `\\operatorname{hypot}\\left(${a.join(', ')}\\right)`,
  floor: (a) => `\\left\\lfloor ${a[0]} \\right\\rfloor`,
  ceil: (a) => `\\left\\lceil ${a[0]} \\right\\rceil`,
  round: (a) => `\\operatorname{round}\\left(${a[0]}\\right)`,
  mod: (a) => `${a[0]} \\bmod ${a[1]}`,
};

// ---------------------------------------------------------------- tokenizer
type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < src.length && (isDigit(src[j]) || src[j] === '.')) j++;
      // exponent
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (isDigit(src[k])) { k++; while (k < src.length && isDigit(src[k])) k++; j = k; }
      }
      const num = Number(src.slice(i, j));
      if (!isFinite(num)) throw new Error(`Bad number "${src.slice(i, j)}"`);
      toks.push({ t: 'num', v: num });
      i = j; continue;
    }
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < src.length && (isAlpha(src[j]) || isDigit(src[j]))) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j; continue;
    }
    if ('+-*/^'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { toks.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { toks.push({ t: 'comma' }); i++; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return insertImplicitMul(toks);
}

/**
 * Desmos-style implicit multiplication: `2x`, `2pi`, `0.18 t`, `(x+1)(x-2)` all mean `·`.
 * A `*` is inserted between a value-ending token (number, identifier, `)`) and a value-starting
 * one (number, identifier, `(`) — except when an identifier names a known function and `(`
 * follows: that stays a call, exactly like a calculator.
 */
function insertImplicitMul(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const cur = toks[i];
    out.push(cur);
    const nxt = toks[i + 1];
    if (!nxt) break;
    const endsValue = cur.t === 'num' || cur.t === 'rp' || (cur.t === 'id' && !(nxt.t === 'lp' && cur.v in FUNCS));
    const startsValue = nxt.t === 'num' || nxt.t === 'id' || nxt.t === 'lp';
    if (endsValue && startsValue) out.push({ t: 'op', v: '*' });
  }
  return out;
}

// ---------------------------------------------------------------- parser
class Parser {
  private pos = 0;
  readonly vars = new Set<string>();
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }

  parse(): Parsed {
    if (this.toks.length === 0) throw new Error('Empty expression');
    const node = this.add();
    if (this.pos < this.toks.length) throw new Error('Unexpected trailing input');
    return node;
  }

  private add(): Parsed {
    let left = this.mul();
    for (let t = this.peek(); t && t.t === 'op' && (t.v === '+' || t.v === '-'); t = this.peek()) {
      this.next();
      const right = this.mul();
      const l = left.f, r = right.f;
      const rTex = right.tex.startsWith('-') ? `\\left(${right.tex}\\right)` : right.tex;
      left = t.v === '+'
        ? { f: (s) => l(s) + r(s), tex: `${left.tex} + ${rTex}`, atom: false }
        : { f: (s) => l(s) - r(s), tex: `${left.tex} - ${rTex}`, atom: false };
    }
    return left;
  }

  private mul(): Parsed {
    let left = this.unary();
    for (let t = this.peek(); t && t.t === 'op' && (t.v === '*' || t.v === '/'); t = this.peek()) {
      this.next();
      const right = this.unary();
      const l = left.f, r = right.f;
      if (t.v === '*') {
        const rTex = right.tex.startsWith('-') ? `\\left(${right.tex}\\right)` : right.tex;
        left = { f: (s) => l(s) * r(s), tex: `${left.tex} \\cdot ${rTex}`, atom: false };
      } else {
        left = { f: (s) => l(s) / r(s), tex: `\\frac{${left.tex}}{${right.tex}}`, atom: true };
      }
    }
    return left;
  }

  private unary(): Parsed {
    const t = this.peek();
    if (t && t.t === 'op' && (t.v === '-' || t.v === '+')) {
      this.next();
      const operand = this.unary();
      if (t.v === '+') return operand;
      const o = operand.f;
      return { f: (s) => -o(s), tex: `-${operand.tex}`, atom: false };
    }
    return this.power();
  }

  private power(): Parsed {
    const base = this.primary();
    const t = this.peek();
    if (t && t.t === 'op' && t.v === '^') {
      this.next();
      const exp = this.unary(); // right-associative; allows 2^-3, x^2
      const b = base.f, e = exp.f;
      const bTex = base.atom ? base.tex : `\\left(${base.tex}\\right)`;
      return { f: (s) => Math.pow(b(s), e(s)), tex: `${bTex}^{${exp.tex}}`, atom: false };
    }
    return base;
  }

  private primary(): Parsed {
    const t = this.next();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === 'num') { const v = t.v; return { f: () => v, tex: String(v), atom: true }; }
    if (t.t === 'lp') {
      const inner = this.add();
      const close = this.next();
      if (!close || close.t !== 'rp') throw new Error('Missing ")"');
      return { f: inner.f, tex: `\\left(${inner.tex}\\right)`, atom: true };
    }
    if (t.t === 'id') {
      const name = t.v;
      if (this.peek()?.t === 'lp') {
        // function call
        this.next(); // consume '('
        const fn = FUNCS[name];
        if (!fn) throw new Error(`Unknown function "${name}"`);
        const args: Parsed[] = [];
        if (this.peek()?.t !== 'rp') {
          args.push(this.add());
          while (this.peek()?.t === 'comma') { this.next(); args.push(this.add()); }
        }
        const close = this.next();
        if (!close || close.t !== 'rp') throw new Error(`Missing ")" after ${name}(...)`);
        const fns = args.map((a) => a.f);
        const texArgs = args.map((a) => a.tex);
        const tex = FUNC_TEX[name]?.(texArgs) ?? `\\operatorname{${name}}\\left(${texArgs.join(', ')}\\right)`;
        return { f: (s) => fn(...fns.map((a) => a(s))), tex, atom: true };
      }
      if (name in CONSTS) {
        const v = CONSTS[name];
        return { f: () => v, tex: CONST_TEX[name] ?? name, atom: true };
      }
      this.vars.add(name);
      return { f: (s) => s[name], tex: name, atom: true };
    }
    throw new Error('Unexpected token');
  }
}

export function parseExpression(src: string): ExprResult {
  try {
    const parser = new Parser(tokenize(src));
    const node = parser.parse();
    return { ok: true, expr: { eval: node.f, vars: [...parser.vars], latex: node.tex } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Source → LaTeX for live rendering; null when the expression doesn't parse. */
export function exprToLatex(src: string): string | null {
  const parsed = parseExpression(src);
  return parsed.ok ? parsed.expr.latex : null;
}

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
}
export type ExprResult = { ok: true; expr: CompiledExpr } | { ok: false; error: string };

type Node = (s: Record<string, number>) => number;

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
  return toks;
}

// ---------------------------------------------------------------- parser
class Parser {
  private pos = 0;
  readonly vars = new Set<string>();
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }

  parse(): Node {
    if (this.toks.length === 0) throw new Error('Empty expression');
    const node = this.add();
    if (this.pos < this.toks.length) throw new Error('Unexpected trailing input');
    return node;
  }

  private add(): Node {
    let left = this.mul();
    for (let t = this.peek(); t && t.t === 'op' && (t.v === '+' || t.v === '-'); t = this.peek()) {
      this.next();
      const right = this.mul();
      const l = left, r = right;
      left = t.v === '+' ? (s) => l(s) + r(s) : (s) => l(s) - r(s);
    }
    return left;
  }

  private mul(): Node {
    let left = this.unary();
    for (let t = this.peek(); t && t.t === 'op' && (t.v === '*' || t.v === '/'); t = this.peek()) {
      this.next();
      const right = this.unary();
      const l = left, r = right;
      left = t.v === '*' ? (s) => l(s) * r(s) : (s) => l(s) / r(s);
    }
    return left;
  }

  private unary(): Node {
    const t = this.peek();
    if (t && t.t === 'op' && (t.v === '-' || t.v === '+')) {
      this.next();
      const operand = this.unary();
      return t.v === '-' ? (s) => -operand(s) : operand;
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    const t = this.peek();
    if (t && t.t === 'op' && t.v === '^') {
      this.next();
      const exp = this.unary(); // right-associative; allows 2^-3, x^2
      return (s) => Math.pow(base(s), exp(s));
    }
    return base;
  }

  private primary(): Node {
    const t = this.next();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === 'num') { const v = t.v; return () => v; }
    if (t.t === 'lp') {
      const node = this.add();
      const close = this.next();
      if (!close || close.t !== 'rp') throw new Error('Missing ")"');
      return node;
    }
    if (t.t === 'id') {
      const name = t.v;
      if (this.peek()?.t === 'lp') {
        // function call
        this.next(); // consume '('
        const fn = FUNCS[name];
        if (!fn) throw new Error(`Unknown function "${name}"`);
        const args: Node[] = [];
        if (this.peek()?.t !== 'rp') {
          args.push(this.add());
          while (this.peek()?.t === 'comma') { this.next(); args.push(this.add()); }
        }
        const close = this.next();
        if (!close || close.t !== 'rp') throw new Error(`Missing ")" after ${name}(...)`);
        return (s) => fn(...args.map((a) => a(s)));
      }
      if (name in CONSTS) { const v = CONSTS[name]; return () => v; }
      this.vars.add(name);
      return (s) => s[name];
    }
    throw new Error('Unexpected token');
  }
}

export function parseExpression(src: string): ExprResult {
  try {
    const parser = new Parser(tokenize(src));
    const node = parser.parse();
    return { ok: true, expr: { eval: node, vars: [...parser.vars] } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

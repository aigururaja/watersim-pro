/**
 * OPC Value Transform Utility
 *
 * Safe arithmetic expression evaluator for OPC pre/post processing.
 * Supports: +, -, *, /, parentheses, numeric literals, unary minus, variable 'x'.
 * No eval() or new Function() — uses a hand-written recursive-descent parser.
 *
 * Transform pipeline: rawValue → equation(x) → clamp(min, max) → result
 */

// ── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('+-*/()'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue; }
    if (ch === 'x' || ch === 'X') { tokens.push({ type: 'var' }); i++; continue; }
    if (/[\d.]/.test(ch)) {
      let num = '';
      while (i < expr.length && /[\d.eE+\-]/.test(expr[i])) {
        // Allow 'e'/'E' followed by optional +/- for scientific notation,
        // but only if preceded by 'e'/'E'
        if ((expr[i] === '+' || expr[i] === '-') && num.length > 0 && !/[eE]$/.test(num)) break;
        num += expr[i];
        i++;
      }
      const parsed = parseFloat(num);
      if (isNaN(parsed)) throw new Error(`Invalid number: ${num}`);
      tokens.push({ type: 'num', value: parsed });
      continue;
    }
    throw new Error(`Unexpected character: '${ch}'`);
  }
  return tokens;
}

// ── Recursive-descent parser ─────────────────────────────────────────────────
// expr   = term (('+' | '-') term)*
// term   = factor (('*' | '/') factor)*
// factor = unary | '(' expr ')' | number | x

function parse(tokens) {
  let pos = 0;

  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }

  function parseExpr() {
    let left = parseTerm();
    while (peek() && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseTerm();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (peek() && (peek().value === '*' || peek().value === '/')) {
      const op = consume().value;
      const right = parseFactor();
      left = { type: 'binary', op, left, right };
    }
    return left;
  }

  function parseFactor() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');

    // Unary minus / plus
    if (t.value === '-') { consume(); return { type: 'unary', op: '-', operand: parseFactor() }; }
    if (t.value === '+') { consume(); return parseFactor(); }

    // Parenthesized sub-expression
    if (t.value === '(') {
      consume(); // '('
      const e = parseExpr();
      const closing = peek();
      if (!closing || closing.value !== ')') throw new Error("Missing closing ')'");
      consume(); // ')'
      return e;
    }

    // Number literal
    if (t.type === 'num') { consume(); return { type: 'literal', value: t.value }; }

    // Variable x
    if (t.type === 'var') { consume(); return { type: 'variable' }; }

    throw new Error(`Unexpected token: '${t.value || t.type}'`);
  }

  const ast = parseExpr();
  if (pos < tokens.length) throw new Error('Unexpected tokens after expression');
  return ast;
}

// ── AST evaluator ────────────────────────────────────────────────────────────

function evaluate(ast, x) {
  switch (ast.type) {
    case 'literal':  return ast.value;
    case 'variable': return x;
    case 'unary':    return ast.op === '-' ? -evaluate(ast.operand, x) : evaluate(ast.operand, x);
    case 'binary': {
      const l = evaluate(ast.left, x);
      const r = evaluate(ast.right, x);
      switch (ast.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? NaN : l / r;
        default:  return NaN;
      }
    }
    default: return NaN;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a math expression with variable 'x'.
 * Returns x unchanged if equation is empty or invalid.
 */
export function evalEquation(equation, x) {
  if (!equation || typeof equation !== 'string' || !equation.trim()) return x;
  try {
    const tokens = tokenize(equation.trim());
    if (tokens.length === 0) return x;
    const ast = parse(tokens);
    const result = evaluate(ast, x);
    return isNaN(result) || !isFinite(result) ? x : result;
  } catch {
    return x;
  }
}

/**
 * Apply the full transform pipeline to a raw value.
 * Order: clamp first (validate raw input), then equation (scale/convert).
 *
 * Example: min=40, max=80, equation="x * 100"
 *   raw 50 → clamp(40,80) → 50 → equation → 5000
 *
 * @param {number} rawValue
 * @param {{ min?: number|null, max?: number|null, equation?: string }} filter
 * @returns {number}
 */
export function applyTransform(rawValue, filter) {
  if (rawValue == null) return rawValue;
  if (!filter) return rawValue;

  let val = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (isNaN(val)) return rawValue;

  // Step 1: Clamp to min
  if (filter.min != null && typeof filter.min === 'number' && val < filter.min) {
    val = filter.min;
  }

  // Step 2: Clamp to max
  if (filter.max != null && typeof filter.max === 'number' && val > filter.max) {
    val = filter.max;
  }

  // Step 3: Apply equation
  if (filter.equation) {
    val = evalEquation(filter.equation, val);
  }

  return val;
}

/**
 * Validate an equation string.
 * @returns {string|null} null if valid, error message if invalid.
 */
export function validateEquation(equation) {
  if (!equation || !equation.trim()) return null;
  try {
    const tokens = tokenize(equation.trim());
    if (tokens.length === 0) return null;
    parse(tokens);
    return null;
  } catch (err) {
    return err.message;
  }
}

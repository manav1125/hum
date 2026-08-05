/**
 * A small, fail-closed formula evaluator for the workbooks Spreadsheet Studio
 * produces.
 *
 * Why this exists: `spreadsheet_create` writes formula cells as ExcelJS
 * `{ formula }` with **no cached result** — Excel/Numbers/Sheets recompute on
 * open (`fullCalcOnLoad`). But a *viewer* that only reads the file (the native
 * in-Cue spreadsheet surface) has no spreadsheet engine, so every formula cell
 * would render blank. Rather than ship a heavyweight formula engine into the
 * browser, we compute results here — where ExcelJS already lives — and store
 * them as `{ formula, result }` so the delivered file carries real cached
 * numbers. This also improves the download: any non-recalculating viewer now
 * shows values, not empty cells.
 *
 * The honesty contract (load-bearing): this evaluator is **fail-closed**. It
 * returns a value ONLY when it can fully resolve one from the actual cell
 * graph. Anything it cannot evaluate — an unsupported function, an unparseable
 * expression, a cyclic reference, a division by zero — returns `undefined`,
 * the cell is left uncached, and the viewer renders the formula text (clearly
 * marked) instead of a number. A cached number is therefore always a number we
 * actually computed; we never emit a guessed or stale value.
 *
 * Supported surface (the SaaS-model / budget / cap-table vocabulary the skill
 * emits): number/string/boolean literals, cell refs (`A1`, `$A$1`,
 * `Sheet!A1`, `'Sheet Name'!A1`), ranges inside function args (`A1:B3`),
 * operators `+ - * / ^` and trailing `%`, unary minus, parentheses,
 * comparisons (`= <> < <= > >=`), and the functions SUM, AVERAGE, MIN, MAX,
 * COUNT, IF, ROUND, ABS. Deliberately conservative — breadth is traded for the
 * guarantee that whatever it does return is correct.
 */

export type CellScalar = number | string | boolean;

/** A parsed cell as handed to the evaluator: either a literal or a formula. */
export interface ModelCell {
  /** Formula body WITHOUT the leading `=` (e.g. "B2*12"). */
  formula?: string;
  /** Literal value for non-formula cells. */
  literal?: CellScalar | null;
}

/** sheetName → "A1" → ModelCell */
export type WorkbookModel = Map<string, Map<string, ModelCell>>;

// ---------------------------------------------------------------------------
// A1 / column-letter helpers
// ---------------------------------------------------------------------------

export function colLetterToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n; // 1-based
}

function colIndexToLetter(index: number): string {
  let s = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokType =
  | "num"
  | "str"
  | "ref"
  | "func"
  | "op"
  | "lparen"
  | "rparen"
  | "comma"
  | "colon"
  | "percent";

interface Token {
  type: TokType;
  value: string;
}

class FormulaError extends Error {}

const FUNCTIONS = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "IF",
  "ROUND",
  "ABS",
]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    // String literal
    if (ch === '"') {
      let j = i + 1;
      let str = "";
      while (j < n) {
        if (input[j] === '"') {
          if (input[j + 1] === '"') {
            str += '"';
            j += 2;
            continue;
          }
          break;
        }
        str += input[j];
        j++;
      }
      if (j >= n) throw new FormulaError("unterminated string");
      tokens.push({ type: "str", value: str });
      i = j + 1;
      continue;
    }
    // Number
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.]/.test(input[j])) j++;
      // scientific notation
      if (j < n && (input[j] === "e" || input[j] === "E")) {
        j++;
        if (j < n && (input[j] === "+" || input[j] === "-")) j++;
        while (j < n && /[0-9]/.test(input[j])) j++;
      }
      tokens.push({ type: "num", value: input.slice(i, j) });
      i = j;
      continue;
    }
    // Quoted sheet name: 'My Sheet'!A1
    if (ch === "'") {
      let j = i + 1;
      let name = "";
      while (j < n && input[j] !== "'") {
        name += input[j];
        j++;
      }
      if (j >= n || input[j + 1] !== "!") {
        throw new FormulaError("bad quoted sheet reference");
      }
      // consume up through the '!'
      j += 2;
      // read the A1 part (with optional $)
      const start = j;
      while (j < n && /[A-Za-z0-9$]/.test(input[j])) j++;
      const a1 = input.slice(start, j);
      tokens.push({ type: "ref", value: `${name}!${a1}` });
      i = j;
      continue;
    }
    // Identifier: function name, or a cell ref / sheet-qualified ref
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$.]/.test(input[j])) j++;
      let ident = input.slice(i, j);
      // Sheet-qualified: Name!A1 (unquoted sheet name)
      if (j < n && input[j] === "!") {
        j++;
        const start = j;
        while (j < n && /[A-Za-z0-9$]/.test(input[j])) j++;
        ident = `${ident}!${input.slice(start, j)}`;
        tokens.push({ type: "ref", value: ident });
        i = j;
        continue;
      }
      const upper = ident.toUpperCase();
      // Function call if immediately followed by '('
      let k = j;
      while (k < n && (input[k] === " " || input[k] === "\t")) k++;
      if (input[k] === "(" && FUNCTIONS.has(upper)) {
        tokens.push({ type: "func", value: upper });
        i = j;
        continue;
      }
      if (upper === "TRUE" || upper === "FALSE") {
        tokens.push({ type: "num", value: upper === "TRUE" ? "1" : "0" });
        i = j;
        continue;
      }
      // Otherwise a cell reference (A1 style). Validate shape.
      tokens.push({ type: "ref", value: ident });
      i = j;
      continue;
    }
    // Operators & punctuation
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i++;
      continue;
    }
    if (ch === ":") {
      tokens.push({ type: "colon", value: ch });
      i++;
      continue;
    }
    if (ch === "%") {
      tokens.push({ type: "percent", value: ch });
      i++;
      continue;
    }
    // Multi-char comparison operators
    if (ch === "<" || ch === ">") {
      if (input[i + 1] === "=") {
        tokens.push({ type: "op", value: ch + "=" });
        i += 2;
        continue;
      }
      if (ch === "<" && input[i + 1] === ">") {
        tokens.push({ type: "op", value: "<>" });
        i += 2;
        continue;
      }
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if ("+-*/^=&".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    throw new FormulaError(`unexpected character '${ch}'`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser + evaluator (recursive descent)
// ---------------------------------------------------------------------------

interface RefAddr {
  sheet?: string;
  col: number;
  row: number;
}

function parseA1(ref: string): RefAddr | null {
  let sheet: string | undefined;
  let a1 = ref;
  const bang = ref.indexOf("!");
  if (bang !== -1) {
    sheet = ref.slice(0, bang);
    a1 = ref.slice(bang + 1);
  }
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/.exec(a1);
  if (!m) return null;
  return {
    sheet,
    col: colLetterToIndex(m[1]),
    row: parseInt(m[2], 10),
  };
}

class Evaluator {
  private tokens: Token[];
  private pos = 0;

  constructor(
    private model: WorkbookModel,
    private currentSheet: string,
    private resolve: (sheet: string, addr: string) => CellScalar | undefined,
    tokens: Token[],
  ) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  /** Entry point: parse a full expression, require all input consumed. */
  evaluate(): CellScalar {
    const v = this.parseComparison();
    if (this.pos !== this.tokens.length) {
      throw new FormulaError("trailing tokens");
    }
    return v;
  }

  private parseComparison(): CellScalar {
    const left = this.parseAddSub();
    const t = this.peek();
    if (
      t &&
      t.type === "op" &&
      ["=", "<>", "<", "<=", ">", ">="].includes(t.value)
    ) {
      this.next();
      const right = this.parseAddSub();
      return this.compare(t.value, left, right);
    }
    return left;
  }

  private compare(op: string, a: CellScalar, b: CellScalar): boolean {
    let cmp: number;
    if (typeof a === "number" && typeof b === "number") {
      cmp = a === b ? 0 : a < b ? -1 : 1;
    } else {
      const sa = String(a);
      const sb = String(b);
      cmp = sa === sb ? 0 : sa < sb ? -1 : 1;
    }
    switch (op) {
      case "=":
        return cmp === 0;
      case "<>":
        return cmp !== 0;
      case "<":
        return cmp < 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case ">=":
        return cmp >= 0;
      default:
        throw new FormulaError("bad comparison");
    }
  }

  private parseAddSub(): CellScalar {
    let left = this.parseMulDiv();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "+" || t.value === "-")) {
        this.next();
        const right = this.parseMulDiv();
        left = this.arith(t.value, left, right);
      } else if (t && t.type === "op" && t.value === "&") {
        this.next();
        const right = this.parseMulDiv();
        left = String(this.toStr(left)) + String(this.toStr(right));
      } else {
        break;
      }
    }
    return left;
  }

  private parseMulDiv(): CellScalar {
    let left = this.parsePower();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "*" || t.value === "/")) {
        this.next();
        const right = this.parsePower();
        left = this.arith(t.value, left, right);
      } else {
        break;
      }
    }
    return left;
  }

  private parsePower(): CellScalar {
    const left = this.parseUnary();
    const t = this.peek();
    if (t && t.type === "op" && t.value === "^") {
      this.next();
      const right = this.parsePower(); // right-assoc
      return Math.pow(this.toNum(left), this.toNum(right));
    }
    return left;
  }

  private parseUnary(): CellScalar {
    const t = this.peek();
    if (t && t.type === "op" && (t.value === "-" || t.value === "+")) {
      this.next();
      const v = this.parseUnary();
      return t.value === "-" ? -this.toNum(v) : this.toNum(v);
    }
    return this.parsePostfix();
  }

  private parsePostfix(): CellScalar {
    const v = this.parsePrimary();
    const t = this.peek();
    if (t && t.type === "percent") {
      this.next();
      return this.toNum(v) / 100;
    }
    return v;
  }

  private parsePrimary(): CellScalar {
    const t = this.next();
    if (!t) throw new FormulaError("unexpected end of input");
    switch (t.type) {
      case "num":
        return parseFloat(t.value);
      case "str":
        return t.value;
      case "lparen": {
        const v = this.parseComparison();
        const close = this.next();
        if (!close || close.type !== "rparen") {
          throw new FormulaError("expected )");
        }
        return v;
      }
      case "ref":
        return this.resolveRef(t.value);
      case "func":
        return this.callFunction(t.value);
      default:
        throw new FormulaError(`unexpected token '${t.value}'`);
    }
  }

  private resolveRef(ref: string): CellScalar {
    const addr = parseA1(ref);
    if (!addr) throw new FormulaError(`bad reference '${ref}'`);
    const sheet = addr.sheet ?? this.currentSheet;
    const a1 = `${colIndexToLetter(addr.col)}${addr.row}`;
    const v = this.resolve(sheet, a1);
    if (v === undefined) {
      // Distinguish a genuinely blank/absent cell (Excel treats it as 0 in
      // arithmetic) from a cell that DOES hold something but couldn't be
      // resolved — an unsupported formula, a failed formula, or a cycle. The
      // latter must fail THIS formula too; silently substituting 0 would emit
      // a wrong number, which the honesty contract forbids.
      const cell = this.model.get(sheet)?.get(a1);
      if (cell && cell.formula !== undefined) {
        throw new FormulaError(`unresolved dependency '${ref}'`);
      }
      return 0;
    }
    return v;
  }

  /** Expand the pending argument list, flattening ranges into scalars. */
  private callFunction(name: string): CellScalar {
    const open = this.next();
    if (!open || open.type !== "lparen") throw new FormulaError("expected (");
    const args: CellScalar[][] = [];
    // parse comma-separated args; each arg may be a range
    if (this.peek()?.type !== "rparen") {
      for (;;) {
        args.push(this.parseArg());
        const t = this.peek();
        if (t && t.type === "comma") {
          this.next();
          continue;
        }
        break;
      }
    }
    const close = this.next();
    if (!close || close.type !== "rparen") throw new FormulaError("expected )");

    const flat = args.flat();
    const nums = () => flat.map((v) => this.toNum(v));
    switch (name) {
      case "SUM":
        return nums().reduce((a, b) => a + b, 0);
      case "AVERAGE": {
        const ns = nums();
        if (ns.length === 0) throw new FormulaError("AVERAGE of nothing");
        return ns.reduce((a, b) => a + b, 0) / ns.length;
      }
      case "MIN":
        return Math.min(...nums());
      case "MAX":
        return Math.max(...nums());
      case "COUNT":
        return flat.filter((v) => typeof v === "number").length;
      case "ABS":
        if (flat.length !== 1) throw new FormulaError("ABS arity");
        return Math.abs(this.toNum(flat[0]));
      case "ROUND": {
        if (args.length !== 2) throw new FormulaError("ROUND arity");
        const x = this.toNum(args[0][0]);
        const d = this.toNum(args[1][0]);
        const f = Math.pow(10, d);
        return Math.round(x * f) / f;
      }
      case "IF": {
        if (args.length < 2) throw new FormulaError("IF arity");
        const cond = args[0][0];
        const truthy =
          typeof cond === "boolean"
            ? cond
            : typeof cond === "number"
              ? cond !== 0
              : cond !== "";
        if (truthy) return args[1][0];
        return args.length >= 3 ? args[2][0] : false;
      }
      default:
        throw new FormulaError(`unsupported function ${name}`);
    }
  }

  /** Parse one function argument, which may be a range `A1:B3`. */
  private parseArg(): CellScalar[] {
    // Look ahead for a range: ref colon ref
    const t = this.peek();
    if (t && t.type === "ref" && this.tokens[this.pos + 1]?.type === "colon") {
      const startTok = this.next()!; // ref
      this.next(); // colon
      const endTok = this.next();
      if (!endTok || endTok.type !== "ref") {
        throw new FormulaError("bad range");
      }
      return this.expandRange(startTok.value, endTok.value);
    }
    // Otherwise a scalar expression
    return [this.parseComparison()];
  }

  private expandRange(startRef: string, endRef: string): CellScalar[] {
    const a = parseA1(startRef);
    const b = parseA1(endRef);
    if (!a || !b) throw new FormulaError("bad range endpoints");
    const sheet = a.sheet ?? this.currentSheet;
    // A range can't span sheets.
    if (b.sheet && b.sheet !== sheet)
      throw new FormulaError("cross-sheet range");
    const c1 = Math.min(a.col, b.col);
    const c2 = Math.max(a.col, b.col);
    const r1 = Math.min(a.row, b.row);
    const r2 = Math.max(a.row, b.row);
    const out: CellScalar[] = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const a1 = `${colIndexToLetter(c)}${r}`;
        const v = this.resolve(sheet, a1);
        if (v !== undefined) {
          out.push(v);
        } else {
          // Blank cells in a range are simply skipped (Excel semantics), but a
          // cell that holds an unresolved formula would make an aggregate over
          // the range wrong — fail the whole formula instead.
          const cell = this.model.get(sheet)?.get(a1);
          if (cell && cell.formula !== undefined) {
            throw new FormulaError(`unresolved dependency in range '${a1}'`);
          }
        }
      }
    }
    return out;
  }

  private arith(op: string, a: CellScalar, b: CellScalar): number {
    const x = this.toNum(a);
    const y = this.toNum(b);
    switch (op) {
      case "+":
        return x + y;
      case "-":
        return x - y;
      case "*":
        return x * y;
      case "/":
        if (y === 0) throw new FormulaError("division by zero");
        return x / y;
      default:
        throw new FormulaError(`bad operator ${op}`);
    }
  }

  private toNum(v: CellScalar): number {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const t = v.trim();
      if (t === "") return 0;
      const n = Number(t);
      if (Number.isNaN(n)) throw new FormulaError(`'${v}' is not a number`);
      return n;
    }
    throw new FormulaError("non-numeric value");
  }

  private toStr(v: CellScalar): string {
    return typeof v === "string" ? v : String(v);
  }
}

// ---------------------------------------------------------------------------
// Public: compute all formula results for a workbook model
// ---------------------------------------------------------------------------

/**
 * Compute the cached value for every formula cell in `model`.
 *
 * Returns `sheetName → "A1" → CellScalar` containing only cells that resolved
 * to a concrete value. Formula cells whose value could not be computed (cycles,
 * unsupported syntax, div-by-zero, references into other uncomputable cells)
 * are simply absent — the caller leaves them uncached. Literal cells are also
 * included so callers have a single resolved view.
 */
export function computeResults(
  model: WorkbookModel,
): Map<string, Map<string, CellScalar>> {
  const results = new Map<string, Map<string, CellScalar>>();
  for (const sheet of model.keys()) results.set(sheet, new Map());

  // memo of resolved values; `null` marks "in progress" for cycle detection
  const memo = new Map<string, CellScalar | null | undefined>();

  const key = (sheet: string, a1: string) => `${sheet} ${a1}`;

  function resolve(sheet: string, a1: string): CellScalar | undefined {
    const k = key(sheet, a1);
    if (memo.has(k)) {
      const m = memo.get(k);
      // null → currently being evaluated (cycle) → fail-closed
      return m === null ? undefined : m;
    }
    const sheetCells = model.get(sheet);
    const cell = sheetCells?.get(a1);
    if (!cell) {
      memo.set(k, undefined);
      return undefined;
    }
    if (cell.formula === undefined) {
      const lit =
        cell.literal === null || cell.literal === undefined
          ? undefined
          : cell.literal;
      memo.set(k, lit);
      return lit;
    }
    // formula: mark in-progress, evaluate
    memo.set(k, null);
    let value: CellScalar | undefined;
    try {
      const tokens = tokenize(cell.formula);
      const evaluator = new Evaluator(model, sheet, resolve, tokens);
      const v = evaluator.evaluate();
      // Only cache finite numbers / strings / booleans.
      if (typeof v === "number" && (Number.isNaN(v) || !Number.isFinite(v))) {
        value = undefined;
      } else {
        value = v;
      }
    } catch {
      value = undefined; // fail-closed
    }
    memo.set(k, value ?? undefined);
    return value;
  }

  for (const [sheet, cells] of model) {
    const out = results.get(sheet)!;
    for (const [a1, cell] of cells) {
      if (cell.formula === undefined) continue; // only report formula results
      const v = resolve(sheet, a1);
      if (v !== undefined) out.set(a1, v);
    }
  }
  return results;
}

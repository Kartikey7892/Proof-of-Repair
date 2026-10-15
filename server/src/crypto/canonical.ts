/**
 * Python-compatible canonical JSON.
 *
 * Proof hashes were defined by Python's `json.dumps(obj, sort_keys=True,
 * separators=(",", ":"))`. `JSON.stringify` differs in three ways that would
 * silently change every digest, so we reproduce Python's encoder exactly:
 *
 *  1. Strings: Python defaults to `ensure_ascii=True` — every char outside
 *     0x20..0x7E is `\uXXXX` escaped (lowercase hex, UTF-16 surrogate pairs).
 *  2. Floats: Python keeps `1.0` (JS prints `1`) and uses `1e+16` / `1e-05`
 *     exponent style. JS numbers carry no int/float tag, so callers name the
 *     keys whose values are Python floats (e.g. `timestamp`, `confidence`).
 *  3. Keys are sorted by code point.
 */

export interface CanonicalOptions {
  /** Keys whose numeric values (or arrays of numbers) are Python floats. */
  floatKeys?: ReadonlySet<string>;
  /** Pretty-print like `json.dumps(..., indent=n)`; omit for compact form. */
  indent?: number;
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

export function pyString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    const esc = ESCAPES[ch];
    if (esc) out += esc;
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else out += "\\u" + code.toString(16).padStart(4, "0");
  }
  return out + '"';
}

/** `repr(float)` — shortest round-trip digits, Python's fixed/exponent switch. */
export function pyFloat(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";

  // toExponential() without an argument yields the shortest round-trip digits,
  // the same digit string Python's repr uses.
  const [mant, expStr] = n.toExponential().split("e") as [string, string];
  const exp = Number(expStr);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  const sign = neg ? "-" : "";

  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  const intLen = exp + 1;
  if (digits.length <= intLen) return `${sign}${digits.padEnd(intLen, "0")}.0`;
  return `${sign}${digits.slice(0, intLen)}.${digits.slice(intLen)}`;
}

function pyInt(n: number): string {
  if (!Number.isInteger(n)) {
    // A non-integral number in an int slot can only have come from a Python float.
    return pyFloat(n);
  }
  return Object.is(n, -0) ? "0" : String(n);
}

function cmpCodePoint(a: string, b: string): number {
  const ia = [...a];
  const ib = [...b];
  const len = Math.min(ia.length, ib.length);
  for (let i = 0; i < len; i++) {
    const d = ia[i]!.codePointAt(0)! - ib[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ia.length - ib.length;
}

export function canonicalDumps(value: unknown, opts: CanonicalOptions = {}): string {
  const floatKeys = opts.floatKeys ?? new Set<string>();
  const indent = opts.indent;

  const enc = (v: unknown, asFloat: boolean, depth: number): string => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") return asFloat ? pyFloat(v) : pyInt(v);
    if (typeof v === "string") return pyString(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const items = v.map((x) => enc(x, asFloat, depth + 1));
      return wrap("[", "]", items, depth);
    }
    if (typeof v === "object") {
      const keys = Object.keys(v as object)
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .sort(cmpCodePoint);
      if (keys.length === 0) return "{}";
      const sep = indent === undefined ? ":" : ": ";
      const items = keys.map(
        (k) => pyString(k) + sep + enc((v as Record<string, unknown>)[k], floatKeys.has(k), depth + 1),
      );
      return wrap("{", "}", items, depth);
    }
    throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
  };

  const wrap = (open: string, close: string, items: string[], depth: number): string => {
    if (indent === undefined) return open + items.join(",") + close;
    const pad = " ".repeat(indent * (depth + 1));
    const end = " ".repeat(indent * depth);
    return `${open}\n${pad}${items.join(`,\n${pad}`)}\n${end}${close}`;
  };

  return enc(value, false, 0);
}

/** Float-typed keys in the Proof-of-Repair schema (Python `float` fields). */
export const POR_FLOAT_KEYS: ReadonlySet<string> = new Set(["timestamp", "confidence"]);

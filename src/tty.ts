/**
 * Terminal primitives for the live run view — zero-dependency ANSI, by design.
 *
 * Three concerns live here, all pure (no process/global reads inside the hot
 * paths — capabilities are detected once and passed in):
 *
 *   - capabilities  what this terminal supports (color depth, unicode)
 *   - styling       a palette bound to those capabilities; plain passthrough
 *                   when color is off, so callers never branch
 *   - text safety   sanitizing event-derived text (labels, log messages,
 *                   errors come from workflow scripts and adapter output —
 *                   untrusted as far as the terminal is concerned: a stray
 *                   ESC/OSC/CR could redraw our UI, retitle the window, or
 *                   worse) and display-width math (CJK-aware) so the repaint
 *                   cursor arithmetic stays exact
 *
 * The color values mirror the web client's design tokens (web/src/theme.css):
 * emerald for the brand/success, amber for "running", red for failure — the
 * dashboard and the terminal read as one product.
 */

export interface TermCaps {
  /** ANSI styling at all (false: emit plain text only). */
  color: boolean;
  /** 24-bit color (COLORTERM=truecolor|24bit); otherwise the 16-color set. */
  truecolor: boolean;
  /** Unicode glyphs (spinner, check marks). ASCII fallbacks otherwise. */
  unicode: boolean;
}

const ESC = "\x1b";

/** Detect capabilities for a stream. Pure given its inputs; call once. */
export function detectCaps(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>,
): TermCaps {
  const isTTY = stream.isTTY === true;
  const color =
    isTTY && env.NO_COLOR === undefined && env.TERM !== "dumb" && env.TERM !== undefined;
  const truecolor = color && /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "");
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  // macOS terminals are UTF-8 even when the locale vars are unset.
  const unicode = /utf-?8/i.test(locale) || (locale === "" && process.platform === "darwin");
  return { color, truecolor, unicode };
}

// --- styling ------------------------------------------------------------------

const RESET = `${ESC}[0m`;

/** One style: 16-color SGR fallback + optional truecolor upgrade. */
function style(caps: TermCaps, basic: string, rgb?: [number, number, number]) {
  if (!caps.color) return (s: string) => s;
  const open =
    caps.truecolor && rgb ? `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `${ESC}[${basic}m`;
  return (s: string) => `${open}${s}${RESET}`;
}

export interface Palette {
  /** Brand accent (workflow name, final check) — emerald. */
  accent(s: string): string;
  /** Success — emerald. */
  ok(s: string): string;
  /** In flight — amber. */
  run(s: string): string;
  /** Failure — red. */
  err(s: string): string;
  /** Secondary text (ids, adapters, timings). */
  dim(s: string): string;
  bold(s: string): string;
}

/** Build the palette for a capability set (plain passthrough when color off). */
export function palette(caps: TermCaps): Palette {
  return {
    accent: style(caps, "32", [16, 185, 129]), // --green:#10b981
    ok: style(caps, "32", [16, 185, 129]),
    run: style(caps, "33", [245, 158, 11]), // --amber:#f59e0b
    err: style(caps, "31", [239, 68, 68]), // --red:#ef4444
    dim: style(caps, "90", [112, 112, 112]), // --muted:#707070
    bold: caps.color ? (s: string) => `${ESC}[1m${s}${RESET}` : (s: string) => s,
  };
}

export interface Glyphs {
  spinner: string[];
  ok: string;
  fail: string;
  stop: string;
  bullet: string;
  header: string;
  rule: string;
}

export function glyphs(caps: TermCaps): Glyphs {
  return caps.unicode
    ? {
        spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"],
        ok: "✔",
        fail: "✖",
        stop: "■",
        bullet: "·",
        header: "◆",
        rule: "─",
      }
    : {
        spinner: ["-", "\\", "|", "/"],
        ok: "ok",
        fail: "x",
        stop: "#",
        bullet: "-",
        header: "*",
        rule: "-",
      };
}

// --- cursor / screen control ---------------------------------------------------

export const cursor = {
  hide: `${ESC}[?25l`,
  show: `${ESC}[?25h`,
  up(n: number): string {
    return n > 0 ? `${ESC}[${n}A` : "";
  },
  /** To column 1. */
  toCol1: "\r",
  /** Erase from cursor to end of screen. */
  eraseDown: `${ESC}[0J`,
};

// --- text safety ----------------------------------------------------------------

// ESC-introduced sequences (CSI, OSC with BEL or ST terminator, and any other
// ESC+final) must be stripped BEFORE the raw-control sweep, or the sweep would
// eat the ESC and leave the sequence payload behind as visible garbage.
const ANSI_SEQ = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^\\x07\\x1b]*(?:\\x07|${ESC}\\\\)|${ESC}[@-_]`,
  "g",
);
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Make event-derived text safe to print: no escape sequences, no control
 * characters, newlines/tabs flattened to spaces, length clamped. Everything the
 * live view prints that originated in a workflow script or adapter output must
 * pass through here exactly once.
 */
export function sanitizeText(raw: unknown, maxLen = 500): string {
  const s = String(raw ?? "");
  const flat = s
    .replace(ANSI_SEQ, "")
    .replace(/[\r\n\t\v\f]+/g, " ")
    .replace(CONTROLS, "")
    .trim();
  return displayWidth(flat) > maxLen ? `${truncateToWidth(flat, maxLen)}` : flat;
}

// Display-width: ranges that render two columns wide (CJK & friends). An
// approximation (no dependency): covers the scripts a workflow label or log
// line realistically contains.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK compat
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compat ideographs
  [0xfe30, 0xfe4f], // CJK compat forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff], // emoji blocks commonly rendered double-width
  [0x20000, 0x2fffd], // CJK ext B+
  [0x30000, 0x3fffd],
];

function charWidth(cp: number): number {
  if (cp === 0) return 0;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/** Terminal display width of a (sanitized, style-free) string. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * Hard-truncate to a display width, appending an ellipsis when cut. Guarantees
 * the result never wraps, which is what keeps the repaint's cursor-up
 * arithmetic exact (one logical line == one physical line).
 */
export function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(s) <= max) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** Pad with spaces to a display width (no-op if already wider). */
export function padEndWidth(s: string, w: number): string {
  const d = w - displayWidth(s);
  return d > 0 ? s + " ".repeat(d) : s;
}

/** mm:ss (or h:mm:ss past the hour), clamped at zero against clock skew. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Seconds with one decimal for sub-minute agent timings ("3.2s", then "1:04"). */
export function fmtDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  return clamped < 60_000 ? `${(clamped / 1000).toFixed(1)}s` : fmtElapsed(clamped);
}

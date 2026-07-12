/**
 * A minimal terminal emulator for renderer tests — just the CSI subset the
 * live view emits. Strip-ANSI assertions can't catch a wrong cursor-up count
 * or a stale line left behind by an erase; replaying the byte stream against
 * a screen model can.
 *
 * Supported: printable text, "\n" (newline + column 0 — Node TTYs are in
 * cooked mode, ONLCR maps \n to CR+LF, so this matches what a real terminal
 * sees), "\r", CSI n A (cursor up), CSI 0J / CSI J (erase from cursor to end
 * of screen), SGR (ignored), and DECTCEM show/hide (recorded).
 */
export class FakeTerm {
  lines: string[] = [""];
  row = 0;
  col = 0;
  hiddenCursor = false;
  /** Every byte ever written, unparsed — for asserting what was NOT emitted. */
  raw = "";
  readonly isTTY = true;

  constructor(public columns = 80) {}

  write(chunk: string): void {
    this.raw += chunk;
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i]!;
      if (ch === "\x1b") {
        i = this.escape(chunk, i);
        continue;
      }
      if (ch === "\n") {
        this.row++;
        this.col = 0;
        while (this.lines.length <= this.row) this.lines.push("");
        i++;
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i++;
        continue;
      }
      this.put(ch);
      i++;
    }
  }

  private put(ch: string): void {
    while (this.lines.length <= this.row) this.lines.push("");
    const line = this.lines[this.row]!;
    const padded = line.length < this.col ? line + " ".repeat(this.col - line.length) : line;
    this.lines[this.row] = padded.slice(0, this.col) + ch + padded.slice(this.col + 1);
    this.col++;
  }

  /** Parse one ESC sequence starting at `start`; return the index after it. */
  private escape(chunk: string, start: number): number {
    // CSI: ESC [ params final
    if (chunk[start + 1] === "[") {
      let j = start + 2;
      while (j < chunk.length && !/[@-~]/.test(chunk[j]!)) j++;
      if (j >= chunk.length) return chunk.length; // truncated sequence: drop
      const params = chunk.slice(start + 2, j);
      const final = chunk[j]!;
      this.csi(params, final);
      return j + 1;
    }
    // Any other ESC+byte: swallow the pair.
    return Math.min(start + 2, chunk.length);
  }

  private csi(params: string, final: string): void {
    if (final === "A") {
      const n = Number(params || "1");
      this.row = Math.max(0, this.row - (Number.isFinite(n) ? n : 1));
      return;
    }
    if (final === "J") {
      // 0J (or bare J): erase from the cursor to the end of the screen.
      if (params === "" || params === "0") {
        this.lines[this.row] = (this.lines[this.row] ?? "").slice(0, this.col);
        this.lines.length = this.row + 1;
      }
      return;
    }
    if (final === "l" && params === "?25") this.hiddenCursor = true;
    if (final === "h" && params === "?25") this.hiddenCursor = false;
    // SGR ("m") and everything else: ignored.
  }

  /** The screen as text: trailing blank space and blank tail lines trimmed. */
  text(): string {
    const out = this.lines.map((l) => l.replace(/\s+$/, ""));
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }
}

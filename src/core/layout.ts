// Doc -> lines of tokens. Prettier-style: a group is printed flat if it fits in the remaining
// width, otherwise its lines break. Closed folds become a single chip token.

import type { Doc, Kind, Text } from "./doc";

export interface Token {
  s: string;
  k: Kind | "fold";
  /** Fold id, for chip tokens. */
  fold?: string;
  /** Tag id (column item) this token belongs to. */
  tag?: string;
  /** Ref index: what the token means (for the context pane). */
  r?: number;
  /** Innermost open fold the token is in (null = top level of the laid-out doc). */
  f?: string | null;
  /** The doc node it was printed from: a stable anchor for the cursor across re-layouts. */
  src?: Text;
}

export interface LayoutLine {
  indent: number;
  tokens: Token[];
  /** Open folds that start on this line (for gutter toggles). */
  opens?: string[];
}

export interface LayoutResult {
  lines: LayoutLine[];
  /** Line where each visible fold starts (chip or opening line). */
  foldLine: Map<string, number>;
  /** First line of each visible tag (section). */
  tagLine: Map<string, number>;
  /** Column of the first token directly in each tag. */
  tagCol: Map<string, number>;
}

export interface LayoutCtx {
  width: number;
  isOpen(id: string): boolean;
  label(id: string): string;
}

const BREAK = 1;
const FLAT = 0;
const INDENT = 2;

/** A fill being laid out from part `from` onwards (avoids re-slicing the parts array). */
interface FillRest {
  t: "FR";
  c: Doc[];
  from: number;
}

type Cmd = [indent: number, mode: number, doc: Doc | FillRest, tag: string | undefined, fold: string | null];

export function layout(doc: Doc, ctx: LayoutCtx, rootFold: string | null = null): LayoutResult {
  const lines: LayoutLine[] = [];
  const foldLine = new Map<string, number>();
  const tagLine = new Map<string, number>();
  const tagCol = new Map<string, number>();
  let cur: LayoutLine = { indent: 0, tokens: [] };
  let col = 0;

  const newline = (ind: number) => {
    trimEnd(cur);
    lines.push(cur);
    cur = { indent: ind, tokens: [] };
    col = ind;
  };

  const stack: Cmd[] = [[0, BREAK, doc, undefined, rootFold]];
  while (stack.length) {
    const [ind, mode, d, tg, fid] = stack.pop()!;
    if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) stack.push([ind, mode, d[i], tg, fid]);
      continue;
    }
    switch (d.t) {
      case "s":
        if (d.s === " " && cur.tokens.length === 0) break; // no leading spaces
        {
          const tok: Token = { s: d.s, k: d.k, f: fid, src: d };
          if (tg) {
            tok.tag = tg;
            if (!tagCol.has(tg)) {
              tagCol.set(tg, col);
              tagLine.set(tg, lines.length); // the first token is the real start
            }
          }
          if (d.r !== undefined) tok.r = d.r;
          cur.tokens.push(tok);
        }
        col += d.s.length;
        break;
      case "l":
        if (mode === FLAT && d.m !== 2) {
          if (d.m === 0 && cur.tokens.length) {
            cur.tokens.push({ s: " ", k: "plain" });
            col += 1;
          }
        } else if (cur.tokens.length) {
          newline(ind);
        } else {
          cur.indent = ind; // already on a fresh line: just adopt the indent
          col = ind;
        }
        break;
      case "g":
        stack.push([ind, mode === FLAT || fits(d.c, ctx.width - col, ctx, stack) ? FLAT : BREAK, d.c, tg, fid]);
        break;
      case "i":
        stack.push([ind + INDENT, mode, d.c, tg, fid]);
        break;
      case "F":
      case "FR": {
        // Prettier's fill: print each item flat if it fits, and break a separator only
        // when the item after it doesn't fit on the current line.
        const parts = d.c;
        const from = d.t === "FR" ? d.from : 0;
        if (from >= parts.length) break;
        const rem = ctx.width - col;
        const content = parts[from];
        // Leave room for the separator's comma after the item.
        const contentMode = fits(content, rem - leadWidth(parts[from + 1]), ctx) ? FLAT : BREAK;
        if (from + 1 >= parts.length) {
          stack.push([ind, contentMode, content, tg, fid]);
          break;
        }
        const sep = parts[from + 1];
        if (from + 2 < parts.length) {
          stack.push([ind, mode, { t: "FR", c: parts, from: from + 2 }, tg, fid]);
          const pairFits = fits([content, sep, parts[from + 2]], rem - leadWidth(parts[from + 3]), ctx);
          stack.push([ind, pairFits ? FLAT : BREAK, sep, tg, fid]);
        } else {
          stack.push([ind, contentMode, sep, tg, fid]);
        }
        stack.push([ind, contentMode, content, tg, fid]);
        break;
      }
      case "t":
        if (!tagLine.has(d.id)) tagLine.set(d.id, lines.length);
        stack.push([ind, mode, d.c, d.id, fid]);
        break;
      case "f": {
        if (!foldLine.has(d.id)) foldLine.set(d.id, lines.length);
        if (ctx.isOpen(d.id)) {
          (cur.opens ??= []).push(d.id);
          stack.push([ind, mode, d.c, tg, d.id]);
        } else {
          const s = ctx.label(d.id);
          cur.tokens.push({ s, k: "fold", fold: d.id, tag: tg, f: fid });
          if (tg && !tagCol.has(tg)) {
            tagCol.set(tg, col);
            tagLine.set(tg, lines.length);
          }
          col += s.length + 2; // chip is drawn as ` label ` (its ▸ is in the gutter)
        }
        break;
      }
    }
  }
  trimEnd(cur);
  if (cur.tokens.length || lines.length === 0) lines.push(cur);
  return { lines, foldLine, tagLine, tagCol };
}

function trimEnd(l: LayoutLine) {
  const t = l.tokens;
  while (t.length && t[t.length - 1].s === " ") t.pop();
}

/**
 * Does `doc` fit flat within `rem` columns? Like prettier, it then keeps measuring the commands
 * that follow it (`rest`, top of stack last) up to the next line break, so text that trails the
 * group on the same line (`) AS "ALIAS",`) counts too.
 */
function fits(doc: Doc, rem: number, ctx: LayoutCtx, rest: Cmd[] = []): boolean {
  const stack: [mode: number, doc: Doc | FillRest][] = [[FLAT, doc]];
  let restIdx = rest.length - 1;
  while (rem >= 0) {
    if (!stack.length) {
      if (restIdx < 0) return true;
      const [, mode, d] = rest[restIdx--];
      stack.push([mode, d]);
      continue;
    }
    const [mode, d] = stack.pop()!;
    if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) stack.push([mode, d[i]]);
      continue;
    }
    switch (d.t) {
      case "s":
        rem -= d.s.length;
        break;
      case "l":
        // A line break in what follows ends the measured line: everything so far fit.
        if (mode === BREAK) return true;
        // A hard break inside `doc` means it can't be flat; one in the trailing commands ends the line.
        if (d.m === 2) return restIdx < rest.length - 1;
        if (d.m === 0) rem -= 1;
        break;
      case "f":
        if (ctx.isOpen(d.id)) stack.push([mode, d.c]);
        else rem -= ctx.label(d.id).length + 2;
        break;
      case "F":
      case "FR":
        for (let i = d.c.length - 1; i >= (d.t === "FR" ? d.from : 0); i--) stack.push([mode, d.c[i]]);
        break;
      default:
        stack.push([mode, d.c]);
    }
  }
  return false;
}

/** Width of the text a separator starts with (the `,` in `[",", line]`). */
function leadWidth(sep: Doc | undefined): number {
  let d = sep;
  while (Array.isArray(d)) d = d[0];
  return d && d.t === "s" ? d.s.length : 0;
}

/** Width of a token on screen, in columns (a fold chip is ` label `, padded). */
export function tokenWidth(t: Token): number {
  return t.k === "fold" ? t.s.length + 2 : t.s.length;
}

/** Width of a line, in columns. */
export function lineWidth(l: LayoutLine): number {
  let n = l.indent;
  for (const t of l.tokens) n += tokenWidth(t);
  return n;
}

/** Index of the token covering column `col` of a line (or -1 in the indent / past the end), and where it starts. */
export function tokenAt(l: LayoutLine, col: number): { i: number; start: number } {
  let c = l.indent;
  for (let i = 0; i < l.tokens.length; i++) {
    const w = tokenWidth(l.tokens[i]);
    if (col < c + w) return { i: col < c ? -1 : i, start: c };
    c += w;
  }
  return { i: -1, start: c };
}

/** Plain text of a layout (for copy). */
export function toText(res: LayoutResult): string {
  return res.lines.map((l) => " ".repeat(l.indent) + l.tokens.map((t) => t.s).join("")).join("\n");
}

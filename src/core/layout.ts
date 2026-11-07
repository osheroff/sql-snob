// Doc -> lines of tokens. Prettier-style: a group is printed flat if it fits in the remaining
// width, otherwise its lines break. Closed folds become a single chip token.

import type { Doc, Kind } from "./doc";

export interface Token {
  s: string;
  k: Kind | "fold";
  /** Fold id, for chip tokens. */
  fold?: string;
  /** Tag id (column item) this token belongs to. */
  tag?: string;
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
  /** First line of each visible tag. */
  tagLine: Map<string, number>;
}

export interface LayoutCtx {
  width: number;
  isOpen(id: string): boolean;
  label(id: string): string;
}

const BREAK = 1;
const FLAT = 0;
const INDENT = 2;

type Cmd = [indent: number, mode: number, doc: Doc, tag: string | undefined];

export function layout(doc: Doc, ctx: LayoutCtx): LayoutResult {
  const lines: LayoutLine[] = [];
  const foldLine = new Map<string, number>();
  const tagLine = new Map<string, number>();
  let cur: LayoutLine = { indent: 0, tokens: [] };
  let col = 0;

  const newline = (ind: number) => {
    trimEnd(cur);
    lines.push(cur);
    cur = { indent: ind, tokens: [] };
    col = ind;
  };

  const stack: Cmd[] = [[0, BREAK, doc, undefined]];
  while (stack.length) {
    const [ind, mode, d, tg] = stack.pop()!;
    if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) stack.push([ind, mode, d[i], tg]);
      continue;
    }
    switch (d.t) {
      case "s":
        if (d.s === " " && cur.tokens.length === 0) break; // no leading spaces
        cur.tokens.push(tg ? { s: d.s, k: d.k, tag: tg } : { s: d.s, k: d.k });
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
        stack.push([ind, mode === FLAT || fits(d.c, ctx.width - col, ctx) ? FLAT : BREAK, d.c, tg]);
        break;
      case "i":
        stack.push([ind + INDENT, mode, d.c, tg]);
        break;
      case "t":
        if (!tagLine.has(d.id)) tagLine.set(d.id, lines.length);
        stack.push([ind, mode, d.c, d.id]);
        break;
      case "f": {
        if (!foldLine.has(d.id)) foldLine.set(d.id, lines.length);
        if (ctx.isOpen(d.id)) {
          (cur.opens ??= []).push(d.id);
          stack.push([ind, mode, d.c, tg]);
        } else {
          const s = ctx.label(d.id);
          cur.tokens.push({ s, k: "fold", fold: d.id, tag: tg });
          col += s.length + 2; // chip padding
        }
        break;
      }
    }
  }
  trimEnd(cur);
  if (cur.tokens.length || lines.length === 0) lines.push(cur);
  return { lines, foldLine, tagLine };
}

function trimEnd(l: LayoutLine) {
  const t = l.tokens;
  while (t.length && t[t.length - 1].s === " ") t.pop();
}

/** Does `doc` fit flat within `rem` columns? Stops as soon as it doesn't. */
function fits(doc: Doc, rem: number, ctx: LayoutCtx): boolean {
  const stack: Doc[] = [doc];
  while (stack.length) {
    if (rem < 0) return false;
    const d = stack.pop()!;
    if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) stack.push(d[i]);
      continue;
    }
    switch (d.t) {
      case "s":
        rem -= d.s.length;
        break;
      case "l":
        if (d.m === 2) return false;
        if (d.m === 0) rem -= 1;
        break;
      case "f":
        if (ctx.isOpen(d.id)) stack.push(d.c);
        else rem -= ctx.label(d.id).length + 2;
        break;
      default:
        stack.push(d.c);
    }
  }
  return rem >= 0;
}

/** Plain text of a layout (for copy). */
export function toText(res: LayoutResult): string {
  return res.lines.map((l) => " ".repeat(l.indent) + l.tokens.map((t) => t.s).join("")).join("\n");
}

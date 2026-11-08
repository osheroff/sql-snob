// Wadler/prettier-style document IR, plus `fold` and `tag` nodes.
// Plain JSON objects so it can cross the worker boundary via structured clone.

export type Kind = "kw" | "id" | "str" | "num" | "op" | "com" | "fn" | "param" | "plain";

export interface Text {
  t: "s";
  s: string;
  k: Kind;
  /** Ref index (what this token means, for the context pane). */
  r?: number;
}
/** m: 0 = line (space when flat), 1 = softline (nothing when flat), 2 = hardline */
export interface Line {
  t: "l";
  m: 0 | 1 | 2;
}
export interface Group {
  t: "g";
  c: Doc;
}
export interface Indent {
  t: "i";
  c: Doc;
}
/** A foldable region. `c` is printed inline when open; `body` is the root used when focused. */
export interface Fold {
  t: "f";
  id: string;
  c: Doc;
  body?: Doc;
}
/** Tags every token inside with `id` (used to cross-highlight select-list columns). */
export interface Tag {
  t: "t";
  id: string;
  c: Doc;
}

/**
 * Paragraph-style list: `c` alternates content and separators (`[item, sep, item, sep, item]`).
 * Each separator breaks only if the next item doesn't fit on the current line.
 */
export interface Fill {
  t: "F";
  c: Doc[];
}

export type Doc = Text | Line | Group | Indent | Fold | Tag | Fill | Doc[];

export const text = (s: string, k: Kind = "plain"): Text => ({ t: "s", s, k });
export const line: Line = { t: "l", m: 0 };
export const softline: Line = { t: "l", m: 1 };
export const hardline: Line = { t: "l", m: 2 };
export const space = text(" ");
export const group = (c: Doc): Group => ({ t: "g", c });
export const indent = (c: Doc): Indent => ({ t: "i", c });
export const fold = (id: string, c: Doc, body?: Doc): Fold => ({ t: "f", id, c, body });
export const tag = (id: string, c: Doc): Tag => ({ t: "t", id, c });
export const fill = (c: Doc[]): Fill => ({ t: "F", c });

export function join(sep: Doc, docs: Doc[]): Doc[] {
  const out: Doc[] = [];
  docs.forEach((d, i) => {
    if (i > 0) out.push(sep);
    out.push(d);
  });
  return out;
}

/** Visit every Fold node in a doc tree. */
export function eachFold(doc: Doc, fn: (f: Fold) => void): void {
  const stack: Doc[] = [doc];
  while (stack.length) {
    const d = stack.pop()!;
    if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) stack.push(d[i]);
    } else if (d.t === "f") {
      fn(d);
      stack.push(d.c); // `body` is always a sub-doc of `c`, so it isn't walked separately
    } else if (d.t === "F") {
      for (let i = d.c.length - 1; i >= 0; i--) stack.push(d.c[i]);
    } else if (d.t === "g" || d.t === "i" || d.t === "t") {
      stack.push(d.c);
    }
  }
}

/**
 * One-line text of a doc as printed flat (open folds, no comments), for outline labels.
 * Cut at `max` characters with an ellipsis. `unquote` drops identifier quotes (`"Name"` -> `Name`).
 */
export function flat(doc: Doc, max = 140, unquote = false): string {
  let out = "";
  const stack: Doc[] = [doc];
  while (stack.length && out.length <= max) {
    const d = stack.pop()!;
    if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) stack.push(d[i]);
    } else if (d.t === "s") {
      if (d.k === "id" && unquote) out += unquoteIdent(d.s);
      else if (d.k !== "com") out += d.s;
    } else if (d.t === "l") {
      if (d.m !== 1) out += " ";
    } else if (d.t === "F") {
      for (let i = d.c.length - 1; i >= 0; i--) stack.push(d.c[i]);
    } else {
      stack.push(d.c);
    }
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max) + " …" : out;
}

/** `"Name"` -> `Name`, `` `a``b` `` -> `` a`b ``; anything else unchanged. */
export function unquoteIdent(s: string): string {
  const q = s[0];
  if (s.length < 2 || (q !== '"' && q !== "`") || s[s.length - 1] !== q) return s;
  return s.slice(1, -1).replaceAll(q + q, q);
}

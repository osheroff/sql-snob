// Wadler/prettier-style document IR, plus `fold` and `tag` nodes.
// Plain JSON objects so it can cross the worker boundary via structured clone.

export type Kind = "kw" | "id" | "str" | "num" | "op" | "com" | "fn" | "param" | "plain";

export interface Text {
  t: "s";
  s: string;
  k: Kind;
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

export type Doc = Text | Line | Group | Indent | Fold | Tag | Doc[];

export const text = (s: string, k: Kind = "plain"): Text => ({ t: "s", s, k });
export const line: Line = { t: "l", m: 0 };
export const softline: Line = { t: "l", m: 1 };
export const hardline: Line = { t: "l", m: 2 };
export const space = text(" ");
export const group = (c: Doc): Group => ({ t: "g", c });
export const indent = (c: Doc): Indent => ({ t: "i", c });
export const fold = (id: string, c: Doc, body?: Doc): Fold => ({ t: "f", id, c, body });
export const tag = (id: string, c: Doc): Tag => ({ t: "t", id, c });

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
    } else if (d.t === "g" || d.t === "i" || d.t === "t") {
      stack.push(d.c);
    }
  }
}

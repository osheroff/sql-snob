// Snowflake semi-structured path access (`col:field`, `"COL":"Field"`). sql-parser-cst has no
// grammar for it, so before parsing we swap each path `:` for `%`, which keeps every offset the
// same. After parsing, we turn those `%` nodes back into `:` and fix the grouping: `:` binds
// tighter than anything else, but `%` binds like `*`.

type N = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const PATH_START = /[A-Za-z_"]/;

/**
 * Replace each path `:` with `%`. A path `:` is a single `:` right after an identifier, `"`, `]`
 * or `)`, and right before a name or `"`. This skips `::` casts, `:name` parameters (they follow a
 * space or an operator) and MySQL `:=`. Strings, quoted names and comments are skipped.
 * Returns null when nothing changed.
 */
export function maskPathColons(sql: string): { text: string; positions: Set<number> } | null {
  const positions = new Set<number>();
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      // Quoted string or name; a doubled quote is an escaped quote.
      i++;
      while (i < n) {
        if (sql[i] === "\\" && c === "'") i += 2;
        else if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "$" && sql[i + 1] === "$") {
      const end = sql.indexOf("$$", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ":") {
      if (sql[i + 1] === ":") {
        i += 2;
        continue;
      }
      const prev = sql[i - 1] ?? "";
      if ((IDENT_CHAR.test(prev) || prev === '"' || prev === "]" || prev === ")") && PATH_START.test(sql[i + 1] ?? "")) {
        positions.add(i);
      }
      i++;
    } else i++;
  }
  if (positions.size === 0) return null;
  const chars = sql.split("");
  for (const p of positions) chars[p] = "%";
  return { text: chars.join(""), positions };
}

/** Rewrite the masked `%` nodes in the parse tree into `:` path nodes with Snowflake grouping. */
export function restorePaths<T>(cst: T, positions: Set<number>): T {
  return walk(cst, positions);
}

function walk(node: N, positions: Set<number>): N {
  if (Array.isArray(node)) return node.map((x) => walk(x, positions));
  if (!node || typeof node !== "object") return node;
  const out: N = {};
  for (const k of Object.keys(node)) out[k] = walk(node[k], positions);
  if (
    out.type === "binary_expr" &&
    out.operator === "%" &&
    out.left?.range &&
    positions.has(out.left.range[1])
  ) {
    return regroup({ ...out, operator: ":" });
  }
  return out;
}

function path(left: N, right: N): N {
  return regroup({ type: "binary_expr", operator: ":", left, right, range: [left.range[0], right.range[1]] });
}

/**
 * Children are already regrouped. Pull the `:` inside anything that the `%` parse let bind
 * tighter or equally: `y * x % a` -> `y * (x:a)`, `x % a::int` -> `(x:a)::int`,
 * `x % a.b` -> `(x:a).b`, `-x % a` -> `-(x:a)`.
 */
function regroup(n: N): N {
  const { left, right } = n;
  const span = [left.range[0], right.range[1]];
  if (left.type === "binary_expr" && left.operator !== ":") {
    return { ...left, right: path(left.right, right), range: span };
  }
  if (left.type === "prefix_op_expr" && typeof left.operator === "string") {
    return { ...left, expr: path(left.expr, right), range: span };
  }
  if (right.type === "binary_expr" && right.operator !== ":") {
    return { ...right, left: path(left, right.left), range: span };
  }
  if (right.type === "cast_operator_expr") {
    return { ...right, left: path(left, right.left), range: span };
  }
  if (right.type === "member_expr") {
    return { ...right, object: path(left, right.object), range: span };
  }
  return n;
}

// CST -> Doc printer. Also builds the fold outline and the column lists in the same pass.
//
// Node types with a rule below are laid out deliberately. Every other node type goes through
// `generic`, which prints its children in source order and keeps the original punctuation
// between them (with whitespace collapsed). So unknown syntax is never lost, only left unformatted.

import type { Program } from "sql-parser-cst";
import {
  type Doc,
  type Kind,
  fold,
  group,
  hardline,
  indent,
  join,
  line,
  softline,
  space,
  tag,
  text,
} from "./doc";
import type {
  ColumnItem,
  ColumnKind,
  ColumnList,
  FoldInfo,
  FoldKind,
  PrintOptions,
  PrintResult,
} from "./model";

// The CST is a big discriminated union; this file walks it structurally, so it uses a loose type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Query folds smaller than this (in source chars) start open. */
const SMALL_FOLD = 120;

const LITERAL_TYPES = new Set([
  "string_literal",
  "number_literal",
  "blob_literal",
  "boolean_literal",
  "null_literal",
  "datetime_literal",
  "time_literal",
  "date_literal",
  "timestamp_literal",
  "json_literal",
  "jsonb_literal",
  "numeric_literal",
  "bignumeric_literal",
  "interval_literal",
]);

const ATOMIC_TYPES = new Set([
  ...LITERAL_TYPES,
  "identifier",
  "member_expr",
  "parameter",
  "variable",
  "func_call",
  "cast_expr",
  "cast_operator_expr",
  "case_expr",
]);

/** Slots where an expression stands alone, so wrapping parens are never needed. */
const TOP_EXPR_PARENTS = new Set([
  "where_clause",
  "having_clause",
  "qualify_clause",
  "join_on_specification",
  "case_when",
  "case_else",
  "alias",
  "list_expr",
  "sort_specification",
]);

const COMPARISON_OPS = new Set([
  "=", "==", "<>", "!=", "<", ">", "<=", ">=",
  "IS", "IS NOT", "IS DISTINCT FROM", "IS NOT DISTINCT FROM",
  "LIKE", "NOT LIKE", "ILIKE", "NOT ILIKE", "RLIKE", "NOT RLIKE",
  "IN", "NOT IN", "SIMILAR TO", "NOT SIMILAR TO",
]);

function isSubSelect(n: N): boolean {
  if (!n) return false;
  if (n.type === "select_stmt" || n.type === "compound_select_stmt") return true;
  return n.type === "paren_expr" && isSubSelect(n.expr);
}

/** Strip redundant parens around a subselect: `((SELECT ...))` -> `SELECT ...`. */
function unwrapParens(n: N): N {
  while (n.type === "paren_expr") n = n.expr;
  return n;
}

function opName(op: N): string {
  if (typeof op === "string") return op.toUpperCase();
  if (Array.isArray(op)) return op.map(opName).join(" ");
  if (op?.type === "keyword") return op.name;
  return "";
}

function opRank(op: N): number {
  const name = opName(op);
  if (name === "OR") return 1;
  if (name === "AND") return 2;
  if (COMPARISON_OPS.has(name)) return 4;
  return 5;
}

function exprRank(n: N): number {
  if (n.type === "binary_expr") return opRank(n.operator);
  if (n.type === "prefix_op_expr" && opName(n.operator) === "NOT") return 3;
  if (n.type === "between_expr") return 4;
  return 6;
}

/** Display name of an identifier: unquoted name if it has one. */
function identName(n: N): string {
  if (!n) return "";
  if (n.type === "identifier") return n.name ?? n.text;
  if (n.type === "member_expr") return identName(n.property);
  return "";
}

const FOLD_ID_PREFIX: Record<FoldKind, string> = { cte: "q", derived: "d", subquery: "s", branch: "b", columns: "c" };

const COMMENT_RE = /--[^\n]*|\/\*[\s\S]*?\*\//g;

class Printer {
  folds: Record<string, FoldInfo> = {};
  roots: string[] = [];
  columns: Record<string, ColumnList> = {};
  rootColumns: string | undefined;

  /** > 0 while printing a data type, where identifiers are type names, not column/table names. */
  private typeDepth = 0;

  private stack: string[] = [];
  private usedNames = new Set<string>();
  private counters = new Map<string, number>();
  private seenComments = new Set<object>();

  constructor(
    private src: string,
    private opts: PrintOptions,
  ) {}

  // ---- folds ----------------------------------------------------------------

  private get current(): string | null {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  private get currentName(): string {
    const c = this.current;
    return c ? this.folds[c].name : "root";
  }

  private uniqueName(base: string): string {
    let name = base;
    for (let i = 2; this.usedNames.has(name); i++) name = `${base}_${i}`;
    this.usedNames.add(name);
    return name;
  }

  private numberedName(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return this.uniqueName(`${prefix}_${n}`);
  }

  private begin(kind: FoldKind, name: string, range: [number, number]): FoldInfo {
    const pfx = FOLD_ID_PREFIX[kind];
    let id = `${pfx}${range[0]}`;
    for (let i = 2; this.folds[id]; i++) id = `${pfx}${range[0]}_${i}`;
    const parent = this.current;
    const info: FoldInfo = {
      id,
      kind,
      name,
      parent,
      children: [],
      range,
      defaultOpen: kind !== "columns" && range[1] - range[0] < SMALL_FOLD,
    };
    this.folds[id] = info;
    if (parent) this.folds[parent].children.push(id);
    else this.roots.push(id);
    this.stack.push(id);
    return info;
  }

  private end(): void {
    this.stack.pop();
  }

  /** `( <fold> )` around a subquery. `name` must already be unique. */
  private subquery(paren: N, kind: FoldKind, name: string): Doc {
    const f = this.begin(kind, name, paren.range);
    const body = this.node(unwrapParens(paren));
    this.end();
    return [this.comments(paren), text("(", "op"), fold(f.id, group([indent([softline, body]), softline]), body), text(")", "op")];
  }

  // ---- comments -------------------------------------------------------------

  /** Leading + trailing comments of a node that haven't been printed yet. */
  private comments(n: N, which: "leading" | "trailing" = "leading"): Doc {
    const ws = n?.[which];
    if (!ws) return [];
    const out: Doc[] = [];
    for (const c of ws) {
      if (c.type !== "line_comment" && c.type !== "block_comment") continue;
      if (this.seenComments.has(c)) continue;
      this.seenComments.add(c);
      const t = text(c.text, "com");
      if (which === "leading") out.push(c.type === "line_comment" ? [t, hardline] : [t, space]);
      else out.push(c.type === "line_comment" ? [space, t, hardline] : [space, t]);
    }
    return out;
  }

  // ---- dispatch -------------------------------------------------------------

  node(n: N, parent?: N): Doc {
    if (n == null) return [];
    if (typeof n === "string") return text(n, "op");
    if (Array.isArray(n)) return join(space, n.map((x) => this.node(x, parent)));
    const lead = this.comments(n, "leading");
    const isType =
      /data_type|type_param/.test(n.type) ||
      (parent && (parent.dataType === n || (parent.type === "cast_operator_expr" && parent.right === n)));
    if (isType) this.typeDepth++;
    const body = this.dispatch(n, parent);
    if (isType) this.typeDepth--;
    const trail = this.comments(n, "trailing");
    return [lead, body, trail];
  }

  private kw(k: N): Doc {
    if (Array.isArray(k)) return join(space, k.map((x) => this.kw(x)));
    return [this.comments(k), text(k.text.toUpperCase(), "kw"), this.comments(k, "trailing")];
  }

  private dispatch(n: N, parent: N): Doc {
    switch (n.type) {
      case "program":
        return this.program(n);
      case "keyword":
        return text(n.text.toUpperCase(), "kw");
      case "identifier":
        // Type names (`::TEXT`, `MAP(VARCHAR, VARIANT)`) parse as identifiers; color them as syntax.
        if (this.typeDepth > 0) return text(n.text, "kw");
        return text(n.text, "id");
      case "parameter":
      case "variable":
        return text(n.text, "param");
      case "all_columns":
        return text("*", "op");
      case "string_literal":
        return text(n.text, "str");
      case "number_literal":
        return text(n.text, "num");

      case "select_stmt":
        return join(hardline, n.clauses.map((c: N) => this.node(c, n)));
      case "compound_select_stmt":
        return this.compound(n);
      case "with_clause":
        return [
          this.kw(n.withKw),
          n.recursiveKw ? [space, this.kw(n.recursiveKw)] : [],
          indent([hardline, join([text(",", "op"), hardline], n.tables.items.map((t: N) => this.node(t, n)))]),
        ];
      case "common_table_expr":
        return this.cte(n);
      case "select_clause":
        return this.selectClause(n);
      case "from_clause":
        return [this.kw(n.fromKw), space, this.tableExpr(n.expr, n)];
      case "join_expr":
        return this.tableExpr(n, parent);
      case "where_clause":
      case "having_clause":
      case "qualify_clause": {
        const kwNode = n.whereKw ?? n.havingKw ?? n.qualifyKw;
        return [this.kw(kwNode), space, this.node(n.expr, n)];
      }
      case "group_by_clause":
        return this.listClause([this.kw(n.groupByKw), n.distinctKw ? [space, this.kw(n.distinctKw)] : []], n.columns, n);
      case "order_by_clause":
        return this.listClause(this.kw(n.orderByKw), n.specifications, n);
      case "partition_by_clause":
        return this.listClause(this.kw(n.partitionByKw), n.specifications, n);
      case "join_on_specification":
        return [this.kw(n.onKw), space, this.node(n.expr, n)];

      case "paren_expr":
        return this.paren(n, parent);
      case "list_expr":
        return group(join([text(",", "op"), line], n.items.map((x: N) => this.node(x, n))));
      case "binary_expr":
        return this.binary(n);
      case "prefix_op_expr":
        return this.prefix(n);
      case "cast_operator_expr":
        return [this.node(n.left, n), text("::", "op"), this.node(n.right, n)];
      case "func_call":
        return [
          n.name.type === "identifier" ? text(n.name.text, "fn") : this.node(n.name, n),
          this.node(n.args, n),
          n.filter ? [space, this.node(n.filter, n)] : [],
          n.over ? [space, this.node(n.over, n)] : [],
        ];
      case "case_expr":
        return group([
          this.kw(n.caseKw),
          n.expr ? [space, this.node(n.expr, n)] : [],
          indent(n.clauses.map((c: N) => [line, this.node(c, n)])),
          line,
          this.kw(n.endKw),
        ]);
      case "case_when":
        return [this.kw(n.whenKw), space, this.node(n.condition, n), space, this.kw(n.thenKw), space, this.node(n.result, n)];
      case "case_else":
        return [this.kw(n.elseKw), space, this.node(n.result, n)];
      case "alias":
        return this.alias(n);

      default:
        return this.generic(n);
    }
  }

  // ---- statements -----------------------------------------------------------

  private program(n: N): Doc {
    const stmts = n.statements.filter((s: N) => s.type !== "empty");
    const hadSemicolon = n.statements.length > 1;
    const parts = stmts.map((s: N) => [this.node(s, n), hadSemicolon ? text(";", "op") : []]);
    return [join([hardline, hardline], parts), this.comments(n, "trailing")];
  }

  private cte(n: N): Doc {
    const name = this.uniqueName(identName(n.table) || "cte");
    return [
      this.node(n.table, n),
      n.columns ? this.node(n.columns, n) : [],
      space,
      this.kw(n.asKw),
      n.materializedKw ? [space, this.kw(n.materializedKw)] : [],
      space,
      this.subquery(n.expr, "cte", name),
      n.search ? [space, this.node(n.search, n)] : [],
      n.cycle ? [space, this.node(n.cycle, n)] : [],
    ];
  }

  private compound(n: N): Doc {
    const branches: N[] = [];
    const ops: N[] = [];
    const pre: Doc[] = [];
    const walk = (x: N) => {
      if (x.type === "compound_select_stmt") {
        if (x !== n) pre.push(this.comments(x));
        walk(x.left);
        ops.push(x.operator);
        walk(x.right);
      } else if (x.type === "select_stmt" && x.clauses.length === 1 && x.clauses[0].type === "paren_expr") {
        // A parenthesized arm parses as a select_stmt wrapping a paren_expr.
        pre.push(this.comments(x));
        branches.push(x.clauses[0]);
      } else branches.push(x);
    };
    walk(n);
    const owner = this.currentName;
    const out: Doc[] = [pre];
    branches.forEach((b, i) => {
      if (i > 0) out.push(hardline, this.kw(ops[i - 1]), hardline);
      const big = b.range[1] - b.range[0] >= SMALL_FOLD;
      if (!big) {
        out.push(this.node(b, n));
      } else if (b.type === "paren_expr") {
        out.push(this.subquery(b, "branch", this.uniqueName(`${owner}#${i + 1}`)));
      } else {
        const f = this.begin("branch", this.uniqueName(`${owner}#${i + 1}`), b.range);
        const body = this.node(b, n);
        this.end();
        out.push(fold(f.id, body, body));
      }
    });
    return out;
  }

  // ---- SELECT list ----------------------------------------------------------

  private selectClause(n: N): Doc {
    const head: Doc = [this.kw(n.selectKw), n.modifiers.map((m: N) => [space, this.node(m, n)])];
    if (!n.columns) return head;

    const listId = `l${n.range[0]}`;
    const owner = this.current;
    if (owner) this.folds[owner].columns ??= listId;
    else this.rootColumns ??= listId;

    const items: N[] = n.columns.items;
    const long = items.length >= this.opts.columnFoldThreshold;
    const f = long ? this.begin("columns", this.uniqueName(`${this.currentName}.columns`), n.columns.range) : null;
    if (f) f.count = items.length;

    const list: ColumnList = { id: listId, owner, foldId: f?.id, items: [] };
    const docs = items.map((it, i) => {
      const { doc, item } = this.column(it, i, listId, n.columns);
      list.items.push(item);
      return tag(item.tag, doc);
    });
    this.columns[listId] = list;

    if (!f) return group([head, indent([line, join([text(",", "op"), line], docs)])]);
    this.end();
    const body = join([text(",", "op"), hardline], docs);
    return [this.comments(n.columns), head, space, fold(f.id, indent([hardline, body]), body)];
  }

  private column(it: N, index: number, listId: string, listNode: N): { doc: Doc; item: ColumnItem } {
    const pre = it.type === "alias" ? this.comments(it) : [];
    const expr = it.type === "alias" ? it.expr : it;
    const alias = it.type === "alias" ? it.alias : null;
    const outputName = alias ? identName(alias) : identName(expr) || (expr.type === "all_columns" ? "*" : `?col_${index + 1}`);

    let exprDoc: Doc;
    if (isSubSelect(expr) && expr.type === "paren_expr") {
      const name = alias ? this.uniqueName(identName(alias)) : this.numberedName("scalar");
      exprDoc = this.subquery(expr, "subquery", name);
    } else {
      exprDoc = this.node(expr, it.type === "alias" ? it : listNode);
    }

    const same = alias && (expr.type === "identifier" || expr.type === "member_expr") && identText(expr) === alias.text;
    let doc: Doc = exprDoc;
    if (alias && !(same && this.opts.collapseAliases)) {
      doc = [exprDoc, space, it.asKw ? [this.kw(it.asKw), space] : [], this.node(alias, it), it.columnAliases ? this.node(it.columnAliases, it) : []];
    }
    const item: ColumnItem = {
      index,
      outputName,
      kind: classify(expr, alias, !!same),
      expr: exprDoc,
      tag: `${listId}:${index}`,
    };
    return { doc: [pre, doc], item };
  }

  // ---- FROM / JOIN ----------------------------------------------------------

  private tableExpr(e: N, parent: N): Doc {
    if (e.type !== "join_expr") return this.node(e, parent);
    const joins: N[] = [];
    let cur = e;
    while (cur.type === "join_expr") {
      joins.unshift(cur);
      cur = cur.left;
    }
    const out: Doc[] = [joins.map((j) => this.comments(j)), this.node(cur, e)];
    for (const j of joins) {
      if (j.operator === ",") {
        out.push(text(",", "op"), hardline, this.node(j.right, j));
        continue;
      }
      const spec = j.specification;
      out.push(
        hardline,
        this.kw(j.operator),
        space,
        this.node(j.right, j),
        spec ? group(indent([line, this.node(spec, j)])) : [],
      );
    }
    return out;
  }

  private alias(n: N): Doc {
    if (n.expr.type === "paren_expr" && isSubSelect(n.expr)) {
      const name = this.uniqueName(identName(n.alias) || "subquery");
      return [
        this.subquery(n.expr, "derived", name),
        space,
        n.asKw ? [this.kw(n.asKw), space] : [],
        this.node(n.alias, n),
        n.columnAliases ? this.node(n.columnAliases, n) : [],
      ];
    }
    return [
      this.node(n.expr, n),
      space,
      n.asKw ? [this.kw(n.asKw), space] : [],
      this.node(n.alias, n),
      n.columnAliases ? this.node(n.columnAliases, n) : [],
    ];
  }

  private listClause(head: Doc, list: N, n: N): Doc {
    return group([head, indent([line, join([text(",", "op"), line], list.items.map((x: N) => this.node(x, n)))])]);
  }

  // ---- expressions ----------------------------------------------------------

  private binary(n: N): Doc {
    const op = opName(n.operator);
    if (op === "AND" || op === "OR") {
      // Flatten `a AND b AND c` into one chain, one operand per line when it doesn't fit.
      const items: N[] = [];
      const ops: N[] = [];
      const pre: Doc[] = [];
      const walk = (x: N) => {
        if (x.type === "binary_expr" && opName(x.operator) === op) {
          if (x !== n) pre.push(this.comments(x));
          walk(x.left);
          ops.push(x.operator);
          walk(x.right);
        } else items.push(x);
      };
      walk(n);
      return group([
        pre,
        this.node(items[0], n),
        indent(items.slice(1).map((it, i) => [line, this.kw(ops[i]), space, this.node(it, n)])),
      ]);
    }
    // The right side gets its own group so a multi-line left side doesn't force a break after the operator.
    return [this.node(n.left, n), space, this.operator(n.operator, n), group(indent([line, this.node(n.right, n)]))];
  }

  private operator(op: N, parent: N): Doc {
    if (typeof op === "string") return text(op, "op");
    if (Array.isArray(op) || op.type === "keyword") return this.kw(op);
    return this.node(op, parent);
  }

  private prefix(n: N): Doc {
    const op = n.operator;
    if (typeof op === "string") return [text(op, "op"), this.node(n.expr, n)];
    if (op.type === "keyword" && op.name === "EXISTS" && isSubSelect(n.expr)) {
      return [this.kw(op), space, this.subquery(n.expr, "subquery", this.numberedName("exists"))];
    }
    return [this.operator(op, n), space, this.node(n.expr, n)];
  }

  private paren(n: N, parent: N): Doc {
    if (isSubSelect(n.expr)) {
      if (parent && (parent.type === "from_clause" || parent.type === "join_expr" || parent.type === "lateral_derived_table")) {
        return this.subquery(n, "derived", this.numberedName("subquery"));
      }
      let prefix = "scalar";
      if (parent?.type === "binary_expr" && opName(parent.operator).endsWith("IN")) prefix = "in";
      else if (parent?.type === "array_constructor") prefix = "array";
      else if (parent?.type === "quantifier_expr") prefix = opName(parent.quantifierKw).toLowerCase();
      return this.subquery(n, "subquery", this.numberedName(prefix));
    }
    if (this.opts.removeParens && canUnwrap(n, parent)) return this.node(n.expr, parent);
    const inner = n.expr;
    const body = inner.type === "list_expr" ? join([text(",", "op"), line], inner.items.map((x: N) => this.node(x, inner))) : this.node(inner, n);
    return group([text("(", "op"), indent([softline, body]), softline, text(")", "op")]);
  }

  /** Children in source order, with the original punctuation between them (whitespace collapsed). */
  private generic(n: N): Doc {
    if (!n.range) return text(n.text ?? "", "plain");
    const kids: N[] = [];
    collectChildren(n, kids);
    kids.sort((a, b) => a.range[0] - b.range[0]);
    const out: Doc[] = [];
    let pos = n.range[0];
    for (const k of kids) {
      if (k.range[0] < pos) continue; // overlapping child (shouldn't happen)
      this.gap(this.src.slice(pos, k.range[0]), out);
      out.push(this.node(k, n));
      pos = k.range[1];
    }
    this.gap(this.src.slice(pos, n.range[1]), out);
    return out;
  }

  private gap(g: string, out: Doc[]): void {
    if (!g) return;
    // Comments are attached to nodes and printed by `node()`, so drop them here.
    g = g.replace(COMMENT_RE, " ");
    for (const piece of g.split(/(\s+)/)) {
      if (!piece) continue;
      out.push(/^\s+$/.test(piece) ? space : text(piece, "op"));
    }
  }
}

function collectChildren(v: N, out: N[]): void {
  for (const key in v) {
    if (key === "type" || key === "range" || key === "leading" || key === "trailing") continue;
    const c = v[key];
    if (c && typeof c === "object") {
      if (Array.isArray(c)) {
        for (const x of c) if (x && typeof x === "object") (x.type && x.range ? out.push(x) : collectChildren(x, out));
      } else if (c.type && c.range) out.push(c);
    }
  }
}

function identText(n: N): string {
  if (n.type === "identifier") return n.text;
  if (n.type === "member_expr" && n.property?.type === "identifier") return n.property.text;
  return "";
}

function canUnwrap(n: N, parent: N): boolean {
  if (!parent) return false;
  const inner = n.expr;
  if (inner.type === "paren_expr") return true; // ((x)) -> (x)
  if (inner.type === "list_expr") return false; // row values
  const pt = parent.type;
  const atomic = ATOMIC_TYPES.has(inner.type);

  if (pt === "binary_expr") {
    const op = opName(parent.operator);
    if (n === parent.right && op.endsWith("IN")) return false; // x IN (1)
    if (atomic) return true;
    const ir = exprRank(inner);
    const pr = opRank(parent.operator);
    if (ir > pr) return true;
    return ir === pr && (op === "AND" || op === "OR") && opName(inner.operator) === op;
  }
  if (pt === "prefix_op_expr" || pt === "cast_operator_expr" || pt === "between_expr") return atomic;
  if (TOP_EXPR_PARENTS.has(pt)) {
    return atomic || inner.type === "binary_expr" || inner.type === "prefix_op_expr" || inner.type === "between_expr";
  }
  return false;
}

function classify(expr: N, alias: N, sameName: boolean): ColumnKind {
  switch (expr.type) {
    case "identifier":
    case "all_columns":
      return !alias || sameName ? "passthrough" : "rename";
    case "member_expr":
      if (expr.property?.type === "array_subscript") return "other";
      return !alias || sameName ? "passthrough" : "rename";
    case "cast_operator_expr":
    case "cast_expr": {
      const inner = expr.type === "cast_expr" ? expr.args.expr.expr : expr.left;
      const k = classify(inner, null, true);
      if (k === "literal") return "literal";
      return k === "passthrough" ? "cast" : k;
    }
    case "func_call":
      return "function";
    case "case_expr":
      return "case";
    case "parameter":
      return "literal";
    case "prefix_op_expr":
      return typeof expr.operator === "string" && LITERAL_TYPES.has(expr.expr.type) ? "literal" : "other";
    case "paren_expr":
      return isSubSelect(expr) ? "subquery" : classify(expr.expr, alias, sameName);
    default:
      return LITERAL_TYPES.has(expr.type) ? "literal" : "other";
  }
}

export function print(cst: Program, src: string, opts: PrintOptions): PrintResult {
  const p = new Printer(src, opts);
  const doc = p.node(cst);
  return { doc, folds: p.folds, roots: p.roots, columns: p.columns, rootColumns: p.rootColumns };
}

export type { Kind };

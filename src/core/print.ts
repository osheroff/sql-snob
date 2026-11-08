// CST -> Doc printer. Also builds the fold outline and the column lists in the same pass.
//
// Node types with a rule below are laid out deliberately. Every other node type goes through
// `generic`, which prints its children in source order and keeps the original punctuation
// between them (with whitespace collapsed). So unknown syntax is never lost, only left unformatted.

import { mysqlKeywords, postgresqlKeywords, postgresqlRequiresAsKeywords, type Program } from "sql-parser-cst";
import {
  type Doc,
  type Kind,
  fill,
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
  flat,
} from "./doc";
import {
  nameKey,
  type ColumnItem,
  type ColumnKind,
  type ColumnList,
  type Dialect,
  type FoldInfo,
  type FoldKind,
  type PrintOptions,
  type PrintResult,
  type Ref,
  type RefKind,
  type Scope,
  type Section,
  type SectionKind,
  type Source,
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

/** Drop parens that wrap all of `s`: `(a OR b)` -> `a OR b`, but `(a) + (b)` stays. */
function unwrapLabel(s: string): string {
  while (s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let quote = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === "'" || c === '"' || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0 && i < s.length - 1) return s;
    }
    s = s.slice(1, -1).trim();
  }
  return s;
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
/**
 * A quoted name without its quotes, if that names the same thing: PostgreSQL folds unquoted names
 * to lowercase, so only lowercase names qualify; MySQL compares them as written. Reserved words
 * (and PostgreSQL's words that need `AS` before an alias) keep their quotes.
 */
export function stripIdentQuotes(s: string, dialect: Dialect): string {
  const q = dialect === "mysql" ? "`" : '"';
  if (s.length < 3 || s[0] !== q || s[s.length - 1] !== q) return s;
  const inner = s.slice(1, -1);
  const upper = inner.toUpperCase();
  if (dialect === "mysql") {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(inner) || mysqlKeywords[upper]) return s;
  } else if (!/^[a-z_][a-z0-9_$]*$/.test(inner) || postgresqlKeywords[upper] || postgresqlRequiresAsKeywords[upper]) {
    return s;
  }
  return inner;
}

function identName(n: N): string {
  if (!n) return "";
  if (n.type === "identifier") return n.name ?? n.text;
  if (n.type === "member_expr") return identName(n.property);
  return "";
}

const FOLD_ID_PREFIX: Record<FoldKind, string> = { cte: "q", derived: "d", subquery: "s", branch: "b", columns: "c" };

const COMMENT_RE = /--[^\n]*|\/\*[\s\S]*?\*\//g;

const CLAUSE_KIND: Record<string, SectionKind> = {
  with_clause: "with",
  select_clause: "select",
  from_clause: "from",
  where_clause: "where",
  having_clause: "having",
  qualify_clause: "qualify",
  group_by_clause: "groupby",
  order_by_clause: "orderby",
  limit_clause: "limit",
  offset_clause: "limit",
  fetch_clause: "limit",
};
const CLAUSE_LABEL: Partial<Record<SectionKind, string>> = {
  with: "WITH",
  select: "SELECT",
  from: "FROM",
  where: "WHERE",
  having: "HAVING",
  qualify: "QUALIFY",
  groupby: "GROUP BY",
  orderby: "ORDER BY",
};

class Printer {
  folds: Record<string, FoldInfo> = {};
  roots: string[] = [];
  columns: Record<string, ColumnList> = {};
  rootColumns: string | undefined;

  sections: Section[] = [];
  scopes: Scope[] = [];
  refs: Ref[] = [];
  ctes: Record<string, string> = {};

  /** > 0 while printing a data type, where identifiers are type names, not column/table names. */
  private typeDepth = 0;
  private scopeStack: number[] = [];
  private secStack: number[] = [];
  /** Output-list collector handed to the next SELECT printed (a subquery body or UNION arm). */
  private pendingOutputs: string[] | null = null;
  private scopeOutputs = new Map<number, string[] | null>();
  /** Id of the fold most recently created by `subquery()`. */
  private lastFold = "";
  /** Index of the ref most recently created by `ident()`. */
  private lastRef = -1;

  private stack: string[] = [];
  private usedNames = new Set<string>();
  private counters = new Map<string, number>();
  private seenComments = new Set<object>();

  constructor(
    private src: string,
    private opts: PrintOptions,
    private dialect: Dialect = "postgresql",
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

  /**
   * `( <fold> )` around a subquery. `name` must already be unique. `outputs` collects the SELECT
   * lists defining the subquery's columns; a UNION arm passes its parent's collector.
   */
  private subquery(paren: N, kind: FoldKind, name: string, outputs?: string[]): Doc {
    const f = this.begin(kind, name, paren.range);
    const outs = outputs ?? [];
    this.pendingOutputs = outs;
    const body = this.node(unwrapParens(paren));
    this.pendingOutputs = null;
    if (!outputs) f.outputs = outs;
    this.end();
    this.lastFold = f.id;
    return [this.comments(paren), text("(", "op"), fold(f.id, group([indent([softline, body]), softline]), body), text(")", "op")];
  }

  // ---- sections (query structure) --------------------------------------------

  /** Print `fn()` as a section: a tagged region of the doc, nested in the current section. */
  /**
   * A section around `fn`'s doc. A null `label` (or `detail: null`) is filled in from the printed doc,
   * so the outline shows what the SQL view shows (parens removed, keywords uppercased, ...).
   */
  private sec(
    kind: SectionKind,
    label: string | null,
    fn: () => Doc,
    more: Omit<Partial<Section>, "detail"> & { detail?: string | null } = {},
  ): Doc {
    const id = this.sections.length;
    const parent = this.secStack.length ? this.secStack[this.secStack.length - 1] : null;
    const sec: Section = { id, kind, label: label ?? "", parent, fold: this.current, ...more, detail: more.detail ?? undefined };
    this.sections.push(sec);
    this.secStack.push(id);
    const doc = fn();
    this.secStack.pop();
    if (label === null) sec.label = flat(doc);
    if (more.detail === null) sec.detail = flat(doc);
    return tag(`S${id}`, doc);
  }

  /** One-line source text of a node, for outline labels. */
  private snippet(n: N, max = 140): string {
    const s = this.src.slice(n.range[0], n.range[1]).replace(COMMENT_RE, " ").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max) + " …" : s;
  }

  private clause(c: N, parent: N): Doc {
    const kind = CLAUSE_KIND[c.type] ?? "clause";
    const label = CLAUSE_LABEL[kind] ?? this.snippet(c, 40);
    const detail = kind === "clause" ? null : undefined;
    return this.sec(kind, label, () => this.node(c, parent), { detail });
  }

  /**
   * One condition. Its outline label drops identifier quotes and wrapping parens:
   * `("T"."ID" = 1 OR b)` -> `T.ID = 1 OR b` (a subquery keeps its parens).
   */
  private cond(e: N, parent: N): Doc {
    const sec = this.sections.length;
    const doc = this.sec("cond", "", () => this.node(e, parent));
    let label = flat(doc, 140, true);
    if (e.type === "paren_expr" && !isSubSelect(e.expr)) label = unwrapLabel(label);
    this.sections[sec].label = label;
    return doc;
  }

  /**
   * WHERE / HAVING / QUALIFY: each AND-ed condition is an item. With redundant parens removed, the
   * chain is flattened through them too: `a AND ((b AND c))` is three items, as the SQL view shows it.
   */
  private conditions(e: N, parent: N): Doc {
    const pre: Doc[] = [];
    /** `x` as an AND node, looking through parens that the printer would drop; else null. */
    const asAnd = (x: N): N | null => {
      const parens: N[] = [];
      if (this.opts.removeParens) {
        while (x.type === "paren_expr" && !isSubSelect(x.expr)) {
          parens.push(x);
          x = x.expr;
        }
      }
      if (x.type !== "binary_expr" || opName(x.operator) !== "AND") return null;
      for (const p of parens) pre.push(this.comments(p)); // dropped parens: keep their comments
      return x;
    };
    const root = asAnd(e);
    if (!root) return [pre, this.cond(e, parent)];
    const items: N[] = [];
    const ops: N[] = [];
    const walk = (x: N) => {
      const and = asAnd(x);
      if (and) {
        pre.push(this.comments(and));
        walk(and.left);
        ops.push(and.operator);
        walk(and.right);
      } else items.push(x);
    };
    walk(root);
    const docs = items.map((it) => this.cond(it, root));
    return group([pre, docs[0], indent(docs.slice(1).map((d, i) => [line, this.kw(ops[i]), space, d]))]);
  }

  // ---- scopes & refs --------------------------------------------------------

  private get scope(): number {
    return this.scopeStack.length ? this.scopeStack[this.scopeStack.length - 1] : -1;
  }

  private ref(r: Omit<Ref, "scope">): number {
    this.refs.push({ ...r, scope: this.scope });
    return this.refs.length - 1;
  }

  /** An identifier token that means something (see RefKind). */
  private ident(n: N, kind: RefKind, extra: Partial<Ref> = {}): Doc {
    this.lastRef = this.ref({ kind, name: n.text, ...extra });
    return [this.comments(n), { t: "s", s: this.identText(n.text), k: "id", r: this.lastRef }, this.comments(n, "trailing")];
  }

  /** A name as printed: without its quotes when they aren't needed (and the option is on). */
  private identText(s: string): string {
    return this.opts.stripQuotes ? stripIdentQuotes(s, this.dialect) : s;
  }

  private addSource(src: Omit<Source, "key">): void {
    if (this.scope >= 0) this.scopes[this.scope].sources.push({ ...src, key: nameKey(src.alias) });
  }

  private selectStmt(n: N): Doc {
    const id = this.scopes.length;
    const cur = this.current;
    this.scopes.push({ id, parent: this.scope >= 0 ? this.scope : null, fold: cur, sources: [] });
    if (cur && this.folds[cur].scope === undefined) this.folds[cur].scope = id;
    this.scopeOutputs.set(id, this.pendingOutputs);
    this.pendingOutputs = null; // nested SELECTs don't define this query's outputs
    this.scopeStack.push(id);
    const doc = this.sec("query", this.currentName, () => join(hardline, n.clauses.map((c: N) => this.clause(c, n))));
    this.scopeStack.pop();
    return doc;
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
        return { t: "s", s: this.identText(n.text), k: "id", r: this.ref({ kind: "column", name: n.text }) };
      case "member_expr":
        // `t.col` / `t.*`: the qualifier and the column are separately clickable.
        if (
          this.typeDepth === 0 &&
          n.object.type === "identifier" &&
          (n.property.type === "identifier" || n.property.type === "all_columns")
        ) {
          const q = n.object;
          const qDoc = this.ident(q, "qualifier");
          if (n.property.type === "all_columns") return [qDoc, text(".", "op"), text("*", "op")];
          return [qDoc, text(".", "op"), this.ident(n.property, "column", { qualifier: q.text })];
        }
        return this.generic(n);
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
        return this.selectStmt(n);
      case "compound_select_stmt":
        return this.sec("union", opName(n.operator), () => this.compound(n));
      case "with_clause":
        return [
          this.kw(n.withKw),
          n.recursiveKw ? [space, this.kw(n.recursiveKw)] : [],
          indent([
            hardline,
            join(
              [text(",", "op"), hardline],
              n.tables.items.map((t: N) => this.sec("cte", identName(t.table) || "cte", () => this.node(t, n))),
            ),
          ]),
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
        return [this.kw(kwNode), space, this.conditions(n.expr, n)];
      }
      case "group_by_clause":
        return [
          this.listClause([this.kw(n.groupByKw), n.distinctKw ? [space, this.kw(n.distinctKw)] : []], n.columns, n, true),
          n.withRollupKw ? [space, this.kw(n.withRollupKw)] : [],
        ];
      case "order_by_clause":
        return this.listClause(this.kw(n.orderByKw), n.specifications, n, parent?.type === "select_stmt");
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
        if (this.opts.hideObviousCasts && isObviousCast(n.left, n.right)) return this.node(n.left, parent);
        return [this.node(n.left, n), text("::", "op"), this.node(n.right, n)];
      case "cast_expr": {
        const arg = n.args?.expr;
        if (this.opts.hideObviousCasts && arg?.type === "cast_arg" && !arg.format && isObviousCast(arg.expr, arg.dataType)) {
          return this.node(arg.expr, parent);
        }
        return this.generic(n);
      }
      case "func_call":
        return [
          n.name.type === "identifier" ? text(n.name.text, "fn") : this.node(n.name, n),
          this.huggedArgs(n.args) ?? this.node(n.args, n),
          n.filter ? [space, this.node(n.filter, n)] : [],
          n.over ? [space, this.node(n.over, n)] : [],
        ];
      case "case_expr": {
        // Two or more branches: always one branch per line. A single WHEN may stay on one line.
        const br = n.clauses.length > 1 ? hardline : line;
        return group([
          this.kw(n.caseKw),
          n.expr ? [space, this.node(n.expr, n)] : [],
          indent(n.clauses.map((c: N) => [br, this.node(c, n)])),
          br,
          this.kw(n.endKw),
        ]);
      }
      case "case_when":
        // THEN stays on the WHEN line if the branch fits; otherwise it gets its own, indented line.
        return group([
          this.kw(n.whenKw),
          space,
          this.node(n.condition, n),
          indent([line, this.kw(n.thenKw), space, this.node(n.result, n)]),
        ]);
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
    const nameDoc = this.ident(n.table, "cte");
    const nameRef = this.lastRef;
    const body = this.subquery(n.expr, "cte", name);
    this.refs[nameRef].fold = this.lastFold;
    this.ctes[nameKey(n.table.text)] = this.lastFold;
    return [
      nameDoc,
      n.columns ? this.node(n.columns, n) : [],
      space,
      this.kw(n.asKw),
      n.materializedKw ? [space, this.kw(n.materializedKw)] : [],
      space,
      body,
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
    const target = this.pendingOutputs; // each arm contributes one output list
    this.pendingOutputs = null;
    const out: Doc[] = [pre];
    branches.forEach((b, i) => {
      if (i > 0) out.push(hardline, this.kw(ops[i - 1]), hardline);
      const big = b.range[1] - b.range[0] >= SMALL_FOLD;
      const armName = `${owner}#${i + 1}`;
      this.pendingOutputs = target;
      out.push(
        this.sec("arm", armName, (): Doc => {
          if (!big) return b.type === "paren_expr" && isSubSelect(b) ? this.parenArm(b) : this.node(b, n);
          if (b.type === "paren_expr") return this.subquery(b, "branch", this.uniqueName(armName), target ?? undefined);
          const f = this.begin("branch", this.uniqueName(armName), b.range);
          const body = this.node(b, n);
          this.end();
          return fold(f.id, body, body);
        }),
      );
      this.pendingOutputs = null;
    });
    return out;
  }

  /** A small parenthesized UNION arm: printed inline (no fold), still contributing its outputs. */
  private parenArm(b: N): Doc {
    const body = this.node(unwrapParens(b));
    return group([text("(", "op"), indent([softline, body]), softline, text(")", "op")]);
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

    const sc = this.scope;
    if (sc >= 0 && this.scopes[sc].list === undefined) {
      this.scopes[sc].list = listId;
      this.scopeOutputs.get(sc)?.push(listId);
    }
    const list: ColumnList = { id: listId, owner, foldId: f?.id, items: [], scope: sc };
    const docs = items.map((it, i) => {
      const id = this.sections.length;
      return this.sec("column", "", () => {
        const { doc, item, exprDoc } = this.column(it, i, listId, n.columns);
        item.tag = `S${id}`;
        this.sections[id].label = item.outputName;
        this.sections[id].detail = flat(exprDoc);
        list.items.push(item);
        return doc;
      });
    });
    this.columns[listId] = list;

    // Columns flow like a paragraph: as many per line as fit.
    const body = fill(join([text(",", "op"), line], docs));
    if (!f) return group([head, indent([line, body])]);
    this.end();
    return [this.comments(n.columns), head, space, fold(f.id, indent([hardline, body]), body)];
  }

  private column(it: N, index: number, listId: string, listNode: N): { doc: Doc; item: ColumnItem; exprDoc: Doc } {
    const pre = it.type === "alias" ? this.comments(it) : [];
    const expr = it.type === "alias" ? it.expr : it;
    const alias = it.type === "alias" ? it.alias : null;
    const star = expr.type === "all_columns" || (expr.type === "member_expr" && expr.property?.type === "all_columns");
    const outputName = alias ? identName(alias) : star ? "*" : identName(expr) || `?col_${index + 1}`;

    const refsBefore = this.refs.length;
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
      doc = [
        exprDoc,
        space,
        it.asKw ? [this.kw(it.asKw), space] : [],
        this.ident(alias, "output", { listId, index }),
        it.columnAliases ? this.node(it.columnAliases, it) : [],
      ];
    }
    // A plain column reference (through casts/parens) can be traced further down; a computed
    // expression lists the columns it reads instead. Refs inside nested subqueries don't count.
    let ref: number | undefined;
    const inputs: number[] = [];
    const seen = new Set<string>();
    const sc = this.scope;
    for (let i = refsBefore; i < this.refs.length; i++) {
      const x = this.refs[i];
      if (x.kind !== "column" || x.scope !== sc) continue;
      const k = `${x.qualifier ? nameKey(x.qualifier) + "." : ""}${nameKey(x.name)}`;
      if (!seen.has(k)) {
        seen.add(k);
        inputs.push(i);
      }
    }
    if (isColumnRef(stripCasts(expr)) && inputs.length) ref = inputs[0];
    const item: ColumnItem = {
      index,
      outputName,
      kind: classify(expr, alias, !!same),
      expr: exprDoc,
      tag: `${listId}:${index}`,
      ref,
      inputs: ref === undefined && inputs.length ? inputs : undefined,
    };
    return { doc: [pre, doc], item, exprDoc };
  }

  // ---- FROM / JOIN ----------------------------------------------------------

  private tableExpr(e: N, parent: N): Doc {
    if (e.type !== "join_expr") return this.sec("source", this.factorName(e), () => this.tableFactor(e, parent), { detail: null });
    const joins: N[] = [];
    let cur = e;
    while (cur.type === "join_expr") {
      joins.unshift(cur);
      cur = cur.left;
    }
    const out: Doc[] = [
      joins.map((j) => this.comments(j)),
      this.sec("source", this.factorName(cur), () => this.tableFactor(cur, e), { detail: null }),
    ];
    for (const j of joins) {
      const spec = j.specification;
      const more = { op: j.operator === "," ? "," : opName(j.operator) };
      if (j.operator === ",") {
        out.push(text(",", "op"), hardline, this.sec("join", this.factorName(j.right), () => this.tableFactor(j.right, j), more));
        continue;
      }
      out.push(
        hardline,
        this.sec(
          "join",
          this.factorName(j.right),
          (): Doc => {
            const specDoc = spec ? this.node(spec, j) : null;
            if (specDoc) this.sections[this.secStack[this.secStack.length - 1]].detail = flat(specDoc);
            return [this.kw(j.operator), space, this.tableFactor(j.right, j), specDoc ? group(indent([line, specDoc])) : []];
          },
          more,
        ),
      );
    }
    return out;
  }

  /** Record what the current FROM/JOIN section points at (a table, or a subquery fold). */
  private setTarget(target: string, fold?: string): void {
    const top = this.secStack[this.secStack.length - 1];
    const sec = top !== undefined ? this.sections[top] : undefined;
    if (sec && (sec.kind === "source" || sec.kind === "join")) {
      sec.target = target;
      sec.targetFold = fold;
    }
  }

  /** One FROM/JOIN entry: printed, and registered as a source of the current SELECT. */
  private tableFactor(f: N, parent: N): Doc {
    if (f.type === "alias" && (isEntity(f.expr) || isSubSelect(f.expr))) {
      const e = f.expr;
      let head: Doc;
      if (isEntity(e)) {
        head = this.tableName(e);
        this.addSource({ alias: f.alias.text, kind: "table", table: this.entityText(e) });
        this.setTarget(this.entityText(e));
      } else {
        head = this.subquery(e, "derived", this.uniqueName(identName(f.alias) || "subquery"));
        this.addSource({ alias: f.alias.text, kind: "derived", fold: this.lastFold });
        this.setTarget(this.folds[this.lastFold].name, this.lastFold);
      }
      return [
        this.comments(f),
        head,
        space,
        f.asKw ? [this.kw(f.asKw), space] : [],
        this.ident(f.alias, "alias"),
        f.columnAliases ? this.node(f.columnAliases, f) : [],
        this.comments(f, "trailing"),
      ];
    }
    if (isEntity(f)) {
      this.addSource({ alias: f.type === "member_expr" ? f.property.text : f.text, kind: "table", table: this.entityText(f) });
      this.setTarget(this.entityText(f));
      return this.tableName(f);
    }
    if (f.type === "paren_expr" && isSubSelect(f)) {
      const doc = this.node(f, parent); // becomes a `subquery_N` fold
      this.addSource({ alias: this.folds[this.lastFold].name, kind: "derived", fold: this.lastFold });
      this.setTarget(this.folds[this.lastFold].name, this.lastFold);
      return doc;
    }
    return this.node(f, parent);
  }

  /** Outline label of a FROM entry: its alias, else its table name. */
  private factorName(f: N): string {
    if (f.type === "alias") return f.alias.text;
    if (isEntity(f)) return this.entityText(f);
    return this.snippet(f, 40);
  }

  private entityText(e: N): string {
    return this.src.slice(e.range[0], e.range[1]).replace(/\s+/g, "");
  }

  private tableName(e: N): Doc {
    const t = this.entityText(e);
    // `schema.table`: each part separately (a quoted part may contain dots).
    const shown = this.opts.stripQuotes ? (t.match(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|[^.]+/g) ?? [t]).map((x) => this.identText(x)).join(".") : t;
    return [this.comments(e), { t: "s", s: shown, k: "id", r: this.ref({ kind: "table", name: t }) }, this.comments(e, "trailing")];
  }

  private alias(n: N): Doc {
    if (n.expr.type === "paren_expr" && isSubSelect(n.expr)) {
      const name = this.uniqueName(identName(n.alias) || "subquery");
      return [
        this.subquery(n.expr, "derived", name),
        space,
        n.asKw ? [this.kw(n.asKw), space] : [],
        this.ident(n.alias, "alias"),
        n.columnAliases ? this.node(n.columnAliases, n) : [],
      ];
    }
    return [
      this.node(n.expr, n),
      space,
      n.asKw ? [this.kw(n.asKw), space] : [],
      this.ident(n.alias, "alias"),
      n.columnAliases ? this.node(n.columnAliases, n) : [],
    ];
  }

  private listClause(head: Doc, list: N, n: N, items = false): Doc {
    const docs = list.items.map((x: N) => (items ? this.sec("item", null, () => this.node(x, n)) : this.node(x, n)));
    return group([head, indent([line, join([text(",", "op"), line], docs)])]);
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

  /**
   * `f(g(...), 'x')` hugs its first argument when that is itself a call and the rest are short
   * atoms: `RTRIM(RTRIM(TO_CHAR(` stays on one line instead of a staircase.
   */
  private huggedArgs(args: N): Doc | null {
    const fa = args?.type === "paren_expr" ? args.expr : null;
    if (fa?.type !== "func_args" || fa.distinctKw || fa.orderBy || fa.limit || fa.nullHandlingKw) return null;
    const items: N[] = fa.args?.type === "list_expr" ? fa.args.items : fa.args ? [fa.args] : [];
    if (!items.length || items[0].type !== "func_call") return null;
    const ATOMS = ["string_literal", "number_literal", "identifier", "parameter", "boolean_literal", "null_literal"];
    const rest = items.slice(1);
    if (!rest.every((x) => ATOMS.includes(x.type) && (x.text ?? "").length <= 30)) return null;
    const list = fa.args.type === "list_expr" ? fa.args : fa;
    return [
      text("(", "op"),
      this.node(items[0], list),
      rest.map((x) => [text(",", "op"), space, this.node(x, list)]),
      text(")", "op"),
    ];
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

/** A table name: `t`, `schema.t`, `db.schema.t`. */
function isEntity(e: N): boolean {
  if (e.type === "identifier") return true;
  return e.type === "member_expr" && e.property?.type === "identifier" && isEntity(e.object);
}

function stripCasts(e: N): N {
  for (;;) {
    if (e.type === "paren_expr") e = e.expr;
    else if (e.type === "cast_operator_expr") e = e.left;
    else if (e.type === "cast_expr" && e.args?.expr?.type === "cast_arg") e = e.args.expr.expr;
    else return e;
  }
}

function isColumnRef(e: N): boolean {
  return (
    e.type === "identifier" ||
    (e.type === "member_expr" && e.object.type === "identifier" && e.property.type === "identifier")
  );
}

function identText(n: N): string {
  if (n.type === "identifier") return n.text;
  if (n.type === "member_expr" && n.property?.type === "identifier") return n.property.text;
  return "";
}

const TEXT_TYPES = new Set(["TEXT", "VARCHAR", "STRING", "CHAR", "CHARACTER", "CHARACTER VARYING", "CHAR VARYING", "NVARCHAR"]);
const INT_TYPES = new Set(["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "BYTEINT", "INT2", "INT4", "INT8", "NUMBER", "NUMERIC", "DECIMAL"]);
const DECIMAL_TYPES = new Set(["DOUBLE", "DOUBLE PRECISION", "FLOAT", "FLOAT4", "FLOAT8", "REAL", "NUMBER", "NUMERIC", "DECIMAL"]);

/** Plain type name (`TEXT`, `DOUBLE PRECISION`), or "" for parameterized/complex types. */
function typeName(t: N): string {
  if (!t) return "";
  if (t.type === "identifier") return String(t.name ?? t.text).toUpperCase();
  if (t.type === "data_type_name") return opName(t.name);
  return "";
}

/** A literal cast to the type it already plainly is. NULL casts are kept: they set types in UNIONs. */
function isObviousCast(expr: N, type: N): boolean {
  const name = typeName(type);
  if (!name) return false;
  expr = unwrapParens(expr); // generated SQL writes `('Method')::TEXT`
  switch (expr.type) {
    case "string_literal":
      return TEXT_TYPES.has(name);
    case "number_literal":
      return /^\d+$/.test(expr.text) ? INT_TYPES.has(name) : DECIMAL_TYPES.has(name);
    case "boolean_literal":
      return name === "BOOLEAN" || name === "BOOL";
    default:
      return false;
  }
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

export function print(cst: Program, src: string, opts: PrintOptions, dialect: Dialect = "postgresql"): PrintResult {
  const p = new Printer(src, opts, dialect);
  const doc = p.node(cst);
  return {
    doc,
    folds: p.folds,
    roots: p.roots,
    columns: p.columns,
    rootColumns: p.rootColumns,
    sections: p.sections,
    scopes: p.scopes,
    refs: p.refs,
    ctes: p.ctes,
  };
}

export type { Kind };

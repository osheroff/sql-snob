import type { Doc } from "./doc";

export type FoldKind = "cte" | "derived" | "subquery" | "branch" | "columns";

export interface FoldInfo {
  id: string;
  kind: FoldKind;
  /** Unique display name, e.g. `orders`, `exists_2`, `orders.columns`. */
  name: string;
  /** Enclosing fold id, or null for top level. */
  parent: string | null;
  children: string[];
  /** Source range in the original SQL. */
  range: [number, number];
  /** Open by default (small regions aren't worth folding). */
  defaultOpen: boolean;
  /** For query folds: the id of its SELECT list's ColumnList, if any. */
  columns?: string;
  /** For `columns` folds: number of items. */
  count?: number;
  /** For query folds: SELECT lists that define its output columns (one per UNION arm). */
  outputs?: string[];
  /** For query folds: the scope of its (first) SELECT. */
  scope?: number;
}

export type ColumnKind = "passthrough" | "rename" | "cast" | "literal" | "function" | "case" | "subquery" | "other";

export interface ColumnItem {
  index: number;
  outputName: string;
  kind: ColumnKind;
  /** Formatted expression, without the alias. */
  expr: Doc;
  /** Tag id of this column in the main doc. */
  tag: string;
  /** If the expression is a plain column reference (possibly cast), its ref index — for lineage. */
  ref?: number;
  /** For computed expressions: the column references it reads (ref indices, one per distinct name). */
  inputs?: number[];
}

export interface ColumnList {
  id: string;
  /** Fold id of the query that owns this SELECT list (null = top level). */
  owner: string | null;
  /** Fold id of the `columns` fold in the main doc, if the list was long enough to fold. */
  foldId?: string;
  /** Scope of the SELECT this list belongs to. */
  scope: number;
  items: ColumnItem[];
}

export interface PrintOptions {
  removeParens: boolean;
  /** Drop casts that restate a literal's type: `'x'::TEXT` -> `'x'`, `1000::BIGINT` -> `1000`. */
  hideObviousCasts: boolean;
  collapseAliases: boolean;
  /** SELECT lists with at least this many columns become a `columns` fold. */
  columnFoldThreshold: number;
  /** Drop quotes around names that don't need them: `"rows"."id"` -> `rows.id`. */
  stripQuotes: boolean;
}

export const defaultPrintOptions: PrintOptions = {
  removeParens: true,
  hideObviousCasts: true,
  collapseAliases: true,
  columnFoldThreshold: 8,
  stripQuotes: true,
};

/** Identity of a name: unquoted, case-insensitive (`"MEASUREMENT_ID"` = `measurement_id`, `` `Id` `` = `id`). */
export function nameKey(s: string): string {
  const q = s[0];
  if (s.length >= 2 && (q === '"' || q === "`") && s[s.length - 1] === q) s = s.slice(1, -1).replaceAll(q + q, q);
  return s.toLowerCase();
}

/**
 * The structure of a query, for the local outline: a query has clauses (WITH, SELECT, FROM, ...)
 * and clauses have items (CTEs, columns, the base table and joins, AND-ed conditions, ...).
 */
export type SectionKind =
  | "query"
  | "union"
  | "arm"
  | "with"
  | "cte"
  | "select"
  | "column"
  | "from"
  | "source"
  | "join"
  | "where"
  | "having"
  | "qualify"
  | "groupby"
  | "orderby"
  | "item"
  | "cond"
  | "limit"
  | "clause";

export interface Section {
  id: number;
  kind: SectionKind;
  /** Short name: column output name, join target, clause keyword, ... */
  label: string;
  /** Longer one-line text: the expression, the ON condition, ... */
  detail?: string;
  /** Join type for `join` items (`LEFT JOIN`). */
  op?: string;
  /** For FROM entries: the table name, or the name of the subquery's fold. */
  target?: string;
  /** For FROM entries that are subqueries: the subquery's fold. */
  targetFold?: string;
  parent: number | null;
  /** Innermost fold the section is printed in (to reveal it). */
  fold: string | null;
}

/** Doc tag id of a section. */
export const sectionTag = (id: number): string => `S${id}`;

/** A FROM/JOIN entry of a SELECT. */
export interface Source {
  /** Name it's referred to by (alias, else table name). */
  alias: string;
  key: string;
  kind: "table" | "derived";
  /** Table name as written (kind `table`). A table may turn out to be a CTE: see PrintResult.ctes. */
  table?: string;
  /** Fold of the subquery (kind `derived`). */
  fold?: string;
}

/** One SELECT: what its FROM brings into scope. */
export interface Scope {
  id: number;
  parent: number | null;
  /** Fold the SELECT is printed in (null = top level). */
  fold: string | null;
  sources: Source[];
  /** Its SELECT list. */
  list?: string;
}

/**
 * What a clickable token means:
 * - column: a column reference (`name`, or `qualifier.name`)
 * - qualifier: the `t` in `t.col`
 * - table / alias: a FROM entry's table name / alias
 * - output: a column alias in a SELECT list (`AS "X"`)
 * - cte: a CTE name where it's defined
 */
export type RefKind = "column" | "qualifier" | "table" | "alias" | "output" | "cte";

export interface Ref {
  kind: RefKind;
  name: string;
  qualifier?: string;
  /** Scope the token appears in (-1 = outside any SELECT). */
  scope: number;
  listId?: string;
  index?: number;
  fold?: string;
}

export interface PrintResult {
  doc: Doc;
  folds: Record<string, FoldInfo>;
  /** Top-level fold ids, in source order. */
  roots: string[];
  columns: Record<string, ColumnList>;
  /** ColumnList id of the top-level SELECT, if any. */
  rootColumns?: string;
  sections: Section[];
  scopes: Scope[];
  refs: Ref[];
  /** CTE name key -> fold id. */
  ctes: Record<string, string>;
}

/** Dialects the parser is run in. Snowflake is parsed as `postgresql`. */
export type Dialect = "postgresql" | "mysql";
/** The dialect setting: a fixed dialect, or `auto` (Postgres, falling back to MySQL). */
export type DialectChoice = Dialect | "auto";
export const dialectNames: Record<Dialect, string> = { postgresql: "PostgreSQL", mysql: "MySQL" };

export interface ParseError {
  /** Dialect of the reported error (with `auto`, the one whose parse got furthest). */
  dialect?: Dialect;
  message: string;
  line: number;
  col: number;
}

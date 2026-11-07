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
}

export interface ColumnList {
  id: string;
  /** Fold id of the query that owns this SELECT list (null = top level). */
  owner: string | null;
  /** Fold id of the `columns` fold in the main doc, if the list was long enough to fold. */
  foldId?: string;
  items: ColumnItem[];
}

export interface PrintOptions {
  removeParens: boolean;
  collapseAliases: boolean;
  /** SELECT lists with at least this many columns become a `columns` fold. */
  columnFoldThreshold: number;
}

export const defaultPrintOptions: PrintOptions = {
  removeParens: true,
  collapseAliases: true,
  columnFoldThreshold: 8,
};

export interface PrintResult {
  doc: Doc;
  folds: Record<string, FoldInfo>;
  /** Top-level fold ids, in source order. */
  roots: string[];
  columns: Record<string, ColumnList>;
  /** ColumnList id of the top-level SELECT, if any. */
  rootColumns?: string;
}

export interface ParseError {
  message: string;
  line: number;
  col: number;
}

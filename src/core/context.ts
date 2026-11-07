// Name resolution and column lineage over the printer's scope model (runs on the main thread).

import { nameKey, type ColumnItem, type ColumnList, type PrintResult, type Ref, type Scope, type Source } from "./model";

export type Trace =
  /** The column is defined by `item` in `list`; `next` traces that definition's own source. */
  | { t: "def"; list: ColumnList; item: ColumnItem; next: Trace | null }
  /** The column comes from a UNION: one trace per arm (matched by position). */
  | { t: "union"; arms: Trace[] }
  /** A base-table column: the end of the line. */
  | { t: "table"; table: string; column: string; alias: string }
  | { t: "unresolved"; reason: string };

export interface ResolvedSource {
  source: Source;
  scope: Scope;
  /** Fold of the subquery or CTE the source refers to (undefined for a base table). */
  fold?: string;
}

const MAX_DEPTH = 40;

/** Find the FROM entry `name` refers to, looking outwards from `scopeId` (for correlated subqueries). */
export function findSource(r: PrintResult, scopeId: number, name: string): ResolvedSource | null {
  const key = nameKey(name);
  for (let s: number | null = scopeId; s !== null && s >= 0; s = r.scopes[s].parent) {
    const src = r.scopes[s].sources.find((x) => x.key === key);
    if (src) return resolved(r, src, r.scopes[s]);
  }
  return null;
}

function resolved(r: PrintResult, source: Source, scope: Scope): ResolvedSource {
  const fold = source.fold ?? (source.table ? r.ctes[nameKey(source.table)] : undefined);
  return { source, scope, fold };
}

/** The source a table-name token belongs to. */
export function sourceForTable(r: PrintResult, scopeId: number, table: string): ResolvedSource | null {
  if (scopeId < 0) return null;
  const sc = r.scopes[scopeId];
  const src = sc.sources.find((x) => x.table === table);
  return src ? resolved(r, src, sc) : null;
}

function outputIndex(list: ColumnList, name: string): number {
  const key = nameKey(name);
  return list.items.findIndex((i) => nameKey(i.outputName) === key);
}

/** Trace a column reference to where its value comes from. */
export function traceColumn(r: PrintResult, name: string, qualifier: string | undefined, scopeId: number, depth = 0): Trace {
  if (depth > MAX_DEPTH) return { t: "unresolved", reason: "too deeply nested" };
  if (scopeId < 0) return { t: "unresolved", reason: "not inside a SELECT" };

  if (qualifier) {
    const rs = findSource(r, scopeId, qualifier);
    return rs ? traceSource(r, rs, name, depth) : { t: "unresolved", reason: `no FROM entry named ${qualifier}` };
  }

  // Unqualified: the only source, or the subquery that has a column by this name.
  for (let s: number | null = scopeId; s !== null && s >= 0; s = r.scopes[s].parent) {
    const sc = r.scopes[s];
    const sources = sc.sources.map((src) => resolved(r, src, sc));
    const providing = sources.filter((rs) => rs.fold && hasOutput(r, rs.fold, name));
    if (providing.length >= 1) return traceSource(r, providing[0], name, depth);
    if (sources.length === 1 && !sources[0].fold) return traceSource(r, sources[0], name, depth);
    // ORDER BY / QUALIFY can refer to the SELECT's own output columns.
    const own = sc.list ? r.columns[sc.list] : undefined;
    const i = own ? outputIndex(own, name) : -1;
    if (own && i >= 0 && s === scopeId && own.items[i].ref === undefined) return def(r, own, own.items[i], depth);
    if (sources.length > 1) {
      return { t: "unresolved", reason: `could come from any of: ${sources.map((x) => x.source.alias).join(", ")}` };
    }
  }
  return { t: "unresolved", reason: "no FROM entry provides it" };
}

function hasOutput(r: PrintResult, fold: string, name: string): boolean {
  const first = r.folds[fold]?.outputs?.[0];
  return !!first && outputIndex(r.columns[first], name) >= 0;
}

function traceSource(r: PrintResult, rs: ResolvedSource, name: string, depth: number): Trace {
  if (!rs.fold) return { t: "table", table: rs.source.table ?? rs.source.alias, column: name, alias: rs.source.alias };
  const outs = r.folds[rs.fold]?.outputs ?? [];
  if (!outs.length) return { t: "unresolved", reason: `can't see the columns of ${r.folds[rs.fold]?.name}` };
  const first = r.columns[outs[0]];
  const idx = outputIndex(first, name);
  if (idx < 0) {
    // `SELECT *` passes columns through from its own FROM.
    if (first.items.some((i) => i.outputName === "*")) return traceColumn(r, name, undefined, first.scope, depth + 1);
    return { t: "unresolved", reason: `${r.folds[rs.fold]?.name} has no column ${name}` };
  }
  const arms = outs.map((lid): Trace => {
    const l = r.columns[lid];
    const it = l.items[idx];
    return it ? def(r, l, it, depth) : { t: "unresolved", reason: "arm has fewer columns" };
  });
  return arms.length === 1 ? arms[0] : { t: "union", arms };
}

function def(r: PrintResult, list: ColumnList, item: ColumnItem, depth: number): Trace {
  const ref = item.ref !== undefined ? r.refs[item.ref] : undefined;
  return { t: "def", list, item, next: ref ? traceRef(r, ref, depth + 1) : null };
}

/** Lineage for a clicked column reference or output alias (null for other refs). */
export function traceRef(r: PrintResult, ref: Ref, depth = 0): Trace | null {
  if (ref.kind === "column") return traceColumn(r, ref.name, ref.qualifier, ref.scope, depth);
  if (ref.kind === "output" && ref.listId !== undefined && ref.index !== undefined) {
    const list = r.columns[ref.listId];
    return def(r, list, list.items[ref.index], depth);
  }
  return null;
}

/** What a qualifier / alias / table token refers to. */
export function sourceForRef(r: PrintResult, ref: Ref): ResolvedSource | null {
  if (ref.kind === "qualifier" || ref.kind === "alias") return findSource(r, ref.scope, ref.name);
  if (ref.kind === "table") return sourceForTable(r, ref.scope, ref.name);
  return null;
}

/** The scope (SELECT) a query fold stands for: its own, or the top level for null. */
export function scopeOfFold(r: PrintResult, fold: string | null): Scope | undefined {
  if (fold === null) return r.scopes.find((s) => s.fold === null && s.parent === null);
  const sid = r.folds[fold]?.scope;
  return sid !== undefined ? r.scopes[sid] : undefined;
}

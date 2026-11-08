# sql-snob: SQL viewer plan

The goal is a read-only, browser-only SQL viewer. Paste SQL and it is formatted, with subqueries, CTEs and long SELECT lists folded under readable names. You can drill into any branch of the query, including column lists. Target dialects are Postgres, Snowflake and MySQL; Snowflake is parsed in `postgresql` mode. The dialect is picked in the status bar; the default, Auto, tries `postgresql` and falls back to `mysql`.

## Stack

- Vite + Vue 3 + TypeScript (strict).
- `sql-parser-cst` as a plain npm dependency (no fork).
- No backend for now. Parsing and layout run in a Web Worker so a 400KB query doesn't freeze the UI.
- The viewer is read-only, so we render our own token lines. We don't need an editor component such as CodeMirror or Monaco.

## Pipeline

```
text ──parse──▶ CST ──outline──▶ FoldTree ──print──▶ Doc ──layout──▶ Lines ──render──▶ Vue
        (worker)                     (names)       (IR w/ fold nodes)        (virtualized)
```

Each stage is a pure function. Only `render` touches Vue.

### 1. Parse: `src/core/parse.ts`
- `parse(sql, { dialect: "postgresql", paramTypes: [":name", "?", "$nr"], includeRange: true, includeComments: true })`.
- Returns `{ ok: true, cst } | { ok: false, error: { message, offset, line, col } }`.
- Runs in `src/worker/parser.worker.ts`. The UI talks to the worker through a small typed RPC (`postMessage` + request ids).

### 2. Outline (fold detection and naming): `src/core/outline.ts`
Walk the CST and emit a `FoldNode` tree: `{ id, kind, name, range, children }`.

| Foldable | Kind | Name |
|---|---|---|
| CTE in `WITH` | `cte` | CTE name |
| Subquery in `FROM` / `JOIN` | `derived` | table alias, else `subquery_N` |
| Scalar / `IN` / `EXISTS` subquery | `subquery` | `exists_N`, `in_N`, `scalar_N` |
| Set-op branch (`UNION ALL` arm) | `branch` | `<parent> #k` |
| SELECT list longer than threshold (default 8) | `columns` | `<parent>.columns (45)` |

- Names are made unique with a `_2`, `_3` suffix.
- IDs are stable for a given input (path-based), so fold state and URL state survive a re-parse.
- Default state: everything folded except the root statement.
- Every `FoldNode` can be focused, whatever its kind. Query-shaped nodes (`cte`, `derived`, `subquery`, `branch`) focus in the main view. `columns` nodes focus in the column panel (see below).

### 3. Column lists: a separate entity: `src/core/columns.ts`
A long SELECT list is its own drill-down target, not just a fold.

- For each `columns` fold, build a `ColumnList`: `{ id, ownerName, items: ColumnItem[] }`.
- `ColumnItem`: `{ index, outputName, expr: Doc, exprKind: passthrough|rename|cast|function|case|subquery|other, sourceRange }`.
  - `passthrough`: `"X"` or `"X" AS "X"`.
  - `rename`: `"A" AS "B"`.
  - The kind is used for filtering and color, so you can hide the boring passthroughs and see the real logic.
- `outputName` is the alias, or the column name for a bare reference. Without either, it is `?col_N`.
- A `columns` item whose expression contains a subquery or a CASE links to that nested fold, so you can drill from the column list back into the query.

### 4. Print (formatter): `src/core/print/`
This is a custom printer from CST to a Wadler-style Doc IR (`text`, `line`, `softline`, `group`, `indent`) plus one extra node, `fold(id, doc)`. We don't use prettier-plugin-sql-cst: it outputs a string, and the folds need to stay as nodes in the tree.

- `print/index.ts`: dispatches on `node.type`. **Any node type we haven't written a rule for prints its original source text** (from `range`, whitespace collapsed). That keeps output correct for syntax we haven't covered yet.
- `print/select.ts`, `print/expr.ts`, `print/join.ts`, `print/cte.ts`: the rules for the node types that matter in Sweep queries.
- Cleanups (each one is a separate pass, and each can be turned off):
  - Remove redundant parentheses: `((x))` becomes `(x)`, and parens are dropped where operator precedence makes them unnecessary. Parens around subqueries and set ops stay.
  - Collapse `"X" AS "X"` to `"X"`. The generated Sweep queries are full of these.
  - Few newlines: a group that fits within the width (default 100) stays on one line.
- Comments are kept and attached to the nearest node.

### 5. Layout: `src/core/layout.ts`
- `layout(doc, foldState, width)` returns `Line[]`. A line is a list of `Token`s: `{ text, kind: keyword|ident|string|number|op|comment|fold, nodeId? }`.
- A folded node becomes one `fold` token (`▸ orders_cte`, `▸ cat_sightings.columns (45)`).
- Re-layout happens on every fold toggle, so it has to be fast. Cache the printed Doc per fold node and only re-lay the parts that changed.

### 6. UI: `src/ui/`
Layout: outline sidebar on the left, query view in the middle, column panel on the right (shown when a column list is focused).

- `PasteBox.vue`: the homepage. A large textarea. A paste (or drop of a `.sql` file) triggers the parse.
- `SqlView.vue`: virtualized list of lines (only visible rows in the DOM) with syntax colors. Click a query fold chip to expand it inline; alt-click expands it recursively. Click a `columns` chip to open that list in the column panel.
- `ColumnPanel.vue`: the focused `ColumnList` as a well-formatted list:
  - One row per column: index, output name, then the formatted expression laid out at the panel's width. Multi-line expressions are indented under the name.
  - Filter box (by name or expression text) and toggle chips by `exprKind`, e.g. "hide passthroughs".
  - Clicking a row highlights that column in `SqlView`. Clicking a nested subquery chip focuses it in the main view.
  - Its own breadcrumb, e.g. `root › cat_sightings › columns`.
- `Outline.vue`: sidebar tree of the `FoldTree`, column lists included. Click an item to scroll to it; double-click to focus it.
- `Breadcrumbs.vue`: the focus path, e.g. `root › cat_sightings › derived_2`.
- **Focus (drill-down):** pick any fold node to make it the render root. Breadcrumbs go back up. The focus for the main view and the column panel is stored in the URL hash, so back and forward work. The SQL itself stays out of the URL.
- Toolbar: expand all, collapse all, copy formatted SQL (the whole query, the focused node, or the focused column list), width setting.
- `ParseError.vue`: when the parse fails, show the original text with the error line marked, plus a "view raw" mode that has highlighting and no formatting.

## Milestones

1. **Skeleton:** Vite/Vue/TS scaffold, parse in a worker, paste box, raw highlighted view, error UI.
2. **Printer v1:** the Doc IR, a layout engine, rules for SELECT/FROM/JOIN/WHERE/GROUP/ORDER/CTE/set ops/expressions, and the verbatim fallback. Check the output by hand against `research/parser-audit/corpus/sf/19`, `20a` and `20b`.
3. **Folding:** outline pass, naming, fold tokens, toggling, virtualized view. All three real queries usable.
4. **Drill-down:** focus mode, breadcrumbs, outline sidebar, URL state.
5. **Column panel:** the `ColumnList` model, `ColumnPanel.vue`, filtering by kind and text, cross-highlighting with the main view.
6. **Cleanups:** redundant parens, `X AS X`, tuning the line-width rules against the real queries.
7. **Polish:** copy focused SQL or columns, keyboard navigation (j/k between folds, enter to expand, `f` to focus, `c` to open columns), dark mode.

## Later (not in this plan)

- Server-backed sharing by URL. For now, nothing leaves the browser. Keep the core pipeline independent of where the SQL comes from, so a "load query by id" entry point can be added beside the paste box later.
- Automated tests.

## Open questions

- SELECT-list fold threshold: is 8 columns right? Or should it be based on line count?
- Should `"X" AS "X"` be collapsed by default or offered as a toggle?
- Should the column panel stay open and follow the focus as you drill (it shows the SELECT list of whatever query is focused), or open only when you click a `columns` chip?

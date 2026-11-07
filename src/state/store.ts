// App state: the loaded query, fold/focus/panel state, the worker client, and URL-hash sync.

import { computed, markRaw, reactive, shallowRef } from "vue";
import { eachFold, type Doc, type Fold } from "../core/doc";
import { layout, toText, type LayoutResult } from "../core/layout";
import { defaultPrintOptions, type FoldInfo, type ParseError, type PrintOptions, type PrintResult } from "../core/model";
import type { Request, Response } from "../worker/protocol";

const SQL_KEY = "sql-snob:sql";
const OUTLINE_KEY = "sql-snob:outline";
/** Set while a query is being viewed, so a page reload goes back to the viewer, not the paste box. */
const VIEWING_KEY = "sql-snob:viewing";

function readOutlinePref(): boolean {
  try {
    return localStorage.getItem(OUTLINE_KEY) === "open";
  } catch {
    return false;
  }
}

export function toggleOutline(): void {
  state.outlineOpen = !state.outlineOpen;
  try {
    localStorage.setItem(OUTLINE_KEY, state.outlineOpen ? "open" : "closed");
  } catch {
    /* storage unavailable */
  }
}

// ---- worker client ------------------------------------------------------------

const worker = new Worker(new URL("../worker/engine.worker.ts", import.meta.url), { type: "module" });
let seq = 0;
const pending = new Map<number, (r: Response) => void>();
worker.onmessage = (ev: MessageEvent<Response>) => {
  pending.get(ev.data.id)?.(ev.data);
  pending.delete(ev.data.id);
};
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
function call(req: DistributiveOmit<Request, "id">): Promise<Response> {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ ...req, id });
  });
}

// ---- state --------------------------------------------------------------------

export const state = reactive({
  sql: "",
  status: "empty" as "empty" | "loading" | "ready" | "error",
  error: null as ParseError | null,
  opts: { ...defaultPrintOptions } as PrintOptions,
  /** Fold id the main view is rooted at (null = whole query). */
  focus: null as string | null,
  /** ColumnList id shown in the side panel (null = closed). */
  panel: null as string | null,
  /** Selected column (tag id) — highlighted in the main view and the panel. */
  selectedTag: null as string | null,
  hoverTag: null as string | null,
  /** Outline sidebar expanded (collapsed to a rail by default; remembered per browser). */
  outlineOpen: readOutlinePref(),
  /** Keyboard cursor: a fold id. */
  cursor: null as string | null,
  /** A fold or tag the main view should scroll to after the next layout. */
  reveal: null as { id: string; kind: "fold" | "tag" } | null,
  width: 100,
  ms: { parse: 0, print: 0 },
});

export const result = shallowRef<PrintResult | null>(null);
/** Open folds. Replaced (not mutated) on change so computeds update. */
export const openSet = shallowRef<Set<string>>(new Set());

let foldDocs = new Map<string, Fold>();
/** columns-fold id -> ColumnList id */
let listByFold = new Map<string, string>();

export const folds = computed<Record<string, FoldInfo>>(() => result.value?.folds ?? {});

export function label(id: string): string {
  const f = folds.value[id];
  if (!f) return id;
  return f.kind === "columns" ? `${f.count} columns` : f.name;
}

// ---- loading ------------------------------------------------------------------

/** Load a query. `restore` keeps the URL hash (page reload of the same query). */
export async function load(sql: string, restore = false): Promise<void> {
  if (!restore) history.replaceState(null, "", location.pathname);
  state.sql = sql;
  state.status = "loading";
  try {
    sessionStorage.setItem(SQL_KEY, sql);
    sessionStorage.setItem(VIEWING_KEY, "1");
  } catch {
    /* storage unavailable */
  }
  const res = await call({ type: "load", sql, opts: { ...state.opts } });
  if (!res.ok) {
    state.status = "error";
    state.error = res.error;
    result.value = null;
    return;
  }
  setResult(res.result, res.ms);
  const r = res.result;
  openSet.value = new Set(Object.keys(r.folds)); // start fully expanded
  state.focus = null;
  state.panel = null;
  state.selectedTag = null;
  state.cursor = null;
  applyHash(true);
  state.status = "ready";
}

export async function reprint(): Promise<void> {
  if (state.status !== "ready") return;
  const res = await call({ type: "reprint", opts: { ...state.opts } });
  if (res.ok) setResult(res.result, res.ms);
}

function setResult(r: PrintResult, ms: { parse: number; print: number }) {
  state.ms = { parse: ms.parse || state.ms.parse, print: ms.print };
  foldDocs = new Map();
  eachFold(r.doc, (f) => foldDocs.set(f.id, f));
  listByFold = new Map();
  for (const l of Object.values(r.columns)) if (l.foldId) listByFold.set(l.foldId, l.id);
  result.value = markRaw(r);
  state.error = null;
}

export function reset(): void {
  try {
    sessionStorage.removeItem(VIEWING_KEY);
  } catch {
    /* storage unavailable */
  }
  state.status = "empty";
  result.value = null;
  history.pushState(null, "", location.pathname);
}

/** The last query, and whether it was being viewed when the page was left. */
export function restoreSession(): { sql: string; viewing: boolean } {
  try {
    return { sql: sessionStorage.getItem(SQL_KEY) ?? "", viewing: sessionStorage.getItem(VIEWING_KEY) === "1" };
  } catch {
    return { sql: "", viewing: false };
  }
}

// ---- layout -------------------------------------------------------------------

export function isOpen(id: string): boolean {
  return openSet.value.has(id);
}

export const mainLayout = computed<LayoutResult | null>(() => {
  const r = result.value;
  if (!r) return null;
  const root = state.focus ? focusDoc(state.focus) : r.doc;
  const open = openSet.value;
  return layout(root, { width: state.width, isOpen: (id) => open.has(id), label });
});

function focusDoc(id: string): Doc {
  const f = foldDocs.get(id);
  return f ? (f.body ?? f.c) : [];
}

export function layoutDoc(doc: Doc, width: number): LayoutResult {
  const open = openSet.value;
  return layout(doc, { width, isOpen: (id) => open.has(id), label });
}

/** Formatted SQL of the current focus with everything expanded. */
export function copyText(): string {
  const r = result.value;
  if (!r) return "";
  const root = state.focus ? focusDoc(state.focus) : r.doc;
  return toText(layout(root, { width: state.width, isOpen: () => true, label }));
}

// ---- folds & focus --------------------------------------------------------------

function setOpen(mutate: (s: Set<string>) => void) {
  const next = new Set(openSet.value);
  mutate(next);
  openSet.value = next;
  writeHash(false);
}

export function toggle(id: string): void {
  setOpen((s) => (s.has(id) ? s.delete(id) : s.add(id)));
}

export function descendants(id: string | null): string[] {
  const out: string[] = [];
  const kids = id ? (folds.value[id]?.children ?? []) : (result.value?.roots ?? []);
  for (const k of kids) out.push(k, ...descendants(k));
  return out;
}

/** Expand a fold and everything under it. */
export function expandDeep(id: string): void {
  setOpen((s) => {
    s.add(id);
    for (const d of descendants(id)) s.add(d);
  });
}

export function expandAll(): void {
  const ids = descendants(state.focus);
  setOpen((s) => ids.forEach((d) => s.add(d)));
}

export function collapseAll(): void {
  const ids = descendants(state.focus);
  setOpen((s) => ids.forEach((d) => !folds.value[d].defaultOpen && s.delete(d)));
}

/** Ancestors of a fold, nearest first. */
export function ancestors(id: string): string[] {
  const out: string[] = [];
  for (let p = folds.value[id]?.parent; p; p = folds.value[p]?.parent) out.push(p);
  return out;
}

function isWithinFocus(id: string): boolean {
  return !state.focus || id === state.focus || ancestors(id).includes(state.focus);
}

/** The query fold a fold belongs to, skipping `columns` folds (which aren't focus targets). */
function queryFold(id: string | null): string | null {
  while (id && folds.value[id]?.kind === "columns") id = folds.value[id].parent;
  return id;
}

export function setFocus(id: string | null): void {
  id = queryFold(id);
  if (id === state.focus) return;
  state.focus = id;
  state.cursor = null;
  // The panel follows the focus: show the focused query's SELECT list.
  if (state.panel) {
    const cols = id ? folds.value[id]?.columns : result.value?.rootColumns;
    if (cols) state.panel = cols;
  }
  writeHash(true);
}

export function focusUp(): void {
  if (state.focus) setFocus(folds.value[state.focus].parent);
}

/** Make a fold visible in the main view and scroll to it. */
export function reveal(id: string): void {
  if (!isWithinFocus(id)) setFocus(null);
  const toOpen = ancestors(id).filter((a) => a !== state.focus && !ancestors(state.focus ?? "").includes(a));
  setOpen((s) => toOpen.forEach((a) => s.add(a)));
  state.cursor = id;
  state.reveal = { id, kind: "fold" };
}

// ---- column panel ---------------------------------------------------------------

export function listForFold(foldId: string): string | undefined {
  return listByFold.get(foldId);
}

export function openPanel(listId: string | null): void {
  state.panel = listId;
  state.selectedTag = null;
  writeHash(true);
}

/** Select a column: highlight it, and make it visible in the main view. */
export function selectColumn(tagId: string): void {
  state.selectedTag = tagId;
  const r = result.value;
  if (!r) return;
  const list = r.columns[tagId.slice(0, tagId.indexOf(":"))];
  if (!list) return;
  if (list.owner && !isWithinFocus(list.owner)) setFocus(list.owner);
  else if (!list.owner && state.focus) setFocus(null);
  const inner = list.foldId ?? list.owner;
  const toOpen = inner ? [inner, ...ancestors(inner)] : [];
  setOpen((s) => toOpen.forEach((a) => s.add(a)));
  state.reveal = { id: tagId, kind: "tag" };
}

// ---- URL hash: #f=<focus>&p=<panel>&c=<collapsed,...> ---------------------------

function writeHash(push: boolean) {
  if (state.status !== "ready" && state.status !== "loading") return;
  const p = new URLSearchParams();
  if (state.focus) p.set("f", state.focus);
  if (state.panel) p.set("p", state.panel);
  // Folds start open, so the URL records the collapsed ones.
  const closed = Object.keys(folds.value).filter((id) => !openSet.value.has(id));
  if (closed.length) p.set("c", closed.join(","));
  const url = `${location.pathname}#${p.toString().replace(/%2C/g, ",")}`;
  if (url === location.pathname + location.hash) return;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

/** Apply the URL hash to the state (after load, and on back/forward). */
export function applyHash(initial = false): void {
  const p = new URLSearchParams(location.hash.slice(1));
  const fs = folds.value;
  const f = p.get("f");
  const panel = p.get("p");
  state.focus = f && fs[f] ? f : null;
  state.panel = panel && result.value?.columns[panel] ? panel : null;
  const closed = new Set((p.get("c") ?? "").split(","));
  openSet.value = new Set(Object.keys(fs).filter((id) => !closed.has(id)));
  if (initial) writeHash(false);
}

window.addEventListener("popstate", () => {
  if (state.status === "ready") applyHash();
});

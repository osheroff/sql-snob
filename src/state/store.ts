// App state: the loaded query, fold/focus/caret state, the worker client, and URL-hash sync.

import { computed, markRaw, reactive, shallowRef } from "vue";
import { eachFold, type Doc, type Fold, type Text } from "../core/doc";
import { layout, lineWidth, toText, tokenAt, tokenWidth, type LayoutResult, type Token } from "../core/layout";
import {
  defaultPrintOptions,
  nameKey,
  type Dialect,
  type DialectChoice,
  sectionTag,
  type FoldInfo,
  type ParseError,
  type PrintOptions,
  type PrintResult,
} from "../core/model";
import type { Request, Response } from "../worker/protocol";
import { openShared } from "./share";

const OUTLINE_KEY = "sql-snob:sidebar";
const DIALECT_KEY = "sql-snob:dialect";

function readDialectPref(): DialectChoice {
  try {
    const d = localStorage.getItem(DIALECT_KEY);
    return d === "postgresql" || d === "mysql" ? d : "auto";
  } catch {
    return "auto";
  }
}

/** Change the dialect setting and re-parse the current query with it. */
export function setDialect(d: DialectChoice): void {
  state.dialect = d;
  try {
    localStorage.setItem(DIALECT_KEY, d);
  } catch {
    /* storage unavailable */
  }
  if (state.status === "ready" || state.status === "error") load(state.sql, true);
}

function readOutlinePref(): boolean {
  try {
    return localStorage.getItem(OUTLINE_KEY) !== "closed";
  } catch {
    return true;
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
  /** Id (content hash) of the query in the URL, `/q/<id>`; null on the paste box. */
  queryId: null as string | null,
  /** Shown on the paste box, e.g. when a `/q/<id>` link's query isn't saved in this browser. */
  notice: null as string | null,
  /** Loading a query that was already being viewed (page reload, dialect change), not one from the paste box. */
  restoring: false,
  error: null as ParseError | null,
  opts: { ...defaultPrintOptions } as PrintOptions,
  /** Dialect setting; remembered per browser. */
  dialect: readDialectPref(),
  /** Dialect the loaded query was parsed in (the detected one with `auto`). */
  parsedAs: "postgresql" as Dialect,
  /** Fold id the main view is rooted at (null = whole query). */
  focus: null as string | null,
  /** The text cursor in the SQL. */
  caret: null as Caret | null,
  /** Section hovered in the local outline (highlighted in the SQL). */
  hoverSection: null as number | null,
  /** Lines visible in the code view (for PageUp/PageDown). */
  viewLines: 30,
  /** Sidebar (outline + context) expanded; remembered per browser. */
  outlineOpen: readOutlinePref(),
  /** An entity (a UNION) the local outline shows instead of the query under the caret, until the caret moves. */
  viewSection: null as number | null,
  /** Keyboard cursor: a fold id. */
  cursor: null as string | null,
  /** A fold or tag the main view should scroll to after the next layout. */
  reveal: null as { id: string; kind: "fold" | "tag" } | null,
  width: 100,
  ms: { parse: 0, print: 0 },
});

/**
 * The cursor. `line`/`col` are where it was placed; the anchor (the doc node of the token it's
 * in, or a fold chip, plus an offset) keeps it on the same text when the layout re-flows.
 */
export interface Caret {
  line: number;
  col: number;
  src?: Text;
  chip?: string;
  off: number;
  /** Innermost open fold of the anchor token, to fall back to its chip if it gets collapsed. */
  f: string | null;
  /** Column to aim for when moving up/down. */
  goal: number;
}

export const result = shallowRef<PrintResult | null>(null);
/** Open folds. Replaced (not mutated) on change so computeds update. */
export const openSet = shallowRef<Set<string>>(new Set());

let foldDocs = new Map<string, Fold>();
/** Section id -> child section ids. */
let sectionKids = new Map<number, number[]>();

export const folds = computed<Record<string, FoldInfo>>(() => result.value?.folds ?? {});

export function label(id: string): string {
  const f = folds.value[id];
  if (!f) return id;
  return f.kind === "columns" ? `${f.count} columns` : f.name;
}

// ---- loading ------------------------------------------------------------------

/**
 * Parse and show a query. The URL is the caller's job (see `submitQuery`, `openRoute`); its hash
 * (focus, folds, caret) is applied once the query is parsed. `restore`: re-showing a query that was
 * already being viewed (reload, dialect change), so don't flash the paste box meanwhile.
 */
export async function load(sql: string, restore = false): Promise<void> {
  state.sql = sql;
  state.status = "loading";
  state.restoring = restore;
  state.notice = null;
  const res = await call({ type: "load", sql, dialect: state.dialect, opts: { ...state.opts } });
  if (!res.ok) {
    state.status = "error";
    state.error = res.error;
    result.value = null;
    return;
  }
  state.parsedAs = res.dialect;
  setResult(res.result, res.ms);
  const r = res.result;
  openSet.value = new Set(Object.keys(r.folds)); // start fully expanded
  state.focus = null;
  state.cursor = null;
  state.caret = null;
  state.hoverSection = null;
  state.viewSection = null;
  state.reveal = null;
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
  sectionKids = new Map();
  for (const sec of r.sections) {
    if (sec.parent === null) continue;
    const k = sectionKids.get(sec.parent);
    if (k) k.push(sec.id);
    else sectionKids.set(sec.parent, [sec.id]);
  }
  result.value = markRaw(r);
  state.error = null;
}

/** Back to the paste box (keeping the current SQL in it), as a new history entry. */
export function reset(): void {
  showPasteBox();
  history.pushState(null, "", "/");
}

function showPasteBox(notice: string | null = null) {
  state.status = "empty";
  state.queryId = null;
  state.notice = notice;
  result.value = null;
}

// ---- saved queries & routes: `/` is the paste box, `/q/<id>` a query ---------------
// Queries are saved in localStorage under a hash of their text, so `/q/<id>` survives reloads and
// works in other tabs (of this browser: nothing leaves it). Only the most recent few are kept.

const QUERY_PREFIX = "sql-snob:q:";
const RECENT_KEY = "sql-snob:recent";
const KEEP_QUERIES = 20;

/** Content id of a query: the first 12 hex digits of its SHA-256. */
async function queryIdOf(sql: string): Promise<string> {
  const data = new TextEncoder().encode(sql);
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf, 0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // No WebCrypto outside secure contexts (e.g. the dev server over plain http on a LAN): FNV-1a.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const b of data) {
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x5bd1e995);
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 12);
}

/** Saved queries, most recent first: `{ id, at }` (`at`: when last viewed, ms since epoch). */
interface RecentEntry {
  id: string;
  at: number;
}

function readRecent(): RecentEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => (typeof x === "string" ? { id: x, at: 0 } : x)) // bare ids: the first version of this list
      .filter((x): x is RecentEntry => typeof x?.id === "string" && typeof x?.at === "number");
  } catch {
    return [];
  }
}

function writeRecent(list: RecentEntry[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

/** Save a query (most recent first), dropping the oldest ones to stay within KEEP_QUERIES and the quota. */
function saveQuery(id: string, sql: string): void {
  try {
    const list = [{ id, at: Date.now() }, ...readRecent().filter((x) => x.id !== id)];
    for (;;) {
      try {
        localStorage.setItem(QUERY_PREFIX + id, sql);
        break;
      } catch {
        // Full: drop the oldest other query and retry; give up when there's nothing left to drop.
        if (list.length <= 1) return;
        localStorage.removeItem(QUERY_PREFIX + list.pop()!.id);
      }
    }
    for (const old of list.splice(KEEP_QUERIES)) localStorage.removeItem(QUERY_PREFIX + old.id);
    writeRecent(list);
  } catch {
    /* storage unavailable: the query still shows, but its link won't survive a reload */
  }
}

export interface SavedQuery {
  id: string;
  /** When it was last viewed (ms since epoch; 0 if unknown). */
  at: number;
  sql: string;
}

/** The saved queries, most recent first. */
export function savedQueries(): SavedQuery[] {
  return readRecent().flatMap(({ id, at }) => {
    const sql = savedQuery(id);
    return sql === null ? [] : [{ id, at, sql }];
  });
}

/** Remove a saved query. */
export function forgetQuery(id: string): void {
  try {
    localStorage.removeItem(QUERY_PREFIX + id);
  } catch {
    /* storage unavailable */
  }
  writeRecent(readRecent().filter((x) => x.id !== id));
}

/** Open a saved query (a new history entry). */
export function openQuery(id: string): void {
  history.pushState(null, "", `/q/${id}`);
  openRoute();
}

function savedQuery(id: string): string | null {
  try {
    return localStorage.getItem(QUERY_PREFIX + id);
  } catch {
    return null;
  }
}

function routeId(): string | null {
  return /^\/q\/([0-9a-f]{12})\/?$/.exec(location.pathname)?.[1] ?? null;
}

/** View SQL from the paste box: save it, and go to its `/q/<id>` URL (a new history entry). */
export async function submitQuery(sql: string): Promise<void> {
  const id = await queryIdOf(sql);
  saveQuery(id, sql);
  state.queryId = id;
  history.pushState(null, "", `/q/${id}`);
  await load(sql);
}

/**
 * A shared link, `/s/<id>#<key>`: fetch and decrypt the query, then make it an ordinary saved query
 * (`/q/<id>`, replacing the shared URL so the key leaves the address bar and history).
 */
async function openSharedRoute(shareId: string): Promise<void> {
  state.status = "loading";
  state.restoring = true; // no paste box while it downloads
  let sql: string;
  try {
    sql = await openShared(shareId, location.hash.slice(1));
  } catch {
    history.replaceState(null, "", "/");
    showPasteBox("That shared link has expired, or it's incomplete (the part after # is the key).");
    return;
  }
  const id = await queryIdOf(sql);
  saveQuery(id, sql);
  state.queryId = id;
  history.replaceState(null, "", `/q/${id}`);
  await load(sql, true);
}

/** Show what the URL says: the paste box, or a saved query (at startup and on back/forward). */
export function openRoute(): void {
  const shared = /^\/s\/([A-Za-z0-9]{10})\/?$/.exec(location.pathname)?.[1];
  if (shared) return void openSharedRoute(shared);
  const id = routeId();
  if (!id) {
    if (location.pathname !== "/") history.replaceState(null, "", "/");
    showPasteBox();
    return;
  }
  if (id === state.queryId && (state.status === "ready" || state.status === "loading")) {
    if (state.status === "ready") applyHash(); // same query: only the view state changed
    return;
  }
  const sql = savedQuery(id);
  if (sql === null) {
    history.replaceState(null, "", "/");
    showPasteBox("That query isn't saved in this browser. Queries never leave your browser, so links only work where they were pasted.");
    return;
  }
  state.queryId = id;
  writeRecent([{ id, at: Date.now() }, ...readRecent().filter((x) => x.id !== id)]); // most recent first
  load(sql, true);
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
  return layout(root, { width: state.width, isOpen: (id) => open.has(id), label }, state.focus);
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
  beforeJump();
  state.focus = id;
  state.cursor = null;
  writeHash(true);
  // Keep the cursor in view: if it's outside the new focus, put it at the focused query's start.
  const at = state.caret?.f ?? null;
  const inside = id === null || (at !== null && (at === id || ancestors(at).includes(id)));
  if (!inside || !state.caret) {
    if (id) caretToFold(id);
    else setCaretAt(0, 0);
  }
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

// ---- caret ----------------------------------------------------------------------

/** Where the caret is in the current layout (follows its anchor through re-layouts). */
export const caretPos = computed<{ line: number; col: number } | null>(() => {
  const c = state.caret;
  const lay = mainLayout.value;
  if (!c || !lay || !lay.lines.length) return null;
  if (c.src || c.chip) {
    // Find the anchor token; if its fold was collapsed, land on the chip of the nearest closed fold.
    const chips = new Map<string, { line: number; col: number }>();
    for (let n = 0; n < lay.lines.length; n++) {
      const l = lay.lines[n];
      let col = l.indent;
      for (const t of l.tokens) {
        if (c.src ? t.src === c.src : t.fold === c.chip && t.k === "fold") {
          return { line: n, col: Math.max(l.indent, Math.min(col + c.off, lineWidth(l))) };
        }
        if (t.k === "fold" && t.fold) chips.set(t.fold, { line: n, col });
        col += tokenWidth(t);
      }
    }
    for (let f: string | null | undefined = c.f; f; f = folds.value[f]?.parent) {
      const at = chips.get(f);
      if (at) return at;
    }
  }
  const line = Math.min(c.line, lay.lines.length - 1);
  return { line, col: Math.min(c.col, lineWidth(lay.lines[line])) };
});

/**
 * Put the caret at a layout position (clamped to the text). `jump` makes it a new history entry
 * (Back returns to where the caret was); small moves such as arrow keys only update the current one.
 */
export function setCaretAt(line: number, col: number, keepGoal = false, jump = false): void {
  const lay = mainLayout.value;
  if (!lay || !lay.lines.length) return;
  if (jump) beforeJump();
  line = Math.max(0, Math.min(line, lay.lines.length - 1));
  const l = lay.lines[line];
  col = Math.max(l.tokens.length ? l.indent : 0, Math.min(col, lineWidth(l)));
  state.viewSection = null;
  const goal = keepGoal && state.caret ? state.caret.goal : col;
  let { i } = tokenAt(l, col);
  if (i < 0 && l.tokens.length) i = l.tokens.length - 1; // end of line: anchor after the last token
  // Spaces and list commas are shared doc nodes, so they can't anchor: use the nearest real token
  // (the offset may then point past its end, or before its start).
  const shared = (x: Token) => x.s === "," || !x.s.trim();
  if (i >= 0 && shared(l.tokens[i])) {
    let j = i;
    while (j >= 0 && shared(l.tokens[j])) j--;
    if (j < 0) for (j = i; j < l.tokens.length && shared(l.tokens[j]); j++);
    i = j < l.tokens.length ? j : -1;
  }
  let start = l.indent;
  for (let k = 0; k < i; k++) start += tokenWidth(l.tokens[k]);
  const t = i >= 0 ? l.tokens[i] : undefined;
  state.caret = {
    line,
    col,
    // Raw, so the reactive state doesn't wrap it in a proxy (the anchor is matched by identity).
    src: t && t.k !== "fold" && t.src ? markRaw(t.src) : undefined,
    chip: t && t.k === "fold" ? t.fold : undefined,
    off: col - start,
    f: t?.f ?? null,
    goal,
  };
  writeHash(jump);
}

export function moveCaret(how: "left" | "right" | "up" | "down" | "home" | "end" | "pageUp" | "pageDown" | "top" | "bottom"): void {
  const lay = mainLayout.value;
  const pos = caretPos.value;
  if (!lay || !lay.lines.length) return;
  if (!pos) return setCaretAt(0, 0);
  const l = lay.lines[pos.line];
  const page = Math.max(1, state.viewLines - 2);
  switch (how) {
    case "left":
      if (pos.col > l.indent) return setCaretAt(pos.line, pos.col - 1);
      if (pos.line > 0) return setCaretAt(pos.line - 1, Infinity);
      return;
    case "right":
      if (pos.col < lineWidth(l)) return setCaretAt(pos.line, pos.col + 1);
      if (pos.line < lay.lines.length - 1) return setCaretAt(pos.line + 1, 0);
      return;
    case "up":
      return setCaretAt(pos.line - 1, state.caret!.goal, true);
    case "down":
      return setCaretAt(pos.line + 1, state.caret!.goal, true);
    case "pageUp":
      return setCaretAt(pos.line - page, state.caret!.goal, true);
    case "pageDown":
      return setCaretAt(pos.line + page, state.caret!.goal, true);
    case "home":
      return setCaretAt(pos.line, 0);
    case "end":
      return setCaretAt(pos.line, Infinity);
    case "top":
      return setCaretAt(0, 0, false, true);
    case "bottom":
      return setCaretAt(lay.lines.length - 1, Infinity, false, true);
  }
}

/** The token the caret is on (or just after, at the end of a line). */
export const caretToken = computed(() => {
  const pos = caretPos.value;
  const lay = mainLayout.value;
  if (!pos || !lay) return null;
  const l = lay.lines[pos.line];
  if (!l?.tokens.length) return null;
  let { i } = tokenAt(l, pos.col);
  if (i < 0) i = l.tokens.length - 1;
  // On a space or list comma, the caret belongs to the item before it (`a,|` is in `a`).
  while (i > 0 && (l.tokens[i].s === "," || !l.tokens[i].s.trim())) i--;
  return l.tokens[i];
});

/** The identifier under the caret: on it, or just after it (`STATE|,`). */
const caretIdent = computed<Token | null>(() => {
  const pos = caretPos.value;
  const lay = mainLayout.value;
  if (!pos || !lay) return null;
  const l = lay.lines[pos.line];
  if (!l?.tokens.length) return null;
  const { i } = tokenAt(l, pos.col);
  const t = i >= 0 ? l.tokens[i] : null;
  if (t?.k === "id") return t;
  // At the end of an identifier: the token that ends at the caret.
  let col = l.indent;
  for (const x of l.tokens) {
    const w = tokenWidth(x);
    if (col + w === pos.col) return x.k === "id" ? x : null;
    col += w;
  }
  return null;
});

/**
 * Usages of the identifier under the caret within the current block (the query around the caret,
 * not its subqueries; all the arms for a UNION): its name key and the section tags to look in.
 */
export const identMatches = computed<{ key: string; tags: Set<string> } | null>(() => {
  const t = caretIdent.value;
  const l = localOutline.value;
  const secs = result.value?.sections;
  if (!t || !l || !secs) return null;
  const root = l.query;
  const tags = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const s = stack.pop()!;
    const k = secs[s].kind;
    if (s !== root && (k === "query" || k === "union") && secs[root].kind !== "union") continue;
    tags.add(sectionTag(s));
    stack.push(...sectionChildren(s));
  }
  return { key: nameKey(t.s), tags };
});

/** Innermost section (query part) the caret is in. */
export const caretSection = computed<number | null>(() => {
  const tg = caretToken.value?.tag;
  return tg && tg[0] === "S" ? Number(tg.slice(1)) : null;
});

export interface LocalOutline {
  /** The innermost entity around the caret: a query, or a UNION of queries. */
  query: number;
  /** The clause of that query the caret is in (SELECT, FROM, ...), and the item within it. */
  clause: number | null;
  item: number | null;
  /** Enclosing queries, outermost first (ending with `query`). */
  path: number[];
}

/** The query structure around the caret, for the local outline. */
export const localOutline = computed<LocalOutline | null>(() => {
  const r = result.value;
  if (!r || !r.sections.length) return null;
  const secs = r.sections;
  const chain: number[] = [];
  for (let s: number | null = caretSection.value; s !== null; s = secs[s].parent) chain.push(s);
  const isEntity = (s: number) => secs[s].kind === "query" || secs[s].kind === "union";
  let qi = state.viewSection !== null ? chain.indexOf(state.viewSection) : -1;
  if (qi < 0) qi = chain.findIndex(isEntity);
  if (qi < 0) {
    // No caret (or outside any query): the query of the current focus, else the top-level one.
    const q = secs.find((x) => x.kind === "query" && x.fold === state.focus) ?? secs.find((x) => x.kind === "query");
    if (!q) return null;
    chain.length = 0;
    for (let s: number | null = q.id; s !== null; s = secs[s].parent) chain.push(s);
    qi = 0;
  }
  return {
    query: chain[qi],
    clause: qi >= 1 ? chain[qi - 1] : null,
    item: qi >= 2 ? chain[qi - 2] : null,
    path: chain.slice(qi).filter(isEntity).reverse(),
  };
});

export function sectionChildren(id: number): number[] {
  return sectionKids.get(id) ?? [];
}

/** A section and everything inside it, as doc tag ids (for highlighting its tokens). */
export function sectionTags(id: number | null): Set<string> {
  const out = new Set<string>();
  if (id === null) return out;
  const stack = [id];
  while (stack.length) {
    const s = stack.pop()!;
    out.add(sectionTag(s));
    stack.push(...sectionChildren(s));
  }
  return out;
}

/** Where a section starts in the current layout: its own first token, else its first child's. */
function sectionStart(lay: LayoutResult, id: number): { line: number; col: number } | null {
  const tg = sectionTag(id);
  const line = lay.tagLine.get(tg);
  const col = lay.tagCol.get(tg);
  let best = line !== undefined && col !== undefined ? { line, col } : null;
  for (const k of sectionChildren(id)) {
    const p = sectionStart(lay, k);
    if (p && (!best || p.line < best.line || (p.line === best.line && p.col < best.col))) best = p;
  }
  return best;
}

/** The first query (SELECT) at or under a section: for a UNION, its first arm's. */
/** The first query (or UNION of queries) in a section. */
export function firstQuery(id: number): number | null {
  const secs = result.value?.sections;
  if (!secs) return null;
  const queue = [id];
  while (queue.length) {
    const s = queue.shift()!;
    if (secs[s].kind === "query" || secs[s].kind === "union") return s;
    queue.push(...sectionChildren(s));
  }
  return null;
}

/** Move the caret into a fold: to its first query, so "This query" shows that subquery. */
export function caretToFold(foldId: string): void {
  const sec = result.value?.sections.find((s) => s.fold === foldId);
  if (!sec) return reveal(foldId);
  caretToSection(sec.kind === "column" ? sec.id : (firstQuery(sec.id) ?? sec.id));
}

/** Move the caret to the start of a section, opening folds as needed. */
export function caretToSection(id: number): void {
  const sec = result.value?.sections[id];
  if (!sec) return;
  beforeJump();
  if (sec.fold ? !isWithinFocus(sec.fold) : state.focus) setFocus(null);
  if (sec.fold) {
    const toOpen = [sec.fold, ...ancestors(sec.fold)].filter((a) => a !== state.focus);
    if (toOpen.some((a) => !openSet.value.has(a))) setOpen((s) => toOpen.forEach((a) => s.add(a)));
  }
  const lay = mainLayout.value;
  const at = lay && sectionStart(lay, id);
  if (at) setCaretAt(at.line, at.col, false, true);
  // A UNION starts where its first arm does: pin the outline to the UNION itself.
  if (sec.kind === "union") state.viewSection = id;
}

// ---- URL hash: #f=<focus>&c=<collapsed,...>&p=<line>.<col> ----------------------

/**
 * A new history entry is written at the end of the current task, so one action (move into a fold:
 * focus + open + caret) makes one entry. Updates to the current entry (arrow keys) are debounced:
 * browsers throttle replaceState (Safari throws after ~100 calls in 30s).
 */
let pushQueued = false;
let replaceTimer = 0;

function writeHash(push: boolean) {
  if (applying) return;
  if (push) {
    if (pushQueued) return;
    pushQueued = true;
    queueMicrotask(() => {
      if (!pushQueued) return;
      pushQueued = false;
      clearTimeout(replaceTimer);
      replaceTimer = 0;
      flushHash(true);
    });
  } else if (!pushQueued) {
    clearTimeout(replaceTimer);
    replaceTimer = window.setTimeout(() => {
      replaceTimer = 0;
      flushHash(false);
    }, 300);
  }
}

/** Before a jump: save the current state (e.g. a caret moved by arrow keys) into the current entry. */
function beforeJump() {
  if (!replaceTimer || pushQueued) return;
  clearTimeout(replaceTimer);
  replaceTimer = 0;
  flushHash(false);
}

/** Cancel queued writes (they describe a state that is being replaced). */
function dropHashWrites() {
  pushQueued = false;
  clearTimeout(replaceTimer);
  replaceTimer = 0;
}

function flushHash(push: boolean) {
  if (state.status !== "ready" && state.status !== "loading") return;
  const p = new URLSearchParams();
  if (state.focus) p.set("f", state.focus);
  // Folds start open, so the URL records the collapsed ones.
  const closed = Object.keys(folds.value).filter((id) => !openSet.value.has(id));
  if (closed.length) p.set("c", closed.join(","));
  // The caret as a position in the layout, which the focus and collapsed folds above determine.
  const at = caretPos.value;
  if (at) p.set("p", `${at.line + 1}.${at.col + 1}`);
  const hash = p.toString().replace(/%2C/g, ",");
  const url = location.pathname + (hash ? `#${hash}` : "");
  if (url === location.pathname + location.hash) return;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

/** Set while the state is being restored from the hash, so restoring doesn't write it back. */
let applying = false;

/** Apply the URL hash to the state (after load, and on back/forward). */
export function applyHash(initial = false): void {
  const p = new URLSearchParams(location.hash.slice(1));
  const fs = folds.value;
  const f = p.get("f");
  applying = true;
  try {
    state.focus = f && fs[f] ? f : null;
    const closed = new Set((p.get("c") ?? "").split(","));
    openSet.value = new Set(Object.keys(fs).filter((id) => !closed.has(id)));
    const m = /^(\d+)\.(\d+)$/.exec(p.get("p") ?? "");
    if (m) setCaretAt(Number(m[1]) - 1, Number(m[2]) - 1);
    else state.caret = null;
  } finally {
    applying = false;
  }
  dropHashWrites();
  if (initial) flushHash(false);
}

window.addEventListener("popstate", openRoute);

/** Formatted SQL of one section (e.g. a subquery), fully expanded and dedented. */
export function copySectionText(id: number): string {
  const r = result.value;
  if (!r) return "";
  const sec = r.sections[id];
  const root = sec.fold ? focusDoc(sec.fold) : r.doc;
  const lay = layout(root, { width: state.width, isOpen: () => true, label }, sec.fold ?? null);
  const tags = sectionTags(id);
  // A section is contiguous in the output: take everything from its first token to its last.
  const inSec = (t: Token) => !!t.tag && tags.has(t.tag);
  let first = -1;
  let last = -1;
  lay.lines.forEach((l, i) => {
    if (l.tokens.some(inSec)) {
      if (first < 0) first = i;
      last = i;
    }
  });
  const rows: { col: number; s: string }[] = [];
  for (let i = first; first >= 0 && i <= last; i++) {
    const toks = lay.lines[i].tokens;
    let from = 0;
    let to = toks.length;
    if (i === first) from = toks.findIndex(inSec);
    if (i === last) to = toks.length - [...toks].reverse().findIndex(inSec);
    let col = lay.lines[i].indent;
    for (let j = 0; j < from; j++) col += toks[j].s.length;
    rows.push({ col, s: toks.slice(from, to).map((t) => t.s).join("").trimEnd() });
  }
  if (!rows.length) return "";
  const min = Math.min(...rows.slice(1).map((r) => r.col), Infinity);
  return rows.map((r, i) => (i === 0 ? r.s.trimStart() : " ".repeat(Math.max(0, r.col - min)) + r.s)).join("\n");
}

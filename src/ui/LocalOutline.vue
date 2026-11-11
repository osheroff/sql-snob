<script setup lang="ts">
// Local outline: a navigation table of the query around the cursor. It mirrors the query's
// structure (columns, tables, conditions, ...) without trying to repeat all of its text.
// A UNION is an entity of its own: a list of its arms and their tables.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Section, SectionKind } from "../core/model";
import {
  caretToFold,
  caretToSection,
  firstQuery,
  localOutline,
  result,
  sectionChildren,
  state,
  toggleOutline,
} from "../state/store";
import { unquote } from "./labels";

const el = ref<HTMLElement>();
const secs = computed(() => result.value?.sections ?? []);
const lo = computed(() => localOutline.value);
const cur = computed(() => (lo.value ? secs.value[lo.value.query] : null));

/** Shorten a long name in the middle: generated names differ at the end (`…_3bd304_0`). */
function mid(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = Math.ceil((max - 1) / 2);
  return s.slice(0, max - 1 - tail) + "…" + s.slice(-tail);
}

const HEADING: Partial<Record<SectionKind, string>> = {
  with: "WITH",
  select: "SELECT",
  from: "TABLES",
  where: "WHERE",
  having: "HAVING",
  qualify: "QUALIFY",
  groupby: "GROUP BY",
  orderby: "ORDER BY",
};

/** Short join-type badge. */
function joinBadge(s: Section): string {
  if (s.kind === "source") return "from";
  const op = (s.op ?? "").toUpperCase();
  if (op === ",") return "cross";
  for (const k of ["LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "INNER"]) if (op.includes(k)) return k.toLowerCase();
  return "inner";
}

/** Rows that lead into a subquery: a derived table, or a CTE. */
function isSubquery(s: Section): boolean {
  return !!s.targetFold || s.kind === "cte";
}

// ---- UNION ------------------------------------------------------------------------

/** If the query is a UNION arm: the UNION, its position, and its sibling arms. */
const arm = computed(() => {
  const l = lo.value;
  if (!l) return null;
  const q = secs.value[l.query];
  const a = q.parent !== null ? secs.value[q.parent] : null;
  if (a?.kind !== "arm" || a.parent === null) return null;
  const arms = sectionChildren(a.parent).filter((x) => secs.value[x].kind === "arm");
  return { union: a.parent, op: secs.value[a.parent].label, index: arms.indexOf(a.id), arms };
});
function gotoArm(i: number) {
  const a = arm.value;
  if (!a || a.arms[i] === undefined) return;
  caretToSection(firstQuery(a.arms[i]) ?? a.arms[i]);
}

/** When the outline shows a UNION: one row per arm. */
const unionArms = computed(() => {
  const u = cur.value;
  if (u?.kind !== "union") return [];
  return sectionChildren(u.id)
    .filter((a) => secs.value[a].kind === "arm")
    .map((a, i) => ({ id: a, n: i + 1, q: firstQuery(a) }));
});

// ---- clauses ----------------------------------------------------------------------

const clauses = computed(() => {
  const l = lo.value;
  if (!l || cur.value?.kind !== "query") return [];
  return sectionChildren(l.query).map((cid) => ({ c: secs.value[cid], items: sectionChildren(cid).map((i) => secs.value[i]) }));
});

/**
 * Lists longer than this scroll in a box of their own (which follows the cursor's row). The box
 * takes the pane's free space, down to MIN_ROWS rows (then the pane itself scrolls).
 */
const SHORT = 20;

// ---- actions ----------------------------------------------------------------------

function go(id: number) {
  caretToSection(id);
}

/** Jump into a subquery row's query: the cursor goes inside it, and this outline follows. */
function enter(it: Section) {
  if (it.targetFold) return caretToFold(it.targetFold);
  caretToSection(firstQuery(it.id) ?? it.id);
}

/** The outline's rows in order: each clause's items (or the clause itself if it has none), or a UNION's arms. */
const stops = computed<number[]>(() => {
  if (cur.value?.kind === "union") return unionArms.value.map((a) => a.id);
  return clauses.value.flatMap(({ c, items }) => (items.length ? items.map((i) => i.id) : [c.id]));
});

/** With the outline focused, Up / Down step through its rows (moving the cursor in the SQL). */
function onKey(ev: KeyboardEvent) {
  if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
  ev.preventDefault();
  const list = stops.value;
  const l = lo.value;
  if (!l || !list.length) return;
  const at = list.indexOf(l.item ?? -1) >= 0 ? list.indexOf(l.item!) : list.indexOf(l.clause ?? -1);
  const next = at < 0 ? 0 : Math.max(0, Math.min(list.length - 1, at + (ev.key === "ArrowDown" ? 1 : -1)));
  if (next !== at) go(list[next]);
}

function hover(id: number | null) {
  state.hoverSection = id;
}

// Keep the current row in view: when it changes, and when the pane (so a long list's box) resizes.
function showCurrent() {
  const target = el.value?.querySelector(".row.cur") ?? el.value?.querySelector(".clause.cur > .heading");
  target?.scrollIntoView({ block: "nearest" });
}
watch(
  () => lo.value?.item ?? lo.value?.clause,
  async () => {
    await nextTick();
    showCurrent();
  },
);
let ro: ResizeObserver | undefined;
onMounted(() => {
  ro = new ResizeObserver(() => showCurrent());
  ro.observe(el.value!);
});
onBeforeUnmount(() => ro?.disconnect());
</script>

<template>
  <section ref="el" class="local" tabindex="0" @keydown="onKey">
    <template v-if="lo">
      <div v-if="arm" class="arm">
        <button class="arm-op" title="Show all the arms of this UNION" @click="go(arm.union)">{{ arm.op }}</button>
        <span>arm {{ arm.index + 1 }} of {{ arm.arms.length }}</span>
        <button class="nav" :disabled="arm.index === 0" title="Previous arm" @click="gotoArm(arm.index - 1)">‹</button>
        <button class="nav" :disabled="arm.index === arm.arms.length - 1" title="Next arm" @click="gotoArm(arm.index + 1)">›</button>
      </div>

      <!-- A UNION: its arms, each with its tables. -->
      <div v-if="cur?.kind === 'union'" class="clause cur">
        <div class="heading" @click="go(cur.id)">
          <span class="h">{{ cur.label }}</span>
          <span class="count">{{ unionArms.length }}</span>
        </div>
        <div class="grid">
          <div
            v-for="a in unionArms"
            :key="a.id"
            class="row"
            :class="{ cur: a.id === lo.clause }"
            @click="go(a.id)"
            @mouseenter="hover(a.id)"
            @mouseleave="hover(null)"
          >
            <span class="text">arm #{{ a.n }}</span>
            <button v-if="a.q !== null" class="into" title="Go into this arm" @click.stop="go(a.q)">›</button>
          </div>
        </div>
      </div>

      <div v-for="{ c, items } in clauses" :key="c.id" class="clause" :class="{ cur: c.id === lo.clause, 'has-scroll': items.length > SHORT }">
        <div class="heading" @click="go(c.id)" @mouseenter="hover(c.id)" @mouseleave="hover(null)">
          <span class="h">{{ HEADING[c.kind] ?? c.label }}</span>
          <span v-if="!items.length && c.detail" class="h-detail">{{ c.detail.replace(/^\w+\s+/, "") }}</span>
          <button v-if="c.kind === 'select'" class="collapse" title="Hide sidebar" @click.stop="toggleOutline">«</button>
          <span v-else-if="items.length > 1" class="count">{{ items.length }}</span>
        </div>

        <div v-if="items.length" class="grid" :class="c.kind">
          <div class="rows" :class="{ scroll: items.length > SHORT }">
            <div
              v-for="it in items"
              :key="it.id"
              class="row"
              :class="{ cur: it.id === lo.item }"
              :title="unquote(it.label)"
              @click="go(it.id)"
              @mouseenter="hover(it.id)"
              @mouseleave="hover(null)"
            >
              <!-- TABLES: join type + alias -->
              <span v-if="it.kind === 'source' || it.kind === 'join'" class="badge" :class="joinBadge(it)">{{ joinBadge(it) }}</span>
              <span class="text">{{ it.kind === "cond" || it.kind === "item" ? it.label : mid(unquote(it.label), 40) }}</span>
              <button v-if="isSubquery(it)" class="into" title="Go into this subquery" @click.stop="enter(it)">›</button>
            </div>
          </div>
        </div>
      </div>
    </template>
    <p v-else class="hint">Click in the SQL to see the structure of the query around the cursor.</p>
  </section>
</template>

<style scoped>
.local {
  display: flex;
  flex-direction: column;
  outline: none;
  overflow: auto;
  padding: 6px 8px 16px;
  font-size: 12px;
}
.hint {
  color: var(--muted);
  margin: 4px;
  line-height: 1.5;
}
.arm-op {
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0;
}
.arm-op:hover {
  text-decoration: underline;
}
/*
 * A long list: as tall as it is if the pane has the room, else it shrinks to the free space (each
 * long list in proportion to its length), down to 10 rows. Everything else keeps its height.
 */
.local > * {
  flex: 0 0 auto;
}
.local > .clause.has-scroll {
  flex: 0 1 auto;
  min-height: calc(10 * 19px + 30px);
  display: flex;
  flex-direction: column;
}
.has-scroll > .heading {
  flex: 0 0 auto;
}
.has-scroll > .grid {
  flex: 0 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.rows.scroll {
  flex: 0 1 auto;
  min-height: 0;
  padding-bottom: 10px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  background: var(--bg);
}
.arm {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  padding: 0 3px 8px;
}
.arm span {
  margin-right: auto;
}
.arm .arm-op + span {
  margin-left: 4px;
}
.nav {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  border-radius: 3px;
  cursor: pointer;
  padding: 0 7px;
}
.nav:disabled {
  opacity: 0.35;
  cursor: default;
}

.clause {
  margin-bottom: 10px;
}
.heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 4px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.heading:hover {
  background: var(--hov);
}
.h {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.clause.cur .h {
  color: var(--accent);
}
.h-detail {
  font-family: var(--mono);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
}
.collapse {
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--muted);
  border-radius: 3px;
  font-size: 12px;
  line-height: 16px;
  padding: 1px 8px;
  cursor: pointer;
}
.collapse:hover {
  border-color: var(--accent);
  color: var(--fg);
}
.count {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
}

.grid {
  font-family: var(--mono);
  margin-top: 2px;
}
.row {
  display: flex;
  align-items: baseline;
  height: 19px;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
}
.row:hover {
  background: var(--hov);
}
.row.cur {
  background: var(--hl);
}
.local:focus-within .row.cur {
  box-shadow: inset 2px 0 0 var(--accent);
}
.text {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg);
}
.into {
  flex: 0 0 auto;
  margin-left: 6px;
  border: 1px solid var(--chip-border);
  background: var(--chip-bg);
  color: var(--chip-fg);
  border-radius: 3px;
  font: inherit;
  line-height: 14px;
  padding: 0 6px;
  cursor: pointer;
}
.into:hover {
  border-color: var(--accent);
  color: var(--fg);
}
.badge {
  flex: 0 0 auto;
  display: inline-block;
  width: 6ch;
  margin-right: 8px;
  font-size: 10px;
  line-height: 15px;
  text-transform: uppercase;
  text-align: center;
  border-radius: 3px;
  color: var(--muted);
  background: var(--kind-bg);
}
.badge.from {
  color: var(--fg);
}
.badge.left,
.badge.right {
  background: var(--k-rename);
  color: var(--chip-fg);
}
.badge.full,
.badge.cross {
  background: var(--k-case);
}
.badge.inner {
  background: var(--k-cast);
}
</style>

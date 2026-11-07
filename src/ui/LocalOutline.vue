<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Section } from "../core/model";
import { caretToSection, localOutline, result, sectionChildren, state } from "../state/store";

const el = ref<HTMLElement>();
const secs = computed(() => result.value?.sections ?? []);
const lo = computed(() => localOutline.value);

/** Breadcrumb label of a query: an arm's name if it's a UNION arm. */
function queryLabel(id: number): string {
  const s = secs.value[id];
  const p = s.parent !== null ? secs.value[s.parent] : null;
  return p?.kind === "arm" ? p.label : s.label;
}

/** If the query is a UNION arm: its position, and its sibling arms. */
const arm = computed(() => {
  const l = lo.value;
  if (!l) return null;
  const q = secs.value[l.query];
  const a = q.parent !== null ? secs.value[q.parent] : null;
  if (a?.kind !== "arm" || a.parent === null) return null;
  const arms = sectionChildren(a.parent);
  return { op: secs.value[a.parent].label, index: arms.indexOf(a.id), arms };
});
function gotoArm(i: number) {
  const a = arm.value;
  if (!a || a.arms[i] === undefined) return;
  // Land inside the arm's query (the arm itself starts at its parenthesis, part of the outer query).
  const stack = [a.arms[i]];
  while (stack.length) {
    const s = stack.shift()!;
    if (secs.value[s].kind === "query") return caretToSection(s);
    stack.push(...sectionChildren(s));
  }
  caretToSection(a.arms[i]);
}

const clauses = computed(() => {
  const l = lo.value;
  if (!l) return [];
  return sectionChildren(l.query).map((cid) => ({ c: secs.value[cid], items: sectionChildren(cid).map((i) => secs.value[i]) }));
});

/** Expression shown next to a column, unless it just repeats the column's name. */
function columnDetail(s: Section): string {
  const d = s.detail ?? "";
  const bare = d.replace(/^.*\./, "").replace(/"/g, "");
  return bare.toLowerCase() === s.label.replace(/"/g, "").toLowerCase() ? "" : d;
}

/** Long item lists outside the current clause are cut short, unless expanded. */
const LONG = 12;
const SHORT = 5;
const expanded = ref(new Set<number>());
function shown(clauseId: number, items: Section[]): Section[] {
  if (items.length <= LONG || clauseId === lo.value?.clause || expanded.value.has(clauseId)) return items;
  return items.slice(0, SHORT);
}
function expand(clauseId: number) {
  expanded.value = new Set(expanded.value).add(clauseId);
}

function onEnter(id: number) {
  state.hoverSection = id;
}
function onLeave() {
  state.hoverSection = null;
}

// Keep the current item in view.
watch(
  () => lo.value?.item ?? lo.value?.clause,
  async () => {
    await nextTick();
    const target = el.value?.querySelector(".cur-item") ?? el.value?.querySelector(".cur-clause > .clause-head");
    target?.scrollIntoView({ block: "nearest" });
  },
);
</script>

<template>
  <section ref="el" class="local">
    <div class="head">This query</div>
    <template v-if="lo">
      <div class="path">
        <template v-for="(q, i) in lo.path" :key="q">
          <span v-if="i > 0" class="sep">›</span>
          <button class="crumb" :class="{ cur: q === lo.query }" @click="caretToSection(q)">{{ queryLabel(q) }}</button>
        </template>
      </div>
      <div v-if="arm" class="arm">
        {{ arm.op }} arm {{ arm.index + 1 }} of {{ arm.arms.length }}
        <button class="nav" :disabled="arm.index === 0" title="Previous arm" @click="gotoArm(arm.index - 1)">‹</button>
        <button class="nav" :disabled="arm.index === arm.arms.length - 1" title="Next arm" @click="gotoArm(arm.index + 1)">›</button>
      </div>

      <div v-for="{ c, items } in clauses" :key="c.id" class="clause" :class="{ 'cur-clause': c.id === lo.clause }">
        <div class="clause-head" @click="caretToSection(c.id)" @mouseenter="onEnter(c.id)" @mouseleave="onLeave">
          <span class="kw">{{ c.label }}</span>
          <span v-if="items.length > 1" class="count">{{ items.length }}</span>
          <span v-else-if="!items.length && c.detail" class="detail">{{ c.detail }}</span>
        </div>
        <ul v-if="items.length">
          <li
            v-for="it in shown(c.id, items)"
            :key="it.id"
            :class="{ 'cur-item': it.id === lo.item }"
            :title="it.detail ?? it.label"
            @click="caretToSection(it.id)"
            @mouseenter="onEnter(it.id)"
            @mouseleave="onLeave"
          >
            <template v-if="it.kind === 'column'">
              <span class="name">{{ it.label }}</span>
              <span class="detail">{{ columnDetail(it) }}</span>
            </template>
            <template v-else-if="it.kind === 'join' || it.kind === 'source'">
              <span class="op">{{ it.kind === "source" ? "FROM" : it.op === "," ? "," : it.op }}</span>
              <span class="name">{{ it.label }}</span>
              <span class="detail">{{ it.kind === "join" ? it.detail : "" }}</span>
            </template>
            <template v-else>
              <span class="name plain">{{ it.label }}</span>
            </template>
          </li>
          <li v-if="shown(c.id, items).length < items.length" class="more" @click="expand(c.id)">
            … {{ items.length - SHORT }} more
          </li>
        </ul>
      </div>
    </template>
    <p v-else class="hint">Click in the SQL to see the structure of the query around the cursor.</p>
  </section>
</template>

<style scoped>
.local {
  overflow: auto;
  padding: 6px 6px 16px;
  font-size: 12px;
}
.head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  padding: 2px 4px 6px;
}
.hint {
  color: var(--muted);
  margin: 4px;
  line-height: 1.5;
}
.path {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1px;
  font-family: var(--mono);
  padding: 0 2px 6px;
}
.crumb {
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 1px 3px;
  border-radius: 3px;
}
.crumb:hover {
  background: var(--hov);
}
.crumb.cur {
  color: var(--fg);
  font-weight: 600;
}
.sep {
  color: var(--muted);
}
.arm {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  padding: 0 4px 6px;
}
.nav {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  border-radius: 3px;
  cursor: pointer;
  padding: 0 6px;
}
.nav:disabled {
  opacity: 0.35;
  cursor: default;
}
.clause {
  margin-bottom: 4px;
}
.clause-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.clause-head:hover {
  background: var(--hov);
}
.cur-clause > .clause-head .kw {
  color: var(--accent);
}
.kw {
  font-family: var(--mono);
  font-weight: 600;
  color: var(--fg);
}
.count {
  color: var(--muted);
  font-size: 11px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0 0 0 10px;
  border-left: 1px solid var(--border-soft);
  margin-left: 8px;
}
li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  font-family: var(--mono);
}
li:hover {
  background: var(--hov);
}
li.cur-item {
  background: var(--hl);
}
li.more {
  color: var(--accent);
  font-family: var(--sans);
}
.name {
  color: var(--fg);
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}
.name.plain {
  flex: 1 1 auto;
}
.op {
  color: var(--kw);
  font-size: 11px;
  flex: 0 0 auto;
}
.detail {
  color: var(--muted);
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.clause-head .detail {
  font-family: var(--mono);
}
</style>

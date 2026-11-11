<script setup lang="ts">
import { dialectNames, type DialectChoice } from "../core/model";
import { setDialect, state } from "../state/store";

function onChange(ev: Event) {
  setDialect((ev.target as HTMLSelectElement).value as DialectChoice);
}
</script>

<template>
  <label class="dialect muted" title="SQL dialect to parse as. Auto tries PostgreSQL, then MySQL.">
    <select :value="state.dialect" @change="onChange">
      <option value="auto">
        Auto{{ state.status === "ready" ? ` (${dialectNames[state.parsedAs]})` : "" }}
      </option>
      <option value="postgresql">PostgreSQL</option>
      <option value="mysql">MySQL</option>
    </select>
  </label>
</template>

<style scoped>
.dialect { display: inline-flex; align-items: center; gap: 4px; }
select {
  font: inherit;
  color: var(--fg);
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 2px;
}
select:hover, select:focus { border-color: var(--accent); outline: none; }
</style>

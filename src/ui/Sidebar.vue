<script setup lang="ts">
import LocalOutline from "./LocalOutline.vue";
import Outline from "./Outline.vue";
</script>

<template>
  <aside class="sidebar">
    <Outline class="pane outline-pane" />
    <LocalOutline class="pane context-pane" />
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--panel-bg);
}
.pane {
  min-height: 0;
  overflow: auto;
}
.outline-pane {
  flex: 0 1 30%;
  height: auto;
  min-height: 90px;
  border-right: 0;
  border-bottom: 1px solid var(--border);
}
.context-pane {
  flex: 1 1 70%;
}
</style>

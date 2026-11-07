import { createApp } from "vue";
import App from "./App.vue";
import * as store from "./state/store";
import "./style.css";

createApp(App).mount("#app");

// Dev-only handle for poking at state from the console / test scripts.
if (import.meta.env.DEV) (window as unknown as { __store: typeof store }).__store = store;

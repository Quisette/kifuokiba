import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { connectEvents } from "./api";

connectEvents();
createApp(App).mount("#app");

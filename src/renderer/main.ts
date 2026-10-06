import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { connectEvents } from "./api";
import "./theme";

connectEvents();
createApp(App).mount("#app");

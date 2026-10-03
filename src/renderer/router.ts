import { reactive } from "vue";

export type Route = { name: string; params: string[]; query: URLSearchParams };

function parse(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { name: parts[0] ?? "home", params: parts.slice(1), query: new URLSearchParams(query ?? "") };
}

export const route = reactive<Route>(parse());

window.addEventListener("hashchange", () => {
  Object.assign(route, parse());
  window.scrollTo(0, 0);
});

export function go(path: string) {
  location.hash = "#/" + path.replace(/^\/+/, "");
}

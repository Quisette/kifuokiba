import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { lanAllowed } from "../src/server/lan.js";

const dir = mkdtempSync(path.join(tmpdir(), "kifu-lan-"));
let app: ReturnType<typeof createApp>;
let base = "";
const local = async (method: string, p: string, body?: unknown) =>
  (await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();

beforeAll(async () => {
  app = createApp({ dbPath: path.join(dir, "t.db"), autoBackup: false, lanHost: "127.0.0.1" });
  base = `http://127.0.0.1:${await app.listen()}`;
});
afterAll(async () => app.close());

it("lets only reviewing and practice writes through from the network", () => {
  expect(lanAllowed("GET", "/api/cards")).toBe(true);
  expect(lanAllowed("GET", "/")).toBe(true);
  expect(lanAllowed("POST", "/api/cards/3/rate")).toBe(true);
  expect(lanAllowed("POST", "/api/games/3/guess")).toBe(true);
  expect(lanAllowed("PUT", "/api/settings")).toBe(false);
  expect(lanAllowed("POST", "/api/engine/test")).toBe(false);
  expect(lanAllowed("POST", "/api/restore")).toBe(false);
  expect(lanAllowed("POST", "/api/import")).toBe(false);
  expect(lanAllowed("GET", "/api/lan")).toBe(false);
  expect(lanAllowed("GET", "/api/backup")).toBe(false);
  expect(lanAllowed("POST", "/")).toBe(false);
});

it("serves phones that bring the token, and nobody else", async () => {
  expect((await local("GET", "/api/lan")).running).toBe(false);
  const info = await local("PUT", "/api/lan", { enabled: true, port: 0 });
  expect(info.running).toBe(true);
  expect(info.port).toBeGreaterThan(0);
  const lan = `http://127.0.0.1:${info.port}`;
  const token = app.lan.config().token;
  expect(token.length).toBeGreaterThanOrEqual(20);

  expect((await fetch(lan + "/api/games")).status).toBe(401);
  expect((await fetch(lan + "/manifest.webmanifest")).status).not.toBe(401);
  expect((await fetch(lan + "/?token=nope", { redirect: "manual" })).status).toBe(401);

  // The link from the QR code sets a cookie and goes to the review page.
  const enter = await fetch(lan + `/?token=${token}`, { redirect: "manual" });
  expect(enter.status).toBe(302);
  expect(enter.headers.get("location")).toBe("/#/review");
  const cookie = enter.headers.get("set-cookie")!.split(";")[0];
  expect(enter.headers.get("set-cookie")).toMatch(/HttpOnly/);
  const phone = (method: string, p: string, body?: unknown) =>
    fetch(lan + p, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  expect((await phone("GET", "/api/games")).status).toBe(200);
  expect((await phone("GET", "/api/cards/due")).status).not.toBe(403);
  expect((await phone("PUT", "/api/settings", { engine: { path: "/bin/sh" } })).status).toBe(403);
  expect((await local("GET", "/api/settings")).engine.path).toBe("");
  expect((await phone("GET", "/api/lan")).status).toBe(403);
  expect((await phone("GET", "/api/backup")).status).toBe(403);

  // A new token locks out phones let in before.
  await local("POST", "/api/lan/token");
  expect((await phone("GET", "/api/games")).status).toBe(401);

  // Off means off.
  const off = await local("PUT", "/api/lan", { enabled: false });
  expect(off.running).toBe(false);
  await expect(fetch(lan + "/api/games")).rejects.toThrow();
  expect((await fetch(base + "/api/lan", { method: "PUT", body: JSON.stringify({ port: 70000 }), headers: { "Content-Type": "application/json" } })).status).toBe(400);
});

it("reports a port that is taken instead of failing", async () => {
  const busy = Number(new URL(base).port);
  const info = await local("PUT", "/api/lan", { enabled: true, port: busy });
  expect(info.running).toBe(false);
  expect(info.error).toMatch(/in use/);
  await local("PUT", "/api/lan", { enabled: false });
});

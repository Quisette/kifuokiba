// Phone access: a second listener on the local network so cards can be
// reviewed from a phone. It needs a token (handed over once in a link or QR
// code, then kept in a cookie) and only allows reading plus the writes that
// reviewing and practising need. Settings, engine paths, imports and
// restores stay on the computer itself, since the engine path is run as a program.
import http from "node:http";
import os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { Db } from "./db.js";

export type LanConfig = { enabled: boolean; port: number; token: string };
export type LanInfo = { enabled: boolean; running: boolean; port: number; urls: string[]; qrSvg: string; error: string };

const COOKIE = "kifu_lan";
const DEFAULT_PORT = 3211;

/** Writes allowed from the network: answering and rating cards, guessing moves, playing positions out, drilling studies. */
const WRITES: [string, RegExp][] = [
  ["POST", /^\/api\/cards\/\d+\/(answer|rate)$/],
  ["PATCH", /^\/api\/cards\/\d+$/],
  ["POST", /^\/api\/cards$/],
  ["POST", /^\/api\/games\/\d+\/guess$/],
  ["POST", /^\/api\/analyze-position$/],
  ["POST", /^\/api\/tsume\/\d+\/result$/],
  ["POST", /^\/api\/studies\/\d+\/drill$/],
];
/** Reads that stay local: the token itself and the whole-library backup. */
const LOCAL_READS = [/^\/api\/lan(\/|$)/, /^\/api\/backups?(\/|$)/];

export function lanAllowed(method: string, pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return method === "GET";
  if (method === "GET") return !LOCAL_READS.some((re) => re.test(pathname));
  return WRITES.some(([m, re]) => m === method && re.test(pathname));
}

/** IPv4 addresses of this computer on its networks, for the link shown in Settings. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};
const cookieToken = (req: http.IncomingMessage) => {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE) return v ?? "";
  }
  return "";
};

export class LanServer {
  private server: http.Server | null = null;
  private port = 0;
  private error = "";

  constructor(
    private readonly db: Db,
    private readonly handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    /** Interface to listen on; tests use 127.0.0.1. */
    private readonly host = "0.0.0.0",
  ) {}

  config(): LanConfig {
    const c = this.db.getSetting<Partial<LanConfig>>("lan", {});
    return { enabled: !!c.enabled, port: c.port ?? DEFAULT_PORT, token: c.token ?? "" };
  }

  /** Turn phone access on or off (or move it to another port). */
  async configure(patch: Partial<Pick<LanConfig, "enabled" | "port">>): Promise<LanInfo> {
    const c = { ...this.config(), ...patch };
    if (!c.token) c.token = randomBytes(18).toString("base64url");
    this.db.setSetting("lan", c);
    await this.stop();
    if (c.enabled) await this.start(c);
    return this.info();
  }

  /** A new token: phones that were let in have to scan the code again. */
  async rotateToken(): Promise<LanInfo> {
    this.db.setSetting("lan", { ...this.config(), token: randomBytes(18).toString("base64url") });
    return this.info();
  }

  async info(): Promise<LanInfo> {
    const c = this.config();
    const running = !!this.server;
    const urls = running ? lanAddresses().map((ip) => `http://${ip}:${this.port}/?token=${c.token}`) : [];
    const qrSvg = urls[0] ? await QRCode.toString(urls[0], { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : "";
    return { enabled: c.enabled, running, port: running ? this.port : c.port, urls, qrSvg, error: this.error };
  }

  async start(c = this.config()) {
    this.error = "";
    const server = http.createServer((req, res) => this.gate(req, res));
    await new Promise<void>((resolve) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        this.error = e.code === "EADDRINUSE" ? `Port ${c.port} is in use; pick another one.` : e.message;
        resolve();
      });
      server.listen(c.port, this.host, () => {
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : c.port;
        this.server = server;
        resolve();
      });
    });
  }

  async stop() {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private gate(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://lan");
    const { token } = this.config();
    const fromLink = url.searchParams.get("token");
    if (fromLink !== null) {
      if (!sameToken(fromLink, token)) return this.deny(res, 401);
      // Keep the token in a cookie and drop it from the address bar.
      res.writeHead(302, {
        "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        Location: "/#/review",
      });
      res.end();
      return;
    }
    // Home-screen icons and the manifest are fetched without cookies; they hold nothing private.
    const publicAsset = req.method === "GET" && /^\/(manifest\.webmanifest|icon-\d+\.png|favicon\.svg)$/.test(url.pathname);
    if (!publicAsset && !sameToken(cookieToken(req), token)) return this.deny(res, 401);
    if (!lanAllowed(req.method ?? "GET", url.pathname)) return this.deny(res, 403);
    this.handle(req, res);
  }

  private deny(res: http.ServerResponse, status: 401 | 403) {
    if (status === 403) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Only reviewing and practice work from a phone. Change this on the computer." }));
      return;
    }
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>棋譜帖</title>` +
        `<body style="font-family:sans-serif;padding:24px;background:#1b1712;color:#efe6d4"><h1>棋譜帖</h1>` +
        `<p>Open Settings → Phone access on your computer and scan the code, or open the link shown there.</p></body>`,
    );
  }
}

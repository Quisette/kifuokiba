import { Db } from "./db.js";

export type Page = { id: number; notebook: string; title: string; body: string; created_at: number; updated_at: number };

export class Pages {
  constructor(private readonly db: Db) {}

  list() {
    return this.db.all<Omit<Page, "body"> & { excerpt: string }>(
      "SELECT id, notebook, title, substr(body, 1, 160) excerpt, created_at, updated_at FROM pages ORDER BY notebook, updated_at DESC",
    );
  }

  get(id: number) {
    return this.db.get<Page>("SELECT * FROM pages WHERE id = ?", id);
  }

  create(p: { title: string; notebook?: string; body?: string }) {
    const now = Date.now();
    const r = this.db.run(
      "INSERT INTO pages (notebook, title, body, created_at, updated_at) VALUES (?,?,?,?,?)",
      p.notebook?.trim() || "Notes",
      p.title?.trim() || "Untitled",
      p.body ?? "",
      now,
      now,
    );
    return this.get(Number(r.lastInsertRowid));
  }

  update(id: number, p: { title?: string; notebook?: string; body?: string }) {
    const cur = this.get(id);
    if (!cur) throw new Error("page not found");
    this.db.run(
      "UPDATE pages SET title = ?, notebook = ?, body = ?, updated_at = ? WHERE id = ?",
      p.title ?? cur.title,
      p.notebook ?? cur.notebook,
      p.body ?? cur.body,
      Date.now(),
      id,
    );
    return this.get(id);
  }

  append(id: number, text: string) {
    const cur = this.get(id);
    if (!cur) throw new Error("page not found");
    const body = cur.body.replace(/\s+$/, "") + (cur.body.trim() ? "\n\n" : "") + text.trim() + "\n";
    return this.update(id, { body });
  }

  delete(id: number) {
    this.db.run("DELETE FROM pages WHERE id = ?", id);
  }
}

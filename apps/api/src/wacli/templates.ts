import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDb, openDatabaseAt } from '../db/index.js';

/** Long enough for "Running late, 10 min", short enough to scan in a list. */
export const TEMPLATE_NAME_MAX = 60;
/** WhatsApp's own limit on one message. */
export const TEMPLATE_BODY_MAX = 65_536;

export interface Template {
  id: string;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface TemplateInput {
  name: string;
  body: string;
}

interface TemplateRow {
  id: string;
  name: string;
  body: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

function fromRow(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * What a caller sent, as a template, or the reason it is not one.
 *
 * The name is trimmed because it is a label. The body is kept as written —
 * leading spaces and blank lines can be the point of a template — but one that
 * is only whitespace is refused, since the composer would refuse to send it.
 */
export function parseTemplateInput(raw: unknown): TemplateInput | string {
  const { name, body } = (raw ?? {}) as { name?: unknown; body?: unknown };
  if (typeof name !== 'string' || !name.trim()) return 'Field "name" is required.';
  if (typeof body !== 'string' || !body.trim()) return 'Field "body" is required.';
  if (name.trim().length > TEMPLATE_NAME_MAX) {
    return `Field "name" must be at most ${TEMPLATE_NAME_MAX} characters.`;
  }
  if (body.length > TEMPLATE_BODY_MAX) {
    return `Field "body" must be at most ${TEMPLATE_BODY_MAX} characters.`;
  }
  return { name: name.trim(), body };
}

/**
 * Quick-reply templates, kept on this machine.
 *
 * Unlike bookmarks and tags, a failure here is not swallowed: a template that
 * silently did not save is text the operator believes they kept, and finds
 * missing at the moment they reach for it. The route turns a throw into a 500
 * the UI shows.
 */
export class TemplateStore {
  /** Set only when a caller asked for its own file, so tests get one store per case. */
  private ownDb: DatabaseSync | null = null;

  constructor(customDbPath?: string) {
    this.ownDb = customDbPath ? openDatabaseAt(customDbPath) : null;
  }

  private db(): DatabaseSync {
    return this.ownDb ?? getDb();
  }

  /** Most recently used first, so the `/` picker opens on what gets reached for. */
  public list(): Template[] {
    const rows = this.db()
      .prepare(
        `SELECT id, name, body, created_at, updated_at, last_used_at
         FROM templates
         ORDER BY last_used_at IS NULL, last_used_at DESC, name COLLATE NOCASE, id`
      )
      .all() as unknown as TemplateRow[];
    return rows.map(fromRow);
  }

  public get(id: string): Template | null {
    const row = this.db()
      .prepare(
        'SELECT id, name, body, created_at, updated_at, last_used_at FROM templates WHERE id = ?'
      )
      .get(id) as TemplateRow | undefined;
    return row ? fromRow(row) : null;
  }

  public create(input: TemplateInput): Template {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db()
      .prepare(
        `INSERT INTO templates (id, name, body, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL)`
      )
      .run(id, input.name, input.body, now, now);
    return { id, ...input, createdAt: now, updatedAt: now, lastUsedAt: null };
  }

  /** The template as saved, or null when there is no such id. */
  public update(id: string, input: TemplateInput): Template | null {
    const result = this.db()
      .prepare('UPDATE templates SET name = ?, body = ?, updated_at = ? WHERE id = ?')
      .run(input.name, input.body, new Date().toISOString(), id);
    return Number(result.changes) > 0 ? this.get(id) : null;
  }

  public remove(id: string): boolean {
    const result = this.db().prepare('DELETE FROM templates WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  /** Moves a template to the top of the picker. False when there is no such id. */
  public markUsed(id: string): boolean {
    const result = this.db()
      .prepare('UPDATE templates SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    return Number(result.changes) > 0;
  }
}

export const templateStore = new TemplateStore();

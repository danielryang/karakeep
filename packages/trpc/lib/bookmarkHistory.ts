import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import { bookmarkHistory } from "@karakeep/db/schema";
import type { ZBookmarkHistorySource } from "@karakeep/shared/types/bookmarkHistory";

export interface BookmarkHistoryChange {
  field: string;
  refId?: string | null;
  oldValue: string | null;
  newValue: string | null;
}

export interface BookmarkHistoryActor {
  bookmarkId: string;
  // Null for system changes that have no acting user.
  userId: string | null;
  source: ZBookmarkHistorySource;
}

// Normalizes a column value to the string stored in history. Dates become ISO
// strings so they compare by value rather than by object identity.
export function toHistoryValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

// Returns one change per key in `after` whose value differs from `before`.
// Keys missing from `after` weren't part of the update and are ignored, which
// is what makes a no-op update produce no history.
export function diffBookmarkFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): BookmarkHistoryChange[] {
  const changes: BookmarkHistoryChange[] = [];
  for (const [field, next] of Object.entries(after)) {
    if (next === undefined) {
      continue;
    }
    const oldValue = toHistoryValue(before[field]);
    const newValue = toHistoryValue(next);
    if (oldValue !== newValue) {
      changes.push({ field, oldValue, newValue });
    }
  }
  return changes;
}

// Synchronous on purpose so it can run inside the existing better-sqlite3
// transactions and roll back together with the change it describes.
export function recordBookmarkHistory(
  db: DB | KarakeepDBTransaction,
  actor: BookmarkHistoryActor,
  changes: BookmarkHistoryChange[],
): void {
  if (changes.length === 0) {
    return;
  }
  // One timestamp for the whole batch so a single edit reads as one moment.
  const createdAt = new Date();
  db.insert(bookmarkHistory)
    .values(
      changes.map((c) => ({
        bookmarkId: actor.bookmarkId,
        userId: actor.userId,
        source: actor.source,
        field: c.field,
        refId: c.refId ?? null,
        oldValue: c.oldValue,
        newValue: c.newValue,
        createdAt,
      })),
    )
    .run();
}

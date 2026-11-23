import { inArray } from "drizzle-orm";

import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import { bookmarkTags } from "@karakeep/db/schema";
import { BOOKMARK_HISTORY_TAGS_FIELD } from "@karakeep/shared/types/bookmarkHistory";

import type { BookmarkHistoryActor } from "./bookmarkHistory";
import { recordBookmarkHistory } from "./bookmarkHistory";

// Records one history row per tag attached to or detached from a bookmark.
// Callers pass the tag ids whose tagsOnBookmarks rows were actually inserted or
// deleted, so no-op attaches/detaches never reach here. A tag that shows up in
// both lists was removed and put back in the same write (e.g. the AI worker
// replacing its own tags), so it didn't change and is skipped.
// Synchronous so it can run inside the caller's transaction.
export function recordTagHistory(
  db: DB | KarakeepDBTransaction,
  actor: BookmarkHistoryActor,
  {
    attachedTagIds,
    detachedTagIds,
  }: {
    attachedTagIds: string[];
    detachedTagIds: string[];
  },
): void {
  const attached = new Set(attachedTagIds);
  const detached = new Set(detachedTagIds);
  const netAttached = [...attached].filter((id) => !detached.has(id));
  const netDetached = [...detached].filter((id) => !attached.has(id));
  if (netAttached.length === 0 && netDetached.length === 0) {
    return;
  }

  // History stores the tag name as it was at the time of the change.
  const names = new Map(
    db
      .select({ id: bookmarkTags.id, name: bookmarkTags.name })
      .from(bookmarkTags)
      .where(inArray(bookmarkTags.id, [...netAttached, ...netDetached]))
      .all()
      .map((t) => [t.id, t.name]),
  );

  recordBookmarkHistory(db, actor, [
    ...netDetached.map((tagId) => ({
      field: BOOKMARK_HISTORY_TAGS_FIELD,
      refId: tagId,
      oldValue: names.get(tagId) ?? null,
      newValue: null,
    })),
    ...netAttached.map((tagId) => ({
      field: BOOKMARK_HISTORY_TAGS_FIELD,
      refId: tagId,
      oldValue: null,
      newValue: names.get(tagId) ?? null,
    })),
  ]);
}

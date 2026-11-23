import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { bookmarkHistory, bookmarks } from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { APICallerType, CustomTestContext, TestDB } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

async function createBookmark(api: APICallerType) {
  const bookmark = await api.bookmarks.createBookmark({
    type: BookmarkTypes.TEXT,
    text: "hello",
  });
  return bookmark.id;
}

async function tagHistory(db: TestDB, bookmarkId: string) {
  const rows = await db
    .select()
    .from(bookmarkHistory)
    .where(eq(bookmarkHistory.bookmarkId, bookmarkId))
    .orderBy(asc(bookmarkHistory.createdAt));
  return rows.filter((r) => r.field === "tags");
}

// Sort so assertions don't depend on insertion order within a single call.
function summarize(rows: Awaited<ReturnType<typeof tagHistory>>) {
  return rows
    .map((r) => ({ oldValue: r.oldValue, newValue: r.newValue }))
    .sort((a, b) =>
      (a.oldValue ?? a.newValue ?? "").localeCompare(
        b.oldValue ?? b.newValue ?? "",
      ),
    );
}

describe("bookmark history: tags", () => {
  test<CustomTestContext>("attaching by name creates rows with tag names", async ({
    apiCallers,
    db,
  }) => {
    const bookmarkId = await createBookmark(apiCallers[0]);
    const owner = await db.query.bookmarks.findFirst({
      where: eq(bookmarks.id, bookmarkId),
    });

    await apiCallers[0].bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagName: "alpha" }, { tagName: "beta" }],
      detach: [],
    });

    const rows = await tagHistory(db, bookmarkId);
    expect(summarize(rows)).toEqual([
      { oldValue: null, newValue: "alpha" },
      { oldValue: null, newValue: "beta" },
    ]);
    const tags = (await apiCallers[0].bookmarks.getBookmark({ bookmarkId }))
      .tags;
    for (const row of rows) {
      expect(row.source).toBe("user");
      expect(row.userId).toBe(owner!.userId);
      expect(row.refId).toBe(tags.find((t) => t.name === row.newValue)!.id);
    }
  });

  test<CustomTestContext>("attaching by id records the tag name", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const { id: tagId } = await api.tags.create({ name: "existing" });
    const bookmarkId = await createBookmark(api);

    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagId }],
      detach: [],
    });

    const rows = await tagHistory(db, bookmarkId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      refId: tagId,
      oldValue: null,
      newValue: "existing",
      source: "user",
    });
  });

  test<CustomTestContext>("detaching creates a row", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmarkId = await createBookmark(api);
    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagName: "gone" }],
      detach: [],
    });
    const tagId = (await api.bookmarks.getBookmark({ bookmarkId })).tags[0].id;

    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [],
      detach: [{ tagId }],
    });

    const rows = await tagHistory(db, bookmarkId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.newValue === null)).toMatchObject({
      refId: tagId,
      oldValue: "gone",
      newValue: null,
      source: "user",
    });
  });

  test<CustomTestContext>("no-op attach and detach record nothing", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const { id: unattachedTagId } = await api.tags.create({ name: "other" });
    const bookmarkId = await createBookmark(api);
    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagName: "kept" }],
      detach: [],
    });
    expect(await tagHistory(db, bookmarkId)).toHaveLength(1);

    // Re-attach an attached tag and detach one that was never attached.
    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagName: "kept" }],
      detach: [{ tagId: unattachedTagId }],
    });

    expect(await tagHistory(db, bookmarkId)).toHaveLength(1);
  });

  test<CustomTestContext>("mixed attach and detach in one call", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmarkId = await createBookmark(api);
    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagName: "one" }, { tagName: "two" }],
      detach: [],
    });
    const before = await tagHistory(db, bookmarkId);

    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagName: "three" }, { tagName: "two" }],
      detach: [{ tagName: "one" }],
    });

    const rows = (await tagHistory(db, bookmarkId)).filter(
      (r) => !before.some((b) => b.id === r.id),
    );
    expect(summarize(rows)).toEqual([
      { oldValue: "one", newValue: null },
      { oldValue: null, newValue: "three" },
    ]);
    // One edit, one timestamp.
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(1);
  });
});

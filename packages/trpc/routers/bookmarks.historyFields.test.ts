import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { bookmarkHistory } from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

describe("Bookmark history: field edits via updateBookmark", () => {
  async function historyFor(db: CustomTestContext["db"], bookmarkId: string) {
    return db
      .select()
      .from(bookmarkHistory)
      .where(eq(bookmarkHistory.bookmarkId, bookmarkId))
      .orderBy(asc(bookmarkHistory.field));
  }

  async function createLink(
    api: CustomTestContext["apiCallers"][number]["bookmarks"],
  ) {
    return api.createBookmark({
      type: BookmarkTypes.LINK,
      url: "https://example.com/original",
    });
  }

  test<CustomTestContext>("title change records one row with old/new and actor", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await createLink(api);
    await api.updateBookmark({ bookmarkId: bookmark.id, title: "First" });
    await api.updateBookmark({ bookmarkId: bookmark.id, title: "Second" });

    const rows = await historyFor(db, bookmark.id);
    expect(rows).toHaveLength(2);
    const userId = (await apiCallers[0].users.whoami()).id;
    expect(rows.map((r) => [r.oldValue, r.newValue])).toEqual(
      expect.arrayContaining([
        [null, "First"],
        ["First", "Second"],
      ]),
    );
    for (const row of rows) {
      expect(row.field).toBe("title");
      expect(row.userId).toBe(userId);
      expect(row.source).toBe("user");
      expect(row.refId).toBeNull();
    }
  });

  test<CustomTestContext>("several fields in one update record one row each", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await createLink(api);
    await api.updateBookmark({
      bookmarkId: bookmark.id,
      title: "New title",
      archived: true,
      favourited: true,
      note: "a note",
    });

    const rows = await historyFor(db, bookmark.id);
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
      ["archived", "false", "true"],
      ["favourited", "false", "true"],
      ["note", null, "a note"],
      ["title", null, "New title"],
    ]);
    // modifiedAt changes on every update but is never recorded.
    expect(rows.some((r) => r.field === "modifiedAt")).toBe(false);
  });

  test<CustomTestContext>("no-op updates record nothing", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await createLink(api);
    await api.updateBookmark({ bookmarkId: bookmark.id });
    await api.updateBookmark({
      bookmarkId: bookmark.id,
      archived: false,
      favourited: false,
      url: "https://example.com/original",
    });

    expect(await historyFor(db, bookmark.id)).toHaveLength(0);
  });

  test<CustomTestContext>("link field changes are recorded", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await createLink(api);
    await api.updateBookmark({
      bookmarkId: bookmark.id,
      url: "https://example.com/updated",
      description: "desc",
    });

    const rows = await historyFor(db, bookmark.id);
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
      ["description", null, "desc"],
      ["url", "https://example.com/original", "https://example.com/updated"],
    ]);
  });

  test<CustomTestContext>("text bookmark text change is recorded", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await api.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "before",
    });
    await api.updateBookmark({ bookmarkId: bookmark.id, text: "after" });

    const rows = await historyFor(db, bookmark.id);
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
      ["text", "before", "after"],
    ]);
  });

  test<CustomTestContext>("deprecated updateBookmarkText is recorded too", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await api.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "before",
    });
    await api.updateBookmarkText({ bookmarkId: bookmark.id, text: "after" });
    await api.updateBookmarkText({ bookmarkId: bookmark.id, text: "after" });

    const rows = await historyFor(db, bookmark.id);
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
      ["text", "before", "after"],
    ]);
  });

  test<CustomTestContext>("failed update records nothing", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await api.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "hello",
    });
    // The title is valid on its own, but the link field makes the whole
    // update fail, so neither change should be recorded.
    await expect(
      api.updateBookmark({
        bookmarkId: bookmark.id,
        title: "should roll back",
        description: "not a link",
      }),
    ).rejects.toThrow(/non-link type bookmark/);

    expect(await historyFor(db, bookmark.id)).toHaveLength(0);
  });
});

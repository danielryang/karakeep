import { asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import {
  bookmarkHistory,
  bookmarks,
  bookmarkTags,
  tagsOnBookmarks,
} from "@karakeep/db/schema";
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

  test<CustomTestContext>("attaching by name reuses an existing tag", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const { id: tagId } = await api.tags.create({ name: "existing" });
    const bookmarkId = await createBookmark(api);

    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagName: "existing" }],
      detach: [],
    });

    const rows = await tagHistory(db, bookmarkId);
    expect(rows).toEqual([
      expect.objectContaining({ refId: tagId, newValue: "existing" }),
    ]);
    expect(await db.select().from(bookmarkTags)).toHaveLength(1);
  });

  test<CustomTestContext>("several attaches and detaches get one row each", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmarkId = await createBookmark(api);
    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagName: "a" }, { tagName: "b" }, { tagName: "c" }],
      detach: [],
    });
    const before = await tagHistory(db, bookmarkId);
    const tagA = (await api.bookmarks.getBookmark({ bookmarkId })).tags.find(
      (t) => t.name === "a",
    )!;

    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagName: "d" }, { tagName: "e" }],
      detach: [{ tagId: tagA.id }, { tagName: "b" }],
    });

    const rows = (await tagHistory(db, bookmarkId)).filter(
      (r) => !before.some((b) => b.id === r.id),
    );
    expect(summarize(rows)).toEqual([
      { oldValue: "a", newValue: null },
      { oldValue: "b", newValue: null },
      { oldValue: null, newValue: "d" },
      { oldValue: null, newValue: "e" },
    ]);
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(1);
  });

  // updateTags detaches before attaching, so a tag in both lists ends up
  // attached; history must agree with that final state.
  test<CustomTestContext>("a tag in both attach and detach matches the final state", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmarkId = await createBookmark(api);
    const { id: kept } = await api.tags.create({ name: "kept" });
    const { id: fresh } = await api.tags.create({ name: "fresh" });
    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagId: kept }],
      detach: [],
    });

    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagId: kept }, { tagId: fresh }],
      detach: [{ tagId: kept }, { tagId: fresh }],
    });

    const tags = (await api.bookmarks.getBookmark({ bookmarkId })).tags;
    expect(tags.map((t) => t.name).sort()).toEqual(["fresh", "kept"]);
    // "kept" was attached throughout; "fresh" was newly attached.
    expect(summarize(await tagHistory(db, bookmarkId))).toEqual([
      { oldValue: null, newValue: "fresh" },
      { oldValue: null, newValue: "kept" },
    ]);
  });

  test<CustomTestContext>("empty attach and detach record nothing", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmarkId = await createBookmark(api);

    const res = await api.bookmarks.updateTags({
      bookmarkId,
      attach: [],
      detach: [],
    });

    expect(res).toEqual({ attached: [], detached: [] });
    expect(await tagHistory(db, bookmarkId)).toEqual([]);
  });

  test<CustomTestContext>("returns requested ids, including no-ops", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const bookmarkId = await createBookmark(api);
    const { id: attachedId } = await api.tags.create({ name: "attached" });
    const { id: neverId } = await api.tags.create({ name: "never" });
    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagId: attachedId }],
      detach: [],
    });

    const res = await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagId: attachedId }],
      detach: [{ tagId: neverId }],
    });

    expect(res).toEqual({ attached: [attachedId], detached: [neverId] });
  });

  test<CustomTestContext>("rows keep the tag name after rename and delete", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmarkId = await createBookmark(api);
    const { id: tagId } = await api.tags.create({ name: "original" });
    await api.bookmarks.updateTags({
      bookmarkId,
      attach: [{ tagId }],
      detach: [],
    });

    await api.tags.update({ tagId, name: "renamed" });
    expect(await tagHistory(db, bookmarkId)).toEqual([
      expect.objectContaining({ refId: tagId, newValue: "original" }),
    ]);

    await api.tags.delete({ tagId });
    expect(await tagHistory(db, bookmarkId)).toEqual([
      expect.objectContaining({ refId: tagId, newValue: "original" }),
    ]);
  });

  test<CustomTestContext>("history and tag write roll back together", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmarkId = await createBookmark(api);
    db.run(
      sql`CREATE TRIGGER fail_history BEFORE INSERT ON bookmarkHistory BEGIN SELECT RAISE(ABORT, 'history failed'); END`,
    );

    await expect(
      api.bookmarks.updateTags({
        bookmarkId,
        attach: [{ tagName: "doomed" }],
        detach: [],
      }),
    ).rejects.toThrow("history failed");

    expect(
      await db
        .select()
        .from(tagsOnBookmarks)
        .where(eq(tagsOnBookmarks.bookmarkId, bookmarkId)),
    ).toEqual([]);
  });

  describe("authorization", () => {
    async function attachedTagIds(db: TestDB, bookmarkId: string) {
      return (
        await db
          .select()
          .from(tagsOnBookmarks)
          .where(eq(tagsOnBookmarks.bookmarkId, bookmarkId))
      ).map((t) => t.tagId);
    }

    test<CustomTestContext>("another user can't update tags", async ({
      apiCallers,
      db,
    }) => {
      const bookmarkId = await createBookmark(apiCallers[0]);
      const { id: tagId } = await apiCallers[1].tags.create({ name: "theirs" });

      await expect(
        apiCallers[1].bookmarks.updateTags({
          bookmarkId,
          attach: [{ tagId }, { tagName: "intruder" }],
          detach: [],
        }),
      ).rejects.toThrow("Bookmark not found");

      expect(await attachedTagIds(db, bookmarkId)).toEqual([]);
      expect(await tagHistory(db, bookmarkId)).toEqual([]);
    });

    for (const role of ["viewer", "editor"] as const) {
      test<CustomTestContext>(`a list ${role} can't update tags`, async ({
        apiCallers,
        db,
      }) => {
        const [owner, collaborator] = apiCallers;
        const bookmarkId = await createBookmark(owner);
        await owner.bookmarks.updateTags({
          bookmarkId,
          attach: [{ tagName: "owned" }],
          detach: [],
        });
        const ownedTagId = (await attachedTagIds(db, bookmarkId))[0];
        const list = await owner.lists.create({
          name: "Shared",
          icon: "📚",
          type: "manual",
        });
        await owner.lists.addToList({ listId: list.id, bookmarkId });
        const { invitationId } = await owner.lists.addCollaborator({
          listId: list.id,
          email: (await collaborator.users.whoami()).email!,
          role,
        });
        await collaborator.lists.acceptInvitation({ invitationId });
        // The collaborator can see the bookmark, just not change its tags.
        await collaborator.bookmarks.getBookmark({ bookmarkId });

        await expect(
          collaborator.bookmarks.updateTags({
            bookmarkId,
            attach: [{ tagName: "collab" }],
            detach: [{ tagId: ownedTagId }],
          }),
        ).rejects.toThrow("User is not allowed to access resource");

        expect(await attachedTagIds(db, bookmarkId)).toEqual([ownedTagId]);
        expect(await tagHistory(db, bookmarkId)).toHaveLength(1);
      });
    }
  });
});

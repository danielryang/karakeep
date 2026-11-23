import { and, asc, eq, notInArray } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import {
  bookmarkAssets,
  bookmarkHistory,
  bookmarks,
} from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { APICallerType, CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

type DB = CustomTestContext["db"];
type BookmarksApi = APICallerType["bookmarks"];

// Field edits only: test setup (e.g. adding to a shared list) can write tag or
// list history once those are captured, and that isn't what these tests check.
async function historyFor(db: DB, bookmarkId: string) {
  return db
    .select()
    .from(bookmarkHistory)
    .where(
      and(
        eq(bookmarkHistory.bookmarkId, bookmarkId),
        notInArray(bookmarkHistory.field, ["tags", "lists"]),
      ),
    )
    .orderBy(asc(bookmarkHistory.field));
}

async function changesFor(db: DB, bookmarkId: string) {
  return (await historyFor(db, bookmarkId)).map((r) => [
    r.field,
    r.oldValue,
    r.newValue,
  ]);
}

async function createLink(
  api: BookmarksApi,
  url = "https://example.com/original",
) {
  return api.createBookmark({ type: BookmarkTypes.LINK, url });
}

async function createText(api: BookmarksApi, text = "before") {
  return api.createBookmark({ type: BookmarkTypes.TEXT, text });
}

// Asset bookmarks in `createBookmark` require a pre-uploaded asset, so this
// inserts the rows directly, as bookmarks.test.ts does.
async function createAsset(
  db: DB,
  api: APICallerType,
  content: string | null = "extracted",
) {
  const userId = (await api.users.whoami()).id;
  const [created] = await db
    .insert(bookmarks)
    .values({ userId, type: BookmarkTypes.ASSET })
    .returning();
  await db.insert(bookmarkAssets).values({
    id: created.id,
    assetId: `asset-${created.id}`,
    assetType: "pdf",
    fileName: "paper.pdf",
    content,
  });
  return created;
}

async function addAndAcceptCollaborator(
  ownerApi: APICallerType,
  collaboratorApi: APICallerType,
  listId: string,
  role: "viewer" | "editor",
) {
  const { email } = await collaboratorApi.users.whoami();
  const { invitationId } = await ownerApi.lists.addCollaborator({
    listId,
    email: email!,
    role,
  });
  await collaboratorApi.lists.acceptInvitation({ invitationId });
}

describe("Bookmark history: field edits via updateBookmark", () => {
  describe("each recordable field", () => {
    const scalarCases: [string, string | boolean, string | null, string][] = [
      ["title", "New title", null, "New title"],
      ["archived", true, "false", "true"],
      ["favourited", true, "false", "true"],
      ["note", "a note", null, "a note"],
      ["summary", "a summary", null, "a summary"],
      ["description", "desc", null, "desc"],
      ["author", "Jane", null, "Jane"],
      ["publisher", "Press", null, "Press"],
      [
        "url",
        "https://example.com/updated",
        "https://example.com/original",
        "https://example.com/updated",
      ],
    ];
    for (const [field, value, oldValue, newValue] of scalarCases) {
      test<CustomTestContext>(`${field} is recorded with exact old/new values`, async ({
        apiCallers,
        db,
      }) => {
        const api = apiCallers[0].bookmarks;
        const bookmark = await createLink(api);
        await api.updateBookmark({ bookmarkId: bookmark.id, [field]: value });

        expect(await changesFor(db, bookmark.id)).toEqual([
          [field, oldValue, newValue],
        ]);
      });
    }

    for (const field of ["createdAt", "datePublished", "dateModified"]) {
      test<CustomTestContext>(`${field} is recorded as an ISO string`, async ({
        apiCallers,
        db,
      }) => {
        const api = apiCallers[0].bookmarks;
        const bookmark = await createLink(api);
        const original =
          field === "createdAt" ? new Date(bookmark.createdAt) : null;
        const date = new Date("2024-03-04T05:06:07.000Z");
        await api.updateBookmark({ bookmarkId: bookmark.id, [field]: date });

        expect(await changesFor(db, bookmark.id)).toEqual([
          [field, original?.toISOString() ?? null, date.toISOString()],
        ]);
      });
    }

    test<CustomTestContext>("text on a text bookmark", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createText(api, "before");
      await api.updateBookmark({ bookmarkId: bookmark.id, text: "after" });

      expect(await changesFor(db, bookmark.id)).toEqual([
        ["text", "before", "after"],
      ]);
    });

    test<CustomTestContext>("assetContent on an asset bookmark", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await createAsset(db, apiCallers[0], "extracted");
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        assetContent: "corrected",
      });
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        assetContent: null,
      });

      const rows = await historyFor(db, bookmark.id);
      expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual(
        expect.arrayContaining([
          ["assetContent", "extracted", "corrected"],
          ["assetContent", "corrected", null],
        ]),
      );
      expect(rows).toHaveLength(2);
    });

    test<CustomTestContext>("assetContent set from null", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await createAsset(db, apiCallers[0], null);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        assetContent: "first extraction",
      });

      expect(await changesFor(db, bookmark.id)).toEqual([
        ["assetContent", null, "first extraction"],
      ]);
    });
  });

  test<CustomTestContext>("values set, changed, then cleared to null", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await createLink(api);
    await api.updateBookmark({
      bookmarkId: bookmark.id,
      title: "t1",
      description: "d1",
      author: "a1",
    });
    await api.updateBookmark({
      bookmarkId: bookmark.id,
      title: "t2",
      description: "d2",
      author: "a2",
    });
    await api.updateBookmark({
      bookmarkId: bookmark.id,
      title: null,
      description: null,
      author: null,
    });

    const rows = await historyFor(db, bookmark.id);
    expect(rows).toHaveLength(9);
    for (const field of ["title", "description", "author"]) {
      const prefix = field[0];
      expect(
        rows
          .filter((r) => r.field === field)
          .map((r) => [r.oldValue, r.newValue]),
      ).toEqual(
        expect.arrayContaining([
          [null, `${prefix}1`],
          [`${prefix}1`, `${prefix}2`],
          [`${prefix}2`, null],
        ]),
      );
    }
  });

  test<CustomTestContext>("several fields in one call share one createdAt and actor", async ({
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
      summary: "sum",
      url: "https://example.com/updated",
      description: "desc",
      publisher: "Press",
    });

    const rows = await historyFor(db, bookmark.id);
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
      ["archived", "false", "true"],
      ["description", null, "desc"],
      ["favourited", "false", "true"],
      ["note", null, "a note"],
      ["publisher", null, "Press"],
      ["summary", null, "sum"],
      ["title", null, "New title"],
      ["url", "https://example.com/original", "https://example.com/updated"],
    ]);
    const userId = (await apiCallers[0].users.whoami()).id;
    const createdAt = rows[0].createdAt.getTime();
    for (const row of rows) {
      expect(row.userId).toBe(userId);
      expect(row.source).toBe("user");
      expect(row.refId).toBeNull();
      expect(row.createdAt.getTime()).toBe(createdAt);
    }
    // modifiedAt changes on every update but is never recorded.
    expect(rows.some((r) => r.field === "modifiedAt")).toBe(false);
  });

  test<CustomTestContext>("sequential edits accumulate, each old value being the previous new one", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await createLink(api);
    for (const title of ["one", "two", "three"]) {
      await api.updateBookmark({ bookmarkId: bookmark.id, title });
    }
    await api.updateBookmark({ bookmarkId: bookmark.id, archived: true });
    await api.updateBookmark({ bookmarkId: bookmark.id, archived: false });

    const rows = await historyFor(db, bookmark.id);
    expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual(
      expect.arrayContaining([
        ["title", null, "one"],
        ["title", "one", "two"],
        ["title", "two", "three"],
        ["archived", "false", "true"],
        ["archived", "true", "false"],
      ]),
    );
    expect(rows).toHaveLength(5);
  });

  describe("no-op updates record nothing", () => {
    test<CustomTestContext>("only bookmarkId", async ({ apiCallers, db }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createLink(api);
      await api.updateBookmark({ bookmarkId: bookmark.id });
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("same values re-sent", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createLink(api);
      const edit = {
        bookmarkId: bookmark.id,
        title: "t",
        note: "n",
        summary: "s",
        description: "d",
        author: "a",
        publisher: "p",
      };
      await api.updateBookmark(edit);
      const recorded = (await historyFor(db, bookmark.id)).length;
      await api.updateBookmark(edit);
      await api.updateBookmark({
        bookmarkId: bookmark.id,
        archived: false,
        favourited: false,
        url: "https://example.com/original",
      });

      expect(await historyFor(db, bookmark.id)).toHaveLength(recorded);
    });

    test<CustomTestContext>("clearing an already-null value", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createLink(api);
      await api.updateBookmark({
        bookmarkId: bookmark.id,
        title: null,
        description: null,
        datePublished: null,
      });
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("same dates re-sent", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createLink(api);
      const date = new Date("2024-03-04T05:06:07.000Z");
      await api.updateBookmark({
        bookmarkId: bookmark.id,
        datePublished: date,
        dateModified: date,
      });
      await api.updateBookmark({
        bookmarkId: bookmark.id,
        datePublished: new Date(date),
        dateModified: new Date(date),
        createdAt: new Date(bookmark.createdAt),
      });
      expect(await historyFor(db, bookmark.id)).toHaveLength(2);
    });

    test<CustomTestContext>("dates differing only below stored second precision", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createLink(api);
      // Dates are stored with second precision, so the milliseconds never
      // reach the row and shouldn't show up in history either.
      await api.updateBookmark({
        bookmarkId: bookmark.id,
        datePublished: new Date("2024-03-04T05:06:07.123Z"),
      });
      await api.updateBookmark({
        bookmarkId: bookmark.id,
        datePublished: new Date("2024-03-04T05:06:07.456Z"),
        createdAt: new Date(new Date(bookmark.createdAt).getTime() + 999),
      });
      expect(await changesFor(db, bookmark.id)).toEqual([
        ["datePublished", null, "2024-03-04T05:06:07.000Z"],
      ]);
    });

    test<CustomTestContext>("url differing only by surrounding whitespace", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createLink(api);
      await api.updateBookmark({
        bookmarkId: bookmark.id,
        url: "  https://example.com/original  ",
      });
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("re-saving the same text", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createText(api, "same");
      await api.updateBookmark({ bookmarkId: bookmark.id, text: "same" });
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("re-saving the same asset content", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await createAsset(db, apiCallers[0], "same");
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        assetContent: "same",
      });
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });
  });

  describe("failed updates roll back history", () => {
    test<CustomTestContext>("link fields on a text bookmark", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createText(api, "hello");
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
      expect((await api.getBookmark({ bookmarkId: bookmark.id })).title).toBe(
        null,
      );
    });

    test<CustomTestContext>("text on a link bookmark", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createLink(api);
      await expect(
        api.updateBookmark({
          bookmarkId: bookmark.id,
          title: "should roll back",
          text: "not a text bookmark",
        }),
      ).rejects.toThrow(/non-text type bookmark/);
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("assetContent on a non-asset bookmark", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createLink(api);
      await expect(
        api.updateBookmark({
          bookmarkId: bookmark.id,
          title: "should roll back",
          url: "https://example.com/also-rolled-back",
          assetContent: "not an asset",
        }),
      ).rejects.toThrow(/non-asset type bookmark/);
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });
  });

  describe("authorization", () => {
    test<CustomTestContext>("another user can't edit, and nothing is recorded", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await createLink(apiCallers[0].bookmarks);
      await expect(
        apiCallers[1].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          title: "hijacked",
        }),
      ).rejects.toThrow();
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("list collaborators (viewer and editor) can't edit", async ({
      apiCallers,
      db,
    }) => {
      const [owner, viewer, editor] = apiCallers;
      const bookmark = await createLink(owner.bookmarks);
      const list = await owner.lists.create({
        name: "Shared",
        icon: "📚",
        type: "manual",
      });
      await owner.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });
      await addAndAcceptCollaborator(owner, viewer, list.id, "viewer");
      await addAndAcceptCollaborator(owner, editor, list.id, "editor");

      for (const collaborator of [viewer, editor]) {
        // They can see it, so the rejection is about ownership, not access.
        await collaborator.bookmarks.getBookmark({ bookmarkId: bookmark.id });
        await expect(
          collaborator.bookmarks.updateBookmark({
            bookmarkId: bookmark.id,
            title: "collaborator edit",
          }),
        ).rejects.toThrow();
      }
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });
  });

  describe("deprecated updateBookmarkText", () => {
    test<CustomTestContext>("records changes and skips same-text saves", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createText(api, "before");
      await api.updateBookmarkText({ bookmarkId: bookmark.id, text: "after" });
      await api.updateBookmarkText({ bookmarkId: bookmark.id, text: "after" });

      const rows = await historyFor(db, bookmark.id);
      expect(rows.map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
        ["text", "before", "after"],
      ]);
      expect(rows[0].userId).toBe((await apiCallers[0].users.whoami()).id);
      expect(rows[0].source).toBe("user");
    });

    test<CustomTestContext>("non-owner is rejected and nothing is recorded", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await createText(apiCallers[0].bookmarks, "before");
      await expect(
        apiCallers[1].bookmarks.updateBookmarkText({
          bookmarkId: bookmark.id,
          text: "hijacked",
        }),
      ).rejects.toThrow();
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("non-text bookmark fails and records nothing", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0].bookmarks;
      const bookmark = await createLink(api);
      await expect(
        api.updateBookmarkText({ bookmarkId: bookmark.id, text: "nope" }),
      ).rejects.toThrow(/not found/i);
      expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    });
  });

  test<CustomTestContext>("history is deleted with the bookmark", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await createLink(api);
    const other = await createLink(api, "https://example.com/other");
    await api.updateBookmark({ bookmarkId: bookmark.id, title: "t" });
    await api.updateBookmark({ bookmarkId: other.id, title: "kept" });
    expect(await historyFor(db, bookmark.id)).toHaveLength(1);

    await api.deleteBookmark({ bookmarkId: bookmark.id });

    expect(await historyFor(db, bookmark.id)).toHaveLength(0);
    expect(await historyFor(db, other.id)).toHaveLength(1);
  });

  test<CustomTestContext>("returned bookmark matches a fresh read", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await createLink(api);
    const updated = await api.updateBookmark({
      bookmarkId: bookmark.id,
      title: "New title",
      favourited: true,
      description: "desc",
    });

    expect(updated.title).toBe("New title");
    expect(updated.favourited).toBe(true);
    expect(updated.content).toMatchObject({
      type: BookmarkTypes.LINK,
      description: "desc",
    });
    expect(updated).toEqual(
      await api.getBookmark({ bookmarkId: bookmark.id, includeContent: false }),
    );
  });
});

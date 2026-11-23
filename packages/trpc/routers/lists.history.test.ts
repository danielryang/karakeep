import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { bookmarkHistory, bookmarksInLists } from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { APICallerType, CustomTestContext, TestDB } from "../testUtils";
import { recordBookmarkHistory } from "../lib/bookmarkHistory";
import { RuleEngine } from "../lib/ruleEngine";
import { defaultBeforeEach } from "../testUtils";

// Wrap the real helper so a test can make a single history write fail.
vi.mock("../lib/bookmarkHistory", async (original) => {
  const mod = (await original()) as typeof import("../lib/bookmarkHistory");
  return { ...mod, recordBookmarkHistory: vi.fn(mod.recordBookmarkHistory) };
});

// Stub the queues bookmark deletion and rule events enqueue to; without this
// they hit the real liteque tables, which the in-memory test DB lacks.
vi.mock("@karakeep/shared-server", async (original) => {
  const mod = (await original()) as typeof import("@karakeep/shared-server");
  return {
    ...mod,
    SearchIndexingQueue: { enqueue: vi.fn() },
    EmbeddingsQueue: { enqueue: vi.fn() },
    RuleEngineQueue: { enqueue: vi.fn() },
    triggerSearchReindex: vi.fn(),
  };
});

beforeEach<CustomTestContext>(defaultBeforeEach(true));

function listHistory(db: TestDB, bookmarkId: string) {
  return db
    .select()
    .from(bookmarkHistory)
    .where(eq(bookmarkHistory.bookmarkId, bookmarkId))
    .orderBy(asc(bookmarkHistory.createdAt))
    .all()
    .filter((r) => r.field === "lists");
}

function isInList(db: TestDB, listId: string, bookmarkId: string) {
  return (
    db
      .select()
      .from(bookmarksInLists)
      .where(
        and(
          eq(bookmarksInLists.listId, listId),
          eq(bookmarksInLists.bookmarkId, bookmarkId),
        ),
      )
      .all().length > 0
  );
}

async function createBookmark(api: APICallerType) {
  return api.bookmarks.createBookmark({
    type: BookmarkTypes.TEXT,
    text: "hello",
  });
}

async function createList(api: APICallerType, name: string) {
  return api.lists.create({ name, icon: "📚", type: "manual" });
}

async function addAndAcceptCollaborator(
  ownerApi: APICallerType,
  collaboratorApi: APICallerType,
  listId: string,
  role: "viewer" | "editor",
) {
  const collaborator = await collaboratorApi.users.whoami();
  const { invitationId } = await ownerApi.lists.addCollaborator({
    listId,
    email: collaborator.email!,
    role,
  });
  await collaboratorApi.lists.acceptInvitation({ invitationId });
}

async function ruleEngineFor(db: TestDB, userId: string, bookmarkId: string) {
  return (await RuleEngine.forBookmark(
    { user: { id: userId, role: "user" }, db, req: { ip: null } },
    bookmarkId,
  ))!;
}

describe("List membership history", () => {
  test<CustomTestContext>("records the owner adding a bookmark", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Reading");

    await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });

    const rows = listHistory(db, bookmark.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: "lists",
      refId: list.id,
      oldValue: null,
      newValue: "Reading",
      source: "user",
      userId: owner.id,
    });
  });

  test<CustomTestContext>("doesn't record a duplicate add", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Reading");

    await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });
    await expect(
      api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id }),
    ).resolves.toBeUndefined();

    expect(listHistory(db, bookmark.id)).toHaveLength(1);
    expect(isInList(db, list.id, bookmark.id)).toBe(true);
  });

  test<CustomTestContext>("records the owner removing a bookmark", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Reading");

    await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });
    await api.lists.removeFromList({
      listId: list.id,
      bookmarkId: bookmark.id,
    });

    const rows = listHistory(db, bookmark.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      refId: list.id,
      oldValue: "Reading",
      newValue: null,
      source: "user",
      userId: owner.id,
    });
  });

  test<CustomTestContext>("records add, remove, add again in order", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Reading");
    const input = { listId: list.id, bookmarkId: bookmark.id };

    await api.lists.addToList(input);
    await api.lists.removeFromList(input);
    await api.lists.addToList(input);

    expect(
      listHistory(db, bookmark.id).map((r) => [r.oldValue, r.newValue]),
    ).toEqual([
      [null, "Reading"],
      ["Reading", null],
      [null, "Reading"],
    ]);
  });

  test<CustomTestContext>("doesn't record removing a bookmark that isn't in the list", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Reading");

    await expect(
      api.lists.removeFromList({ listId: list.id, bookmarkId: bookmark.id }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/already not in list/),
    });

    expect(listHistory(db, bookmark.id)).toHaveLength(0);
  });

  test<CustomTestContext>("keeps each list's rows separate and named after that list", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const listA = await createList(api, "List A");
    const listB = await createList(api, "List B");

    await api.lists.addToList({ listId: listA.id, bookmarkId: bookmark.id });
    let rows = listHistory(db, bookmark.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refId: listA.id, newValue: "List A" });

    await api.lists.addToList({ listId: listB.id, bookmarkId: bookmark.id });
    await api.lists.removeFromList({
      listId: listA.id,
      bookmarkId: bookmark.id,
    });
    rows = listHistory(db, bookmark.id);
    expect(rows.map((r) => [r.refId, r.oldValue, r.newValue])).toEqual([
      [listA.id, null, "List A"],
      [listB.id, null, "List B"],
      [listA.id, "List A", null],
    ]);
  });

  test<CustomTestContext>("keeps the list name as it was when the change happened", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Old name");

    await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });
    await api.lists.edit({ listId: list.id, name: "New name" });
    await api.lists.removeFromList({
      listId: list.id,
      bookmarkId: bookmark.id,
    });

    const rows = listHistory(db, bookmark.id);
    expect(rows.map((r) => [r.oldValue, r.newValue])).toEqual([
      [null, "Old name"],
      ["New name", null],
    ]);
  });

  test<CustomTestContext>("keeps rows after the list is deleted", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Doomed");

    await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });
    await api.lists.delete({ listId: list.id });

    const rows = listHistory(db, bookmark.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refId: list.id, newValue: "Doomed" });
  });

  test<CustomTestContext>("deletes rows with the bookmark", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Reading");

    await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });
    expect(listHistory(db, bookmark.id)).toHaveLength(1);

    await api.bookmarks.deleteBookmark({ bookmarkId: bookmark.id });

    expect(listHistory(db, bookmark.id)).toHaveLength(0);
  });

  test<CustomTestContext>("rejects smart lists without recording", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await api.lists.create({
      name: "Smart",
      icon: "⭐",
      type: "smart",
      query: "is:fav",
    });
    const input = { listId: list.id, bookmarkId: bookmark.id };

    await expect(api.lists.addToList(input)).rejects.toThrow(
      "Smart lists cannot be added to",
    );
    await expect(api.lists.removeFromList(input)).rejects.toThrow(
      "Smart lists cannot be removed from",
    );

    expect(listHistory(db, bookmark.id)).toHaveLength(0);
  });

  test<CustomTestContext>("still fires the addedToList event after recording", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Reading");
    const trigger = vi.spyOn(RuleEngine, "triggerOnEvent");

    try {
      await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });

      expect(trigger).toHaveBeenCalledWith(
        owner.id,
        bookmark.id,
        [{ type: "addedToList", listId: list.id }],
        undefined,
        db,
      );
      expect(listHistory(db, bookmark.id)).toHaveLength(1);
    } finally {
      trigger.mockRestore();
    }
  });
});

describe("List membership history atomicity", () => {
  test<CustomTestContext>("rolls back the add when the history write fails", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Reading");
    const trigger = vi.spyOn(RuleEngine, "triggerOnEvent");
    vi.mocked(recordBookmarkHistory).mockImplementationOnce(() => {
      throw new Error("history write failed");
    });

    try {
      await expect(
        api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id }),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

      expect(isInList(db, list.id, bookmark.id)).toBe(false);
      expect(listHistory(db, bookmark.id)).toHaveLength(0);
      expect(trigger).not.toHaveBeenCalled();
    } finally {
      trigger.mockRestore();
    }
  });

  test<CustomTestContext>("rolls back the remove when the history write fails", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Reading");
    const input = { listId: list.id, bookmarkId: bookmark.id };
    await api.lists.addToList(input);
    vi.mocked(recordBookmarkHistory).mockImplementationOnce(() => {
      throw new Error("history write failed");
    });

    await expect(api.lists.removeFromList(input)).rejects.toThrow(
      "history write failed",
    );

    expect(isInList(db, list.id, bookmark.id)).toBe(true);
    expect(listHistory(db, bookmark.id)).toHaveLength(1);
  });
});

describe("List membership history on shared lists", () => {
  test<CustomTestContext>("credits an editor collaborator who adds their own bookmark", async ({
    apiCallers,
    db,
  }) => {
    const ownerApi = apiCallers[0];
    const editorApi = apiCallers[1];
    const editor = await editorApi.users.whoami();
    const list = await createList(ownerApi, "Shared");
    await addAndAcceptCollaborator(ownerApi, editorApi, list.id, "editor");
    const bookmark = await createBookmark(editorApi);

    await editorApi.lists.addToList({
      listId: list.id,
      bookmarkId: bookmark.id,
    });

    const rows = listHistory(db, bookmark.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      refId: list.id,
      oldValue: null,
      newValue: "Shared",
      source: "user",
      userId: editor.id,
    });
  });

  test<CustomTestContext>("credits an editor collaborator who removes the owner's bookmark", async ({
    apiCallers,
    db,
  }) => {
    const ownerApi = apiCallers[0];
    const editorApi = apiCallers[1];
    const editor = await editorApi.users.whoami();
    const bookmark = await createBookmark(ownerApi);
    const list = await createList(ownerApi, "Shared");
    await addAndAcceptCollaborator(ownerApi, editorApi, list.id, "editor");
    await ownerApi.lists.addToList({
      listId: list.id,
      bookmarkId: bookmark.id,
    });

    await editorApi.lists.removeFromList({
      listId: list.id,
      bookmarkId: bookmark.id,
    });

    const rows = listHistory(db, bookmark.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      refId: list.id,
      oldValue: "Shared",
      newValue: null,
      source: "user",
      userId: editor.id,
    });
  });

  test<CustomTestContext>("rejects a viewer's add and remove without recording", async ({
    apiCallers,
    db,
  }) => {
    const ownerApi = apiCallers[0];
    const viewerApi = apiCallers[1];
    const list = await createList(ownerApi, "Shared");
    await addAndAcceptCollaborator(ownerApi, viewerApi, list.id, "viewer");
    const ownerBookmark = await createBookmark(ownerApi);
    await ownerApi.lists.addToList({
      listId: list.id,
      bookmarkId: ownerBookmark.id,
    });
    const viewerBookmark = await createBookmark(viewerApi);

    await expect(
      viewerApi.lists.addToList({
        listId: list.id,
        bookmarkId: viewerBookmark.id,
      }),
    ).rejects.toThrow("User is not allowed to edit this list");
    await expect(
      viewerApi.lists.removeFromList({
        listId: list.id,
        bookmarkId: ownerBookmark.id,
      }),
    ).rejects.toThrow("User is not allowed to edit this list");

    expect(listHistory(db, viewerBookmark.id)).toHaveLength(0);
    expect(listHistory(db, ownerBookmark.id)).toHaveLength(1);
    expect(isInList(db, list.id, ownerBookmark.id)).toBe(true);
  });

  test<CustomTestContext>("rejects a non-member's add and remove without recording", async ({
    apiCallers,
    db,
  }) => {
    const ownerApi = apiCallers[0];
    const strangerApi = apiCallers[2];
    const list = await createList(ownerApi, "Private");
    const ownerBookmark = await createBookmark(ownerApi);
    await ownerApi.lists.addToList({
      listId: list.id,
      bookmarkId: ownerBookmark.id,
    });
    const strangerBookmark = await createBookmark(strangerApi);

    await expect(
      strangerApi.lists.addToList({
        listId: list.id,
        bookmarkId: strangerBookmark.id,
      }),
    ).rejects.toThrow("List not found");
    await expect(
      strangerApi.lists.removeFromList({
        listId: list.id,
        bookmarkId: ownerBookmark.id,
      }),
    ).rejects.toThrow("List not found");

    expect(listHistory(db, strangerBookmark.id)).toHaveLength(0);
    expect(listHistory(db, ownerBookmark.id)).toHaveLength(1);
  });

  test<CustomTestContext>("rejects adding someone else's bookmark without recording", async ({
    apiCallers,
    db,
  }) => {
    const ownerApi = apiCallers[0];
    const otherApi = apiCallers[1];
    const list = await createList(ownerApi, "Mine");
    const otherBookmark = await createBookmark(otherApi);

    await expect(
      ownerApi.lists.addToList({
        listId: list.id,
        bookmarkId: otherBookmark.id,
      }),
    ).rejects.toThrow();

    expect(isInList(db, list.id, otherBookmark.id)).toBe(false);
    expect(listHistory(db, otherBookmark.id)).toHaveLength(0);
  });
});

describe("List membership history from rules", () => {
  test<CustomTestContext>("records rule actions with the rule source and no user", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Auto");

    const engine = await ruleEngineFor(db, owner.id, bookmark.id);
    await engine.executeAction({ type: "addToList", listId: list.id });
    await engine.executeAction({ type: "removeFromList", listId: list.id });

    const rows = listHistory(db, bookmark.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      refId: list.id,
      oldValue: null,
      newValue: "Auto",
      source: "rule",
      userId: null,
    });
    expect(rows[1]).toMatchObject({
      refId: list.id,
      oldValue: "Auto",
      newValue: null,
      source: "rule",
      userId: null,
    });
  });

  test<CustomTestContext>("doesn't record a rule adding a bookmark already in the list", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Auto");
    await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });

    const engine = await ruleEngineFor(db, owner.id, bookmark.id);
    await expect(
      engine.executeAction({ type: "addToList", listId: list.id }),
    ).resolves.toBe(`Added to list ${list.id}`);

    const rows = listHistory(db, bookmark.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "user", userId: owner.id });
  });

  test<CustomTestContext>("doesn't record a rule removing a bookmark not in the list", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Auto");

    const engine = await ruleEngineFor(db, owner.id, bookmark.id);
    await expect(
      engine.executeAction({ type: "removeFromList", listId: list.id }),
    ).rejects.toThrow(/already not in list/);

    expect(listHistory(db, bookmark.id)).toHaveLength(0);
  });
});

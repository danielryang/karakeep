import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { BookmarkHistoryActor } from "../lib/bookmarkHistory";
import type { APICallerType, CustomTestContext } from "../testUtils";
import { recordBookmarkHistory } from "../lib/bookmarkHistory";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

// Only Date is faked so each seeded batch gets a distinct, known timestamp.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

let clock = new Date("2026-01-01T00:00:00Z").getTime();
function record(
  db: CustomTestContext["db"],
  actor: BookmarkHistoryActor,
  changes: Parameters<typeof recordBookmarkHistory>[2],
) {
  clock += 1000;
  vi.setSystemTime(clock);
  recordBookmarkHistory(db, actor, changes);
}

async function createBookmark(api: APICallerType) {
  return await api.bookmarks.createBookmark({
    type: BookmarkTypes.TEXT,
    text: "hello",
  });
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

describe("bookmarks.getHistory", () => {
  test<CustomTestContext>("owner sees all entries newest first with the actor", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const actor: BookmarkHistoryActor = {
      bookmarkId: bookmark.id,
      userId: owner.id,
      source: "user",
    };

    record(db, actor, [{ field: "title", oldValue: null, newValue: "First" }]);
    record(db, actor, [
      { field: "note", oldValue: null, newValue: "private note" },
      { field: "archived", oldValue: "false", newValue: "true" },
    ]);
    record(db, actor, [
      { field: "title", oldValue: "First", newValue: "Second" },
    ]);

    const history = await api.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });

    expect(history.map((h) => [h.field, h.newValue])).toEqual([
      ["title", "Second"],
      // Same batch: kept in insertion order.
      ["archived", "true"],
      ["note", "private note"],
      ["title", "First"],
    ]);
    for (const h of history) {
      expect(h.bookmarkId).toBe(bookmark.id);
      expect(h.source).toBe("user");
      expect(h.user).toEqual({ id: owner.id, name: "Test User 1" });
      expect(h.createdAt).toBeInstanceOf(Date);
    }
    expect(history[0].createdAt.getTime()).toBeGreaterThan(
      history[3].createdAt.getTime(),
    );
  });

  test<CustomTestContext>("returns an empty array when there is no history", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    expect(await api.bookmarks.getHistory({ bookmarkId: bookmark.id })).toEqual(
      [],
    );
  });

  test<CustomTestContext>("system changes have no user", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    record(db, { bookmarkId: bookmark.id, userId: null, source: "ai" }, [
      { field: "tags", refId: "tag-1", oldValue: null, newValue: "ai-tag" },
    ]);

    const history = await api.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      field: "tags",
      refId: "tag-1",
      source: "ai",
      user: null,
    });
  });

  test<CustomTestContext>("collaborators only see what they can already see", async ({
    apiCallers,
    db,
  }) => {
    const ownerApi = apiCallers[0];
    const collaboratorApi = apiCallers[1];
    const owner = await ownerApi.users.whoami();
    const bookmark = await createBookmark(ownerApi);

    const sharedList = await ownerApi.lists.create({
      name: "Shared",
      icon: "📚",
      type: "manual",
    });
    const privateList = await ownerApi.lists.create({
      name: "Private",
      icon: "🔒",
      type: "manual",
    });
    await ownerApi.lists.addToList({
      listId: sharedList.id,
      bookmarkId: bookmark.id,
    });
    await addAndAcceptCollaborator(
      ownerApi,
      collaboratorApi,
      sharedList.id,
      "viewer",
    );

    const actor: BookmarkHistoryActor = {
      bookmarkId: bookmark.id,
      userId: owner.id,
      source: "user",
    };
    record(db, actor, [
      { field: "title", oldValue: null, newValue: "Title" },
      { field: "note", oldValue: null, newValue: "private note" },
      { field: "archived", oldValue: "false", newValue: "true" },
      { field: "favourited", oldValue: "false", newValue: "true" },
    ]);
    record(db, actor, [
      { field: "tags", refId: "tag-1", oldValue: null, newValue: "news" },
      {
        field: "lists",
        refId: sharedList.id,
        oldValue: null,
        newValue: "Shared",
      },
      {
        field: "lists",
        refId: privateList.id,
        oldValue: null,
        newValue: "Private",
      },
      {
        field: "lists",
        refId: "deleted-list",
        oldValue: null,
        newValue: "Gone",
      },
    ]);

    const ownerHistory = await ownerApi.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });
    expect(ownerHistory).toHaveLength(8);

    const collaboratorHistory = await collaboratorApi.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });
    expect(
      collaboratorHistory.map((h) => [h.field, h.refId, h.newValue]),
    ).toEqual([
      ["lists", sharedList.id, "Shared"],
      ["tags", "tag-1", "news"],
      ["title", null, "Title"],
    ]);
    // The actor's name is visible, as the owner already is in shared lists.
    expect(collaboratorHistory[0].user).toEqual({
      id: owner.id,
      name: "Test User 1",
    });
  });

  test<CustomTestContext>("users without access get NOT_FOUND", async ({
    apiCallers,
    db,
  }) => {
    const ownerApi = apiCallers[0];
    const owner = await ownerApi.users.whoami();
    const bookmark = await createBookmark(ownerApi);
    record(db, { bookmarkId: bookmark.id, userId: owner.id, source: "user" }, [
      { field: "title", oldValue: null, newValue: "Title" },
    ]);

    await expect(
      apiCallers[2].bookmarks.getHistory({ bookmarkId: bookmark.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      ownerApi.bookmarks.getHistory({ bookmarkId: "does-not-exist" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

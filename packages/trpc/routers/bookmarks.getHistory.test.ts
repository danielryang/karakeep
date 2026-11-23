import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { bookmarkHistory, users } from "@karakeep/db/schema";
import { zBookmarkHistoryEntrySchema } from "@karakeep/shared/types/bookmarkHistory";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { BookmarkHistoryActor } from "../lib/bookmarkHistory";
import type { APICallerType, CustomTestContext } from "../testUtils";
import { recordBookmarkHistory } from "../lib/bookmarkHistory";
import {
  BareBookmark,
  MAX_BOOKMARK_HISTORY_ENTRIES,
} from "../models/bookmarks";
import { defaultBeforeEach, getApiKeyCallerForPlainKey } from "../testUtils";

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

async function createList(api: APICallerType, name: string) {
  return await api.lists.create({ name, icon: "📚", type: "manual" });
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
  return collaborator;
}

// Owner's bookmark in a list shared with apiCallers[1] under `role`.
async function setUpSharedBookmark(
  apiCallers: APICallerType[],
  role: "viewer" | "editor",
) {
  const ownerApi = apiCallers[0];
  const collaboratorApi = apiCallers[1];
  const owner = await ownerApi.users.whoami();
  const bookmark = await createBookmark(ownerApi);
  const sharedList = await createList(ownerApi, "Shared");
  await ownerApi.lists.addToList({
    listId: sharedList.id,
    bookmarkId: bookmark.id,
  });
  const collaborator = await addAndAcceptCollaborator(
    ownerApi,
    collaboratorApi,
    sharedList.id,
    role,
  );
  return {
    ownerApi,
    collaboratorApi,
    owner,
    collaborator,
    bookmark,
    sharedList,
  };
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

  test<CustomTestContext>("rows sharing a timestamp come back in reverse insertion order", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const fields = ["title", "url", "summary", "favourited", "note", "tags"];
    record(
      db,
      { bookmarkId: bookmark.id, userId: owner.id, source: "user" },
      fields.map((field) => ({ field, oldValue: null, newValue: field })),
    );

    const history = await api.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });
    expect(new Set(history.map((h) => h.createdAt.getTime())).size).toBe(1);
    expect(history.map((h) => h.field)).toEqual([...fields].reverse());
  });

  test<CustomTestContext>("owner sees every field, including lists rows for deleted lists", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await createList(api, "Soon gone");
    const actor: BookmarkHistoryActor = {
      bookmarkId: bookmark.id,
      userId: owner.id,
      source: "user",
    };
    record(db, actor, [
      { field: "note", oldValue: null, newValue: "n" },
      { field: "archived", oldValue: "false", newValue: "true" },
      { field: "favourited", oldValue: "false", newValue: "true" },
      { field: "tags", refId: "tag-1", oldValue: null, newValue: "news" },
      { field: "lists", refId: list.id, oldValue: null, newValue: "Soon gone" },
    ]);
    await api.lists.delete({ listId: list.id });

    const history = await api.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });
    expect(history.map((h) => [h.field, h.refId])).toEqual([
      ["lists", list.id],
      ["tags", "tag-1"],
      ["favourited", null],
      ["archived", null],
      ["note", null],
    ]);
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
    record(db, { bookmarkId: bookmark.id, userId: null, source: "rule" }, [
      { field: "favourited", oldValue: "false", newValue: "true" },
    ]);

    const history = await api.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      field: "favourited",
      source: "rule",
      user: null,
    });
    expect(history[1]).toMatchObject({
      field: "tags",
      refId: "tag-1",
      source: "ai",
      user: null,
    });
  });

  test<CustomTestContext>("entries outlive a deleted actor with user null", async ({
    apiCallers,
    db,
  }) => {
    const { ownerApi, collaborator, bookmark } = await setUpSharedBookmark(
      apiCallers,
      "editor",
    );
    record(
      db,
      { bookmarkId: bookmark.id, userId: collaborator.id, source: "user" },
      [{ field: "title", oldValue: null, newValue: "By editor" }],
    );
    await db.delete(users).where(eq(users.id, collaborator.id));

    const history = await ownerApi.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ newValue: "By editor", user: null });
  });

  test<CustomTestContext>("output matches zBookmarkHistoryEntrySchema", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    record(db, { bookmarkId: bookmark.id, userId: owner.id, source: "user" }, [
      { field: "title", oldValue: "a", newValue: "b" },
      { field: "tags", refId: "t", oldValue: "x", newValue: null },
    ]);
    record(db, { bookmarkId: bookmark.id, userId: null, source: "ai" }, [
      { field: "summary", oldValue: null, newValue: "s" },
    ]);

    const history = await api.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });
    expect(history).toHaveLength(3);
    for (const h of history) {
      expect(zBookmarkHistoryEntrySchema.strict().parse(h)).toEqual(h);
      expect(h.createdAt).toBeInstanceOf(Date);
      expect(typeof h.id).toBe("string");
    }
  });

  test<CustomTestContext>("never returns another bookmark's history", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const a = await createBookmark(api);
    const b = await createBookmark(api);
    record(db, { bookmarkId: a.id, userId: owner.id, source: "user" }, [
      { field: "title", oldValue: null, newValue: "A" },
    ]);
    record(db, { bookmarkId: b.id, userId: owner.id, source: "user" }, [
      { field: "title", oldValue: null, newValue: "B" },
    ]);

    const historyA = await api.bookmarks.getHistory({ bookmarkId: a.id });
    const historyB = await api.bookmarks.getHistory({ bookmarkId: b.id });
    expect(historyA.map((h) => [h.bookmarkId, h.newValue])).toEqual([
      [a.id, "A"],
    ]);
    expect(historyB.map((h) => [h.bookmarkId, h.newValue])).toEqual([
      [b.id, "B"],
    ]);
  });

  test<CustomTestContext>(`caps the response at the newest ${MAX_BOOKMARK_HISTORY_ENTRIES} entries`, async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const total = MAX_BOOKMARK_HISTORY_ENTRIES + 20;
    const base = new Date("2026-02-01T00:00:00Z").getTime();
    await db.insert(bookmarkHistory).values(
      Array.from({ length: total }, (_, i) => ({
        bookmarkId: bookmark.id,
        userId: owner.id,
        source: "user" as const,
        field: "title",
        oldValue: null,
        newValue: `v${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    );

    const history = await api.bookmarks.getHistory({
      bookmarkId: bookmark.id,
    });
    expect(history).toHaveLength(MAX_BOOKMARK_HISTORY_ENTRIES);
    expect(history[0].newValue).toBe(`v${total - 1}`);
    expect(history.at(-1)!.newValue).toBe(
      `v${total - MAX_BOOKMARK_HISTORY_ENTRIES}`,
    );
  });

  describe.each(["viewer", "editor"] as const)("collaborator (%s)", (role) => {
    test<CustomTestContext>("only sees what they can already see", async ({
      apiCallers,
      db,
    }) => {
      const { ownerApi, collaboratorApi, owner, bookmark, sharedList } =
        await setUpSharedBookmark(apiCallers, role);
      const privateList = await createList(ownerApi, "Private");
      const deletedList = await createList(ownerApi, "Deleted");
      const strangersList = await createList(apiCallers[2], "Stranger's");
      // The collaborator's own list is viewable to them but the bookmark was
      // never in it, so no row refers to it.
      await createList(collaboratorApi, "Mine");

      const actor: BookmarkHistoryActor = {
        bookmarkId: bookmark.id,
        userId: owner.id,
        source: "user",
      };
      record(db, actor, [
        { field: "title", oldValue: null, newValue: "Title" },
        { field: "url", oldValue: "a", newValue: "b" },
        { field: "note", oldValue: null, newValue: "private note" },
        { field: "archived", oldValue: "false", newValue: "true" },
        { field: "favourited", oldValue: "false", newValue: "true" },
      ]);
      record(db, actor, [
        { field: "tags", refId: "tag-1", oldValue: null, newValue: "news" },
        ...[sharedList, privateList, deletedList, strangersList].map((l) => ({
          field: "lists",
          refId: l.id,
          oldValue: null,
          newValue: l.name,
        })),
      ]);
      await ownerApi.lists.delete({ listId: deletedList.id });

      const ownerHistory = await ownerApi.bookmarks.getHistory({
        bookmarkId: bookmark.id,
      });
      expect(ownerHistory).toHaveLength(10);

      const collaboratorHistory = await collaboratorApi.bookmarks.getHistory({
        bookmarkId: bookmark.id,
      });
      expect(
        collaboratorHistory.map((h) => [h.field, h.refId, h.newValue]),
      ).toEqual([
        ["lists", sharedList.id, "Shared"],
        ["tags", "tag-1", "news"],
        ["url", null, "b"],
        ["title", null, "Title"],
      ]);
      // The actor's name is visible, as the owner already is in shared lists.
      expect(collaboratorHistory[0].user).toEqual({
        id: owner.id,
        name: "Test User 1",
      });
    });

    test<CustomTestContext>("gets NOT_FOUND once removed from the shared list", async ({
      apiCallers,
    }) => {
      const { ownerApi, collaboratorApi, collaborator, bookmark, sharedList } =
        await setUpSharedBookmark(apiCallers, role);
      await expect(
        collaboratorApi.bookmarks.getHistory({ bookmarkId: bookmark.id }),
      ).resolves.toEqual([]);

      await ownerApi.lists.removeCollaborator({
        listId: sharedList.id,
        userId: collaborator.id,
      });
      await expect(
        collaboratorApi.bookmarks.getHistory({ bookmarkId: bookmark.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    test<CustomTestContext>("gets NOT_FOUND once the bookmark leaves the shared list", async ({
      apiCallers,
    }) => {
      const { ownerApi, collaboratorApi, bookmark, sharedList } =
        await setUpSharedBookmark(apiCallers, role);
      await ownerApi.lists.removeFromList({
        listId: sharedList.id,
        bookmarkId: bookmark.id,
      });
      await expect(
        collaboratorApi.bookmarks.getHistory({ bookmarkId: bookmark.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  // Through the router a collaborator always has at least the list that
  // granted access. The empty case is only reachable when access is lost
  // between the access check and the query, so drive the model directly.
  test<CustomTestContext>("a collaborator with no viewable lists sees no lists rows", async ({
    apiCallers,
    db,
  }) => {
    const { ownerApi, owner, collaborator, bookmark, sharedList } =
      await setUpSharedBookmark(apiCallers, "viewer");
    record(db, { bookmarkId: bookmark.id, userId: owner.id, source: "user" }, [
      { field: "title", oldValue: null, newValue: "Title" },
      { field: "note", oldValue: null, newValue: "secret" },
      { field: "lists", refId: sharedList.id, oldValue: null, newValue: "S" },
    ]);

    const model = await BareBookmark.bareFromId(
      {
        user: { id: collaborator.id, email: collaborator.email, role: "user" },
        auth: { type: "session" },
        db,
        req: { ip: null },
      },
      bookmark.id,
    );
    await ownerApi.lists.removeCollaborator({
      listId: sharedList.id,
      userId: collaborator.id,
    });

    const history = await model.getHistory();
    expect(history.map((h) => h.field)).toEqual(["title"]);
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

  test<CustomTestContext>("unauthenticated callers get UNAUTHORIZED", async ({
    apiCallers,
    unauthedAPICaller,
  }) => {
    const bookmark = await createBookmark(apiCallers[0]);
    await expect(
      unauthedAPICaller.bookmarks.getHistory({ bookmarkId: bookmark.id }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test<CustomTestContext>("rejects a missing bookmarkId", async ({
    apiCallers,
  }) => {
    await expect(
      apiCallers[0].bookmarks.getHistory(
        {} as unknown as { bookmarkId: string },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test<CustomTestContext>("API keys need the bookmarks read scope", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    record(db, { bookmarkId: bookmark.id, userId: owner.id, source: "user" }, [
      { field: "title", oldValue: null, newValue: "Title" },
    ]);

    const unscoped = await api.apiKeys.create({
      name: "no bookmarks",
      scopes: ["users:read"],
    });
    await expect(
      (await getApiKeyCallerForPlainKey(db, unscoped.key)).bookmarks.getHistory(
        { bookmarkId: bookmark.id },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const scoped = await api.apiKeys.create({
      name: "bookmarks read",
      scopes: ["bookmarks:read"],
    });
    const history = await (
      await getApiKeyCallerForPlainKey(db, scoped.key)
    ).bookmarks.getHistory({ bookmarkId: bookmark.id });
    expect(history.map((h) => h.newValue)).toEqual(["Title"]);
  });
});

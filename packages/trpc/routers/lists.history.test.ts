import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";

import { bookmarkHistory } from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { APICallerType, CustomTestContext, TestDB } from "../testUtils";
import { RuleEngine } from "../lib/ruleEngine";
import { defaultBeforeEach } from "../testUtils";

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

async function createBookmark(api: APICallerType) {
  return api.bookmarks.createBookmark({
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

describe("List membership history", () => {
  test<CustomTestContext>("records the owner adding a bookmark", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await api.lists.create({
      name: "Reading",
      icon: "📚",
      type: "manual",
    });

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
    const list = await api.lists.create({
      name: "Reading",
      icon: "📚",
      type: "manual",
    });

    await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });
    await api.lists.addToList({ listId: list.id, bookmarkId: bookmark.id });

    expect(listHistory(db, bookmark.id)).toHaveLength(1);
  });

  test<CustomTestContext>("records the owner removing a bookmark", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await api.lists.create({
      name: "Reading",
      icon: "📚",
      type: "manual",
    });

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

  test<CustomTestContext>("doesn't record removing a bookmark that isn't in the list", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createBookmark(api);
    const list = await api.lists.create({
      name: "Reading",
      icon: "📚",
      type: "manual",
    });

    await expect(
      api.lists.removeFromList({ listId: list.id, bookmarkId: bookmark.id }),
    ).rejects.toThrow(/already not in list/);

    expect(listHistory(db, bookmark.id)).toHaveLength(0);
  });

  test<CustomTestContext>("credits an editor collaborator who removes the owner's bookmark", async ({
    apiCallers,
    db,
  }) => {
    const ownerApi = apiCallers[0];
    const editorApi = apiCallers[1];
    const editor = await editorApi.users.whoami();
    const bookmark = await createBookmark(ownerApi);
    const list = await ownerApi.lists.create({
      name: "Shared",
      icon: "📚",
      type: "manual",
    });
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

  test<CustomTestContext>("records rule actions with the rule source and no user", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const owner = await api.users.whoami();
    const bookmark = await createBookmark(api);
    const list = await api.lists.create({
      name: "Auto",
      icon: "📚",
      type: "manual",
    });

    const engine = (await RuleEngine.forBookmark(
      { user: { id: owner.id, role: "user" }, db, req: { ip: null } },
      bookmark.id,
    ))!;
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
});

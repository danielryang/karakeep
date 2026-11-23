import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  bookmarkHistory,
  bookmarks,
  bookmarkTags,
  tagsOnBookmarks,
  users,
} from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { connectTags } from "./tagging";

const mocks = await vi.hoisted(async () => {
  const { getInMemoryDB } = await import("@karakeep/db/drizzle");
  return { db: getInMemoryDB(true) };
});

vi.mock("@karakeep/db", async (original) => ({
  ...(await original<typeof import("@karakeep/db")>()),
  db: mocks.db,
}));

vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  RuleEngineQueue: { enqueue: vi.fn() },
}));

const db = mocks.db;

let userId: string;
let bookmarkId: string;

beforeEach(async () => {
  [{ id: userId }] = await db
    .insert(users)
    .values({ name: "Test", email: `${crypto.randomUUID()}@test.com` })
    .returning({ id: users.id });
  [{ id: bookmarkId }] = await db
    .insert(bookmarks)
    .values({ userId, type: BookmarkTypes.TEXT })
    .returning({ id: bookmarks.id });
});

async function history() {
  return (
    await db
      .select()
      .from(bookmarkHistory)
      .where(eq(bookmarkHistory.bookmarkId, bookmarkId))
  )
    .map((r) => ({
      refId: r.refId,
      oldValue: r.oldValue,
      newValue: r.newValue,
      source: r.source,
      userId: r.userId,
    }))
    .sort((a, b) =>
      (a.oldValue ?? a.newValue ?? "").localeCompare(
        b.oldValue ?? b.newValue ?? "",
      ),
    );
}

async function tagId(name: string) {
  const tag = await db.query.bookmarkTags.findFirst({
    where: eq(bookmarkTags.name, name),
  });
  return tag!.id;
}

describe("connectTags history", () => {
  test("AI attaching new tags records ai rows with no user", async () => {
    await connectTags(bookmarkId, ["alpha", "beta"], userId);

    expect(await history()).toEqual([
      {
        refId: await tagId("alpha"),
        oldValue: null,
        newValue: "alpha",
        source: "ai",
        userId: null,
      },
      {
        refId: await tagId("beta"),
        oldValue: null,
        newValue: "beta",
        source: "ai",
        userId: null,
      },
    ]);
  });

  test("re-running with the same tags records nothing", async () => {
    await connectTags(bookmarkId, ["alpha", "beta"], userId);
    await db.delete(bookmarkHistory);

    await connectTags(bookmarkId, ["alpha", "beta"], userId);

    expect(await history()).toEqual([]);
  });

  test("replacing tag A with B records one removal and one addition", async () => {
    await connectTags(bookmarkId, ["a"], userId);
    await db.delete(bookmarkHistory);

    await connectTags(bookmarkId, ["b"], userId);

    expect(await history()).toEqual([
      expect.objectContaining({
        refId: await tagId("a"),
        oldValue: "a",
        newValue: null,
        source: "ai",
      }),
      expect.objectContaining({
        refId: await tagId("b"),
        oldValue: null,
        newValue: "b",
        source: "ai",
      }),
    ]);
  });

  test("human-attached tags are untouched and not recorded", async () => {
    const [{ id: humanTagId }] = await db
      .insert(bookmarkTags)
      .values({ name: "human", userId })
      .returning({ id: bookmarkTags.id });
    await db
      .insert(tagsOnBookmarks)
      .values({ bookmarkId, tagId: humanTagId, attachedBy: "human" });

    // The AI suggesting a tag the user already attached is a no-op too.
    await connectTags(bookmarkId, ["human", "ai-tag"], userId);

    expect(await history()).toEqual([
      expect.objectContaining({ newValue: "ai-tag", source: "ai" }),
    ]);
    const attached = await db
      .select()
      .from(tagsOnBookmarks)
      .where(eq(tagsOnBookmarks.bookmarkId, bookmarkId));
    expect(attached.find((t) => t.tagId === humanTagId)?.attachedBy).toBe(
      "human",
    );
  });

  test("no inferred tags records nothing", async () => {
    await connectTags(bookmarkId, [], userId);
    expect(await history()).toEqual([]);
  });
});

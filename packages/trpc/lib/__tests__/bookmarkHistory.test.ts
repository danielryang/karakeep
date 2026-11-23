import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getInMemoryDB } from "@karakeep/db/drizzle";
import { bookmarkHistory, bookmarks, users } from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { TestDB } from "../../testUtils";
import {
  diffBookmarkFields,
  recordBookmarkHistory,
  toHistoryValue,
} from "../bookmarkHistory";

describe("toHistoryValue", () => {
  it("normalizes values to strings", () => {
    expect(toHistoryValue(null)).toBeNull();
    expect(toHistoryValue(undefined)).toBeNull();
    expect(toHistoryValue("a")).toBe("a");
    expect(toHistoryValue(true)).toBe("true");
    expect(toHistoryValue(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });
});

describe("diffBookmarkFields", () => {
  it("returns only fields whose value changed", () => {
    const changes = diffBookmarkFields(
      { title: "old", archived: false, note: "same" },
      { title: "new", archived: false, note: "same" },
    );
    expect(changes).toEqual([
      { field: "title", oldValue: "old", newValue: "new" },
    ]);
  });

  it("ignores fields that are not part of the update", () => {
    expect(diffBookmarkFields({ title: "a" }, { note: undefined })).toEqual([]);
  });

  it("compares dates by value", () => {
    expect(
      diffBookmarkFields(
        { createdAt: new Date(1000) },
        { createdAt: new Date(1000) },
      ),
    ).toEqual([]);
  });

  it("records clearing a value as a change to null", () => {
    expect(diffBookmarkFields({ title: "a" }, { title: null })).toEqual([
      { field: "title", oldValue: "a", newValue: null },
    ]);
  });
});

describe("recordBookmarkHistory", () => {
  let db: TestDB;
  let userId: string;
  let bookmarkId: string;

  beforeEach(async () => {
    db = getInMemoryDB(/* runMigrations */ true);
    [{ id: userId }] = await db
      .insert(users)
      .values({ name: "Test User", email: "test@test.com" })
      .returning({ id: users.id });
    [{ id: bookmarkId }] = await db
      .insert(bookmarks)
      .values({ userId, type: BookmarkTypes.TEXT })
      .returning({ id: bookmarks.id });
  });

  it("inserts one row per change", async () => {
    recordBookmarkHistory(db, { bookmarkId, userId, source: "user" }, [
      { field: "title", oldValue: null, newValue: "a" },
      { field: "tags", refId: "tag1", oldValue: null, newValue: "news" },
    ]);
    const rows = await db.query.bookmarkHistory.findMany({
      where: eq(bookmarkHistory.bookmarkId, bookmarkId),
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.field).sort()).toEqual(["tags", "title"]);
    expect(rows.every((r) => r.userId === userId)).toBe(true);
    expect(rows.find((r) => r.field === "tags")?.refId).toBe("tag1");
  });

  it("writes nothing for an empty change set", async () => {
    recordBookmarkHistory(db, { bookmarkId, userId, source: "user" }, []);
    expect(await db.query.bookmarkHistory.findMany()).toHaveLength(0);
  });

  it("is removed together with its bookmark", async () => {
    recordBookmarkHistory(db, { bookmarkId, userId: null, source: "ai" }, [
      { field: "title", oldValue: null, newValue: "a" },
    ]);
    await db.delete(bookmarks).where(eq(bookmarks.id, bookmarkId));
    expect(await db.query.bookmarkHistory.findMany()).toHaveLength(0);
  });
});

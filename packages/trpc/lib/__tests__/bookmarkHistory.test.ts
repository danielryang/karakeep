import { eq, sql } from "drizzle-orm";
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

describe("bookmarkHistory migration", () => {
  const db = getInMemoryDB(/* runMigrations */ true);

  it("creates the table with the expected columns", () => {
    const columns = db.all<{ name: string; notnull: number; pk: number }>(
      sql`PRAGMA table_info(bookmarkHistory)`,
    );
    expect(
      Object.fromEntries(columns.map((c) => [c.name, c.notnull === 1])),
    ).toEqual({
      id: true,
      bookmarkId: true,
      userId: false,
      source: true,
      field: true,
      refId: false,
      oldValue: false,
      newValue: false,
      createdAt: true,
    });
    expect(columns.find((c) => c.pk === 1)?.name).toBe("id");
  });

  it("indexes bookmarkId + createdAt for newest-first reads", () => {
    const cols = db.all<{ name: string }>(
      sql`PRAGMA index_info(bookmarkHistory_bookmarkId_createdAt_idx)`,
    );
    expect(cols.map((c) => c.name)).toEqual(["bookmarkId", "createdAt"]);
  });

  it("cascades with the bookmark and nulls the actor on user deletion", () => {
    const fks = db.all<{ table: string; from: string; on_delete: string }>(
      sql`PRAGMA foreign_key_list(bookmarkHistory)`,
    );
    expect(
      Object.fromEntries(fks.map((f) => [f.from, [f.table, f.on_delete]])),
    ).toEqual({
      bookmarkId: ["bookmarks", "CASCADE"],
      userId: ["user", "SET NULL"],
    });
  });
});

describe("toHistoryValue", () => {
  it("normalizes values to strings", () => {
    expect(toHistoryValue(null)).toBeNull();
    expect(toHistoryValue(undefined)).toBeNull();
    expect(toHistoryValue("a")).toBe("a");
    expect(toHistoryValue(true)).toBe("true");
    expect(toHistoryValue(false)).toBe("false");
    expect(toHistoryValue(0)).toBe("0");
    expect(toHistoryValue(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });

  it("keeps an empty string distinct from unset", () => {
    expect(toHistoryValue("")).toBe("");
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

  it("treats a field missing from the old row as unset", () => {
    expect(diffBookmarkFields({}, { author: "me" })).toEqual([
      { field: "author", oldValue: null, newValue: "me" },
    ]);
  });

  it("records boolean flips and empty-string edits", () => {
    expect(
      diffBookmarkFields(
        { archived: false, title: "a" },
        { archived: true, title: "" },
      ),
    ).toEqual([
      { field: "archived", oldValue: "false", newValue: "true" },
      { field: "title", oldValue: "a", newValue: "" },
    ]);
  });

  it("returns nothing when null is set on an already-null field", () => {
    expect(diffBookmarkFields({ title: null }, { title: null })).toEqual([]);
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

  it("defaults refId to null and generates ids", async () => {
    recordBookmarkHistory(db, { bookmarkId, userId, source: "user" }, [
      { field: "title", oldValue: null, newValue: "a" },
      { field: "note", oldValue: null, newValue: "b" },
    ]);
    const rows = await db.query.bookmarkHistory.findMany();
    expect(rows.every((r) => r.refId === null)).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it("gives every row in one call the same timestamp", async () => {
    recordBookmarkHistory(db, { bookmarkId, userId, source: "user" }, [
      { field: "title", oldValue: null, newValue: "a" },
      { field: "note", oldValue: null, newValue: "b" },
      { field: "summary", oldValue: null, newValue: "c" },
    ]);
    const rows = await db.query.bookmarkHistory.findMany();
    expect(new Set(rows.map((r) => r.createdAt.valueOf())).size).toBe(1);
  });

  it("stores system changes without a user", async () => {
    recordBookmarkHistory(db, { bookmarkId, userId: null, source: "rule" }, [
      { field: "tags", refId: "t", oldValue: "x", newValue: null },
    ]);
    const [row] = await db.query.bookmarkHistory.findMany();
    expect(row).toMatchObject({ userId: null, source: "rule", newValue: null });
  });

  it("rolls back with the surrounding transaction", async () => {
    expect(() =>
      db.transaction((tx) => {
        recordBookmarkHistory(tx, { bookmarkId, userId, source: "user" }, [
          { field: "title", oldValue: null, newValue: "a" },
        ]);
        throw new Error("change failed");
      }),
    ).toThrow("change failed");
    expect(await db.query.bookmarkHistory.findMany()).toHaveLength(0);
  });

  it("rejects rows for a bookmark that doesn't exist", () => {
    expect(() =>
      recordBookmarkHistory(
        db,
        { bookmarkId: "missing", userId, source: "user" },
        [{ field: "title", oldValue: null, newValue: "a" }],
      ),
    ).toThrow();
  });

  it("keeps the entry but clears the actor when that user is deleted", async () => {
    // A collaborator (not the owner) made the change, then deleted their account.
    const [{ id: collaboratorId }] = await db
      .insert(users)
      .values({ name: "Collaborator", email: "collab@test.com" })
      .returning({ id: users.id });
    recordBookmarkHistory(
      db,
      { bookmarkId, userId: collaboratorId, source: "user" },
      [{ field: "lists", refId: "l", oldValue: "Shared", newValue: null }],
    );
    await db.delete(users).where(eq(users.id, collaboratorId));
    const [row] = await db.query.bookmarkHistory.findMany();
    expect(row.userId).toBeNull();
    expect(row.oldValue).toBe("Shared");
  });

  it("is removed together with its bookmark", async () => {
    recordBookmarkHistory(db, { bookmarkId, userId: null, source: "ai" }, [
      { field: "title", oldValue: null, newValue: "a" },
    ]);
    await db.delete(bookmarks).where(eq(bookmarks.id, bookmarkId));
    expect(await db.query.bookmarkHistory.findMany()).toHaveLength(0);
  });
});

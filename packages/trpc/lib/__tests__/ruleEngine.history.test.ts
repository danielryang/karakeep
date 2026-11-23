import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getInMemoryDB } from "@karakeep/db/drizzle";
import {
  bookmarkHistory,
  bookmarks,
  bookmarkTags,
  tagsOnBookmarks,
  users,
} from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { AuthedContext } from "../..";
import { TestDB } from "../../testUtils";
import { recordTagHistory } from "../bookmarkHistoryTags";
import { RuleEngine } from "../ruleEngine";

vi.mock("@karakeep/shared-server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@karakeep/shared-server")>();
  return {
    ...actual,
    LowPriorityCrawlerQueue: { enqueue: vi.fn() },
    RuleEngineQueue: { enqueue: vi.fn() },
  };
});

describe("tag history", () => {
  let db: TestDB;
  let ctx: AuthedContext;
  let bookmarkId: string;
  let attachedTagId: string;
  let otherTagId: string;

  const historyRows = () =>
    db
      .select()
      .from(bookmarkHistory)
      .where(eq(bookmarkHistory.bookmarkId, bookmarkId));

  beforeEach(async () => {
    db = getInMemoryDB(/* runMigrations */ true);
    const [user] = await db
      .insert(users)
      .values({ name: "Test User", email: "test@test.com" })
      .returning({ id: users.id });
    ctx = { user: { id: user.id, role: "user" }, db, req: { ip: null } };

    [attachedTagId, otherTagId] = (
      await db
        .insert(bookmarkTags)
        .values([
          { name: "Attached", userId: user.id },
          { name: "Other", userId: user.id },
        ])
        .returning({ id: bookmarkTags.id })
    ).map((t) => t.id);

    [bookmarkId] = (
      await db
        .insert(bookmarks)
        .values({ userId: user.id, type: BookmarkTypes.TEXT })
        .returning({ id: bookmarks.id })
    ).map((b) => b.id);
    await db.insert(tagsOnBookmarks).values({
      bookmarkId,
      tagId: attachedTagId,
      attachedBy: "human",
    });
  });

  describe("rule engine actions", () => {
    let engine: RuleEngine;

    beforeEach(async () => {
      engine = (await RuleEngine.forBookmark(ctx, bookmarkId))!;
    });

    it("records addTag as a rule change with no user", async () => {
      await engine.executeAction({ type: "addTag", tagId: otherTagId });

      expect(await historyRows()).toEqual([
        expect.objectContaining({
          field: "tags",
          refId: otherTagId,
          oldValue: null,
          newValue: "Other",
          source: "rule",
          userId: null,
        }),
      ]);
    });

    it("records removeTag as a rule change with no user", async () => {
      await engine.executeAction({ type: "removeTag", tagId: attachedTagId });

      expect(await historyRows()).toEqual([
        expect.objectContaining({
          field: "tags",
          refId: attachedTagId,
          oldValue: "Attached",
          newValue: null,
          source: "rule",
          userId: null,
        }),
      ]);
    });

    it("records nothing when the tag state doesn't change", async () => {
      await engine.executeAction({ type: "addTag", tagId: attachedTagId });
      await engine.executeAction({ type: "removeTag", tagId: otherTagId });

      expect(await historyRows()).toEqual([]);
    });

    it("rolls back the tag change when history fails", async () => {
      db.run(
        sql`CREATE TRIGGER fail_history BEFORE INSERT ON bookmarkHistory BEGIN SELECT RAISE(ABORT, 'history failed'); END`,
      );

      await expect(
        engine.executeAction({ type: "addTag", tagId: otherTagId }),
      ).rejects.toThrow("history failed");
      await expect(
        engine.executeAction({ type: "removeTag", tagId: attachedTagId }),
      ).rejects.toThrow("history failed");

      const attached = await db
        .select({ tagId: tagsOnBookmarks.tagId })
        .from(tagsOnBookmarks)
        .where(eq(tagsOnBookmarks.bookmarkId, bookmarkId));
      expect(attached).toEqual([{ tagId: attachedTagId }]);
    });
  });

  // The AI tagging worker calls recordTagHistory with the AI tags it deleted
  // and the ones it inserted; this mirrors that call.
  describe("recordTagHistory", () => {
    it("skips tags that were detached and re-attached in the same write", () => {
      recordTagHistory(
        db,
        { bookmarkId, userId: null, source: "ai" },
        {
          detachedTagIds: [attachedTagId],
          attachedTagIds: [attachedTagId, otherTagId],
        },
      );

      return expect(historyRows()).resolves.toEqual([
        expect.objectContaining({
          refId: otherTagId,
          oldValue: null,
          newValue: "Other",
          source: "ai",
          userId: null,
        }),
      ]);
    });

    it("records nothing for empty input", async () => {
      recordTagHistory(
        db,
        { bookmarkId, userId: null, source: "ai" },
        { detachedTagIds: [], attachedTagIds: [] },
      );
      expect(await historyRows()).toEqual([]);
    });

    const aiActor = () => ({ bookmarkId, userId: null, source: "ai" as const });

    it("records detach-only and attach-only changes", async () => {
      recordTagHistory(db, aiActor(), {
        detachedTagIds: [attachedTagId],
        attachedTagIds: [],
      });
      recordTagHistory(db, aiActor(), {
        detachedTagIds: [],
        attachedTagIds: [otherTagId],
      });

      const rows = await historyRows();
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            refId: attachedTagId,
            oldValue: "Attached",
            newValue: null,
          }),
          expect.objectContaining({
            refId: otherTagId,
            oldValue: null,
            newValue: "Other",
          }),
        ]),
      );
    });

    it("records nothing when every id is in both lists", async () => {
      recordTagHistory(db, aiActor(), {
        detachedTagIds: [attachedTagId, otherTagId],
        attachedTagIds: [otherTagId, attachedTagId],
      });
      expect(await historyRows()).toEqual([]);
    });

    it("records a null name for a tag id that no longer exists", async () => {
      recordTagHistory(db, aiActor(), {
        detachedTagIds: ["gone-detached"],
        attachedTagIds: ["gone-attached"],
      });
      const rows = await historyRows();
      expect(rows).toHaveLength(2);
      for (const refId of ["gone-detached", "gone-attached"]) {
        expect(rows).toContainEqual(
          expect.objectContaining({ refId, oldValue: null, newValue: null }),
        );
      }
    });

    it("writes nothing when the surrounding transaction rolls back", async () => {
      expect(() =>
        db.transaction((tx) => {
          recordTagHistory(tx, aiActor(), {
            detachedTagIds: [],
            attachedTagIds: [otherTagId],
          });
          throw new Error("abort");
        }),
      ).toThrow("abort");
      expect(await historyRows()).toEqual([]);
    });
  });
});

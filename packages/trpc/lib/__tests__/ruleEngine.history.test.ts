import { eq } from "drizzle-orm";
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
  });
});

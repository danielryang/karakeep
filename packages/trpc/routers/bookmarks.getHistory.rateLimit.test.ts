import { beforeEach, describe, expect, test, vi } from "vitest";

import type {
  RateLimitClient,
  RateLimitConfig,
  RateLimitResult,
} from "@karakeep/shared/ratelimiting";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

const { rateLimiting, getRateLimitClientMock } = vi.hoisted(() => ({
  rateLimiting: { enabled: true },
  getRateLimitClientMock: vi.fn(),
}));

vi.mock("@karakeep/shared/config", async (original) => {
  const mod = await original<typeof import("@karakeep/shared/config")>();
  return {
    ...mod,
    default: {
      ...mod.default,
      rateLimiting: {
        ...mod.default.rateLimiting,
        get enabled() {
          return rateLimiting.enabled;
        },
      },
    },
  };
});

vi.mock("@karakeep/shared/ratelimiting", async (original) => ({
  ...(await original<typeof import("@karakeep/shared/ratelimiting")>()),
  getRateLimitClient: getRateLimitClientMock,
}));

// Fixed-window counter, enough to exercise the middleware's limits.
function createCountingClient() {
  const counts = new Map<string, number>();
  const client: RateLimitClient = {
    checkRateLimit: vi.fn(
      (config: RateLimitConfig, key: string): RateLimitResult => {
        const k = `${config.name}:${key}`;
        const count = (counts.get(k) ?? 0) + 1;
        counts.set(k, count);
        return count > config.maxRequests
          ? { allowed: false, resetInSeconds: 60 }
          : { allowed: true };
      },
    ),
    reset: vi.fn(),
    clear: vi.fn(() => counts.clear()),
  };
  return client;
}

const LIMIT = 30;

beforeEach<CustomTestContext>(defaultBeforeEach(true));

let client: RateLimitClient;
beforeEach(() => {
  rateLimiting.enabled = true;
  client = createCountingClient();
  getRateLimitClientMock.mockResolvedValue(client);
});

describe("bookmarks.getHistory rate limit", () => {
  test<CustomTestContext>(`allows ${LIMIT} requests per user per minute, then TOO_MANY_REQUESTS`, async ({
    apiCallers,
  }) => {
    const [owner, other] = apiCallers;
    const bookmark = await owner.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "hello",
    });
    const otherBookmark = await other.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "other",
    });

    for (let i = 0; i < LIMIT; i++) {
      await expect(
        owner.bookmarks.getHistory({ bookmarkId: bookmark.id }),
      ).resolves.toEqual([]);
    }
    await expect(
      owner.bookmarks.getHistory({ bookmarkId: bookmark.id }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(client.checkRateLimit).toHaveBeenCalledWith(
      { name: "bookmarks.getHistory", windowMs: 60 * 1000, maxRequests: LIMIT },
      expect.stringMatching(/^user:.+:bookmarks\.getHistory$/),
    );

    // Another user has their own budget.
    for (let i = 0; i < LIMIT; i++) {
      await expect(
        other.bookmarks.getHistory({ bookmarkId: otherBookmark.id }),
      ).resolves.toEqual([]);
    }
    await expect(
      other.bookmarks.getHistory({ bookmarkId: otherBookmark.id }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  test<CustomTestContext>("requests rejected for lack of access still count", async ({
    apiCallers,
  }) => {
    // The limiter runs before the access check, so probing ids is limited too.
    for (let i = 0; i < LIMIT; i++) {
      await expect(
        apiCallers[0].bookmarks.getHistory({ bookmarkId: `missing-${i}` }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      apiCallers[0].bookmarks.getHistory({ bookmarkId: "missing" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  test<CustomTestContext>("is not enforced when rate limiting is disabled", async ({
    apiCallers,
  }) => {
    rateLimiting.enabled = false;
    const bookmark = await apiCallers[0].bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "hello",
    });
    for (let i = 0; i < LIMIT + 5; i++) {
      await expect(
        apiCallers[0].bookmarks.getHistory({ bookmarkId: bookmark.id }),
      ).resolves.toEqual([]);
    }
    expect(client.checkRateLimit).not.toHaveBeenCalled();
  });
});

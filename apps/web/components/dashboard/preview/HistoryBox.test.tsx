// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZBookmarkHistoryEntry } from "@karakeep/shared/types/bookmarkHistory";

const fetchHistory = vi.hoisted(() => vi.fn());

// Echo keys and interpolation values so assertions don't depend on copy.
vi.mock("@/lib/i18n/client", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && Object.keys(opts).length
        ? `${key}(${Object.values(opts).join(",")})`
        : key,
    i18n: { language: "en" },
  }),
}));

vi.mock("@karakeep/shared-react/trpc", () => ({
  useTRPC: () => ({
    bookmarks: {
      getHistory: {
        queryOptions: (input: { bookmarkId: string }) => ({
          queryKey: ["bookmarks.getHistory", input],
          queryFn: () => fetchHistory(input),
        }),
      },
    },
  }),
}));

import HistoryBox from "./HistoryBox";

let seq = 0;
function entry(
  overrides: Partial<ZBookmarkHistoryEntry>,
): ZBookmarkHistoryEntry {
  seq += 1;
  return {
    id: `h${seq}`,
    bookmarkId: "b1",
    field: "title",
    refId: null,
    oldValue: null,
    newValue: null,
    source: "user",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    user: { id: "u1", name: "Alice" },
    ...overrides,
  };
}

const baseBookmark = { id: "b1", modifiedAt: null, tags: [] };

function renderBox(bookmark = baseBookmark) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<HistoryBox bookmark={bookmark} />, { wrapper });
}

async function openBox() {
  fireEvent.click(await screen.findByText("preview.history.title"));
}

describe("HistoryBox", () => {
  beforeEach(() => {
    fetchHistory.mockReset();
  });
  afterEach(cleanup);

  it("asks the endpoint for this bookmark's history", async () => {
    fetchHistory.mockResolvedValue([]);
    renderBox();
    await waitFor(() =>
      expect(fetchHistory).toHaveBeenCalledWith({ bookmarkId: "b1" }),
    );
  });

  it("renders nothing when there is no history", async () => {
    fetchHistory.mockResolvedValue([]);
    const { container } = renderBox();
    await waitFor(() => expect(fetchHistory).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("shows the entry count and starts collapsed", async () => {
    fetchHistory.mockResolvedValue([entry({}), entry({})]);
    renderBox();
    expect(await screen.findByText("2")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("keeps the endpoint's newest-first order", async () => {
    fetchHistory.mockResolvedValue([
      entry({ field: "tags", newValue: "newest" }),
      entry({ field: "tags", newValue: "oldest" }),
    ]);
    renderBox();
    await openBox();
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("newest");
    expect(items[1].textContent).toContain("oldest");
  });

  it("renders every kind of change", async () => {
    fetchHistory.mockResolvedValue([
      entry({ field: "title", oldValue: "Old title", newValue: "New title" }),
      entry({ field: "note", newValue: "A note" }),
      entry({ field: "description", oldValue: "Gone" }),
      entry({ field: "tags", refId: "t1", newValue: "news" }),
      entry({ field: "tags", refId: "t2", oldValue: "old-tag" }),
      entry({ field: "lists", refId: "l1", newValue: "Reading" }),
      entry({ field: "lists", refId: "l2", oldValue: "Later" }),
      entry({ field: "archived", oldValue: "false", newValue: "true" }),
      entry({ field: "favourited", oldValue: "true", newValue: "false" }),
    ]);
    renderBox();
    await openBox();
    const text = screen.getAllByRole("listitem").map((li) => li.textContent);

    expect(text[0]).toContain("preview.history.changed");
    // The old value is struck through, the new one isn't.
    expect(screen.getByText("Old title").className).toContain("line-through");
    expect(screen.getByText("New title").className).not.toContain(
      "line-through",
    );
    expect(text[1]).toContain("preview.history.set");
    expect(text[1]).toContain("A note");
    expect(text[2]).toContain("preview.history.cleared");
    expect(screen.getByText("Gone").className).toContain("line-through");
    expect(text[3]).toContain("preview.history.tag_added");
    expect(text[3]).toContain("news");
    expect(text[4]).toContain("preview.history.tag_removed");
    expect(text[5]).toContain("preview.history.list_added");
    expect(text[6]).toContain("preview.history.list_removed");
    expect(text[7]).toContain("preview.history.archived_on");
    expect(text[8]).toContain("preview.history.favourited_off");
  });

  it("labels who made each change", async () => {
    fetchHistory.mockResolvedValue([
      entry({ source: "user", user: { id: "u1", name: "Alice" } }),
      entry({ source: "ai", user: null }),
      entry({ source: "rule", user: null }),
      entry({ source: "user", user: null }),
    ]);
    renderBox();
    await openBox();
    const text = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(text[0]).toContain("Alice");
    expect(text[1]).toContain("preview.history.by_ai");
    expect(text[2]).toContain("preview.history.by_rule");
    expect(text[3]).toContain("preview.history.by_unknown");
  });

  it("keeps the full value available when it's clamped", async () => {
    const long = "x".repeat(500);
    fetchHistory.mockResolvedValue([entry({ field: "note", newValue: long })]);
    renderBox();
    await openBox();
    const value = screen.getByText(long);
    expect(value.getAttribute("title")).toBe(long);
    expect(value.className).toContain("line-clamp-2");
  });

  it("refetches when background jobs change the bookmark", async () => {
    fetchHistory.mockResolvedValue([entry({})]);
    const { rerender } = renderBox();
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledTimes(1));

    // Same bookmark again: no extra request.
    rerender(<HistoryBox bookmark={{ ...baseBookmark }} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchHistory).toHaveBeenCalledTimes(1);

    // An AI job attached a tag.
    rerender(
      <HistoryBox
        bookmark={{
          ...baseBookmark,
          tags: [
            {
              id: "t1",
              name: "news",
              attachedBy: "ai",
            } as (typeof baseBookmark.tags)[number],
          ],
        }}
      />,
    );
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledTimes(2));

    // An edit bumped modifiedAt.
    rerender(
      <HistoryBox
        bookmark={{ ...baseBookmark, modifiedAt: new Date(5000) as never }}
      />,
    );
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledTimes(3));
  });
});

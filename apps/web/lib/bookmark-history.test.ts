import { describe, expect, it } from "vitest";

import { describeHistoryEntry } from "./bookmark-history";

describe("describeHistoryEntry", () => {
  it("describes a changed field with both values", () => {
    expect(
      describeHistoryEntry({ field: "title", oldValue: "a", newValue: "b" }),
    ).toEqual({
      kind: "changed",
      field: "title",
      oldValue: "a",
      newValue: "b",
    });
  });

  it("describes setting and clearing a field", () => {
    expect(
      describeHistoryEntry({ field: "note", oldValue: null, newValue: "hi" }),
    ).toEqual({ kind: "set", field: "note", value: "hi" });
    expect(
      describeHistoryEntry({ field: "title", oldValue: "a", newValue: null }),
    ).toEqual({ kind: "cleared", field: "title", oldValue: "a" });
  });

  it("describes tag and list rows by the side that holds the name", () => {
    expect(
      describeHistoryEntry({ field: "tags", oldValue: null, newValue: "news" }),
    ).toEqual({ kind: "tag_added", value: "news" });
    expect(
      describeHistoryEntry({ field: "tags", oldValue: "news", newValue: null }),
    ).toEqual({ kind: "tag_removed", value: "news" });
    expect(
      describeHistoryEntry({
        field: "lists",
        oldValue: null,
        newValue: "Read",
      }),
    ).toEqual({ kind: "list_added", value: "Read" });
    expect(
      describeHistoryEntry({
        field: "lists",
        oldValue: "Read",
        newValue: null,
      }),
    ).toEqual({ kind: "list_removed", value: "Read" });
  });

  it("describes archive and favourite as toggles", () => {
    expect(
      describeHistoryEntry({
        field: "archived",
        oldValue: "false",
        newValue: "true",
      }),
    ).toEqual({ kind: "toggled", field: "archived", on: true });
    expect(
      describeHistoryEntry({
        field: "favourited",
        oldValue: "true",
        newValue: "false",
      }),
    ).toEqual({ kind: "toggled", field: "favourited", on: false });
  });

  it("formats date fields as local dates", () => {
    expect(
      describeHistoryEntry(
        {
          field: "datePublished",
          oldValue: null,
          newValue: "2025-01-05T12:00:00.000Z",
        },
        "en",
      ),
    ).toEqual({ kind: "set", field: "datePublished", value: "Jan 5, 2025" });
  });

  it("formats both sides of a changed date", () => {
    expect(
      describeHistoryEntry(
        {
          field: "createdAt",
          oldValue: "2025-01-05T12:00:00.000Z",
          newValue: "2025-02-10T12:00:00.000Z",
        },
        "en",
      ),
    ).toEqual({
      kind: "changed",
      field: "createdAt",
      oldValue: "Jan 5, 2025",
      newValue: "Feb 10, 2025",
    });
  });

  it("shows an unparseable date as stored instead of crashing", () => {
    expect(
      describeHistoryEntry({
        field: "dateModified",
        oldValue: "not-a-date",
        newValue: null,
      }),
    ).toEqual({
      kind: "cleared",
      field: "dateModified",
      oldValue: "not-a-date",
    });
  });

  it("doesn't treat non-date fields that look like dates as dates", () => {
    expect(
      describeHistoryEntry({
        field: "title",
        oldValue: null,
        newValue: "2025-01-05T12:00:00.000Z",
      }),
    ).toEqual({
      kind: "set",
      field: "title",
      value: "2025-01-05T12:00:00.000Z",
    });
  });

  it("falls back to an empty name when a tag or list row has none", () => {
    expect(
      describeHistoryEntry({ field: "tags", oldValue: null, newValue: null }),
    ).toEqual({ kind: "tag_removed", value: "" });
    expect(
      describeHistoryEntry({ field: "lists", oldValue: null, newValue: null }),
    ).toEqual({ kind: "list_removed", value: "" });
  });

  it("treats a toggle row with a missing new value as off", () => {
    expect(
      describeHistoryEntry({
        field: "archived",
        oldValue: "true",
        newValue: null,
      }),
    ).toEqual({ kind: "toggled", field: "archived", on: false });
  });

  it("handles a field row with neither side set", () => {
    expect(
      describeHistoryEntry({ field: "author", oldValue: null, newValue: null }),
    ).toEqual({ kind: "set", field: "author", value: "" });
  });
});

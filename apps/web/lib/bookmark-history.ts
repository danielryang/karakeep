import { formatLocalDate } from "@/lib/date-format";

import type { ZBookmarkHistoryEntry } from "@karakeep/shared/types/bookmarkHistory";
import {
  BOOKMARK_HISTORY_LISTS_FIELD,
  BOOKMARK_HISTORY_TAGS_FIELD,
} from "@karakeep/shared/types/bookmarkHistory";

// What a single history entry says happened, independent of wording so the
// component can translate it and tests can check it without rendering.
export type BookmarkHistoryChange =
  | { kind: "tag_added" | "tag_removed"; value: string }
  | { kind: "list_added" | "list_removed"; value: string }
  | { kind: "toggled"; field: "archived" | "favourited"; on: boolean }
  | { kind: "set"; field: string; value: string }
  | { kind: "cleared"; field: string; oldValue: string }
  | { kind: "changed"; field: string; oldValue: string; newValue: string };

const DATE_FIELDS = new Set(["createdAt", "datePublished", "dateModified"]);

// Dates are stored as ISO strings; show them as local dates instead.
function formatValue(field: string, value: string, language?: string) {
  if (DATE_FIELDS.has(field)) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) {
      return formatLocalDate(date, "PP", language);
    }
  }
  return value;
}

export function describeHistoryEntry(
  entry: Pick<ZBookmarkHistoryEntry, "field" | "oldValue" | "newValue">,
  language?: string,
): BookmarkHistoryChange {
  const { field, oldValue, newValue } = entry;

  // Tag and list rows carry the name on whichever side it was attached.
  if (field === BOOKMARK_HISTORY_TAGS_FIELD) {
    return newValue !== null
      ? { kind: "tag_added", value: newValue }
      : { kind: "tag_removed", value: oldValue ?? "" };
  }
  if (field === BOOKMARK_HISTORY_LISTS_FIELD) {
    return newValue !== null
      ? { kind: "list_added", value: newValue }
      : { kind: "list_removed", value: oldValue ?? "" };
  }
  if (field === "archived" || field === "favourited") {
    return { kind: "toggled", field, on: newValue === "true" };
  }

  if (oldValue === null) {
    return {
      kind: "set",
      field,
      value: formatValue(field, newValue ?? "", language),
    };
  }
  if (newValue === null) {
    return {
      kind: "cleared",
      field,
      oldValue: formatValue(field, oldValue, language),
    };
  }
  return {
    kind: "changed",
    field,
    oldValue: formatValue(field, oldValue, language),
    newValue: formatValue(field, newValue, language),
  };
}

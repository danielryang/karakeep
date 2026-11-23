import { z } from "zod";

export const zBookmarkHistorySourceSchema = z.enum(["user", "ai", "rule"]);
export type ZBookmarkHistorySource = z.infer<
  typeof zBookmarkHistorySourceSchema
>;

// Pseudo field names for the non-column changes we track.
export const BOOKMARK_HISTORY_TAGS_FIELD = "tags";
export const BOOKMARK_HISTORY_LISTS_FIELD = "lists";

// Owner-only state. Collaborators never see these on the bookmark itself
// (see Bookmark.asZBookmark), so they must not see them in its history either.
export const OWNER_ONLY_BOOKMARK_HISTORY_FIELDS: readonly string[] = [
  "note",
  "archived",
  "favourited",
];

export const zBookmarkHistoryEntrySchema = z.object({
  id: z.string(),
  bookmarkId: z.string(),
  field: z.string(),
  // The tag or list id when field is "tags" / "lists".
  refId: z.string().nullable(),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  source: zBookmarkHistorySourceSchema,
  createdAt: z.date(),
  // Null for system changes or when the acting user no longer exists.
  user: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type ZBookmarkHistoryEntry = z.infer<typeof zBookmarkHistoryEntrySchema>;

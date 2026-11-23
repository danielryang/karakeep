import { useEffect, useRef, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import RelativeTime from "@/components/ui/relative-time";
import { Separator } from "@/components/ui/separator";
import { describeHistoryEntry } from "@/lib/bookmark-history";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";

import type { ZBookmarkHistoryEntry } from "@karakeep/shared/types/bookmarkHistory";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { useTRPC } from "@karakeep/shared-react/trpc";

// Long values (notes, page text) are clamped; the full value is in the tooltip.
function Value({ value, struck }: { value: string; struck?: boolean }) {
  return (
    <span
      title={value}
      className={cn(
        "line-clamp-2 break-words",
        struck ? "text-muted-foreground line-through" : "text-foreground",
      )}
    >
      {value}
    </span>
  );
}

function HistoryRow({ entry }: { entry: ZBookmarkHistoryEntry }) {
  const { t, i18n } = useTranslation();
  const change = describeHistoryEntry(entry, i18n.language);
  const fieldLabel = (field: string) =>
    t(`preview.history.fields.${field}`, { defaultValue: field });

  let body: React.ReactNode;
  switch (change.kind) {
    case "tag_added":
    case "tag_removed":
    case "list_added":
    case "list_removed":
      body = (
        <span>
          {t(`preview.history.${change.kind}`)}{" "}
          <span className="font-medium text-foreground">{change.value}</span>
        </span>
      );
      break;
    case "toggled":
      body = t(`preview.history.${change.field}_${change.on ? "on" : "off"}`);
      break;
    case "set":
      body = (
        <>
          <span>
            {t("preview.history.set", { field: fieldLabel(change.field) })}
          </span>
          <Value value={change.value} />
        </>
      );
      break;
    case "cleared":
      body = (
        <>
          <span>
            {t("preview.history.cleared", { field: fieldLabel(change.field) })}
          </span>
          <Value value={change.oldValue} struck />
        </>
      );
      break;
    case "changed":
      body = (
        <>
          <span>
            {t("preview.history.changed", { field: fieldLabel(change.field) })}
          </span>
          <Value value={change.oldValue} struck />
          <Value value={change.newValue} />
        </>
      );
      break;
  }

  const actor =
    entry.source === "ai"
      ? t("preview.history.by_ai")
      : entry.source === "rule"
        ? t("preview.history.by_rule")
        : (entry.user?.name ?? t("preview.history.by_unknown"));

  return (
    <li className="flex flex-col gap-1 border-l-2 border-border pl-3">
      <div className="flex flex-col gap-0.5">{body}</div>
      <span className="text-xs text-muted-foreground">
        {actor} · <RelativeTime date={entry.createdAt} />
      </span>
    </li>
  );
}

export default function HistoryBox({
  bookmark,
}: {
  bookmark: Pick<ZBookmark, "id" | "modifiedAt" | "tags">;
}) {
  const api = useTRPC();
  const { t } = useTranslation();
  // Collapsed by default: history can be long and is secondary to the details.
  const [isOpen, setIsOpen] = useState(false);

  const { data: history, refetch } = useQuery(
    api.bookmarks.getHistory.queryOptions({ bookmarkId: bookmark.id }),
  );

  // Background jobs (AI tagging, rules) change the bookmark without going
  // through a mutation hook here. The preview already polls the bookmark while
  // those run, so refetch history whenever the bookmark we're handed changes.
  const version = `${bookmark.modifiedAt?.valueOf() ?? ""}|${bookmark.tags
    .map((tag) => tag.id)
    .join()}`;
  const lastVersion = useRef(version);
  useEffect(() => {
    if (lastVersion.current !== version) {
      lastVersion.current = version;
      void refetch();
    }
  }, [version, refetch]);

  if (!history || history.length === 0) {
    return null;
  }

  return (
    <>
      <Separator />
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="flex min-h-8 w-full items-center justify-between gap-2 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 max-sm:min-h-11 [@media(pointer:coarse)]:min-h-11">
          <span className="flex items-center gap-2">
            {t("preview.history.title")}
            <span className="font-normal tabular-nums">{history.length}</span>
          </span>
          <ChevronRight
            className={cn("size-4 transition-transform", isOpen && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* The endpoint already returns newest first. */}
          <ol className="flex flex-col gap-3 py-3 text-sm text-muted-foreground">
            {history.map((entry) => (
              <HistoryRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

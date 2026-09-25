import type { EnvironmentId, ProviderAccountActivityEntry } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  GaugeIcon,
  HistoryIcon,
  LogInIcon,
  PencilIcon,
  RotateCcwIcon,
  Settings2Icon,
  TerminalIcon,
  TimerIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserPlusIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { ClaudeAI, OpenAI } from "../Icons";
import { SettingsGroup } from "../settings/SettingsGroup";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ACCOUNT_DRIVER_LABELS } from "./accounts.logic";
import {
  ACTIVITY_END_TEXT,
  ACTIVITY_MAX_ENTRIES,
  activityClock,
  activityInput,
  activityText,
  activityTimestamp,
  activityView,
  groupActivityByDay,
  type ActivityFilter,
  type ActivityIcon,
} from "./activity.logic";
import { providerAccountsEnvironment } from "./state";

/**
 * Time, kind icon, provider mark, sentence, Auto badge. Narrow views (< 36rem) move the
 * detail under the sentence; time and icon keep their columns.
 */
const ACTIVITY_ROW_GRID =
  "grid min-h-9 grid-cols-[2.75rem_1rem_1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2";

const ICONS: Record<ActivityIcon, LucideIcon> = {
  switch: ArrowLeftRightIcon,
  auto: ZapIcon,
  window: TimerIcon,
  added: UserPlusIcon,
  login: LogInIcon,
  removed: Trash2Icon,
  renamed: PencilIcon,
  excluded: CircleSlashIcon,
  included: CircleCheckIcon,
  terminal: TerminalIcon,
  settings: Settings2Icon,
  failed: TriangleAlertIcon,
  rateLimit: GaugeIcon,
  recovery: RotateCcwIcon,
};
const TONES = {
  default: "text-muted-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
} as const;
const FILTERS: readonly { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "claudeAgent", label: ACCOUNT_DRIVER_LABELS.claudeAgent },
  { value: "codex", label: ACCOUNT_DRIVER_LABELS.codex },
];

function ActivityRow({ entry, now }: { entry: ProviderAccountActivityEntry; now: number }) {
  const view = activityView(entry);
  const Icon = ICONS[view.icon];
  const Mark = entry.driver === "claudeAgent" ? ClaudeAI : OpenAI;
  const clock = activityClock(entry.at);
  const detailTooltip = [view.detail, view.tooltip].filter(Boolean).join(" · ");
  return (
    <li aria-label={`${clock}, ${activityText(view)}`} className={ACTIVITY_ROW_GRID}>
      <Tooltip>
        <TooltipTrigger
          render={
            <time
              dateTime={entry.at}
              className="text-xs text-muted-foreground tabular-nums @max-[36rem]/activity:self-start @max-[36rem]/activity:pt-0.5"
            />
          }
        >
          {clock}
        </TooltipTrigger>
        <TooltipPopup>{activityTimestamp(entry.at, now)}</TooltipPopup>
      </Tooltip>
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 @max-[36rem]/activity:mt-0.5 @max-[36rem]/activity:self-start",
          TONES[view.tone],
        )}
      />
      <Mark
        aria-hidden
        className="size-3.5 @max-[36rem]/activity:mt-0.5 @max-[36rem]/activity:self-start"
      />
      <div className="flex min-w-0 items-baseline gap-x-1.5 @max-[36rem]/activity:flex-col @max-[36rem]/activity:gap-y-0.5">
        <span className="max-w-full shrink-0 truncate text-sm">
          {view.parts.map((part, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- A sentence's parts never reorder.
            <span key={index} className={part.strong ? "font-medium" : undefined}>
              {part.text}
            </span>
          ))}
        </span>
        {view.detail ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="min-w-0 truncate text-xs text-muted-foreground @max-[36rem]/activity:max-w-full" />
              }
            >
              <span aria-hidden className="@max-[36rem]/activity:hidden">
                ·{" "}
              </span>
              {view.detail}
            </TooltipTrigger>
            <TooltipPopup className="max-w-sm">{detailTooltip}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {view.auto ? (
        <Badge variant="outline" size="sm" className="@max-[36rem]/activity:self-start" aria-hidden>
          Auto
        </Badge>
      ) : (
        <span />
      )}
    </li>
  );
}

/** Same grid and height as a real row, so nothing moves when entries arrive. */
const SKELETON_SENTENCES = [
  <Skeleton key="a" className="h-3.5 w-[62%]" />,
  <Skeleton key="b" className="h-3.5 w-[48%]" />,
  <Skeleton key="c" className="h-3.5 w-[70%]" />,
  <Skeleton key="d" className="h-3.5 w-[40%]" />,
  <Skeleton key="e" className="h-3.5 w-[56%]" />,
  <Skeleton key="f" className="h-3.5 w-[66%]" />,
];
function ActivitySkeleton() {
  return (
    <SettingsGroup variant="grouped" divided aria-hidden>
      <ul className="divide-y divide-border/50">
        {SKELETON_SENTENCES.map((sentence) => (
          <li key={sentence.key} className={ACTIVITY_ROW_GRID}>
            <Skeleton className="h-3 w-9" />
            <Skeleton shape="pill" className="size-3.5" />
            <Skeleton shape="pill" className="size-3.5" />
            {sentence}
            <span />
          </li>
        ))}
      </ul>
    </SettingsGroup>
  );
}

/**
 * The account switcher's log, opened over the Accounts dialog. Escape (or Back) returns to
 * the accounts; the list is fetched only while this is open and refreshes on new entries.
 */
export function AccountActivityDialog({
  open,
  onOpenChange,
  environmentId,
  deviceLabel,
  now,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  deviceLabel: string;
  now: number;
}) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [pages, setPages] = useState(1);
  const filterRef = useRef<HTMLButtonElement>(null);
  const page = (count: number) =>
    open
      ? providerAccountsEnvironment.activity({ environmentId, input: activityInput(filter, count) })
      : null;
  const query = useEnvironmentQuery(page(pages));
  // "Load more" asks for a larger page; the smaller one stays mounted so its rows stay on
  // screen until the larger one arrives.
  const previous = useEnvironmentQuery(pages > 1 ? page(pages - 1) : null);
  const data = query.data ?? previous.data;
  const loadingMore = query.data === null && data !== null && query.error === null;
  const entries = data?.entries ?? [];
  const hasMore = Boolean(data?.nextCursor) && entries.length < ACTIVITY_MAX_ENTRIES;
  const days = groupActivityByDay(entries, now);
  const providerName = filter === "all" ? null : ACCOUNT_DRIVER_LABELS[filter];
  const body =
    data === null && query.error ? (
      <Alert variant="error">
        <TriangleAlertIcon />
        <AlertTitle>Couldn't load activity</AlertTitle>
        <AlertDescription>{query.error}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="xs" onClick={query.refresh}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    ) : data === null ? (
      <ActivitySkeleton />
    ) : entries.length === 0 ? (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyTitle>No {providerName ? `${providerName} ` : ""}activity yet</EmptyTitle>
          <EmptyDescription>
            Switches, window starts and sign-ins will show up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <div className="grid gap-3">
        {days.map((day) => (
          <section key={day.key} aria-label={day.label}>
            <h3 className="sticky top-0 z-10 flex h-8 items-center bg-popover/95 text-xs font-medium text-muted-foreground backdrop-blur-sm">
              {day.label}
            </h3>
            <SettingsGroup variant="grouped" divided>
              <ul aria-label={`Activity on ${day.label}`} className="divide-y divide-border/50">
                {day.entries.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} now={now} />
                ))}
              </ul>
            </SettingsGroup>
          </section>
        ))}
        {hasMore ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={loadingMore}
            onClick={() => setPages((current) => current + 1)}
          >
            {loadingMore ? <Spinner size="sm" /> : null}
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        ) : (
          <p className="py-1 text-center text-xs text-muted-foreground">{ACTIVITY_END_TEXT}</p>
        )}
      </div>
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup initialFocus={filterRef} className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Activity</DialogTitle>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <DialogDescription className="min-w-0 flex-1">
              What the account switcher did on {deviceLabel}.
            </DialogDescription>
            <ToggleGroup
              aria-label="Show activity for"
              className="max-sm:w-full max-sm:*:flex-1"
              value={[filter]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "all" || value === "claudeAgent" || value === "codex") {
                  setFilter(value);
                  setPages(1);
                }
              }}
            >
              {FILTERS.map((item) => (
                <Toggle
                  key={item.value}
                  value={item.value}
                  ref={item.value === filter ? filterRef : undefined}
                >
                  {item.label}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        </DialogHeader>
        <DialogPanel>
          <div
            aria-busy={data === null || loadingMore || undefined}
            className="@container/activity"
          >
            {body}
          </div>
        </DialogPanel>
        <DialogFooter>
          <p className="mr-auto text-xs text-muted-foreground">
            Kept on {deviceLabel}: the last {ACTIVITY_MAX_ENTRIES} events.
          </p>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            <ArrowLeftIcon />
            Accounts
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

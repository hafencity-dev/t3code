import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAccount,
  ProviderAccountGroup,
  ProviderAccountId,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  LogOutIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AccountActionsMenu } from "./AccountActionsMenu";
import { AccountFreshnessCell } from "./AccountFreshnessCell";
import { AccountUsageCell } from "./AccountUsageCell";
import {
  accountPrimaryAction,
  accountStatusMessage,
  accountSubtitle,
  nextAccountReason,
  removeBlockedReason,
  renameRestoresFocus,
  shortPlanLabel,
  switchBlockedReason,
  type AccountFreshness,
  type AccountStatusMessage,
  type SwitchState,
} from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";
import { SwitchAccountAction } from "./SwitchAccountAction";

/**
 * Shared by the column header, account rows and hint rows so every value keeps its column.
 * Narrow sections (< 44rem) stack usage and freshness under the identity instead.
 */
export const ACCOUNT_ROW_GRID =
  "grid items-center gap-x-4 px-3 py-2.5 grid-cols-[0.5rem_minmax(0,1fr)_8rem_8rem_7rem_8.5rem] @max-[44rem]/accounts:grid-cols-[0.5rem_minmax(0,1fr)_auto] @max-[44rem]/accounts:gap-y-2";

// Narrow placement keeps DOM order (refresh → primary → menu) while actions sit on row 1.
const NARROW_DOT = "@max-[44rem]/accounts:col-start-1 @max-[44rem]/accounts:row-start-1";
const NARROW_IDENTITY = "@max-[44rem]/accounts:col-start-2 @max-[44rem]/accounts:row-start-1";
const NARROW_USAGE =
  "contents @max-[44rem]/accounts:col-span-2 @max-[44rem]/accounts:col-start-2 @max-[44rem]/accounts:row-start-2 @max-[44rem]/accounts:grid @max-[44rem]/accounts:grid-cols-2 @max-[44rem]/accounts:gap-3";
const NARROW_CHECKED =
  "@max-[44rem]/accounts:col-span-2 @max-[44rem]/accounts:col-start-2 @max-[44rem]/accounts:row-start-3";
const NARROW_ACTIONS = "@max-[44rem]/accounts:col-start-3 @max-[44rem]/accounts:row-start-1";
const NARROW_MESSAGE =
  "@max-[44rem]/accounts:col-span-2 @max-[44rem]/accounts:col-start-2 @max-[44rem]/accounts:row-span-2 @max-[44rem]/accounts:row-start-2";

const STATUS_ICONS = {
  copy: CopyIcon,
  signedOut: LogOutIcon,
  alert: TriangleAlertIcon,
  clock: ClockIcon,
} as const;
const STATUS_TONES = {
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
  muted: "text-muted-foreground",
} as const;

function StatusMessage({
  message,
  className,
}: {
  message: AccountStatusMessage;
  className: string;
}) {
  const Icon = STATUS_ICONS[message.icon];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex min-w-0 items-start gap-1.5 text-xs",
              STATUS_TONES[message.tone],
              className,
            )}
          />
        }
      >
        <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
        <span className="line-clamp-2">{message.text}</span>
      </TooltipTrigger>
      <TooltipPopup>{message.text}</TooltipPopup>
    </Tooltip>
  );
}

type RenameEnd = Parameters<typeof renameRestoresFocus>[0];

function RenameInput({
  account,
  environmentId,
  onDone,
}: {
  account: ProviderAccount;
  environmentId: EnvironmentId;
  onDone: (how: RenameEnd) => void;
}) {
  const [name, setName] = useState(account.label);
  const [saving, setSaving] = useState(false);
  // State lags a render; the ref stops a blur during the request from saving twice.
  const savingRef = useRef(false);
  const settled = useRef(false);
  // Blur only counts once the input owns focus: the closing menu may briefly hold it.
  const armed = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
      armed.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const rename = useAtomCommand(providerAccountsEnvironment.rename, { reportFailure: false });
  const finish = (how: RenameEnd) => {
    if (settled.current) return;
    settled.current = true;
    onDone(how);
  };
  const save = async (how: Exclude<RenameEnd, "escape">) => {
    if (savingRef.current || settled.current) return;
    const label = name.trim();
    // An empty or unchanged value reverts to the old label.
    if (!label || label === account.label) return finish(how);
    savingRef.current = true;
    setSaving(true);
    const result = await rename({ environmentId, input: { accountId: account.id, label } });
    savingRef.current = false;
    setSaving(false);
    if (result._tag === "Success") finish(how);
    else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't rename account",
        description: error instanceof Error ? error.message : "Please try again.",
      });
      // Keep editing so the name can be fixed or the rename cancelled with Escape.
      inputRef.current?.focus();
    }
  };
  return (
    <form
      className="min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        void save("enter");
      }}
    >
      <Input
        size="sm"
        aria-label="Account name"
        maxLength={40}
        value={name}
        // Read-only, not disabled: a disabled input drops focus mid-save.
        readOnly={saving}
        aria-busy={saving || undefined}
        ref={inputRef}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (armed.current) void save("blur");
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Escape closes the rename, never the dialog.
          event.stopPropagation();
          event.preventDefault();
          finish("escape");
        }}
      />
    </form>
  );
}

/** One account in the fixed grid. Every state replaces a cell's content, never adds lines. */
export function AccountRow({
  account,
  group,
  environmentId,
  now,
  freshness,
  best,
  keeperLabel,
  renaming,
  signingIn,
  resetChecking,
  switchState,
  menuTriggerRef,
  onRenameStart,
  onRenameEnd,
  onSwitchStart,
  onSwitchEnd,
  onRefresh,
  onSignIn,
  onRemove,
}: {
  account: ProviderAccount;
  group: ProviderAccountGroup;
  environmentId: EnvironmentId;
  now: number;
  freshness: AccountFreshness | null;
  best: boolean;
  keeperLabel: string;
  renaming: boolean;
  signingIn: boolean;
  /** A passed reset will actually be checked; otherwise the cells never say `checking…`. */
  resetChecking: boolean;
  switchState: SwitchState;
  menuTriggerRef: Ref<HTMLButtonElement>;
  onRenameStart: () => void;
  onRenameEnd: (how: RenameEnd) => void;
  onSwitchStart: (accountId: ProviderAccountId) => void;
  onSwitchEnd: (accountId: ProviderAccountId) => void;
  onRefresh: () => void;
  onSignIn: () => void;
  onRemove: () => void;
}) {
  const message = accountStatusMessage(account, keeperLabel);
  const unsupported = account.usage?.unavailable?.reason === "unsupported";
  const windows = account.usage?.windows ?? [];
  const primary = accountPrimaryAction(account, group, switchState);
  const switchReason = switchBlockedReason(group, switchState);
  const subtitle = accountSubtitle(account);
  const removeReason = removeBlockedReason(account, signingIn);
  const removeButton = (
    <Button
      variant="destructive-outline"
      size="xs"
      className="w-full"
      aria-label={`Remove ${account.label}, same account as ${keeperLabel}`}
      // aria-disabled keeps the button focusable so its reason stays reachable.
      aria-disabled={removeReason ? true : undefined}
      onClick={() => {
        if (!removeReason) onRemove();
      }}
    >
      <Trash2Icon />
      Remove
    </Button>
  );
  const ariaLabel = [account.label, account.active ? "active" : null, message?.text]
    .filter(Boolean)
    .join(", ");
  return (
    <li
      aria-label={ariaLabel}
      data-active={account.active ? "" : undefined}
      className={cn(ACCOUNT_ROW_GRID, "data-active:bg-muted/40")}
    >
      <span className={cn("flex items-center justify-center", NARROW_DOT)}>
        {account.active ? (
          <>
            <span aria-hidden className="size-2 rounded-full bg-primary" />
            <span className="sr-only">Active</span>
          </>
        ) : null}
      </span>
      <div className={cn("grid min-w-0", NARROW_IDENTITY)}>
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          {renaming ? (
            <RenameInput account={account} environmentId={environmentId} onDone={onRenameEnd} />
          ) : (
            <>
              <span className="truncate text-sm font-medium">{account.label}</span>
              {account.plan ? (
                <Tooltip>
                  <TooltipTrigger render={<Badge variant="outline" size="sm" />}>
                    {shortPlanLabel(account.plan)}
                  </TooltipTrigger>
                  <TooltipPopup>{account.plan}</TooltipPopup>
                </Tooltip>
              ) : null}
              {best ? (
                <Tooltip>
                  <TooltipTrigger render={<Badge variant="success" size="sm" />}>
                    Best option
                  </TooltipTrigger>
                  <TooltipPopup>{nextAccountReason(account, now)}</TooltipPopup>
                </Tooltip>
              ) : null}
            </>
          )}
        </div>
        <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
      </div>
      {message ? (
        <StatusMessage message={message} className={cn("col-span-3", NARROW_MESSAGE)} />
      ) : (
        <>
          {unsupported ? (
            <p
              className={cn(
                "col-span-2 truncate text-xs text-muted-foreground",
                "@max-[44rem]/accounts:col-span-2 @max-[44rem]/accounts:col-start-2 @max-[44rem]/accounts:row-start-2",
              )}
            >
              This login doesn't report usage limits.
            </p>
          ) : (
            <div className={NARROW_USAGE}>
              <AccountUsageCell
                kind="session"
                windows={windows}
                now={now}
                checking={resetChecking}
              />
              <AccountUsageCell
                kind="weekly"
                windows={windows}
                now={now}
                checking={resetChecking}
              />
            </div>
          )}
          <div className={cn("min-w-0", NARROW_CHECKED)}>
            {freshness ? (
              <AccountFreshnessCell
                freshness={freshness}
                label={account.label}
                onRefresh={onRefresh}
              />
            ) : null}
          </div>
        </>
      )}
      <div className={cn("flex items-center justify-end gap-1", NARROW_ACTIONS)}>
        <div className="flex w-24 justify-end">
          {primary.kind === "switch" || primary.kind === "switching" ? (
            <SwitchAccountAction
              environmentId={environmentId}
              switchMode={group.switchMode}
              accountId={account.id}
              label={account.label}
              fill
              busy={primary.kind === "switching"}
              disabledReason={switchReason}
              onStart={onSwitchStart}
              onEnd={onSwitchEnd}
            />
          ) : primary.kind === "switchToKeeper" ? (
            <SwitchAccountAction
              environmentId={environmentId}
              switchMode={group.switchMode}
              accountId={primary.keeper.id}
              label={primary.keeper.label}
              fill
              disabledReason={switchReason}
              onStart={onSwitchStart}
              onEnd={onSwitchEnd}
            >
              {`Switch to ${primary.keeper.label}`}
            </SwitchAccountAction>
          ) : primary.kind === "remove" ? (
            removeReason ? (
              <Tooltip>
                <TooltipTrigger render={removeButton} />
                <TooltipPopup>{removeReason}</TooltipPopup>
              </Tooltip>
            ) : (
              removeButton
            )
          ) : primary.kind === "signIn" ? (
            <Button variant="outline" size="xs" className="w-full" onClick={onSignIn}>
              Sign in
            </Button>
          ) : (
            <Badge variant="success" size="control" className="w-full">
              <CheckIcon />
              Active
            </Badge>
          )}
        </div>
        <AccountActionsMenu
          account={account}
          triggerRef={menuTriggerRef}
          removeBlockedReason={removeReason}
          editBlockedReason={switchState === "self" ? "Wait for the switch to finish." : undefined}
          onRename={onRenameStart}
          onSignIn={onSignIn}
          onRemove={onRemove}
        />
      </div>
    </li>
  );
}

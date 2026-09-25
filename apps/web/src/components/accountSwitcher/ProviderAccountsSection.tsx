import type {
  EnvironmentId,
  ProviderAccount,
  ProviderAccountAutoSwitchEvent,
  ProviderAccountDriver,
  ProviderAccountGroup,
  ProviderAccountId,
} from "@t3tools/contracts";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { ClaudeAI, OpenAI } from "../Icons";
import { SettingsGroup } from "../settings/SettingsGroup";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ACCOUNT_ROW_GRID, AccountRow } from "./AccountRow";
import { AddAccountWizard } from "./AddAccountWizard";
import { AutoSwitchBar } from "./AutoSwitchBar";
import {
  ACCOUNT_DRIVER_LABELS,
  accountFreshness,
  accountSwitchState,
  duplicateKeeperLabel,
  endRename,
  endSwitch,
  orderedAccounts,
  readyAccountCount,
  renameRestoresFocus,
  usageResetCheckWillRun,
} from "./accounts.logic";
import { RemoveAccountDialog } from "./RemoveAccountDialog";

const SWITCH_NOTES = {
  hot: "Switches instantly. Running sessions keep going.",
  restart: "Switching restarts Codex. Running turns stop only after you confirm.",
} as const;

/** One provider: header, warning, and a card with the column header, rows and auto-switch. */
export function ProviderAccountsSection({
  driver,
  group,
  environmentId,
  deviceLabel,
  now,
  refreshingIds,
  cooldownUntil,
  resetChecksAttempted,
  onRefresh,
  autoEvent,
}: {
  driver: ProviderAccountDriver;
  group?: ProviderAccountGroup | undefined;
  environmentId: EnvironmentId;
  deviceLabel: string;
  now: number;
  refreshingIds: ReadonlySet<ProviderAccountId>;
  cooldownUntil: ReadonlyMap<ProviderAccountId, number>;
  /** Reset keys the dialog already refreshed the active account for. */
  resetChecksAttempted: ReadonlySet<string>;
  onRefresh: (account: ProviderAccount) => void;
  autoEvent?: ProviderAccountAutoSwitchEvent | undefined;
}) {
  const provider = ACCOUNT_DRIVER_LABELS[driver];
  const Mark = driver === "claudeAgent" ? ClaudeAI : OpenAI;
  const headingId = useId();
  const [renamingId, setRenamingId] = useState<ProviderAccountId | null>(null);
  const [switchingId, setSwitchingId] = useState<ProviderAccountId | null>(null);
  // `account` set means sign in again; otherwise add a new account.
  const [wizard, setWizard] = useState<{ account?: ProviderAccount } | null>(null);
  const [removing, setRemoving] = useState<ProviderAccount | null>(null);
  const focusAfterRemoval = useRef<{
    removedId: ProviderAccountId;
    nextId: ProviderAccountId | null;
  } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const menuTriggers = useRef(new Map<ProviderAccountId, HTMLButtonElement>());
  const accounts = orderedAccounts(group?.accounts ?? []);
  const signingInId = wizard?.account?.id;
  // After removal, focus the next row's menu, or Add account once the row is gone.
  const serverAccounts = group?.accounts;
  useEffect(() => {
    const pending = focusAfterRemoval.current;
    if (!pending || serverAccounts?.some((account) => account.id === pending.removedId)) return;
    focusAfterRemoval.current = null;
    const next = pending.nextId && menuTriggers.current.get(pending.nextId);
    (next || addButtonRef.current)?.focus();
  }, [serverAccounts]);
  const readyCount = readyAccountCount(accounts);
  const onSwitchStart = (accountId: ProviderAccountId) => setSwitchingId(accountId);
  const onSwitchEnd = (accountId: ProviderAccountId) =>
    setSwitchingId((current) => endSwitch(current, accountId));
  const openAdd = () => setWizard({});
  const header = (
    <div className="flex min-h-7 min-w-0 items-center gap-2">
      <Mark aria-hidden className="size-4 shrink-0" />
      <h3 id={headingId} className="shrink-0 text-sm font-medium">
        {provider}
      </h3>
      {group ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className="min-w-0 truncate text-xs text-muted-foreground" />}
          >
            {SWITCH_NOTES[group.switchMode]}
          </TooltipTrigger>
          <TooltipPopup>{SWITCH_NOTES[group.switchMode]}</TooltipPopup>
        </Tooltip>
      ) : null}
      <span className="ml-auto shrink-0">
        <Button ref={addButtonRef} variant="outline" size="xs" disabled={!group} onClick={openAdd}>
          <PlusIcon />
          Add account
        </Button>
      </span>
    </div>
  );
  return (
    <section className="@container/accounts grid gap-2" aria-labelledby={headingId}>
      {header}
      {group?.warning ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertDescription>{group.warning}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsGroup variant="grouped" divided>
        {!group ? (
          <p className="px-3 py-2.5 text-sm text-muted-foreground">
            {provider} isn't set up on this device. Enable it in Settings → Providers.
          </p>
        ) : accounts.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>No {provider} login yet</EmptyTitle>
              <EmptyDescription>Add an account to use {provider} here.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={openAdd}>
                Add account
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <div
              aria-hidden
              className={cn(
                ACCOUNT_ROW_GRID,
                "py-1.5 text-xs text-muted-foreground @max-[44rem]/accounts:hidden",
              )}
            >
              <span />
              <span>Account</span>
              <span>5-hour limit</span>
              <span>Weekly limit</span>
              <span>Checked</span>
              <span />
            </div>
            <ul className="divide-y divide-border/50">
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  group={group}
                  environmentId={environmentId}
                  now={now}
                  freshness={accountFreshness(account, now, {
                    refreshing: refreshingIds.has(account.id),
                    cooldownUntil: cooldownUntil.get(account.id),
                  })}
                  best={group.nextAccountId === account.id}
                  keeperLabel={duplicateKeeperLabel(account, group)}
                  renaming={renamingId === account.id}
                  signingIn={signingInId === account.id}
                  resetChecking={
                    refreshingIds.has(account.id) ||
                    usageResetCheckWillRun(account, now, resetChecksAttempted)
                  }
                  switchState={accountSwitchState(switchingId, account.id)}
                  menuTriggerRef={(element) => {
                    if (element) menuTriggers.current.set(account.id, element);
                    else menuTriggers.current.delete(account.id);
                  }}
                  onRenameStart={() => setRenamingId(account.id)}
                  onRenameEnd={(how) => {
                    setRenamingId((current) => endRename(current, account.id));
                    if (renameRestoresFocus(how)) menuTriggers.current.get(account.id)?.focus();
                  }}
                  onSwitchStart={onSwitchStart}
                  onSwitchEnd={onSwitchEnd}
                  onRefresh={() => onRefresh(account)}
                  onSignIn={() => setWizard({ account })}
                  onRemove={() => setRemoving(account)}
                />
              ))}
              {accounts.length === 1 ? (
                <li className={cn(ACCOUNT_ROW_GRID, "text-xs text-muted-foreground")}>
                  <span />
                  <span className="col-span-5 flex min-w-0 flex-wrap items-center gap-x-2 @max-[44rem]/accounts:col-span-2">
                    Add another account to switch when this one runs low.
                    <Button variant="link" size="xs" onClick={openAdd}>
                      Add account
                    </Button>
                  </span>
                </li>
              ) : null}
            </ul>
            <AutoSwitchBar
              group={group}
              environmentId={environmentId}
              event={autoEvent}
              now={now}
              readyCount={readyCount}
              switchingId={switchingId}
              onSwitchStart={onSwitchStart}
              onSwitchEnd={onSwitchEnd}
            />
          </>
        )}
      </SettingsGroup>
      {wizard && group ? (
        <AddAccountWizard
          open
          onOpenChange={(open) => {
            if (!open) setWizard(null);
          }}
          environmentId={environmentId}
          deviceLabel={deviceLabel}
          group={group}
          account={wizard.account}
          onSwitchStart={onSwitchStart}
          onSwitchEnd={onSwitchEnd}
        />
      ) : null}
      {removing && group ? (
        <RemoveAccountDialog
          account={removing}
          environmentId={environmentId}
          deviceLabel={deviceLabel}
          keeperLabel={removing.duplicateOf ? duplicateKeeperLabel(removing, group) : undefined}
          onClose={(removed) => {
            if (removed) {
              const index = accounts.findIndex((account) => account.id === removing.id);
              const next = accounts[index + 1] ?? accounts[index - 1];
              focusAfterRemoval.current = { removedId: removing.id, nextId: next?.id ?? null };
            }
            setRemoving(null);
          }}
        />
      ) : null}
    </section>
  );
}

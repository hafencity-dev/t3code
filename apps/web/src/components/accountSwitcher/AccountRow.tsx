import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderAccountGroup, ProviderAccount } from "@t3tools/contracts";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { AccountUsage } from "./UsageBar";
import { RemoveAccountDialog } from "./RemoveAccountDialog";
import { SwitchAccountAction } from "./SwitchAccountAction";
import { providerAccountsEnvironment } from "./state";

export function AccountRow({
  account,
  environmentId,
  switchMode,
  now,
  best,
  refreshing,
  coolingDown,
  onRefreshUsage,
  onSignIn,
}: {
  account: ProviderAccount;
  environmentId: EnvironmentId;
  switchMode: ProviderAccountGroup["switchMode"];
  now: number;
  best: boolean;
  refreshing: boolean;
  coolingDown: boolean;
  /** Omitted when this account's usage cannot be refreshed. */
  onRefreshUsage?: () => void;
  onSignIn: (account: ProviderAccount) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(account.label);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const rename = useAtomCommand(providerAccountsEnvironment.rename, { reportFailure: false });
  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const result = await rename({
      environmentId,
      input: { accountId: account.id, label: name.trim() },
    });
    setSaving(false);
    if (result._tag === "Success") setRenaming(false);
    else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't rename account",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    }
  };
  const removeItem = (
    <MenuItem variant="destructive" disabled={account.active} onClick={() => setRemoving(true)}>
      {account.kind === "external" ? "Forget…" : "Remove…"}
    </MenuItem>
  );
  return (
    <div className="grid gap-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Input
                autoFocus
                aria-label="Account name"
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setRenaming(false);
                  }
                }}
              />
              <Button size="xs" type="submit" disabled={saving || !name.trim()}>
                {saving ? <Spinner /> : "Save"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={saving}
                onClick={() => setRenaming(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-medium">{account.label}</span>
              {account.active ? <Badge size="sm">Active</Badge> : null}
              {best ? (
                <Badge size="sm" variant="success">
                  Best option
                </Badge>
              ) : null}
              {account.plan ? (
                <Badge size="sm" variant="secondary">
                  {account.plan}
                </Badge>
              ) : null}
            </div>
          )}
          {account.email && account.email !== account.label ? (
            <p className="truncate text-xs text-muted-foreground">{account.email}</p>
          ) : null}
        </div>
        <div className="flex max-w-full shrink-0 items-start gap-1">
          <div className="w-44 min-w-0">
            <AccountUsage account={account} now={now} />
          </div>
          {onRefreshUsage ? (
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Refresh usage for ${account.label}`}
                  disabled={refreshing || coolingDown}
                  onClick={onRefreshUsage}
                >
                  <RefreshIcon refreshing={refreshing} />
                </Button>
              </TooltipTrigger>
              <TooltipPopup>
                {coolingDown ? "Usage was refreshed moments ago" : "Refresh usage"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex items-start gap-1">
          {!account.active && account.status === "ready" ? (
            <SwitchAccountAction
              switchMode={switchMode}
              environmentId={environmentId}
              accountId={account.id}
              label={account.label}
            />
          ) : null}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`More actions for ${account.label}`}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() => {
                  setName(account.label);
                  setRenaming(true);
                }}
              >
                Rename…
              </MenuItem>
              <MenuItem onClick={() => onSignIn(account)}>Sign in again</MenuItem>
              {account.kind !== "default" ? (
                <>
                  <MenuSeparator />
                  {account.active ? (
                    <Tooltip>
                      <TooltipTrigger render={<div />}>{removeItem}</TooltipTrigger>
                      <TooltipPopup>Switch to another account first</TooltipPopup>
                    </Tooltip>
                  ) : (
                    removeItem
                  )}
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {account.status === "error" || account.status === "signedOut" ? (
        <div className="grid gap-2">
          <Alert variant={account.status === "error" ? "error" : "warning"}>
            <TriangleAlertIcon />
            <AlertDescription>
              {account.status === "error"
                ? "Login expired. Sign in again to keep using this account."
                : "Not signed in."}
            </AlertDescription>
          </Alert>
          <div>
            <Button variant="outline" size="xs" onClick={() => onSignIn(account)}>
              Sign in again
            </Button>
          </div>
        </div>
      ) : account.status === "pending" ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          Sign-in not finished{" "}
          <Button variant="outline" size="xs" onClick={() => onSignIn(account)}>
            Sign in
          </Button>
        </div>
      ) : null}
      {removing ? (
        <RemoveAccountDialog
          account={account}
          environmentId={environmentId}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </div>
  );
}

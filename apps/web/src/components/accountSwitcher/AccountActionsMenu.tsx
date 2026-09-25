import type { ProviderAccount } from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleSlashIcon,
  EllipsisIcon,
  LogInIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, type ReactNode, type Ref } from "react";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { autoSwitchExclusionHelp } from "./accounts.logic";

/** Tooltips don't work reliably on disabled menu items, so the reason is written out. */
function ItemText({ children, reason }: { children: ReactNode; reason?: string | undefined }) {
  return (
    <span className="grid min-w-0">
      <span className="truncate">{children}</span>
      {reason ? <span className="text-xs text-muted-foreground">{reason}</span> : null}
    </span>
  );
}

/** The `⋯` menu, always in the same column: rare actions, disabled with a written reason. */
export function AccountActionsMenu({
  account,
  triggerRef,
  removeBlockedReason,
  editBlockedReason,
  exclusionBusy,
  onRename,
  onSignIn,
  onToggleAutoSwitchExcluded,
  onRemove,
}: {
  account: ProviderAccount;
  triggerRef?: Ref<HTMLButtonElement>;
  removeBlockedReason?: string | undefined;
  editBlockedReason?: string | undefined;
  /** An exclude/include request for this account is in flight. */
  exclusionBusy?: boolean | undefined;
  onRename: () => void;
  onSignIn: () => void;
  onToggleAutoSwitchExcluded: () => void;
  onRemove: () => void;
}) {
  const excluded = account.autoSwitchExcluded === true;
  // Rename focuses its own input; handing focus back to the trigger would blur it.
  const skipFinalFocus = useRef(false);
  const external = account.kind === "external";
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              ref={triggerRef}
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`More actions for ${account.label}`}
                />
              }
            />
          }
        >
          <EllipsisIcon />
        </TooltipTrigger>
        <TooltipPopup>More actions</TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="end"
        finalFocus={() => {
          const skip = skipFinalFocus.current;
          skipFinalFocus.current = false;
          return !skip;
        }}
      >
        <MenuGroup>
          <MenuItem
            disabled={Boolean(editBlockedReason)}
            onClick={() => {
              skipFinalFocus.current = true;
              onRename();
            }}
          >
            <PencilIcon />
            <ItemText reason={editBlockedReason}>Rename</ItemText>
          </MenuItem>
          <MenuItem disabled={Boolean(editBlockedReason)} onClick={onSignIn}>
            <LogInIcon />
            <ItemText reason={editBlockedReason}>Sign in again</ItemText>
          </MenuItem>
          <Tooltip>
            <TooltipTrigger
              render={<MenuItem disabled={exclusionBusy} onClick={onToggleAutoSwitchExcluded} />}
            >
              {excluded ? <CircleCheckIcon /> : <CircleSlashIcon />}
              <ItemText>
                {excluded ? "Include in auto-switch" : "Exclude from auto-switch"}
              </ItemText>
            </TooltipTrigger>
            <TooltipPopup side="left" className="max-w-xs">
              {autoSwitchExclusionHelp(excluded)}
            </TooltipPopup>
          </Tooltip>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem variant="destructive" disabled={Boolean(removeBlockedReason)} onClick={onRemove}>
          <Trash2Icon />
          <ItemText reason={removeBlockedReason}>
            {external ? "Forget account" : "Remove account"}
          </ItemText>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

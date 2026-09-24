/** Environment-owned saved accounts for the default Claude and Codex instances. */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";

export const ProviderAccountId = TrimmedNonEmptyString.pipe(Schema.brand("ProviderAccountId"));
export type ProviderAccountId = typeof ProviderAccountId.Type;

export const ProviderAccountDriver = Schema.Literals(["claudeAgent", "codex"]);
export type ProviderAccountDriver = typeof ProviderAccountDriver.Type;

// Only display metadata crosses the wire; credential files remain in the account home.
export const ProviderAccount = Schema.Struct({
  id: ProviderAccountId,
  driver: ProviderAccountDriver,
  label: TrimmedNonEmptyString,
  kind: Schema.Literals(["default", "managed", "external"]),
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  status: Schema.Literals(["ready", "pending", "signedOut", "error"]),
  active: Schema.Boolean,
  usage: Schema.optional(ServerProviderUsageLimits),
  usageRefresh: Schema.optional(
    Schema.Struct({
      nextAllowedAt: Schema.optional(IsoDateTime),
      rateLimited: Schema.optional(Schema.Boolean),
    }),
  ),
  message: Schema.optional(TrimmedNonEmptyString),
  /** Set on a saved account signed in as the same identity as this (kept) account. */
  duplicateOf: Schema.optional(ProviderAccountId),
});
export type ProviderAccount = typeof ProviderAccount.Type;

export const ProviderAccountAutoSwitchTrigger = Schema.Literals([
  "session",
  "weekly",
  "signedOut",
  "expiring",
]);
export type ProviderAccountAutoSwitchTrigger = typeof ProviderAccountAutoSwitchTrigger.Type;

export const ProviderAccountAutoSwitchLastSwitch = Schema.Struct({
  at: IsoDateTime,
  fromAccountId: ProviderAccountId,
  toAccountId: ProviderAccountId,
  trigger: ProviderAccountAutoSwitchTrigger,
  reason: TrimmedNonEmptyString,
});
export type ProviderAccountAutoSwitchLastSwitch = typeof ProviderAccountAutoSwitchLastSwitch.Type;

export const ProviderAccountAutoSwitchThresholdPercent = Schema.Int.check(
  Schema.isBetween({ minimum: 5, maximum: 50 }),
);
export type ProviderAccountAutoSwitchThresholdPercent =
  typeof ProviderAccountAutoSwitchThresholdPercent.Type;

export const ProviderAccountAutoSwitch = Schema.Struct({
  enabled: Schema.Boolean,
  thresholdPercent: ProviderAccountAutoSwitchThresholdPercent,
  state: Schema.Literals(["off", "watching", "pending", "waiting", "paused"]),
  message: Schema.optional(TrimmedNonEmptyString),
  pendingTargetAccountId: Schema.optional(ProviderAccountId),
  wakeAt: Schema.optional(IsoDateTime),
  lastSwitch: Schema.optional(ProviderAccountAutoSwitchLastSwitch),
});
export type ProviderAccountAutoSwitch = typeof ProviderAccountAutoSwitch.Type;

export const ProviderAccountAutoSwitchEvent = Schema.Union([
  Schema.TaggedStruct("changed", { driver: Schema.optional(ProviderAccountDriver) }),
  Schema.TaggedStruct("switched", {
    driver: ProviderAccountDriver,
    fromAccountId: ProviderAccountId,
    toAccountId: ProviderAccountId,
    toLabel: TrimmedNonEmptyString,
    trigger: ProviderAccountAutoSwitchTrigger,
    reason: TrimmedNonEmptyString,
    at: IsoDateTime,
  }),
  Schema.TaggedStruct("pending", {
    driver: ProviderAccountDriver,
    toAccountId: ProviderAccountId,
    toLabel: TrimmedNonEmptyString,
    runningTurnCount: NonNegativeInt,
    reason: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("blocked", {
    driver: ProviderAccountDriver,
    reason: TrimmedNonEmptyString,
  }),
]);
export type ProviderAccountAutoSwitchEvent = typeof ProviderAccountAutoSwitchEvent.Type;

/** Claude only: sends a tiny Haiku request when an account's 5-hour window can start. */
export const ProviderAccountWindowPrimer = Schema.Struct({
  enabled: Schema.Boolean,
  lastPrimedAt: Schema.optional(IsoDateTime),
  lastPrimedAccountId: Schema.optional(ProviderAccountId),
  nextPrimeAt: Schema.optional(IsoDateTime),
  nextPrimeAccountId: Schema.optional(ProviderAccountId),
  /** Safe, user-facing reason when a start failed or starting is paused. */
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccountWindowPrimer = typeof ProviderAccountWindowPrimer.Type;

export const ProviderAccountGroup = Schema.Struct({
  driver: ProviderAccountDriver,
  switchMode: Schema.Literals(["hot", "restart"]),
  instanceId: ProviderInstanceId,
  activeAccountId: Schema.optional(ProviderAccountId),
  accounts: Schema.Array(ProviderAccount),
  autoSwitch: ProviderAccountAutoSwitch,
  windowPrimer: Schema.optional(ProviderAccountWindowPrimer),
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccountGroup = typeof ProviderAccountGroup.Type;

export const ProviderAccountsSnapshot = Schema.Struct({
  groups: Schema.Array(ProviderAccountGroup),
});
export type ProviderAccountsSnapshot = typeof ProviderAccountsSnapshot.Type;

export const ProviderAccountLoginEvent = Schema.Union([
  Schema.TaggedStruct("started", {
    loginId: TrimmedNonEmptyString,
    accountId: ProviderAccountId,
  }),
  Schema.TaggedStruct("browser", {
    url: TrimmedNonEmptyString,
    needsCode: Schema.Literal(true),
  }),
  Schema.TaggedStruct("deviceCode", {
    url: TrimmedNonEmptyString,
    userCode: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("verifying", {}),
  Schema.TaggedStruct("completed", {
    accountId: ProviderAccountId,
    email: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.TaggedStruct("failed", { message: TrimmedNonEmptyString }),
]);
export type ProviderAccountLoginEvent = typeof ProviderAccountLoginEvent.Type;

export class ProviderAccountError extends Schema.TaggedError<ProviderAccountError>()(
  "ProviderAccountError",
  { message: Schema.String },
) {}

export class ProviderAccountBusyError extends Schema.TaggedError<ProviderAccountBusyError>()(
  "ProviderAccountBusyError",
  { runningTurnCount: NonNegativeInt },
) {}

export const ProviderAccountsListInput = Schema.Struct({});
export type ProviderAccountsListInput = typeof ProviderAccountsListInput.Type;
export const ProviderAccountsRefreshUsageInput = Schema.Struct({
  accountIds: Schema.optional(Schema.Array(ProviderAccountId)),
  force: Schema.optional(Schema.Boolean),
});
export type ProviderAccountsRefreshUsageInput = typeof ProviderAccountsRefreshUsageInput.Type;
export const ProviderAccountsStartLoginInput = Schema.Struct({
  driver: ProviderAccountDriver,
  accountId: Schema.optional(ProviderAccountId),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccountsStartLoginInput = typeof ProviderAccountsStartLoginInput.Type;
export const ProviderAccountsSubmitLoginCodeInput = Schema.Struct({
  loginId: TrimmedNonEmptyString,
  code: TrimmedNonEmptyString,
});
export type ProviderAccountsSubmitLoginCodeInput = typeof ProviderAccountsSubmitLoginCodeInput.Type;
export const ProviderAccountsCancelLoginInput = Schema.Struct({ loginId: TrimmedNonEmptyString });
export type ProviderAccountsCancelLoginInput = typeof ProviderAccountsCancelLoginInput.Type;
export const ProviderAccountsSwitchInput = Schema.Struct({
  accountId: ProviderAccountId,
  interruptRunning: Schema.optional(Schema.Boolean),
});
export type ProviderAccountsSwitchInput = typeof ProviderAccountsSwitchInput.Type;
export const ProviderAccountsRenameInput = Schema.Struct({
  accountId: ProviderAccountId,
  label: TrimmedNonEmptyString,
});
export type ProviderAccountsRenameInput = typeof ProviderAccountsRenameInput.Type;
export const ProviderAccountsRemoveInput = Schema.Struct({ accountId: ProviderAccountId });
export type ProviderAccountsRemoveInput = typeof ProviderAccountsRemoveInput.Type;

export const ProviderAccountsSetAutoSwitchInput = Schema.Struct({
  driver: ProviderAccountDriver,
  enabled: Schema.Boolean,
  thresholdPercent: Schema.optional(ProviderAccountAutoSwitchThresholdPercent),
});
export type ProviderAccountsSetAutoSwitchInput = typeof ProviderAccountsSetAutoSwitchInput.Type;
export const ProviderAccountsSetWindowPrimerInput = Schema.Struct({
  driver: Schema.Literal("claudeAgent"),
  enabled: Schema.Boolean,
});
export type ProviderAccountsSetWindowPrimerInput = typeof ProviderAccountsSetWindowPrimerInput.Type;
export const ProviderAccountsAutoSwitchEventsInput = Schema.Struct({});
export type ProviderAccountsAutoSwitchEventsInput =
  typeof ProviderAccountsAutoSwitchEventsInput.Type;

export const PROVIDER_ACCOUNTS_METHODS = {
  providerAccountsSetAutoSwitch: "providerAccounts.setAutoSwitch",
  providerAccountsSetWindowPrimer: "providerAccounts.setWindowPrimer",
  providerAccountsAutoSwitchEvents: "providerAccounts.autoSwitchEvents",
  providerAccountsList: "providerAccounts.list",
  providerAccountsRefreshUsage: "providerAccounts.refreshUsage",
  providerAccountsStartLogin: "providerAccounts.startLogin",
  providerAccountsSubmitLoginCode: "providerAccounts.submitLoginCode",
  providerAccountsCancelLogin: "providerAccounts.cancelLogin",
  providerAccountsSwitch: "providerAccounts.switch",
  providerAccountsRename: "providerAccounts.rename",
  providerAccountsRemove: "providerAccounts.remove",
} as const;

const ProviderAccountsRpcError = Schema.Union([
  ProviderAccountError,
  EnvironmentAuthorizationError,
]);

export const WsProviderAccountsListRpc = Rpc.make(PROVIDER_ACCOUNTS_METHODS.providerAccountsList, {
  payload: ProviderAccountsListInput,
  success: ProviderAccountsSnapshot,
  error: ProviderAccountsRpcError,
});
export const WsProviderAccountsRefreshUsageRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsRefreshUsage,
  {
    payload: ProviderAccountsRefreshUsageInput,
    success: ProviderAccountsSnapshot,
    error: ProviderAccountsRpcError,
  },
);
export const WsProviderAccountsStartLoginRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsStartLogin,
  {
    payload: ProviderAccountsStartLoginInput,
    success: ProviderAccountLoginEvent,
    error: ProviderAccountsRpcError,
    stream: true,
  },
);
export const WsProviderAccountsSubmitLoginCodeRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsSubmitLoginCode,
  { payload: ProviderAccountsSubmitLoginCodeInput, error: ProviderAccountsRpcError },
);
export const WsProviderAccountsCancelLoginRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsCancelLogin,
  { payload: ProviderAccountsCancelLoginInput, error: ProviderAccountsRpcError },
);
export const WsProviderAccountsSwitchRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsSwitch,
  {
    payload: ProviderAccountsSwitchInput,
    success: ProviderAccountsSnapshot,
    error: Schema.Union([ProviderAccountsRpcError, ProviderAccountBusyError]),
  },
);
export const WsProviderAccountsRenameRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsRename,
  {
    payload: ProviderAccountsRenameInput,
    success: ProviderAccountsSnapshot,
    error: ProviderAccountsRpcError,
  },
);
export const WsProviderAccountsRemoveRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsRemove,
  {
    payload: ProviderAccountsRemoveInput,
    success: ProviderAccountsSnapshot,
    error: ProviderAccountsRpcError,
  },
);

export const WsProviderAccountsSetAutoSwitchRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsSetAutoSwitch,
  {
    payload: ProviderAccountsSetAutoSwitchInput,
    success: ProviderAccountsSnapshot,
    error: ProviderAccountsRpcError,
  },
);
export const WsProviderAccountsSetWindowPrimerRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsSetWindowPrimer,
  {
    payload: ProviderAccountsSetWindowPrimerInput,
    success: ProviderAccountsSnapshot,
    error: ProviderAccountsRpcError,
  },
);
export const WsProviderAccountsAutoSwitchEventsRpc = Rpc.make(
  PROVIDER_ACCOUNTS_METHODS.providerAccountsAutoSwitchEvents,
  {
    payload: ProviderAccountsAutoSwitchEventsInput,
    success: ProviderAccountAutoSwitchEvent,
    error: ProviderAccountsRpcError,
    stream: true,
  },
);

export const PROVIDER_ACCOUNTS_RPCS = [
  WsProviderAccountsSetAutoSwitchRpc,
  WsProviderAccountsSetWindowPrimerRpc,
  WsProviderAccountsAutoSwitchEventsRpc,
  WsProviderAccountsListRpc,
  WsProviderAccountsRefreshUsageRpc,
  WsProviderAccountsStartLoginRpc,
  WsProviderAccountsSubmitLoginCodeRpc,
  WsProviderAccountsCancelLoginRpc,
  WsProviderAccountsSwitchRpc,
  WsProviderAccountsRenameRpc,
  WsProviderAccountsRemoveRpc,
] as const;

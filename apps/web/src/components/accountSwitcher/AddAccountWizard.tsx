import { RegistryContext } from "@effect/atom-react";
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
  CheckCircle2Icon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useContext, useEffect, useId, useState, type ReactNode } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import {
  ACCOUNT_DRIVER_LABELS,
  loginWizardView,
  nextLoginPrompt,
  type LoginPrompt,
} from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";
import { SwitchAccountAction } from "./SwitchAccountAction";

let loginAttempt = 0;

type LoginEventsAtom = ReturnType<typeof providerAccountsEnvironment.loginEvents>;

const BROWSER_HINT = {
  claudeAgent:
    "Already signed in to claude.ai in this browser? Sign out first or use a private window, or you'll add the same account again.",
  codex:
    "Already signed in to chatgpt.com in this browser? Sign out first or use a private window, or you'll add the same account again.",
} as const;

function CopyAction({
  value,
  label,
  iconOnly = false,
}: {
  value: string;
  label: string;
  iconOnly?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button
      size={iconOnly ? "icon-sm" : "sm"}
      variant="outline"
      aria-label={label}
      onClick={() => copyToClipboard(value)}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
      {iconOnly ? null : label}
    </Button>
  );
}

function openSignInPage(url: string) {
  void ensureLocalApi()
    .shell.openExternal(url)
    .catch(() => {
      toastManager.add({
        type: "error",
        title: "Couldn't open the sign-in page",
        description: "Copy the link into your browser instead.",
      });
    });
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Step({ index, children }: { index: number; children: ReactNode }) {
  return (
    <li className="flex min-w-0 gap-3">
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums"
      >
        {index}
      </span>
      <div className="grid min-w-0 flex-1 gap-2 text-sm">{children}</div>
    </li>
  );
}

function LinkActions({ url }: { url: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => openSignInPage(url)}>
        <ExternalLinkIcon />
        Open sign-in page
      </Button>
      <CopyAction value={url} label="Copy link" />
    </div>
  );
}

/**
 * Nested sign-in dialog. Adds a new account, or signs an existing one in again (`account`).
 * Closing it at any step cancels the login. The login atom is created once per attempt and
 * held in state: a fresh lookup must never start a second server login.
 */
export function AddAccountWizard({
  open,
  onOpenChange,
  environmentId,
  deviceLabel,
  group,
  account,
  onSwitchStart,
  onSwitchEnd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  deviceLabel: string;
  group: ProviderAccountGroup;
  account?: ProviderAccount | undefined;
  onSwitchStart?: (accountId: ProviderAccountId) => void;
  onSwitchEnd?: (accountId: ProviderAccountId) => void;
}) {
  const driver = group.driver;
  const provider = ACCOUNT_DRIVER_LABELS[driver];
  const relogin = account !== undefined;
  const [name, setName] = useState("");
  const createAttempt = (label: string) =>
    providerAccountsEnvironment.loginEvents({
      environmentId,
      input: {
        driver,
        // New attempts need a new account: failed/cancelled new homes are cleaned up by the server.
        ...(account ? { accountId: account.id } : {}),
        ...(account?.email ? { email: account.email } : {}),
        ...(label ? { label } : {}),
        attempt: ++loginAttempt,
      },
    });
  // Re-login starts immediately: the user already chose the action.
  const [eventAtom, setEventAtom] = useState<LoginEventsAtom | null>(() =>
    relogin ? createAttempt("") : null,
  );
  const [loginId, setLoginId] = useState<string | null>(null);
  // The last link or code stays visible while the account is verified after sign-in.
  const [prompt, setPrompt] = useState<LoginPrompt | null>(null);
  const registry = useContext(RegistryContext);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nameId = useId();
  const events = useEnvironmentQuery(eventAtom);
  const event = events.data;
  const submit = useAtomCommand(providerAccountsEnvironment.submitLoginCode, {
    reportFailure: false,
  });
  const cancelLogin = useAtomCommand(providerAccountsEnvironment.cancelLogin, {
    reportFailure: false,
  });
  // Capture the login id and prompt from the subscription, not a render that may batch events.
  useEffect(() => {
    if (!eventAtom) return;
    return registry.subscribe(
      eventAtom,
      (result) => {
        if (result._tag !== "Success") return;
        const loginEvent = result.value;
        if (loginEvent._tag === "started") setLoginId(loginEvent.loginId);
        setPrompt((previous) => nextLoginPrompt(previous, loginEvent));
      },
      { immediate: true },
    );
  }, [eventAtom, registry]);
  const start = () => {
    setCode("");
    setLoginId(null);
    setPrompt(null);
    setEventAtom(createAttempt(name.trim()));
  };
  const view = loginWizardView({
    started: eventAtom !== null || relogin,
    prompt,
    event,
    error: events.error,
  });
  const completed = view.kind === "completed" ? view.completed : null;
  const close = () => {
    // Unsubscribing also cancels the server process, including before started arrives.
    if (!completed && loginId) void cancelLogin({ environmentId, input: { loginId } });
    setEventAtom(null);
    setLoginId(null);
    onOpenChange(false);
  };
  const confirm = async () => {
    if (!loginId || !code.trim() || submitting) return;
    setSubmitting(true);
    const result = await submit({ environmentId, input: { loginId, code: code.trim() } });
    setSubmitting(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't submit the code",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    }
  };
  const failed = view.kind === "failed" ? view.message : null;
  const link = view.kind === "prompt" ? view.prompt : null;
  const verifying = view.kind === "prompt" && view.verifying;
  const steps = relogin ? ["Sign in", "Done"] : ["Name", "Sign in", "Done"];
  const currentStep = completed ? steps.length - 1 : eventAtom || relogin ? steps.length - 2 : 0;
  const active = group.accounts.find((candidate) => candidate.active);
  const saved = completed
    ? group.accounts.find((candidate) => candidate.id === completed.accountId)
    : undefined;
  const finalLabel =
    account?.label ?? saved?.label ?? (name.trim() || completed?.email || provider);
  const title = relogin ? `Sign in to ${account.label} again` : `Add a ${provider} account`;
  const description = relogin
    ? `${account.email ? `Sign in as ${account.email}. Signing in with an account that is already saved under another name is rejected.` : `Sign in with the account saved as ${account.label}.`}${account.active && group.switchMode === "hot" ? " Running sessions pick up the new login from their next request." : ""}`
    : `Sign in with another ${provider} account. Its login is stored on ${deviceLabel}.`;
  const canSwitch =
    completed && !(saved?.active ?? false) && (saved?.status ?? "ready") === "ready";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <WizardPopup>
        <WizardHeader title={title} description={description}>
          <WizardSteps steps={steps} currentStep={currentStep} />
        </WizardHeader>
        <WizardPanel>
          {view.kind === "name" ? (
            <form
              id={`${nameId}-form`}
              className="grid gap-4"
              onSubmit={(formEvent) => {
                formEvent.preventDefault();
                start();
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor={nameId}>Name</Label>
                <Input
                  id={nameId}
                  autoFocus
                  placeholder="e.g. Work"
                  maxLength={40}
                  value={name}
                  onChange={(changeEvent) => setName(changeEvent.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Shown in the account list. Leave empty to use the email address.
                </p>
              </div>
              <Alert variant="info">
                <InfoIcon />
                <AlertDescription>{BROWSER_HINT[driver]}</AlertDescription>
              </Alert>
            </form>
          ) : failed ? (
            <Alert variant="error">
              <TriangleAlertIcon />
              <AlertTitle>Sign-in didn't finish</AlertTitle>
              <AlertDescription>{failed}</AlertDescription>
            </Alert>
          ) : completed ? (
            <div className="flex gap-3">
              <CheckCircle2Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
              <div className="grid gap-1">
                <p className="text-sm font-medium">
                  {relogin ? `${finalLabel} is signed in again.` : `${finalLabel} is ready`}
                </p>
                {completed.email ? (
                  <p className="text-sm text-muted-foreground">Signed in as {completed.email}.</p>
                ) : null}
                {relogin ? null : (
                  <p className="text-sm text-muted-foreground">
                    {group.switchMode === "hot"
                      ? "Switch now to use it from the next request. Running sessions keep going."
                      : "Switching restarts Codex."}
                  </p>
                )}
              </div>
            </div>
          ) : !link ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner size="sm" />
              {view.kind === "verifying" ? "Checking the account…" : "Getting a sign-in link…"}
            </p>
          ) : (
            <div className="grid gap-4">
              <div className="flex items-start gap-4">
                <div className="grid min-w-0 flex-1 gap-4">
                  {link._tag === "deviceCode" ? (
                    <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-4">
                      <code className="font-mono text-2xl tracking-[0.18em]">{link.userCode}</code>
                      <CopyAction value={link.userCode} label="Copy code" iconOnly />
                    </div>
                  ) : null}
                  <ol className="grid gap-4">
                    <Step index={1}>
                      <p className="font-medium">
                        {link._tag === "deviceCode" ? (
                          <>
                            Open{" "}
                            <a
                              className="underline underline-offset-2"
                              href={link.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(clickEvent) => {
                                clickEvent.preventDefault();
                                openSignInPage(link.url);
                              }}
                            >
                              {hostOf(link.url)}
                            </a>
                          </>
                        ) : (
                          "Open the sign-in page"
                        )}
                      </p>
                      <LinkActions url={link.url} />
                      <p className="text-xs break-all text-muted-foreground">{link.url}</p>
                    </Step>
                    {link._tag === "browser" ? (
                      <>
                        <Step index={2}>
                          <p>Sign in with the account you want to add.</p>
                        </Step>
                        <Step index={3}>
                          <p className="font-medium">Paste the code shown after sign-in</p>
                          <form
                            onSubmit={(submitEvent) => {
                              submitEvent.preventDefault();
                              void confirm();
                            }}
                          >
                            <InputGroup>
                              <InputGroupInput
                                aria-label="Sign-in code"
                                placeholder="Paste code"
                                value={code}
                                disabled={submitting}
                                onChange={(changeEvent) => setCode(changeEvent.target.value)}
                              />
                              <InputGroupAddon align="inline-end">
                                <Button
                                  size="xs"
                                  type="submit"
                                  disabled={!code.trim() || !loginId || submitting || verifying}
                                >
                                  {submitting ? <Spinner /> : null}
                                  Confirm
                                </Button>
                              </InputGroupAddon>
                            </InputGroup>
                          </form>
                        </Step>
                      </>
                    ) : (
                      <Step index={2}>
                        <p>Enter the code above and approve the sign-in.</p>
                      </Step>
                    )}
                  </ol>
                </div>
                <div className="hidden shrink-0 sm:block">
                  <QRCodeSvg value={link.url} size={112} title="Sign-in link" />
                </div>
              </div>
              <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                {verifying ? (
                  <>
                    <Spinner size="xs" />
                    Checking the account…
                  </>
                ) : (
                  <>
                    <ClockIcon aria-hidden className="size-3.5" />
                    {link._tag === "browser"
                      ? "Waiting for the code…"
                      : "Waiting for you to approve in the browser…"}
                  </>
                )}
              </p>
            </div>
          )}
        </WizardPanel>
        <WizardFooter>
          {completed ? (
            relogin ? (
              <>
                <Button variant="outline" onClick={close}>
                  Done
                </Button>
                {canSwitch ? (
                  <SwitchAccountAction
                    environmentId={environmentId}
                    switchMode={group.switchMode}
                    accountId={completed.accountId}
                    label={finalLabel}
                    size="default"
                    onSwitched={close}
                    {...(onSwitchStart ? { onStart: onSwitchStart } : {})}
                    {...(onSwitchEnd ? { onEnd: onSwitchEnd } : {})}
                  >
                    {`Switch to ${finalLabel}`}
                  </SwitchAccountAction>
                ) : null}
              </>
            ) : (
              <>
                <Button variant="outline" onClick={close}>
                  Keep {active?.label ?? "current account"}
                </Button>
                {canSwitch ? (
                  <SwitchAccountAction
                    environmentId={environmentId}
                    switchMode={group.switchMode}
                    accountId={completed.accountId}
                    label={finalLabel}
                    size="default"
                    onSwitched={close}
                    {...(onSwitchStart ? { onStart: onSwitchStart } : {})}
                    {...(onSwitchEnd ? { onEnd: onSwitchEnd } : {})}
                  >
                    {`Switch to ${finalLabel}`}
                  </SwitchAccountAction>
                ) : null}
              </>
            )
          ) : failed ? (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button onClick={start}>Try again</Button>
            </>
          ) : view.kind === "name" ? (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" form={`${nameId}-form`}>
                Start sign-in
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

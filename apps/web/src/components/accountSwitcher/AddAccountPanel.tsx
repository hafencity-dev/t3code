import { RegistryContext } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAccountGroup,
  ProviderAccount,
  ProviderAccountDriver,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { DialogHeader, DialogTitle, DialogDescription, DialogPanel } from "../ui/dialog";
import { Input } from "../ui/input";
import { InputGroup, InputGroupInput, InputGroupAddon } from "../ui/input-group";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ACCOUNT_DRIVER_LABELS } from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";
import { SwitchAccountAction } from "./SwitchAccountAction";

let loginAttempt = 0;

type LoginEventsAtom = ReturnType<typeof providerAccountsEnvironment.loginEvents>;

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
      size={iconOnly ? "icon-sm" : "xs"}
      variant="outline"
      aria-label={label}
      onClick={() => copyToClipboard(value)}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
      {iconOnly ? null : label}
    </Button>
  );
}

export function AddAccountPanel({
  environmentId,
  switchMode,
  driver,
  account,
  onBack,
}: {
  environmentId: EnvironmentId;
  switchMode: ProviderAccountGroup["switchMode"];
  driver: ProviderAccountDriver;
  account?: ProviderAccount;
  onBack: () => void;
}) {
  const [name, setName] = useState("");
  // Hold the attempt's atom for its lifetime: a fresh lookup must never start another login.
  const [eventAtom, setEventAtom] = useState<LoginEventsAtom | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const registry = useContext(RegistryContext);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const events = useEnvironmentQuery(eventAtom);
  const event = events.data;
  const submit = useAtomCommand(providerAccountsEnvironment.submitLoginCode, {
    reportFailure: false,
  });
  const cancelLogin = useAtomCommand(providerAccountsEnvironment.cancelLogin, {
    reportFailure: false,
  });
  // Capture the login id from the subscription, not a React render that may batch events.
  useEffect(() => {
    if (!eventAtom) return;
    return registry.subscribe(
      eventAtom,
      (result) => {
        if (result._tag === "Success" && result.value._tag === "started") {
          setLoginId(result.value.loginId);
        }
      },
      { immediate: true },
    );
  }, [eventAtom, registry]);
  const start = () => {
    setCode("");
    setLoginId(null);
    setEventAtom(
      providerAccountsEnvironment.loginEvents({
        environmentId,
        input: {
          driver,
          // New attempts need a new account: failed/cancelled new homes are cleaned up by the server.
          ...(account ? { accountId: account.id } : {}),
          ...(name.trim() ? { label: name.trim() } : {}),
          attempt: ++loginAttempt,
        },
      }),
    );
  };
  const cancel = () => {
    // Unsubscribing also cancels the server process, including before started arrives.
    setEventAtom(null);
    if (loginId) void cancelLogin({ environmentId, input: { loginId } });
    setLoginId(null);
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
        title: "Couldn't submit sign-in code",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    }
  };
  const failed = events.error ?? (event?._tag === "failed" ? event.message : null);
  const link = event?._tag === "browser" || event?._tag === "deviceCode" ? event : null;
  const waiting = eventAtom !== null && !failed && event?._tag !== "completed";
  return (
    <>
      <DialogHeader>
        <div>
          <Button variant="ghost-muted" size="xs" onClick={onBack}>
            <ArrowLeftIcon />
            Back
          </Button>
        </div>
        <DialogTitle>
          {account ? `Sign in to ${account.label}` : `Add ${ACCOUNT_DRIVER_LABELS[driver]} account`}
        </DialogTitle>
        <DialogDescription>
          Sign in in your browser. This account is stored separately from your other logins.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {!eventAtom ? (
          <div className="grid gap-3">
            {!account ? (
              <label className="grid gap-1.5 text-sm">
                Name (optional)
                <Input
                  placeholder="Work"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            ) : null}
            <div>
              <Button onClick={start}>Start sign-in</Button>
            </div>
          </div>
        ) : null}
        {waiting && (!event || event._tag === "started") ? (
          <Button disabled>
            <Spinner />
            Requesting login link…
          </Button>
        ) : null}
        {link ? (
          <div className="grid gap-3">
            {link._tag === "deviceCode" ? (
              <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-3">
                <code className="font-mono text-2xl tracking-[0.18em]">{link.userCode}</code>
                <CopyAction value={link.userCode} label="Copy device code" iconOnly />
              </div>
            ) : null}
            <div className="flex items-start gap-4">
              <div className="grid min-w-0 flex-1 gap-2">
                <p className="text-sm text-muted-foreground">
                  {link._tag === "deviceCode" ? "Enter the code at" : "Sign in at"}{" "}
                  <a
                    className="break-all text-primary underline underline-offset-2"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => {
                      event.preventDefault();
                      void ensureLocalApi()
                        .shell.openExternal(link.url)
                        .catch(() => {
                          toastManager.add({
                            type: "error",
                            title: "Couldn't open sign-in link",
                            description: "Copy the link into your browser instead.",
                          });
                        });
                    }}
                  >
                    {link.url}
                    <ExternalLinkIcon className="ml-1 inline size-3" />
                  </a>
                </p>
                <div className="flex gap-2">
                  <CopyAction value={link.url} label="Copy link" />
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      void ensureLocalApi()
                        .shell.openExternal(link.url)
                        .catch(() => {
                          toastManager.add({
                            type: "error",
                            title: "Couldn't open sign-in link",
                            description: "Copy the link into your browser instead.",
                          });
                        })
                    }
                  >
                    <ExternalLinkIcon />
                    Open link
                  </Button>
                </div>
              </div>
              <div className="hidden shrink-0 sm:block">
                <QRCodeSvg value={link.url} size={96} title="Sign-in link" />
              </div>
            </div>
            {link._tag === "browser" && link.needsCode ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void confirm();
                }}
              >
                <InputGroup>
                  <InputGroupInput
                    aria-label="Paste the code from the browser"
                    placeholder="Paste the code from the browser"
                    value={code}
                    disabled={submitting}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <InputGroupAddon align="inline-end">
                    <Button
                      size="xs"
                      type="submit"
                      disabled={!code.trim() || !loginId || submitting}
                    >
                      {submitting ? <Spinner /> : null}Confirm
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
              </form>
            ) : null}
          </div>
        ) : null}
        {waiting ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Spinner size="xs" />
            {event?._tag === "verifying" ? "Verifying…" : "Waiting for confirmation…"}
            <Button variant="ghost-muted" size="xs" onClick={cancel}>
              Cancel
            </Button>
          </div>
        ) : null}
        {event?._tag === "completed" ? (
          <div className="grid gap-3">
            <p className="flex items-center gap-2 text-sm">
              <CheckIcon className="size-4 text-success" />
              Signed in as{" "}
              {event.email ?? account?.label ?? (name.trim() || ACCOUNT_DRIVER_LABELS[driver])}
            </p>
            <div className="flex flex-wrap gap-2">
              <SwitchAccountAction
                switchMode={switchMode}
                environmentId={environmentId}
                accountId={event.accountId}
                label={
                  account?.label ?? (name.trim() || event.email || ACCOUNT_DRIVER_LABELS[driver])
                }
                onSwitched={onBack}
              >
                Switch to it now
              </SwitchAccountAction>
              <Button variant="outline" onClick={onBack}>
                Keep current
              </Button>
            </div>
          </div>
        ) : null}
        {failed ? (
          <div className="grid gap-3">
            <Alert variant="error">
              <TriangleAlertIcon />
              <AlertDescription>{failed}</AlertDescription>
            </Alert>
            <div>
              <Button size="sm" onClick={start}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
      </DialogPanel>
    </>
  );
}

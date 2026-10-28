// Undoable actions use recovery toasts rather than this destructive-action confirmation path.
import { useEffect, useRef, useState } from "react";

import type { SourceControlConfirmOptions } from "~/lib/sourceControl/safetyLadder";

// Electron does not implement window.prompt; text requests use the existing dialog host.
export interface SourceControlPromptOptions {
  readonly title: string;
  /** Plain English: what the value is for. Required, same as a confirm rung. */
  readonly consequence: string;
  readonly inputLabel: string;
  readonly confirmLabel: string;
  readonly placeholder?: string | undefined;
  readonly initialValue?: string | undefined;
}

export interface PendingSourceControlConfirm {
  readonly id: number;
  readonly kind: "confirm";
  readonly options: SourceControlConfirmOptions;
}

export interface PendingSourceControlPrompt {
  readonly id: number;
  readonly kind: "prompt";
  readonly options: SourceControlPromptOptions;
}

export type PendingSourceControlRequest = PendingSourceControlConfirm | PendingSourceControlPrompt;

export interface SourceControlConfirmController {
  readonly pending: PendingSourceControlRequest | null;
  /** Resolves true to proceed, false to cancel, "alternative" for the safer path. */
  readonly confirm: (options: SourceControlConfirmOptions) => Promise<ConfirmOutcome>;
  /** Resolves the typed value, or `null` when cancelled. */
  readonly promptText: (options: SourceControlPromptOptions) => Promise<string | null>;
  readonly resolve: (outcome: ConfirmOutcome, value?: string) => void;
}

export type ConfirmOutcome = "confirmed" | "cancelled" | "alternative";

type Resolver = (outcome: ConfirmOutcome, value?: string) => void;

export function useSourceControlConfirm(): SourceControlConfirmController {
  const [pending, setPending] = useState<PendingSourceControlRequest | null>(null);
  const resolverRef = useRef<Resolver | null>(null);
  const idRef = useRef(0);

  /**
   * fork: f4 F-18 — a promise only this component can settle must be settled
   * when this component goes away. The panel has two early returns above the
   * dialog and is `lazy` + unmounted whenever the right-panel surface changes,
   * so an awaiting `discard` used to hang forever with its busy key held.
   */
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- settle pending confirmation promises when their dialog host unmounts
  useEffect(
    () => () => {
      const resolver = resolverRef.current;
      resolverRef.current = null;
      resolver?.("cancelled");
    },
    [],
  );

  const confirm = (options: SourceControlConfirmOptions) => {
    // A second request while one is open cancels the first rather than stacking
    // dialogs — two modals over one list is how people confirm the wrong thing.
    resolverRef.current?.("cancelled");
    idRef.current += 1;
    setPending({ id: idRef.current, kind: "confirm", options });
    return new Promise<ConfirmOutcome>((resolvePromise) => {
      resolverRef.current = (outcome) => resolvePromise(outcome);
    });
  };

  const promptText = (options: SourceControlPromptOptions) => {
    resolverRef.current?.("cancelled");
    idRef.current += 1;
    setPending({ id: idRef.current, kind: "prompt", options });
    return new Promise<string | null>((resolvePromise) => {
      resolverRef.current = (outcome, value) => {
        resolvePromise(outcome === "confirmed" ? (value ?? "") : null);
      };
    });
  };

  const resolve = (outcome: ConfirmOutcome, value?: string) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolver?.(outcome, value);
  };

  return { pending, confirm, promptText, resolve };
}

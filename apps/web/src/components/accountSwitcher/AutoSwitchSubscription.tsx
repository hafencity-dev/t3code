import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderAccountAutoSwitchEvent,
  ProviderAccountDriver,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect } from "react";
import { environmentPresentations } from "../../state/presentation";
import { toastManager } from "../ui/toast";
import { autoSwitchToastTitle, shouldToastAutoSwitch } from "./accounts.logic";
import { providerAccountsEnvironment } from "./state";

type AutoSwitchEvents = ReadonlyMap<
  EnvironmentId,
  Partial<Record<ProviderAccountDriver, ProviderAccountAutoSwitchEvent>>
>;

/** The latest notification per device and provider, read by the accounts dialog. */
export const autoSwitchEventsAtom = Atom.make<AutoSwitchEvents>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("provider-accounts:auto-switch-events"),
);

// Module level: a remounted host or subscription never toasts the same switch twice.
const toastedSwitches = new Map<string, string>();

function connectedDevices(
  presentations: Atom.Type<typeof environmentPresentations.presentationsAtom>,
) {
  return [...presentations].flatMap(([id, presentation]) =>
    presentation.connection.phase === "connected" && presentation.serverConfig !== null
      ? [[id, presentation.entry.target.label] as const]
      : [],
  );
}

/** Mounted only for connected devices. The server stream never replays historical switches. */
function AutoSwitchSubscription({
  environmentId,
  onEvent,
}: {
  environmentId: EnvironmentId;
  onEvent: (environmentId: EnvironmentId, event: ProviderAccountAutoSwitchEvent) => void;
}) {
  const registry = useContext(RegistryContext);
  useEffect(
    () =>
      // No `immediate`: replaying the cached last event on remount would toast it again.
      registry.subscribe(
        providerAccountsEnvironment.autoSwitchEvents({ environmentId, input: {} }),
        (result) => {
          if (result._tag === "Success") onEvent(environmentId, result.value);
        },
      ),
    [environmentId, onEvent, registry],
  );
  return null;
}

/**
 * Mounted once at the app root so auto-switch toasts arrive on every route, whether or not
 * the sidebar's account button is on screen.
 */
export function ProviderAccountsAutoSwitchHost() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const registry = useContext(RegistryContext);
  const connected = connectedDevices(presentations);
  const onEvent = useCallback(
    (environmentId: EnvironmentId, event: ProviderAccountAutoSwitchEvent) => {
      // `changed` only invalidates the list in client-runtime. Future tags are not notifications.
      if (event._tag !== "switched" && event._tag !== "pending" && event._tag !== "blocked") return;
      if (event._tag === "switched") {
        if (!shouldToastAutoSwitch(toastedSwitches, environmentId, event)) return;
        // More than one device: name the one that switched.
        const names = new Map(
          connectedDevices(registry.get(environmentPresentations.presentationsAtom)),
        );
        toastManager.add({
          type: "success",
          title: autoSwitchToastTitle(
            event.driver,
            event.toLabel,
            names.size > 1 ? names.get(environmentId) : undefined,
          ),
          description: event.reason,
        });
      }
      registry.update(autoSwitchEventsAtom, (previous) =>
        new Map(previous).set(environmentId, {
          ...previous.get(environmentId),
          [event.driver]: event,
        }),
      );
    },
    [registry],
  );
  return connected.map(([id]) => (
    <AutoSwitchSubscription key={id} environmentId={id} onEvent={onEvent} />
  ));
}

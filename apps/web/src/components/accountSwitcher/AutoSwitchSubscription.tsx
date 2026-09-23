import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, ProviderAccountAutoSwitchEvent } from "@t3tools/contracts";
import { useContext, useEffect } from "react";
import { providerAccountsEnvironment } from "./state";

/** Mounted only for connected devices. The server stream never replays historical switches. */
export function AutoSwitchSubscription({
  environmentId,
  onEvent,
}: {
  environmentId: EnvironmentId;
  onEvent: (environmentId: EnvironmentId, event: ProviderAccountAutoSwitchEvent) => void;
}) {
  const registry = useContext(RegistryContext);
  useEffect(
    () =>
      registry.subscribe(
        providerAccountsEnvironment.autoSwitchEvents({ environmentId, input: {} }),
        (result) => {
          if (result._tag !== "Success") return;
          const event = result.value;
          onEvent(environmentId, event);
        },
        { immediate: true },
      ),
    [environmentId, onEvent, registry],
  );
  return null;
}

import { createFileRoute } from "@tanstack/react-router";

import { ModelRoutingSettingsPanel } from "../components/settings/ModelRoutingSettings";

export const Route = createFileRoute("/_chat/settings/model-routing")({
  component: ModelRoutingSettingsPanel,
});

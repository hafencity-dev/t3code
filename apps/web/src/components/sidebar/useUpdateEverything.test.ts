import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
  machines: [
    {
      environmentId: "remote",
      label: "Remote server",
      connected: true,
      hostedByThisApp: false,
      canMaintain: true,
      updateState: { status: "idle" },
      serverConfig: {
        environment: {
          serverVersion: "0.0.49",
          capabilities: { serverSelfUpdate: "boot-service" },
        },
        settings: {},
      },
    },
  ],
}));

vi.mock("react", () => ({ useMemo: (compute: () => unknown) => compute() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => fixtures.machines }));
vi.mock("~/branding", () => ({ APP_VERSION: "0.0.50" }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("~/state/npmRelease", () => ({ useNpmReleasePublished: () => true }));
vi.mock("~/state/server", () => ({ serverEnvironment: {} }));
vi.mock("~/state/session", () => ({ environmentSession: {} }));
vi.mock("../ProviderUpdatesAction", () => ({
  useProviderUpdates: () => ({ machines: [], updateAll: async () => [] }),
}));
vi.mock("../ServerUpdateAction", () => ({
  canUpdateServer: () => true,
  useServerUpdate: () => async () => ({ status: "updated" }),
}));
vi.mock("./updateEverythingRun", () => ({
  clearSavedUpdateEverythingResult: () => {},
  saveUpdateEverythingResult: () => {},
  setUpdateEverythingRun: () => {},
  settleUpdateRunMachine: () => {},
  showUpdateEverythingResult: () => {},
}));

import { useUpdateEverything } from "./useUpdateEverything";

describe("2code update everything", () => {
  beforeEach(() => {
    fixtures.machines[0]!.serverConfig.environment.serverVersion = "0.0.49";
  });
  it("plans remote runtime updates separately from the desktop release", () => {
    const update = useUpdateEverything("1.0.163");
    expect(update.hasUpdates).toBe(true);
    expect(update.lines.join("\n")).toContain("0.0.50");
    expect(update.lines.join("\n")).toContain("1.0.163");
    expect(update.skipped).toEqual([]);
  });

  it("does not update a current runtime just because the desktop release is newer", () => {
    fixtures.machines[0]!.serverConfig.environment.serverVersion = "0.0.50";
    const update = useUpdateEverything("1.0.163");
    expect(update.hasUpdates).toBe(false);
    expect(update.lines.join("\n")).not.toContain("Remote server");
  });
});

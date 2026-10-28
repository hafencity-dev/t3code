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

vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("~/branding", () => ({ APP_VERSION: "0.0.50" }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: fixtures.machines.map((machine) => ({
      ...machine,
      connection: { phase: "connected" },
      entry: { target: { _tag: "BearerConnectionTarget", connectionId: "remote" } },
    })),
  }),
}));
vi.mock("~/state/npmRelease", () => ({ useNpmReleasePublished: () => true }));
vi.mock("~/state/server", () => ({
  environmentUpdateStatesAtom: () => fixtures.machines.map((machine) => machine.updateState),
}));
vi.mock("~/state/session", () => ({
  environmentSessionStatesAtom: () => fixtures.machines.map(() => ({ authenticated: true })),
}));
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
    expect(update.runtimeVersion).toBe("0.0.50");
    expect(update.version).toBe("1.0.163");
    expect(update.rows.find((row) => row.environmentId === "remote")).toMatchObject({
      app: "server",
      skipped: null,
    });
  });

  it("does not update a current runtime just because the desktop release is newer", () => {
    fixtures.machines[0]!.serverConfig.environment.serverVersion = "0.0.50";
    const update = useUpdateEverything("1.0.163");
    expect(update.hasUpdates).toBe(false);
    expect(update.runtimeVersion).toBeNull();
    expect(update.rows.some((row) => row.environmentId === "remote")).toBe(false);
  });
});

import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  presentations: new Map(),
  refresh: vi.fn(
    async (_input: { environmentId: string; input: object }): Promise<void> => undefined,
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.presentations }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [true, vi.fn()] }));
vi.mock("../usage/UsageLimits", () => ({ barColor: () => "" }));
vi.mock("../settings/providerDriverMeta", () => ({ getDriverOption: () => null }));
vi.mock("../ui/refresh-icon", () => ({ RefreshIcon: () => null }));

import { SidebarProviderUsage } from "./SidebarProviderUsage";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("refreshes only the selected online device, waits for completion, and excludes offline devices", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.presentations = new Map(
    ["local", "remote", "offline"].map((id) => [
      id,
      {
        entry: { target: { label: id } },
        connection: { phase: id === "offline" ? "disconnected" : "connected" },
        serverConfig: { providers: [] },
      },
    ]),
  );
  await act(async () => {
    renderer = create(<SidebarProviderUsage />);
  });
  const root = renderer!.root;
  await act(async () => {
    root
      .findByProps({ "aria-label": "Usage device" })
      .props.onChange({ target: { value: "remote" } });
  });
  let complete!: () => void;
  state.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const refresh = () => root.findByProps({ "aria-label": "Refresh usage" });
  await act(async () => {
    refresh().props.onClick();
    refresh().props.onClick();
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(state.refresh).toHaveBeenLastCalledWith({ environmentId: "remote", input: {} });
  expect(refresh().props.disabled).toBe(true);
  await act(async () => complete());
  expect(refresh().props.disabled).toBe(false);
  state.refresh.mockClear();
  await act(async () => {
    root.findByProps({ "aria-label": "Usage device" }).props.onChange({ target: { value: "" } });
  });
  await act(async () => refresh().props.onClick());
  expect(state.refresh.mock.calls.map(([input]) => input)).toEqual([
    { environmentId: "local", input: {} },
    { environmentId: "remote", input: {} },
  ]);
});

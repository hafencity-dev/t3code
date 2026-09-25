import { ProviderAccountId, type ProviderAccountActivityEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  ACTIVITY_MAX_ENTRIES,
  activityDayLabel,
  activityInput,
  activityText,
  activityView,
  groupActivityByDay,
  type ActivityView,
} from "./activity.logic";

const entry = (
  fields: Partial<ProviderAccountActivityEntry> & Pick<ProviderAccountActivityEntry, "kind">,
): ProviderAccountActivityEntry => ({
  id: "1",
  at: "2026-09-25T12:32:00.000Z",
  driver: "claudeAgent",
  labels: {},
  outcome: "ok",
  ...fields,
});
const sentence = (view: ActivityView) => view.parts.map((part) => part.text).join("");
const strong = (view: ActivityView) =>
  view.parts.filter((part) => part.strong).map((part) => part.text);

describe("activity sentences", () => {
  it("names both accounts of a switch, and marks automatic ones", () => {
    const manual = activityView(
      entry({ kind: "switch.manual", labels: { from: "hauke", to: "claude2" } }),
    );
    expect(sentence(manual)).toBe("Switched to claude2 from hauke");
    expect(strong(manual)).toEqual(["claude2", "hauke"]);
    expect(manual).toMatchObject({ icon: "switch", auto: false, tone: "default" });
    const auto = activityView(
      entry({
        kind: "switch.auto",
        labels: { from: "hauke", to: "claude2" },
        trigger: "weekly",
        reason: "Weekly limit at 2% · claude2 resets in 4d 13h",
        message: "hauke has 2% of its weekly limit left; switching to claude2.",
      }),
    );
    expect(auto).toMatchObject({
      icon: "auto",
      auto: true,
      detail: "Weekly limit at 2% · claude2 resets in 4d 13h",
      tooltip: "hauke has 2% of its weekly limit left; switching to claude2.",
    });
    expect(activityText(auto)).toBe(
      "Auto. Switched to claude2 from hauke. Weekly limit at 2% · claude2 resets in 4d 13h",
    );
  });

  it("puts error tone on failures only, and keeps the auto marker on a failed auto switch", () => {
    const failed = activityView(
      entry({
        kind: "switch.failed",
        labels: { to: "claude2" },
        trigger: "session",
        reason: "Switch failed",
        outcome: "failed",
      }),
    );
    expect(sentence(failed)).toBe("Couldn't switch to claude2");
    expect(failed).toMatchObject({ tone: "error", icon: "failed", auto: true });
    const window = activityView(
      entry({
        kind: "window.failed",
        labels: { account: "marius" },
        reason: "Signed out",
        outcome: "failed",
      }),
    );
    expect(sentence(window)).toBe("Couldn't start marius's 5-hour window");
    expect(window.detail).toBe("Signed out");
    expect(activityView(entry({ kind: "usage.rateLimited", labels: { account: "x" } })).tone).toBe(
      "warning",
    );
  });

  it("writes every kind in the switcher's own words", () => {
    const cases: [
      Partial<ProviderAccountActivityEntry> & Pick<ProviderAccountActivityEntry, "kind">,
      string,
    ][] = [
      [
        { kind: "window.started", labels: { account: "claude2" } },
        "Started claude2's 5-hour window",
      ],
      [
        { kind: "login.added", labels: { account: "hauke@hafencity.dev" } },
        "Added hauke@hafencity.dev",
      ],
      [{ kind: "login.reauthenticated", labels: { account: "hauke" } }, "Signed in again to hauke"],
      [
        { kind: "login.failed", labels: { account: "x@y", to: "claude2" } },
        "Rejected x@y: already saved as claude2",
      ],
      [
        {
          kind: "login.failed",
          accountId: ProviderAccountId.make("a"),
          labels: { account: "a", to: "b" },
        },
        "Couldn't sign in again to a",
      ],
      [{ kind: "account.removed", labels: { account: "New account" } }, "Removed New account"],
      [{ kind: "account.renamed", labels: { from: "a", to: "b" } }, "Renamed a to b"],
      [{ kind: "account.excluded", labels: { account: "x" } }, "Excluded x from auto-switch"],
      [{ kind: "account.included", labels: { account: "x" } }, "Included x in auto-switch"],
      [
        {
          kind: "terminal.login",
          fromAccountId: ProviderAccountId.make("hauke"),
          toAccountId: ProviderAccountId.make("claude2"),
          labels: { from: "hauke", to: "claude2" },
        },
        "Terminal sign-in as claude2; switched to it",
      ],
      [
        { kind: "terminal.login", labels: { from: "hauke", to: "new@x" }, created: true },
        "Terminal sign-in as new@x; saved as a new account",
      ],
      [{ kind: "terminal.login", labels: { to: "hauke" } }, "Terminal sign-in as hauke"],
      [{ kind: "terminal.logout", labels: { account: "hauke" } }, "Terminal sign-out of hauke"],
      [
        { kind: "usage.rateLimited", labels: { account: "x" }, reason: "Retrying in 15m" },
        "Usage checks for x rate-limited",
      ],
      [{ kind: "recovery.abandonedJournal", labels: {} }, "Recovered from an unfinished switch"],
      [
        { kind: "windowPrimer.settingsChanged", labels: {}, settings: { enabled: true } },
        "Automatic 5-hour window starts turned on",
      ],
    ];
    for (const [fields, expected] of cases)
      expect(sentence(activityView(entry(fields)))).toBe(expected);
  });

  it("describes auto-switch settings with their thresholds while on", () => {
    const settings = { thresholdPercent: 10, weeklyThresholdPercent: 2 };
    const on = activityView(
      entry({
        kind: "autoSwitch.settingsChanged",
        settings: { enabled: true, enabledChanged: true, ...settings },
      }),
    );
    expect(sentence(on)).toBe("Auto-switch turned on");
    expect(on.detail).toBe("5-hour at 10%, weekly at 2%");
    const changed = activityView(
      entry({ kind: "autoSwitch.settingsChanged", settings: { enabled: true, ...settings } }),
    );
    expect(sentence(changed)).toBe("Auto-switch thresholds changed");
    const off = activityView(
      entry({
        kind: "autoSwitch.settingsChanged",
        settings: { enabled: false, enabledChanged: true, ...settings },
      }),
    );
    expect(sentence(off)).toBe("Auto-switch turned off");
    expect(off.detail).toBeUndefined();
  });

  it("never renders an empty name", () => {
    expect(sentence(activityView(entry({ kind: "account.removed" })))).toBe("Removed an account");
  });
});

describe("activity days", () => {
  const now = new Date(2026, 8, 25, 15, 0).getTime();
  it("labels today and yesterday, then the date", () => {
    expect(activityDayLabel(new Date(2026, 8, 25, 0, 5).getTime(), now)).toBe("Today");
    expect(activityDayLabel(new Date(2026, 8, 24, 23, 59).getTime(), now)).toBe("Yesterday");
    const older = activityDayLabel(new Date(2026, 8, 22, 9).getTime(), now);
    expect(older).not.toMatch(/Today|Yesterday|2026/u);
    expect(activityDayLabel(new Date(2025, 8, 22, 9).getTime(), now)).toContain("2025");
  });

  it("groups newest-first entries by local day without reordering them", () => {
    const at = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();
    const days = groupActivityByDay(
      [
        entry({ kind: "account.removed", id: "c", at: at(25, 14) }),
        entry({ kind: "account.removed", id: "b", at: at(25, 9) }),
        entry({ kind: "account.removed", id: "a", at: at(24, 18) }),
      ],
      now,
    );
    expect(days.map((day) => [day.label, day.entries.map((item) => item.id)])).toEqual([
      ["Today", ["c", "b"]],
      ["Yesterday", ["a"]],
    ]);
  });
});

describe("activity paging", () => {
  it("grows the page by 100 and never asks for more than the log keeps", () => {
    expect(activityInput("all", 1)).toEqual({ limit: 100 });
    expect(activityInput("codex", 2)).toEqual({ driver: "codex", limit: 200 });
    expect(activityInput("claudeAgent", 9).limit).toBe(ACTIVITY_MAX_ENTRIES);
  });
});

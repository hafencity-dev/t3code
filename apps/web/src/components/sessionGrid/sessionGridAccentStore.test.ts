import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useSessionGridAccentStore } from "./sessionGridAccentStore";

describe("personal session grid accents", () => {
  beforeEach(() => useSessionGridAccentStore.setState({ colors: {} }));

  it("keeps environment-scoped sessions independent and resets only the selected color", () => {
    const { setColor } = useSessionGridAccentStore.getState();
    setColor("environment-a:thread", "#3b82f6");
    setColor("environment-b:thread", "#f43f5e");
    setColor("environment-a:thread", null);
    expect(useSessionGridAccentStore.getState().colors).toEqual({
      "environment-b:thread": "#f43f5e",
    });
  });

  it("accepts custom hex colors and ignores invalid updates", () => {
    const { setColor } = useSessionGridAccentStore.getState();
    setColor("thread", "#12AbEF");
    setColor("thread", "invalid");
    expect(useSessionGridAccentStore.getState().colors.thread).toBe("#12AbEF");
  });
});

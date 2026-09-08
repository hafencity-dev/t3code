import { PaletteIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { useSessionGridAccentStore } from "./sessionGridAccentStore";

const PRESETS = [
  ["Rose", "#f43f5e"],
  ["Orange", "#f97316"],
  ["Amber", "#eab308"],
  ["Green", "#22c55e"],
  ["Teal", "#14b8a6"],
  ["Blue", "#3b82f6"],
  ["Violet", "#8b5cf6"],
  ["Pink", "#ec4899"],
] as const;

export function SessionGridAccentPicker(props: { threadKey: string; title: string }) {
  const color = useSessionGridAccentStore((state) => state.colors[props.threadKey]);
  const setColor = useSessionGridAccentStore((state) => state.setColor);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Accent color for ${props.title}`}
        render={<Button size="icon-xs" variant="ghost" title="Session accent color" />}
      >
        <PaletteIcon style={{ color }} />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-60">
        <PopoverTitle className="text-sm">Session accent color</PopoverTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Personal to this browser or desktop app.
        </p>
        <div className="my-3 grid grid-cols-8 gap-1">
          {PRESETS.map(([name, value]) => (
            <button
              key={value}
              type="button"
              aria-label={name}
              aria-pressed={color?.toLowerCase() === value}
              className="size-5 rounded-full border border-foreground/20 outline-offset-2 focus-visible:outline-2 aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-2 aria-pressed:ring-offset-background"
              style={{ backgroundColor: value }}
              onClick={() => setColor(props.threadKey, value)}
            />
          ))}
        </div>
        <label className="flex items-center justify-between text-xs">
          Custom color
          <input
            type="color"
            aria-label="Custom accent color"
            className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
            value={color ?? "#3b82f6"}
            onChange={(event) => setColor(props.threadKey, event.target.value)}
          />
        </label>
        <Button
          className="mt-3 w-full"
          size="xs"
          variant="outline"
          disabled={!color}
          onClick={() => setColor(props.threadKey, null)}
        >
          Reset color
        </Button>
      </PopoverPopup>
    </Popover>
  );
}

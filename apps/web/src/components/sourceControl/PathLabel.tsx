// RTL clipping preserves the directory tail; inner LTR isolation keeps slashes in reading order.
import { cn } from "~/lib/utils";

export function PathLabel(props: {
  readonly name: string;
  readonly dir: string;
  readonly className?: string;
  /** Rendered muted and one step down, as the row's secondary slot. */
  readonly dirClassName?: string;
}) {
  return (
    <span className={cn("flex min-w-0 flex-1 items-baseline gap-1.5", props.className)}>
      <span className="min-w-0 shrink-[2] truncate text-foreground">{props.name}</span>
      {props.dir ? (
        <span
          className={cn(
            "min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground text-xs",
            props.dirClassName,
          )}
          // The clipping box runs right-to-left so the ellipsis is at the head.
          dir="rtl"
          style={{ textAlign: "left" }}
        >
          <bdi dir="ltr">{props.dir}</bdi>
        </span>
      ) : null}
    </span>
  );
}

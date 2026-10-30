import * as Schema from "effect/Schema";

export class DesktopDistributionChannelError extends Schema.TaggedError<DesktopDistributionChannelError>()(
  "DesktopDistributionChannelError",
  {},
) {
  override get message(): string {
    return "2code uses its own stable release feed and cannot switch to the upstream Nightly channel.";
  }
}

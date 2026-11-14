declare const __T3CODE_DESKTOP_FORK__: boolean | undefined;

export { desktopForkIdentity } from "@t3tools/shared/desktopForkIdentity";

export const isDesktopForkBuild =
  typeof __T3CODE_DESKTOP_FORK__ !== "undefined" && __T3CODE_DESKTOP_FORK__;

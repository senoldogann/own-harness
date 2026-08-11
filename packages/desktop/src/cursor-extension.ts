import { createHarnessExtension, type ExtensionApiLike, type HarnessExtension, type HarnessExtensionOptions } from "./extension-host.js"

export function createCursorExtension(
  api: ExtensionApiLike,
  options: Omit<HarnessExtensionOptions, "agent">
): HarnessExtension {
  return createHarnessExtension(api, {
    ...options,
    agent: "cursor"
  })
}

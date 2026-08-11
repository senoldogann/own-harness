import { bootstrap } from "../bootstrap.js"

export function runRoutingStatus(cwd: string): void {
  const boot = bootstrap(cwd)
  const routing = boot.config.routing
  if (routing === undefined) {
    console.log(JSON.stringify({ mode: "disabled", rules: [] }, null, 2))
    return
  }
  console.log(JSON.stringify({
    mode: routing.mode,
    rules: routing.rules.map((rule) => ({
      id: rule.id,
      modelRegex: rule.modelRegex,
      provider: rule.provider
    }))
  }, null, 2))
}

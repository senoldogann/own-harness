import { initProject } from "../bootstrap.js"

export function runInit(cwd: string): void {
  initProject(cwd)
  console.log("Initialized harness project in", cwd)
}

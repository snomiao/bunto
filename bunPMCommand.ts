import { $ } from "bun";
import path from "path";
import { nil } from "./nil";
import { notneed } from "./notneed";

export async function bunPMCommand(
  command: string,
  pkgDepsMap: Map<string, string[]>,
  { dry = false } = {}
) {
  for (const [dir, deps] of pkgDepsMap.entries()) {
    const cwd = path.resolve(dir);
    const sh = $.cwd(cwd);
    for await (const dep of deps) {
      console.log("[Bun Auto] bun " + command + " " + dep + "# in " + dir);
      if (dry) continue;
      (await sh`bun ${command} ${dep}`.quiet().catch(nil)) &&
        !notneed.has(dep) &&
        (await sh`bun ${command} -d ${"@types/" + dep}`.quiet().catch(nil));
    }
  }
}

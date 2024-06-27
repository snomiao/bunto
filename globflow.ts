import { Glob } from "bun";
import fs from "fs/promises";
import { globby } from "globby";
import path from "path";
import { filter, map } from "rambda";
import { snoflow } from "snoflow";

/** return glob all list, and then watch changes to got changed [filename], note that changed [filename] may be deleted */

export function globflow(
  pattern: string,
  {
    watch = true,
    signal = new AbortController().signal,
    cwd = process.cwd(),
    polling = 0,
  } = {}
) {
  const glob = new Glob(pattern);
  return (
    snoflow([[] as string[]])
      .interval(polling)
      .map(() => globby(pattern))
      // .map(() => Array.fromAsync(glob.scan({ dot: true })))
      .join(
        (watch || undefined) &&
          snoflow(fs.watch(".", { recursive: true }))
            .map((event) => event.filename)
            .filter()
            .buffer(1)
      )
      .abort(signal)
      .map(
        filter((f) =>
          glob.match(
            f.replace(
              /\/\[\.+([^\/]*?)\]/,
              "/$1" /* hack for nextjs [...], cannot be matched by bun glob*/
            )
          )
        )
      )
      .map(map((f) => path.relative(cwd, f)))
      .map(map((f) => f.replace(/\\/g, "/")))
  );
}

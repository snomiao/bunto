import { Glob } from "bun";
import { globby } from "globby";
import path from "path";
import { filter, map } from "rambda";
import { sflow } from "sflow";

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
    sflow(globby(pattern))
      // .chunkInterval(polling)
      // .map(() => globby(pattern))
      // .map(() => Array.fromAsync(glob.scan({ dot: true })))
      // .merge(
      //   (watch || undefined) &&
      //     sflow(fs.watch(".", { recursive: true }))
      //       .map((event) => event.filename)
      //       .filter()
      //       .chunk(1)
      // )
      // .abort(signal)
      .map(filter((f) => glob.match(hackNextJSPath(f))))
      .map(map((f) => path.relative(cwd, f)))
      .map(map((f) => f.replace(/\\/g, "/")))
  );
}
export function hackNextJSPath(f: string): string {
  /* hack for nextjs [...], cannot be matched by bun glob*/
  return f.replace(/\/\[\.+([^\/]*?)\]/, "/$1");
}

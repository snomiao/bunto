import ignore from "ignore";
import path from "path";
import { globTextMapFlow } from "./globMapFlow";
import { globby } from "globby";

export function createIgnoreFilter({
  watch,
  signal,
  pattern = "./**/.gitignore",
}: {
  watch?: boolean;
  signal?: AbortSignal;
  /* must start with ./ , eg. ./.{prettier,git}ignore */
  pattern?: string;
}) {
  const defaultIgnores = ['./.git']
  // globby("./**/.gitignore",{ig})
  const ret = Promise.withResolvers<(filename: string) => boolean>();
  /* TODO: ignore ignorefiles it self */
  globTextMapFlow(pattern, { watch, signal })
    .debounce(100)
    .map((ignoresMap) => {
      const filters = [...ignoresMap.entries()].map(([f, text]) => {
        // each ignore file applies to all sub folder
        const dir = path.dirname(f);
        const ignores = [...text.split("\n"), ...defaultIgnores];
        const filter = ignore().add(ignores).createFilter();
        return { dir, filter };
      });
      const filter = (f: string) =>
        filters.every(({ dir, filter }) => {
          const rel = path.relative(dir, f);
          if (rel.startsWith("..")) return true;
          return filter(rel);
        });
      // resolve existed await s
      ret.resolve(filter);
      // resolve future await s
      Object.assign(
        ret,
        Promise.withResolvers<(filename: string) => boolean>()
      );
      ret.resolve(filter);
    })
    .done();
  return ret;
}

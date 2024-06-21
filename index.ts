#!bun
import { $ } from "bun";
import fs from "fs/promises";
import ignore from "ignore";
import path from "path";
import { difference, keys, toPairs } from "rambda";
import { snoflow } from "snoflow";
import { logError } from "./logError";
import { nil } from "./nil";
import { wait } from "./wait";

if (import.meta.main) {
  await bunAuto();
}

export const bunAutoInstall = bunAuto;
export default async function bunAuto() {
  const nodeBuiltins =
    "assert,buffer,child_process,cluster,crypto,dgram,dns,domain,events,fs,http,https,net,os,path,punycode,querystring,readline,stream,string_decoder,timers,tls,tty,url,util,v8,vm,zlib"
      .split(",")
      .flatMap((e) => ["node:" + e, e]);
  const bunBuiltins = "bun,sqlite,test"
    .split(",")
    .flatMap((e) => ["bun:" + e, e]);
  const implicitImports = new Set("typescript,react,react-dom,vue".split(","));
  const builtins = new Set([...nodeBuiltins, ...bunBuiltins]);
  const ignores = await fs.readFile(".gitignore", "utf8");
  const ignorer = ignore({ allowRelativePaths: true }).add(ignores.split("\n"));
  const pattern = "**/*.{ts,tsx,jsx,js,mjs,cjs}";
  const glob = new Bun.Glob(pattern);
  const imports = snoflow(fs.watch("./"))
    .map((event) => event.filename)
    .filter()
    .map((f) => path.relative(process.cwd(), f))
    .filter((f) => glob.match(f))
    .join(snoflow(glob.scan()))
    .map((f) => f.replace(/\\/g, "/"))
    .filter(ignorer.createFilter())
    .reduce(new Map<string, string[]>(), async (m, f) => {
      const content = await fs
        .readFile(f, "utf8")
        .catch(() => (m.delete(f), null));
      if (content)
        await wait(() => new Bun.Transpiler({ loader: "tsx" }).scan(content))
          .then((r) => r.imports.map((e) => e.path))
          .then((deps) => m.set(f, deps))
          .catch(logError("[" + f + "]"));
      return m;
    })
    .debounce(100)
    .map((s) =>
      [...s.values()]
        .flat()
        .filter((f) => !f.startsWith("./"))
        .map((f) =>
          f.startsWith("@")
            ? f.split("/").slice(0, 2).join("/")
            : f.split("/")[0]
        )
    );

  const deps = snoflow(fs.watch("./package.json"))
    .map((e) => "package.json changed")
    .join(snoflow("first-trigger"))
    .map(() => fs.readFile("./package.json", "utf-8"))
    .map((s) => wait(() => JSON.parse(s)).catch(logError("[package.json]")))
    .filter()
    .map((pkg) => {
      const scripts = JSON.stringify(pkg.scripts)
      return toPairs(pkg)
        .filter(([key, depObj]) => key.match(/dependencies$/i))
        .flatMap(([k, depObj]) => keys(depObj) as string[])
        .filter(dep => !scripts.includes(dep)); // don t remove package in scripts
    });
  type input = { imports?: string[]; deps?: string[] };
  type output = { install?: string[]; remove?: string[] };
  type cmd = { install?: string; remove?: string };

  // diff
  console.log("[bun-auto] is watching for changes");
  await snoflow([{} as input])
    .join(imports.map((imports) => ({ imports })))
    .join(deps.map((deps) => ({ deps })))
    .reduce<input & output>({}, (state, input) => {
      const { imports, deps } = Object.assign(state, input);
      return Object.assign(state, {
        install: imports && deps && difference(imports, deps),
        remove: imports && deps && difference(deps, imports),
      });
    })
    .debounce(200)
    // convert diffs to single command
    .flatMap<cmd | undefined>(({ install, remove }) =>
      [
        install
          ?.filter(Boolean)
          .filter((e) => !builtins.has(e))
          .map((install) => ({ install })),
        remove
          ?.filter(Boolean)
          .filter((e) => !e.startsWith("@types"))
          .filter((e) => implicitImports.has(e))
          .map((remove) => ({ remove })),
      ].flat()
    )
    .filter()
    .map(async (cmd) => {
      cmd.install &&
        (await $`bun install ${cmd.install}`.catch(nil)) &&
        (await $`bun install -d @types/${cmd.install}`.quiet().catch(nil));
      cmd.remove &&
        (await $`bun remove ${cmd.remove}`.catch(nil)) &&
        (await $`bun remove -d @types/${cmd.remove}`.quiet().catch(nil));
    })
    .done();
}

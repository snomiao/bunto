#!/usr/bin/env bunimport DIE from "@snomiao/die";import { $ } from "bun";
import DIE from "@snomiao/die";
import pMap from "p-map";
import path from "path";
import { difference, filter, keys, sortBy } from "rambda";
import { parallels } from "snoflow";
import type { PartialUnion } from "./PartialUnion";
import { bunPMCommand } from "./bunPMCommand";
import { createIgnoreFilter } from "./createIgnoreFilter";
import { globTextMapFlow } from "./globMapFlow";
import { globflow } from "./globflow";
import { fs, fspath } from "./import-helpers";
import { logError } from "./logError";
import { nil } from "./nil";
import { wait } from "./wait";

if (import.meta.main) {
  await bunAuto();
}

export const bunAutoInstall = bunAuto;
export default async function bunAuto({
  watch = true,
  install = true,
  remove = true,
  dryRun = false,
  signal = new AbortController().signal,
  verbose=true,
} = {}) {
  console.log("[Bun Auto] Starting...");
  let bunPmRunning = false;
  const nodeBuiltins =
    "assert,buffer,child_process,cluster,crypto,dgram,dns,domain,events,fs,http,https,net,os,path,punycode,querystring,readline,stream,string_decoder,timers,tls,tty,url,util,v8,vm,zlib"
      .split(",")
      .flatMap((e) => ["node:" + e, e]);
  const bunBuiltins = "bun,sqlite,test,main"
    .split(",")
    .flatMap((e) => ["bun:" + e, e]);
  const implicitImports = new Set(
    "typescript,react,react-dom,vue,bun,jest,node"
      .split(",")
      .flatMap((e) => ["@types/" + e, e])
  );
  const onlyTypeImports = new Set("ts-toolbelt".split(","));

  const builtins = new Set([...nodeBuiltins, ...bunBuiltins]);
  // todo: handle ignore files not in root

  // load git ignore filters
  const ignoreFilter = createIgnoreFilter({ watch, signal });

  // dont remove pkgs that have configs, like tailwindcss, postcss, vite, etc
  let allConfigStringPromise = Promise.withResolvers<string>();
  globTextMapFlow("./*{config,rc}.{ts,tsx,jsx,js,mjs,cjs,json}", {
    watch,
    filter: await ignoreFilter.promise,
    signal,
  })
    .map((map) => {
      const allConfigString = JSON.stringify([...map.entries()]);
      // update promise allConfigFileString
      allConfigStringPromise.resolve(allConfigString);
      allConfigStringPromise = Promise.withResolvers<string>();
      allConfigStringPromise.resolve(allConfigString);
      return allConfigString;
    })
    .done();

  // load package.json files {dir, scriptsStr, pkgDeps}[]
  const pkgs = globTextMapFlow("./**/package.json", {
    watch,
    filter: await ignoreFilter.promise,
    signal,
  }).map((pkgMap) => {
    return [...pkgMap.entries()].map(([pkgFile, pkgJson]) => {
      // each pkg file applies to none of sub packages, sub packages manages them selves
      const dir = fspath.dirname(pkgFile);
      const pkgModules = dir + "/node_modules"; // should bun i to install if not existed
      const pkg = JSON.parse(pkgJson);
      const scriptsStr = Object.values(pkg.scripts || {}).join("\n");
      const pkgDeps = keys(pkg)
        .filter((k) => k.match(/dependencies$/i))
        .map((k) => keys(pkg[k]))
        .flat();
      return { dir, scriptsStr, pkgDeps };
    });
  });

  const imports = globflow("./**/*.{ts,tsx,jsx,js,mjs,cjs}", { watch })
    .map(async (flist) => {
      const _filter = await ignoreFilter.promise;
      return filter((f) => _filter(f), flist);
    })
    // get import Map<file, import[]>
    .reduce(new Map<string, string[]>(), async (m, changed) => {
      await pMap(changed, async (f) => {
        const content = await fs.readFile(f, "utf8").catch(nil);
        if (!content) {
          // file deleted or empty
          m.delete(f);
          return m;
        }
        const deps = (
          await wait(() => {
            if (f.endsWith(".tsx"))
              return new Bun.Transpiler({ loader: "tsx" }).scan(content);
            if (f.endsWith(".ts"))
              return new Bun.Transpiler({ loader: "ts" }).scan(content);
            if (f.endsWith(".jsx"))
              return new Bun.Transpiler({ loader: "jsx" }).scan(content);
            if (f.endsWith(".js"))
              return new Bun.Transpiler({ loader: "js" }).scan(content);
            if (f.endsWith(".mjs"))
              return new Bun.Transpiler({ loader: "js" }).scan(content);
            if (f.endsWith(".cjs"))
              return new Bun.Transpiler({ loader: "js" }).scan(content);
            DIE("unknown ext in " + f);
          }).catch(logError("[" + f + "]"))
        )?.imports
          .map((e) => e.path)
          .filter((f) => !f.startsWith(".")) // file relative
          .filter((f) => !f.startsWith("@/")) // root alias
          .filter((f) => !f.startsWith("~/")) // root alias
          .filter((f) => !f.match(":")) // virtual module
          // scoped
          .map((f) =>
            f.startsWith("@")
              ? f.split("/").slice(0, 2).join("/")
              : f.split("/")[0]
          );
        // parse error, wait for correct file next time, keep f state in m
        if (!deps) return;
        m.set(f, deps);
      });
      return m;
    });

  // diff imports deps by pkgs
  // { imports: typeof imports._type } & { pkgs: typeof pkgs._type }
  const watching = parallels(
    imports.map((imports) => ({ imports })),
    pkgs.map((pkgs) => ({ pkgs }))
  )
    .filter(() => !bunPmRunning)
    .abort(signal)
    // memoize deps and pkgs
    .map((e) => e as PartialUnion<typeof e>)
    .reduce(async (s, a) => Object.assign(s ?? {}, a))
    .debounce(200)
    //
    .map(async ({ imports, pkgs }) => {
      if (!(imports && pkgs)) return null;
      const allConfigFileString = await allConfigStringPromise.promise;

      const processedFiles = new Set<string>();
      const installs = new Map<string, string[]>();
      const removes = new Map<string, string[]>();
      // sort by pkg level, process deepest first
      sortBy(({ dir }) => -dir.split("/").length, pkgs).map(
        ({ dir, pkgDeps, scriptsStr }) => {
          const scriptDeps = pkgDeps.filter((dep) => scriptsStr.includes(dep));

          const pkgImports = [...imports.entries()]
            .map(([file, imports]) => {
              const rel = path.relative(dir, file);
              if (rel.startsWith("..")) return;
              if (processedFiles.has(file)) return;
              processedFiles.add(file);
              return imports;
            })
            .flatMap((e) => (e ? [e] : []))
            .flat();

          const install = difference(pkgImports, pkgDeps).filter(
            (dep) => !builtins.has(dep)
          );
          const remove = difference(pkgDeps, pkgImports)
            .filter((dep) => !builtins.has(dep))
            .filter((dep) => !implicitImports.has(dep))
            .filter((dep) => !onlyTypeImports.has(dep))
            .filter((dep) => !dep.startsWith("prettier-plugin-"))
            .filter((dep) => !dep.startsWith("eslint-config-"))
            .filter((dep) => !scriptDeps.includes(dep))
            .filter((dep) => !allConfigFileString.includes(dep))
            .filter(
              (dep) => !pkgImports.map((e) => "@types/" + e).includes(dep)
            );
          // install to dir
          install.forEach((dep) => {
            if (!installs.has(dir)) installs.set(dir, []);
            installs.get(dir)!.push(dep);
          });
          // remove from dir
          remove.forEach((dep) => {
            if (!removes.has(dir)) removes.set(dir, []);
            removes.get(dir)!.push(dep);
          });
        }
      );
      return { installs, removes };
    })
    .filter()
    // TODO: optimize this delta stage, maybe unwind before this stage
    .reduce(
      {
        installs: new Map<string, string[]>(),
        removes: new Map<string, string[]>(),
        delta: {
          installs: new Map<string, string[]>(),
          removes: new Map<string, string[]>(),
        },
      },
      (s, a) => {
        s.delta = {
          installs: new Map(
            [
              ...new Set([...s.installs.keys(), ...a.installs.keys()]).values(),
            ].map(
              (key) =>
                [
                  key,
                  difference(
                    a.installs.get(key) ?? [],
                    s.installs.get(key) ?? []
                  ),
                ] as const
            )
          ),
          removes: new Map(
            [
              ...new Set([...s.removes.keys(), ...a.removes.keys()]).values(),
            ].map(
              (key) =>
                [
                  key,
                  difference(
                    a.removes.get(key) ?? [],
                    s.removes.get(key) ?? []
                  ),
                ] as const
            )
          ),
        };
        return s;
      }
    )
    .map(async ({ delta: { installs, removes } }) => {
      if (!(installs && removes)) return;
      bunPmRunning = true;
      if (install) await bunPMCommand("install", installs, { dryRun });
      if (remove) await bunPMCommand("remove", removes, { dryRun });
      bunPmRunning = false;
    })
    .done();
  watch && console.log("[Bun Auto] Watching...");
  await Promise.all([watching]);
  console.log("[Bun Auto] All done!");
}

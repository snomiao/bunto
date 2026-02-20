#!/usr/bin/env bun
// import "dotenv";
import ignore from "ignore";
import pProps from "p-props";
import path from "path";
import DIE from "phpdie";
import { difference, filter, keys, sortBy, tryCatch, union, uniq } from "rambda";
import { regexMapper } from "regex-mapper";
import { nil, reduces, sf, sflow } from "sflow";
import { bunPMCommand } from "./bunPMCommand";
import { globFlow, mapChanges } from "./globWatch";
import pkg from "./package.json";
import { text } from "stream/consumers";
import pMap from "p-map";
import promiseAllProperties from "promise-all-properties";
import { render } from 'ink'
import { useEffect, useState } from "react";

if (import.meta.main) {
  await bunAuto({ watch: true })
}
export const bunAutoInstall = bunAuto;

const cfg = {
  nodeBuiltins:
    "assert,buffer,child_process,cluster,crypto,dgram,dns,domain,events,fs,http,https,net,os,path,punycode,querystring,readline,stream,string_decoder,timers,tls,tty,url,util,v8,vm,zlib,worker_threads",
  bunBuiltins: "bun,sqlite,test,main",
  implicitImports: "typescript,react,react-dom,vue,bun,jest,node",
  onlyTypeImports: "ts-toolbelt",
  ignoreFilesGlob: "./**/.gitignore",
  configsGlob: "./*{config,rc}.{ts,tsx,jsx,js,mjs,cjs,json}",
  pkgsGlob: "./**/package.json",
  codesGlob: "./**/*.{ts,tsx,js,jsx,mjs,cjs}",
};

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

export default function bunAuto({ watch = true, cwd = process.cwd() } = {}) {
  const pkgs = globFlow(cfg.pkgsGlob)
    .reduce((map, { added, changed, deleted }) => {
      added.forEach(({ path }) => map.set(path, config))
      return map
    }, new Map<string, string>())

  const imports = globFlow(cfg.codesGlob)
    .map(({ added, changed, deleted }) => {
      pkgs.latest()
    })
  const [installed, notRemove] = globFlow(cfg.pkgsGlob)
    .map(getDeps)

  const ignoreFlow = globFlow(cfg.ignoreFilesGlob)
  
  const configsFlow = globFlow(cfg.configsGlob).reduce((map, { added, changed, deleted }) => {
    added.forEach(({ path }) => map.set(path, config))
    return map
  }, new Map<string, string>())

  const installedFlow = globFlow(cfg.pkgsGlob)
  .reduce((map, { added, changed, deleted }) => {
    added.forEach(({ path }) => map.set(path, config))
    return map
  }, new Map<string, string>())
  
  const importsFlow = globFlow(cfg.codesGlob)
  .reduce((map, { added, changed, deleted }) => {
    added.forEach(({ path }) => map.set(path, config))
    return map
  }, new Map<string, string>())

  // 
  return sflow(
    installedFlow.map(v => ({ installed: v })),
    importsFlow.map(v => ({ imports: v })),
  )
    .map((e) => e as UnionToIntersection<typeof e>)
    .filter(({ imports, installed }) => [imports, installed].every(Boolean))
    .map(async ({ imports, installed }) => {
      const install = difference(imports, installed)
      const remove = difference(installed, imports)
      return { install, remove }
    })
    .map(async ({ install, remove }) => {
      if (install.length > 0) {
        console.log("[Bun Auto] Installing: ", install.join(", "));
        if (watch) {
          await bunPMCommand("install", install, { dry: false });
        }
      }
      if (remove.length > 0) {
        console.log("[Bun Auto] Removing: ", remove.join(", "));
        if (watch) {
          await bunPMCommand("remove", remove, { dry: false });
        }
      }
    })
    .run()
}


async function useBunAuto({
  watch = true,
  install = true,
  remove = true,
  dry = false,
  signal = new AbortController().signal,
  verbose = true,
  watchReady = false,
} = {}) {
  console.log("[Bun Auto] v" + pkg.version);
  // console.log("[Bun Auto] Conf" + yaml.stringify(config).replace(/\s+/g, " "));

  // ignore buildin imports
  const nodeBuiltins = config.nodeBuiltins
    .split(",")
    .flatMap((e) => ["node:" + e, e]);
  const bunBuiltins = config.bunBuiltins
    .split(",")
    .flatMap((e) => ["bun:" + e, e]);
  // ignore implicit imports
  const implicitImports = config.implicitImports
    .split(",")
    .flatMap((e) => ["@types/" + e, e]);
  const onlyTypeImports = config.onlyTypeImports.split(",");

  // ignores pkgs
  const notInstall = new Set([...nodeBuiltins, ...bunBuiltins]);
  const notRemove = new Set([
    ...nodeBuiltins,
    ...bunBuiltins,
    ...implicitImports,
    ...onlyTypeImports,
  ]);

  // ignore files
  const ignoreFilterFlow = createIgnoreFilterFlow()
  pkgsFlow = ignoreFilterFlow
    .map(
      (filter) => (f: string) => {
        // filter out ignored files
        return filter(f) && !f.match(/node_modules/);
      }
    )

  // config texts
  const allConfigText = await getAllTextFromGlob(config.configsGlob)

  const pkgsReadyFlag = Promise.withResolvers();
  const pkgsGlob = new Bun.Glob(config.pkgsGlob);
  const pkgs = sflow(
    sflow(pkgsGlob.scan({ dot: true })).onFlush(() => pkgsReadyFlag.resolve())
    // ...(!watch
    //   ? []
    //   : [
    //       sflow(fsp.watch(".", { recursive: true, signal }))
    //         .map((e) => e.filename)
    //         .filter(),
    //     ])
  )
    .map((e) => "./" + path.relative(process.cwd(), e))
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => pkgsGlob.match(hackNextJSPath(f)))
    .filter((f) => ignoreFilter(f))
    .log((f) => "* Package " + f)
    .map(async (f) => [f, await Bun.file(f).text()] as const)
    .reduce(
      (map, [k, v]) => (v ? map.set(k, v) : (map.delete(k), map)),
      new Map<string, string>()
    )
    .map((pkgContentsMap) => {
      return [...pkgContentsMap.entries()].map(([pkgFile, pkgJson]) => {
        // each pkg file applies to none of sub packages, sub packages manages them selves
        const dir = path.dirname(pkgFile);
        const pkgModules = dir + "/node_modules"; // should bun i to install if not existed
        const pkg = tryCatch(JSON.parse, () => null)(pkgJson)
        const scriptsStr = Object.values(pkg.scripts || {}).join("\n");
        const pkgDeps = keys(pkg)
          .filter((k) => k.match(/dependencies$/i))
          .map((k) => keys(pkg[k]))
          .flat();
        return { dir, scriptsStr, pkgDeps };
      });
    })
  const jsonSafeParse = tryCatch(JSON.parse, () => null);
  const importsReadyFlag = Promise.withResolvers();
  const codesGlob = new Bun.Glob(config.codesGlob);
  const imports = sflow(
    sflow(codesGlob.scan({ dot: true })).onFlush(() =>
      importsReadyFlag.resolve()
    )
    // ...(!watch
    //   ? []
    //   : [
    //       sflow(fsp.watch(".", { recursive: true, signal }))
    //         .map((e) => e.filename)
    //         .filter(),
    //     ])
  )
    .map((e) => "./" + path.relative(process.cwd(), e))
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => codesGlob.match(hackNextJSPath(f)))
    .filter((f) => ignoreFilter(f))
    // .log((f) => "* Code " + f)
    .reduce(async (m, f: string): Promise<Map<string, string[]>> => {
      const content = await Bun.file(f).text().catch(nil);

      if (!content) {
        // file deleted or empty
        m.delete(f);
        return m;
      }

      const typeImports = [
        ...content.matchAll(/^import type .* from "(.*?)";$/gm),
      ].map((m) => m[1]);

      const loader =
        regexMapper({
          tsx: /\.tsx$/,
          ts: /\.ts$/,
          jsx: /\.jsx$/,
          js: /\.(?:mjs|cjs|js)$/,
        })(f) ?? DIE("Unknown loader for " + f);
      const deps = [
        ...new Bun.Transpiler({ loader })
          .scan(content)
          .imports.map((e) => e.path),
        ...typeImports,
      ]
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
      if (!deps) return m;
      m.set(f, deps);
      console.log(`+ ${f}${+" "}${JSON.stringify(deps)}`);
      return m;
    }, new Map<string, string[]>());
  //
  (async function watchingMessage() {
    if (!watch) return;
    await pkgsReadyFlag.promise;
    await importsReadyFlag.promise;
    console.log("[Bun Auto] Watching... (-w=false to turn off watching mode)");
  })();

  const pp = await pProps({
    imports: imports.tail(1).toExactlyOne(),
    pkgs: pkgs.tail(1).toExactlyOne(),
  });
  const actions = getInstallRemoveActions(
    pp.imports!,
    pp.pkgs!,
    notInstall,
    notRemove,
    allConfigText
  );

  await sflow([actions])
    .filter()
    // TODO: optimize this delta stage, maybe unwind before this stage
    .reduce(
      (s, a) => ({
        ...s,
        delta: {
          installs: new Map(
            uniq([...s.installs.keys(), ...a.installs.keys()]).map(
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
            uniq([...s.removes.keys(), ...a.removes.keys()]).map(
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
        },
      }),
      {
        installs: new Map<string, string[]>(),
        removes: new Map<string, string[]>(),
        delta: {
          installs: new Map<string, string[]>(),
          removes: new Map<string, string[]>(),
        },
      }
    )
    .map((e) => e.delta)
    // .log()
    .map(async ({ installs, removes }) => {
      if (!(installs && removes)) return;
      bunPmRunning = true;
      if (install) await bunPMCommand("install", installs, { dry });
      if (remove) await bunPMCommand("remove", removes, { dry });
      bunPmRunning = false;
    })
    .done();
  console.log("[Bun Auto] All done!");
}

function getInstallRemoveActions(
  imports: Map<string, string[]>,
  pkgs: { dir: string; scriptsStr: string; pkgDeps: string[] }[],
  notInstall: Set<string>,
  notRemove: Set<string>,
  allConfigText: string
) {
  const notRemovePattern = /^prettier-plugin-|^eslint-config-/;
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
        (dep) => !notInstall.has(dep)
      );
      const remove = difference(pkgDeps, pkgImports)
        .filter((dep) => !notRemove.has(dep))
        .filter((dep) => !dep.match(notRemovePattern))
        .filter((dep) => !scriptDeps.includes(dep))
        .filter((dep) => !allConfigText.includes(dep))
        .filter((dep) => !pkgImports.map((e) => "@types/" + e).includes(dep));
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
}

function getAllTextFromGlob(configsGlob: string) {
  return sflow(new Bun.Glob(configsGlob).scan({ dot: true }))
    .map(async (f) => [f, await Bun.file(f).text()] as const)
    .chunk()
    .map((e) => e.join("\n"))
    .toExactlyOne()!;
}

/**
 * create a filter function from glob ignore files
 * 
 * the filter function is live 
 * @returns 
 */
function createIgnoreFilterFlow() {
  const ignoreFilesGlob = config.ignoreFilesGlob;
  return globFlow(ignoreFilesGlob)
    // read file text
    .map(async ({ added, changed, deleted }) => promiseAllProperties({
      added: pMap(added, async (e) => ({ ...e, text: await getText(e.path) })),
      changed: pMap(changed, async (e) => ({ ...e, text: await getText(e.path) })),
      deleted: deleted.map((e) => ({ ...e, })),
    }))
    // map of text
    .reduce(
      async (map, { added, changed, deleted }) => {
        added.forEach((f) => map.set(f.path, f.text));
        changed.forEach((f) => map.set(f.path, f.text))
        deleted.forEach((f) => map.delete(f.path));
        return map
      }, new Map<string, string>()
    )
    // create filter
    .map((ignoresMap) => {
      const filters = [...ignoresMap.entries()].map(([f, text]) => {
        // each ignore file applies to all sub folder
        const dir = path.dirname(f);
        const filter = ignore().add(text.split("\n")).createFilter();
        return { dir, filter };
      });
      return function filter(f: string) {
        return filters.every(({ dir, filter }) => {
          const rel = path.relative(dir, f);
          if (rel.startsWith("..")) return true;
          return filter(rel);
        });
      };
    })
  // .reduce((filter, curr) => {
  //   filter.update()
  //   return filter
  // }, createLazyImplFunction<(f: string) => boolean>())
  // .limit(1, { terminate: false })
  // .toFirst()
}
async function tryText(f: string): Promise<string | null> {
  return await Bun.file(f).text().catch(nil);
}
async function getText(f: string): Promise<string> {
  return await Bun.file(f).text();
}


function createLazyImplFunction<T extends (...args: any[]) => any>(): T {
  let impl: T | null = null;
  return new Proxy(
    (...args: any[]): any => {
      if (impl) {
        return impl(...args);
      }
      throw new Error("Function not implemented yet, call update() to set the implementation");
    },
    {
      get(target, prop) {
        if (prop === "update") {
          return (newImpl: T) => {
            impl = newImpl;
          };
        }
        return target[prop as keyof typeof target];
      },
    }
  ) as T;
}
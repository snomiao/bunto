#!/usr/bin/env bun
// import "dotenv";
import ignore from "ignore";
import pProps from "p-props";
import path from "path";
import DIE from "phpdie";
import { difference, keys, sortBy, uniq } from "rambda";
import { regexMapper } from "regex-mapper";
import { nil, sflow } from "sflow";
import { bunPMCommand } from "./bunPMCommand";
import { hackNextJSPath } from "./globflow";
import pkg from "./package.json";
if (import.meta.main) {
  await bunAuto();
}
export const bunAutoInstall = bunAuto;
const config = {
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
export default async function bunAuto({
  watch = true,
  install = true,
  remove = true,
  dry = false,
  signal = new AbortController().signal,
  verbose = true,
  watchReady = false,
} = {}) {
  console.log("[Bun Auto] v" + pkg.version);
  let bunPmRunning = false;

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
  const ignoreFilter = await getIgnoreFilterFromGlob();

  // config texts
  const allConfigText = await getAllTextFromGlob(config.configsGlob);

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
        const pkg = JSON.parse(pkgJson);
        const scriptsStr = Object.values(pkg.scripts || {}).join("\n");
        const pkgDeps = keys(pkg)
          .filter((k) => k.match(/dependencies$/i))
          .map((k) => keys(pkg[k]))
          .flat();
        return { dir, scriptsStr, pkgDeps };
      });
    });
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

async function getIgnoreFilterFromGlob(): Promise<(f: string) => boolean> {
  const ignoreFilesGlob = config.ignoreFilesGlob;
  return await sflow(new Bun.Glob(ignoreFilesGlob).scan({ dot: true }))
    .map(async (f) => [f, await Bun.file(f).text().catch(nil)] as const)
    .reduce(
      (map, [k, v]) => (v ? map.set(k, v) : (map.delete(k), map)),
      new Map<string, string>()
    )
    .tail(1)
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
    .toExactlyOne()!;
}

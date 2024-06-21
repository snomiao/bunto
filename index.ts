#!bun
import "rambda";

// import fs from "fs/promises";
// import { from } from "web-streams-extensions";
// import { maps, nils } from "webstream-kernel";
// import "dotenv";
import fs from "fs/promises";
import ignore from "ignore";
import path from "path";
import { peekYaml } from "peek-log";
import { from } from "webstream-kernel";
/* 
bun update webstream-kernel --force
*/
// import 'dotenv';
// import "dotenv";
// import "dotenv";
import { $ } from "bun";
import { difference, keys, toPairs } from "rambda";
import { snoflow } from "snoflow";
import { of } from "web-streams-extensions";
import { logError } from "./logError";
import { nil } from "./nil";
import { wait } from "./wait";
if (import.meta.main) {
  await bunAutoInstall();
}
async function bunAutoInstall() {
  const nodeBuiltins =
    "assert,buffer,child_process,cluster,crypto,dgram,dns,domain,events,fs,http,https,net,os,path,punycode,querystring,readline,stream,string_decoder,timers,tls,tty,url,util,v8,vm,zlib".split(
      ","
    );
  const transpiler = new Bun.Transpiler({ loader: "tsx" });

  const ignores = await fs.readFile(".gitignore", "utf8");
  const pattern = "**/*.{ts,tsx,jsx,js}";
  const ignorer = ignore({ allowRelativePaths: true }).add(ignores.split("\n"));
  const fname = new Map();
  const fimports = new Map();
  const glob = new Bun.Glob(pattern);
  const imports = snoflow(fs.watch("./"))
    .map((event) => event.filename)
    .filter()
    .map((f) => path.relative(process.cwd(), f))
    .filter((f) => glob.match(f))
    .join((s) => from(glob.scan()).pipeTo(s))
    .map((f) => f.replace(/\\/g, "/"))
    .filter(ignorer.createFilter())
    .reduce(new Map<string, string[]>(), async (m, f) => {
      const c = await fs.readFile(f, "utf8").catch(() => (m.delete(f), null));
      c &&
        (await wait(() => transpiler.scanImports(c))
          .then((deps) =>
            m.set(
              f,
              deps.map((e) => e.path)
            )
          )
          .catch(nil));
      // c &&
      //   (await wait(() => importWalk(c))
      //     .then((deps) => m.set(f, deps))
      //     .catch(nil));
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

  type pkg = Record<string, Record<string, string>>;
  const deps = snoflow(fs.watch("./package.json"))
    .map((e) => "file_changed")
    .join(of("initial_change"))
    .map(() => fs.readFile("./package.json", "utf-8"))
    .map((s) => wait(() => JSON.parse(s)).catch(logError))
    .filter()
    .map((pkg) =>
      toPairs(pkg)
        .filter(([key, depObj]) => key.match(/dependencies$/i))
        .flatMap(([k, depObj]) => keys(depObj) as string[])
    )
    .map(peekYaml);

  type input = { imports?: string[]; deps?: string[] };
  type output = { install?: string[]; remove?: string[] };
  type cmd = { install?: string; remove?: string };
  // diff
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
    .debounce(1000)
    // convert diff to command
    .flatMap<cmd | undefined>(({ install, remove }) =>
      [
        install
          ?.filter((e) => !nodeBuiltins.includes(e))
          .map((install) => ({ install })),
        remove
          ?.filter((e) => !e.startsWith("@types"))
          .filter((e) => e !== "typescript")
          .map((remove) => ({ remove })),
      ].flat()
    )
    .filter()
    .peek((e) => peekYaml(e))
    .throttle(1000)
    .map(async (cmd) => {
      cmd.install && (await $`bun install ${cmd.install}`);
      cmd.remove && (await $`bun remove ${cmd.remove}`);
    })
    // .tees(s=>s.tee({ install }) => peekYaml(install, "install"))
    // .tees(s=>s.tee({ remove }) => peekYaml(remove, "remove"))
    .done();
  // .pipeThrough(
  //   tees((r) =>
  //     r
  //       .pipeThrough(maps(prop("install")))
  //       .pipeThrough(flats())
  //       .pipeThrough(debounces(1e3))
  //       .pipeThrough(throttles(1e3))
  //       .pipeThrough(filters((x) => !!x.match(/^[a-zA-Z0-9-]$/i)))
  //       .pipeThrough(filters((x) => !builtins.includes(x)))
  //       .pipeThrough(peeks((e) => peekYaml(e, "install")))
  //       .pipeTo(nils())
  //   )
  // )
  // .pipeThrough(
  //   tees((r) =>
  //     r
  //       .pipeThrough(maps(prop("remove")))
  //       .pipeThrough(debounces(10e3))
  //       .pipeThrough(flats())
  //       .pipeThrough(throttles(1e3))
  //       .pipeThrough(filters((x) => !x.startsWith("@types/")))
  //       .pipeThrough(filters((x) => x !== "typescript"))
  //       .pipeThrough(peeks((e) => peekYaml(e, "remove")))
  //       .pipeTo(nils())
  //   )
  // )
  // .pipeThrough(filters())
  // .pipeThrough(peeks(peekYaml))
  // .pipeTo(nils())
  // .catch(nil);
  console.log("all done");
}

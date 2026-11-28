#!/usr/bin/env node
// Writes rs/parity.json, the parity cases for bunto (Rust against TypeScript).
//
//   node rs/parity.gen.mjs            rewrite rs/parity.json
//   node rs/parity.gen.mjs --check    fail if rs/parity.json is out of date
//
// How to run the cases (from the repository root, after `bun install
// --frozen-lockfile --ignore-scripts`, `bun run build`, which bundles cli.ts
// into bin/cli.js, the file npm publishes and the binary hands back to, and
// `cargo build --release --manifest-path rs/Cargo.toml`):
//
//   node <rustify>/templates/parity/parity.mjs --cases rs/parity.json \
//     --ts "sh rs/parity/run.sh bun bin/cli.js" \
//     --rs "env BUNTO_PACKAGE_ROOT=$PWD sh rs/parity/run.sh rs/target/release/bunto"
//   node <rustify>/templates/parity/parity.mjs --cases rs/parity.json \
//     --rs "sh rs/parity/run.sh rs/target/release/bunto" \
//     --handback BUNTO_PACKAGE_ROOT=bin/cli.js
//
// The first compares everything a case names; BUNTO_PACKAGE_ROOT lets the
// binary hand back what it does not answer itself. The second runs the
// binary against a stand-in package and fails unless exactly the cases
// marked `handback` for the system it runs on reached the JavaScript.
// `sh rs/parity/proof.sh <parity.mjs> <binary>` runs both, in lanes side by
// side, with the others proofs, on Linux, macOS or Windows (Git Bash).
//
// rs/parity/run.sh starts the command for a case: it puts a `bun` first on
// PATH that notes, and does not run, every install and removal (see there).
//
// What the binary answers (rs/src/cli.rs, rs/src/runtime.rs): the help, the
// version and yargs's `Unknown argument` error, for the command lines made
// of plain words and flags. Every command line that reaches a command's
// handler goes back to the JavaScript: at dec02fd every handler throws
// (`ReferenceError: getDeps is not defined`, index.tsx:50), and yargs
// answers with the command's help and bun's report of the error. The `work`
// cases show that on projects bunto is meant for, and that nothing is
// installed or removed by either side.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const flags = new Set(process.argv.slice(2));

const cases = [];
function add(name, args, o = {}) {
  if (cases.some((c) => c.name === name)) throw new Error(`two cases named ${JSON.stringify(name)}`);
  cases.push({ name, args, ...o });
}

// ── the yargs chain of cli.ts, as rs/src/cli.rs has it ────────────────────
//
// Only to say which cases are meant to reach the JavaScript. The --handback
// check holds the binary to these marks, and the comparison holds the
// binary to the TypeScript, so a mistake here shows in one of the two.

const isName = (text) => /^[a-z][a-z0-9]*$/.test(text);
function lex(args) {
  const toks = [];
  for (const arg of args) {
    let tok;
    if (arg.startsWith("--")) tok = arg.length >= 4 && isName(arg.slice(2)) ? { opt: arg.slice(2) } : null;
    else if (arg.startsWith("-")) tok = arg.length === 2 && isName(arg.slice(1)) ? { opt: arg.slice(1) } : null;
    else tok = isName(arg) ? { word: arg } : null;
    if (!tok || ["true", "false", "constructor"].includes(tok.opt ?? tok.word)) return null;
    toks.push(tok);
  }
  return toks;
}
function known(ctx, name) {
  const global = ["help", "h", "version", "v"].includes(name);
  const command = ["watch", "w", "dry"].includes(name);
  const defaultCommand = ["remove", "r", "install", "i"].includes(name);
  if (ctx === "top") return global;
  if (ctx === "fallback" || ctx === "auto") return global || command || defaultCommand;
  return global || command;
}
function parse(toks, ctx) {
  const p = { help: false, version: false, unknown: [], words: [] };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.word) p.words.push(t.word);
    else if (known(ctx, t.opt)) {
      if (t.opt === "help" || t.opt === "h") p.help = true;
      if (t.opt === "version" || t.opt === "v") p.version = true;
    } else {
      if (!p.unknown.includes(t.opt)) p.unknown.push(t.opt);
      if (toks[i + 1]?.word) i++;
    }
  }
  if (p.words.at(-1) === "help") {
    p.words.pop();
    p.help = true;
  }
  return p;
}
const COMMANDS = { auto: "auto", install: "install", i: "install", remove: "remove", r: "remove" };
/** "help", "version", "unknown", "handler", or null for a command line outside the model. */
function outcome(args) {
  const toks = lex(args);
  if (!toks) return null;
  const top = parse(toks, "top");
  let ctx = COMMANDS[top.words[0]];
  if (!ctx && top.help) return "help";
  ctx ??= "fallback";
  const inner = parse(toks, ctx);
  if (inner.help) return "help";
  if (inner.version) return "version";
  const rest = inner.words.slice(ctx === "fallback" ? 0 : 1);
  return inner.unknown.length || rest.length ? "unknown" : "handler";
}

const HANDLER = "the command's handler runs, and at dec02fd it throws (ReferenceError: getDeps is not defined); yargs prints the help and bun's report of the error, which the binary does not imitate";
const OUTSIDE = "a spelling outside the command lines rs/src/cli.rs models (lex): yargs answers it";
function argsMark(args) {
  const o = outcome(args);
  if (o === null) return { handback: OUTSIDE };
  if (o === "handler") return { handback: HANDLER };
  return {};
}
const shown = (args) => args.map((a) => (a === "" ? '""' : /[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ") || "(nothing)";

// ═══════════════════════════ args ═══════════════════════════
// Every command line of up to two words from this vocabulary, then longer
// ones drawn from it (the same on every run). rs/parity/args.mjs compares
// thousands more against bin/cli.js directly.

const WORDS = ["auto", "install", "i", "remove", "r", "help", "foo", "version", "--help", "-h", "--version", "-v", "--dry", "--watch", "-w", "--remove", "-r", "--install", "-i", "--nope", "-x"];
const lines = [[]];
for (const a of WORDS) lines.push([a]);
for (const a of WORDS) for (const b of WORDS) lines.push([a, b]);
const LONGER = [...WORDS, "watch", "dry", "h", "v", "x1", "--auto", "-q"];
let seed = 20261127;
const below = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return Math.floor(seed / 65536) % n;
};
for (let k = 0; k < 200; k++) lines.push(Array.from({ length: 3 + below(3) }, () => LONGER[below(LONGER.length)]));
// Outside the vocabulary: the binary hands these back whatever they mean.
for (const args of [
  ["--no-dry"], ["--dry=true"], ["--help=false"], ["-wd"], ["-hv"], ["--"], ["-"], ["-h", "--"], ["--", "--help"], ["true"], ["--dry", "true"],
  ["--dry", "false"], ["1"], ["0x10"], ["--h"], ["--v"], ["--HELP"], ["Help"], ["HELP"], ["-W"], ["--constructor"], ["constructor"], ["--__proto__"],
  [""], ["a b"], ["--nope=1"], ["--a-b"], ["--fooBar"], ["é"], ["--hélp"], ["i", "--no-watch"], ["help", "-"], ["--version", "--no-version"],
]) lines.push(args);
const seen = new Set();
for (const args of lines) {
  const name = `args: ${shown(args)}`;
  if (seen.has(name)) continue;
  seen.add(name);
  add(name, args, argsMark(args));
}

// ═══════════════════════════ gate ═══════════════════════════
// The states of the machine that change what bun or the bundle prints
// before yargs answers (rs/src/runtime.rs), and some that do not.

const BACK = (why) => ({ handback: why });

// Variables.
add("gate: BUN_INSTALL is only where bun lives", ["--help"], { env: { BUN_INSTALL: "<HOME>/.bun" } });
for (const [name, value] of [["BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0"], ["bun_config_no_such_thing", "1"], ["__BUN_NO_SUCH_THING", "1"], ["NODE_ENV", "production"], ["NODE_NO_WARNINGS", "1"], ["MIMALLOC_SHOW_ERRORS", "0"], ["ICU_NO_SUCH_THING", "1"]]) {
  add(`gate: ${name} is the runtime's`, ["--help"], { env: { [name]: value }, ...BACK("a variable of bun's, node's, the allocator's or ICU's (rs/src/runtime.rs changes_the_runtime)") });
}
add("gate: YARGS_DISABLE_WRAP unwraps the help", ["--help"], { env: { YARGS_DISABLE_WRAP: "1" }, ...BACK("a variable of yargs's") });
add("gate: YARGS_DISABLE_WRAP and an error", ["--nope"], { env: { YARGS_DISABLE_WRAP: "1" }, ...BACK("a variable of yargs's") });
add("gate: YARGS_MIN_NODE_VERSION makes yargs-parser throw", ["--help"], { env: { YARGS_MIN_NODE_VERSION: "99" }, ...BACK("a variable of yargs's") });
add("gate: BUNTO_NO_NATIVE hands everything back", ["--help"], { env: { BUNTO_NO_NATIVE: "1" }, ...BACK("BUNTO_NO_NATIVE=1") });
add("gate: BUNTO_NO_NATIVE, the version", ["-v"], { env: { BUNTO_NO_NATIVE: "1" }, ...BACK("BUNTO_NO_NATIVE=1") });
add("gate: TZ, TERM and CI change nothing", ["--nope"], { env: { TZ: "America/New_York", TERM: "xterm-256color", CI: "true", GITHUB_ACTIONS: "true", COLORTERM: "truecolor" } });
add("gate: stdin is not read", ["i", "--help"], { stdin: "y\nanything\n" });

// .env files: bun loads these four from the current directory (NODE_ENV is
// not set), and they can set anything, YARGS_DISABLE_WRAP included.
for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  add(`gate: ${file} that unwraps the help`, ["--help"], { files: { [file]: "YARGS_DISABLE_WRAP=1\n" }, ...BACK("bun loads it into the environment (rs/src/runtime.rs DOTENV_FILES)") });
}
add("gate: .env with nothing in it for yargs", ["--help"], { files: { ".env": "A=1\n" }, ...BACK("bun loads it into the environment") });
add("gate: .env and an error", ["foo"], { files: { ".env": "A=1\n" }, ...BACK("bun loads it into the environment") });
add("gate: .env and the version", ["--version"], { files: { ".env": "A=1\n" }, ...BACK("bun loads it into the environment") });
add("gate: .env that is a directory", ["--help"], { setup: ["mkdir .env"], ...BACK("bun loads it into the environment") });
for (const file of [".env.production", ".env.test", ".env.example", ".envrc", "env"]) {
  add(`gate: ${file} is not loaded`, ["--help"], { files: { [file]: "YARGS_DISABLE_WRAP=1\n" } });
}
add("gate: .env of the directory above is not loaded", ["--help"], { setup: ["printf 'YARGS_DISABLE_WRAP=1\\n' > <ROOT>/.env"] });

// bunfig.toml: of the current directory, and the user's own.
add("gate: bunfig.toml that preloads a script", ["--help"], { files: { "bunfig.toml": 'preload = ["./pre.js"]\n', "pre.js": 'console.log("preloaded");\n' }, ...BACK("bun reads bunfig.toml of the current directory") });
add("gate: bunfig.toml that is empty", ["--help"], { files: { "bunfig.toml": "" }, ...BACK("bun reads bunfig.toml of the current directory") });
// (A bunfig.toml that bun cannot parse goes back as well, but there bun
// stops before any program, the --handback check's stand-in included, so no
// case can show who answered.)
// The user's own bunfig: bun 1.4.0 does not read it to run a file, but it
// may elsewhere; it goes back.
add("gate: ~/.bunfig.toml", ["--help"], { setup: ["printf '[install]\\n' > <HOME>/.bunfig.toml"], ...BACK("bun reads the user's bunfig") });
add("gate: $XDG_CONFIG_HOME/.bunfig.toml", ["--help"], { setup: ["mkdir -p <HOME>/.config", "printf '[install]\\n' > <HOME>/.config/.bunfig.toml"], ...BACK("bun reads the user's bunfig") });
add("gate: bunfig.toml of the directory above is not read", ["--help"], { setup: ["printf 'console.log(\"preloaded\")\\n' > <ROOT>/pre.js", "printf 'preload = [\"<ROOT>/pre.js\"]\\n' > <ROOT>/bunfig.toml"] });

// package.json, tsconfig.json and jsconfig.json, here and above: bun does
// not report them for a bundle (bin/cli.js carries `// @bun`).
const PROJECT = JSON.stringify({ name: "app", version: "1.0.0", dependencies: { lodash: "^4.17.21" }, scripts: { build: "tsc" } }, null, 2) + "\n";
add("gate: a project's package.json", ["--help"], { files: { "package.json": PROJECT } });
add("gate: a package.json that is not JSON", ["--help"], { files: { "package.json": "{ not json\n" } });
add("gate: a package.json that is not JSON, and an error", ["--nope"], { files: { "package.json": "{ not json\n" } });
add("gate: a tsconfig.json and a jsconfig.json that are not JSON", ["-v"], { files: { "tsconfig.json": "{ not json\n", "jsconfig.json": "{ not json\n" } });
add("gate: a package.json above that is not JSON", ["i", "--help"], { setup: ["printf '{ not json\\n' > <ROOT>/package.json", "printf '{ not json\\n' > <ROOT>/tsconfig.json"] });
add("gate: package.json of another type", ["r", "-h"], { files: { "package.json": '{"type":"commonjs","workspaces":5,"imports":3}\n' } });

// yargs's locale: y18n finds no translations beside the package, so every
// language is English, until there is a `locales` directory there.
for (const [name, value] of [["LANG", "de_DE.UTF-8"], ["LC_ALL", "fr_FR.UTF-8"], ["LC_MESSAGES", "ja_JP"], ["LANGUAGE", "es"], ["LANG", "C.UTF-8"], ["LANG", "POSIX"], ["LC_ALL", "zh_CN:zh"]]) {
  add(`gate: ${name}=${value} is still English`, ["--help"], { env: { [name]: value } });
}
add("gate: an empty LC_ALL is no locale", ["--nope"], { env: { LC_ALL: "", LANG: "de_DE.UTF-8" } });
add("gate: a locale that is a path", ["--help"], { env: { LC_ALL: "x/y" }, ...BACK("y18n would read a file elsewhere (rs/src/runtime.rs)") });
add("gate: a locale that is a Windows path", ["--help"], { env: { LANG: "a\\b" }, ...BACK("y18n would read a file elsewhere") });
const COPY = ["mkdir -p <ROOT>/pkg/bin", "cp <REPO>/package.json <ROOT>/pkg/package.json", "cp <REPO>/bin/cli.js <ROOT>/pkg/bin/cli.js"];
const FROM_COPY = { X_PKG: "<ROOT>/pkg" };
add("gate: a copy of the package", ["--help"], { setup: COPY, env: FROM_COPY });
add("gate: a copy of the package, the version", ["--version"], { setup: COPY, env: FROM_COPY });
add("gate: locales beside the package, in German", ["--help"], { setup: [...COPY, "mkdir <ROOT>/locales", `printf '{"Show help": "Hilfe anzeigen"}\\n' > <ROOT>/locales/de.json`], env: { ...FROM_COPY, LANG: "de_DE.UTF-8" }, ...BACK("a locales directory beside the package (rs/src/runtime.rs)") });
add("gate: locales beside the package, en_US", ["--nope"], { setup: [...COPY, "mkdir <ROOT>/locales", `printf '{"Show help": "HELP!"}\\n' > <ROOT>/locales/en_US.json`], env: FROM_COPY, ...BACK("a locales directory beside the package") });
add("gate: locales beside the package, none for this language", ["-h"], { setup: [...COPY, "mkdir <ROOT>/locales", `printf '{"Show help": "Hilfe anzeigen"}\\n' > <ROOT>/locales/de.json`], env: FROM_COPY, ...BACK("a locales directory beside the package") });
add("gate: locales beside the package, empty", ["-v"], { setup: [...COPY, "mkdir <ROOT>/locales"], env: FROM_COPY, ...BACK("a locales directory beside the package") });
add("gate: locales inside the package are not y18n's", ["--help"], { setup: [...COPY, "mkdir <ROOT>/pkg/locales", `printf '{"Show help": "HELP!"}\\n' > <ROOT>/pkg/locales/en_US.json`], env: FROM_COPY });
add("gate: locales beside the package a link names", ["--help"], {
  setup: ["mkdir -p <ROOT>/real/pkg/bin <ROOT>/real/locales", "cp <REPO>/package.json <ROOT>/real/pkg/", "cp <REPO>/bin/cli.js <ROOT>/real/pkg/bin/", `printf '{"Show help": "HELP!"}\\n' > <ROOT>/real/locales/en_US.json`, "ln -s <ROOT>/real/pkg <ROOT>/link"],
  env: { X_PKG: "<ROOT>/link" },
  ...BACK("a locales directory beside the package's real directory"),
});
add("gate: locales beside the link to the package", ["--help"], {
  setup: ["mkdir -p <ROOT>/real/pkg/bin <ROOT>/locales", "cp <REPO>/package.json <ROOT>/real/pkg/", "cp <REPO>/bin/cli.js <ROOT>/real/pkg/bin/", `printf '{"Show help": "HELP!"}\\n' > <ROOT>/locales/en_US.json`, "ln -s <ROOT>/real/pkg <ROOT>/link"],
  env: { X_PKG: "<ROOT>/link" },
  ...BACK("a locales directory beside the link to the package"),
});
// A package in a directory with `?` in its name: bun cannot load the
// program there, not even the --handback check's stand-in, so no case can
// show it; rs/src/runtime.rs's test `bun_cannot_load_such_a_path` does.

// Colour: bun makes console.error red when stdout or stderr is a terminal,
// or FORCE_COLOR asks for it; console.log stays plain.
for (const value of ["1", "0", ""]) add(`gate: FORCE_COLOR=${value} and an error`, ["--nope"], { env: { FORCE_COLOR: value }, ...BACK("FORCE_COLOR decides bun's colour of console.error") });
add("gate: FORCE_COLOR and the help", ["--help"], { env: { FORCE_COLOR: "1" } });
add("gate: FORCE_COLOR and the version", ["-v"], { env: { FORCE_COLOR: "3" } });
add("gate: NO_COLOR and an error", ["i", "--nope"], { env: { NO_COLOR: "1" } });

// A terminal (80 columns unless X_COLS says otherwise).
const TTY_ERR = "console.error on a terminal is red (rs/src/runtime.rs stderr_is_plain)";
add("tty: the help on a terminal", ["--help"], { tty: "stdout" });
add("tty: the help with everything on a terminal", ["install", "--help"], { tty: true });
add("tty: the help with stderr on a terminal", ["help"], { tty: "stderr" });
add("tty: the version on a terminal", ["-v"], { tty: "stdout" });
add("tty: an error with stdout on a terminal", ["--nope"], { tty: "stdout", ...BACK(TTY_ERR) });
add("tty: an error with stderr on a terminal", ["foo"], { tty: "stderr", ...BACK(TTY_ERR) });
add("tty: an error with everything on a terminal", ["r", "--nope"], { tty: true, ...BACK(TTY_ERR) });
for (const cols of ["60", "79"]) add(`tty: the help on a terminal ${cols} columns wide`, ["--help"], { tty: "stdout", env: { X_COLS: cols }, ...BACK("yargs wraps the help to a terminal under 80 columns") });
add("tty: the version on a terminal 60 columns wide", ["--version"], { tty: "stdout", env: { X_COLS: "60" }, ...BACK("on a terminal under 80 columns stdout goes back") });
for (const cols of ["80", "200"]) add(`tty: the help on a terminal ${cols} columns wide`, ["i", "--help"], { tty: "stdout", env: { X_COLS: cols } });
add("tty: a narrow terminal that only stderr is", ["--help"], { tty: "stderr", env: { X_COLS: "60" } });
add("tty: the handler on a terminal", ["i"], { tty: "stdout", ...BACK(HANDLER) });

add("gate: a current directory that has been removed", ["--help"], { env: { X_GONE: "1" }, ...BACK("bun fails when the current directory has gone") });

// ═══════════════════════════ work ═══════════════════════════
// The commands on projects bunto is meant for. At dec02fd each of them ends
// in the handler's error (every one is handed back), and neither side asks
// bun to install or remove anything: `bun.log` stays empty. The registry is
// a closed port, should anything get as far as asking it.

const NPMRC = "registry=http://127.0.0.1:9/\n";
const APP = {
  ".npmrc": NPMRC,
  "package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { build: "tsc && prettier --write ." }, dependencies: { lodash: "^4.17.21", "left-pad": "1.3.0" }, devDependencies: { typescript: "^5.0.0", "prettier-plugin-x": "1.0.0", "@types/lodash": "^4" } }, null, 2) + "\n",
  "index.ts": 'import _ from "lodash";\nimport { z } from "zod";\nimport type { Foo } from "@scope/types/deep";\nimport fs from "node:fs";\nimport { $ } from "bun";\nimport "./local";\n',
  "local.ts": "export const local = 1;\n",
  ".gitignore": "dist\n",
  "dist/out.js": 'import "only-in-dist";\n',
  "packages/sub/package.json": JSON.stringify({ name: "sub", dependencies: { chalk: "^5" } }, null, 2) + "\n",
  "packages/sub/src/a.tsx": 'import React from "react";\nimport chalk from "chalk";\nimport { x } from "@/alias";\nexport const A = () => null;\n',
  "packages/sub/lib.mjs": 'import yaml from "yaml/dist/index.js";\n',
};
const AFTER = ["cat <ROOT>/bun.log 2> /dev/null || echo 'bun was asked to install or remove nothing'", "ls -A", "cat package.json packages/sub/package.json"];
for (const args of [[], ["auto"], ["-w"], ["--watch"], ["--dry"], ["-r"], ["--install"], ["i"], ["install", "--dry"], ["i", "-w"], ["r"], ["remove", "--watch", "--dry"], ["r", "--dry"]]) {
  add(`work: ${shown(args)} on a project`, args, { files: APP, after: AFTER, ...BACK(HANDLER) });
}
add("work: bunto in an empty directory", [], { files: { ".npmrc": NPMRC }, after: ["cat <ROOT>/bun.log 2> /dev/null || echo 'bun was asked to install or remove nothing'", "ls -A"], ...BACK(HANDLER) });
add("work: bunto i in a project with node_modules", ["i"], {
  files: { ...APP, "node_modules/lodash/package.json": '{"name":"lodash","version":"4.17.21"}\n', "node_modules/lodash/index.js": "module.exports = {};\n" },
  after: AFTER,
  ...BACK(HANDLER),
});
add("work: a usage error on a project changes nothing", ["i", "--nope"], { files: APP, after: AFTER });
add("work: the help on a project changes nothing", ["--help"], { files: APP, after: AFTER });

// ═══════════════════════════ systems ═══════════════════════════
// The same cases run on Linux, macOS and Windows (rs/parity/proof.sh).

// The binary answers natively only where these cases have passed
// (rs/parity/systems.json; rs/src/runtime.rs platform_is_proven); everywhere
// else every case is meant to reach the JavaScript.
const NATIVE_ON = JSON.parse(fs.readFileSync(path.join(HERE, "parity", "systems.json"), "utf8")).native;
for (const system of ["linux", "darwin", "win32"].filter((s) => !NATIVE_ON.includes(s))) {
  for (const c of cases) {
    if (typeof c.handback !== "string") c.handback = { ...c.handback, [system]: "every invocation goes back on this system (rs/src/runtime.rs platform_is_proven)" };
  }
}

const WINDOWS_SKIPS = [
  [(c) => c.tty, "a terminal: the runner has none on Windows"],
  [(c) => c.env?.X_GONE, "Windows does not remove a directory a process is in"],
  [(c) => (c.setup || []).some((line) => /\bln -s\b/.test(line)), "a symbolic link: Git Bash's ln -s copies the directory instead"],
];
for (const c of cases) {
  const why = WINDOWS_SKIPS.find(([applies]) => applies(c))?.[1];
  if (why) c.skip = { ...c.skip, win32: why };
}

// ═══════════════════════════ write ═══════════════════════════

const out = { env: { PARITY_BUN_LOG: "<ROOT>/bun.log" }, cases };
const text = JSON.stringify(out, null, 1) + "\n";
const target = path.join(HERE, "parity.json");
if (flags.has("--check")) {
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== text) {
    console.error("rs/parity.json is not what rs/parity.gen.mjs writes; run `node rs/parity.gen.mjs`");
    process.exit(1);
  }
  console.error(`rs/parity.json is up to date (${cases.length} cases)`);
} else {
  fs.writeFileSync(target, text);
  const back = (system) => cases.filter((c) => !c.skip?.[system] && (typeof c.handback === "string" || c.handback?.[system])).length;
  const skipped = (system) => cases.filter((c) => c.skip?.[system]).length;
  console.error(`wrote rs/parity.json (${cases.length} cases; handed back on linux ${back("linux")}, darwin ${back("darwin")}, win32 ${back("win32")}; skipped on win32 ${skipped("win32")})`);
}

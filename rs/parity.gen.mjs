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

// ═══════════════════════════ verify ═══════════════════════════
// An independent verifier's cases (2026-11-28), aimed at what the cases
// above missed; written by /tmp/vb-tools/gen-extra.mjs then, and kept here
// as they were, with the marks the repair calls for. Four kinds differed
// from bin/cli.js, and go back now (rs/src/runtime.rs):
// - a locale longer than a path may be: y18n opens `<locale>.json`, gets
//   ENAMETOOLONG instead of ENOENT, and rethrows it, so bin/cli.js ends
//   with bun's report of the error (Linux from about 4080 letters, macOS
//   from about 1000);
// - SIMDUTF_FORCE_IMPLEMENTATION, which bun reads as it starts;
// - the variables of the system's loader and allocator: glibc's ld.so
//   (LD_*) writes for bun, and the static Linux binary has none; macOS's
//   libmalloc (MallocStackLogging) writes for every process;
// - a `bun` on PATH that does not run (a version manager's shim).
// Where the programs around the command write lines of their own (ld.so and
// libmalloc write for each process, the runner's and run.sh's included, and
// each side starts other ones), those lines are taken out before comparing
// (LOADER_LINES): the cases compare what the command prints, and the
// --handback check shows who answered.

const V = (name, args, o = {}) => add(`verify: ${name}`, args, o);
const a = (n, ch = "a") => ch.repeat(n);
const LOCALE_BACK = "a locale y18n cannot open as a file that is not there (rs/src/runtime.rs ordinary_locale_file): past what a path may be, it rethrows ENAMETOOLONG";
const LOADER_BACK = "a variable of the system's loader or allocator, which bun goes through and this binary does not, or not alike (rs/src/runtime.rs changes_the_runtime)";
const SIMDUTF_BACK = "simdutf's variable, which bun reads as it starts (rs/src/runtime.rs changes_the_runtime)";
const BUN_BACK = "the bun on PATH does not run, or is not of the versions proven (rs/src/runtime.rs bun_runs)";
// The lines ld.so, dyld, libmalloc and the Objective-C runtime write for a
// process; [^\n]* takes a terminal's \r with it.
const LOADER_LINES = [
  ["(ERROR|WARNING): ld\\.so: [^\\n]*\\n", ""],
  ["warning: debug option [^\\n]*\\n", ""],
  ["AT_[A-Z0-9_]+:[^\\n]*\\n", ""],
  ["[\\w.-]+\\(\\d+\\) MallocStackLogging: [^\\n]*\\n", ""],
  ["dyld\\[\\d+\\]: [^\\n]*\\n", ""],
  ["objc\\[\\d+\\]: [^\\n]*\\n", ""],
];

// A locale longer than a path may be.
V("LANG of 5000 letters, --help", ["--help"], { env: { LANG: a(5000) }, ...BACK(LOCALE_BACK) });
V("LC_ALL of 5000 letters, an unknown argument", ["--nope"], { env: { LC_ALL: a(5000) }, ...BACK(LOCALE_BACK) });
V("LC_MESSAGES of 5000 letters, i --help", ["i", "--help"], { env: { LC_MESSAGES: a(5000) }, ...BACK(LOCALE_BACK) });
V("LANGUAGE of 5000 letters, r help", ["r", "help"], { env: { LANGUAGE: a(5000) }, ...BACK(LOCALE_BACK) });
V("LANG of 5000 letters with .UTF-8", ["-h"], { env: { LANG: a(5000) + ".UTF-8" }, ...BACK(LOCALE_BACK) });
V("LANG de_ and 5000 letters (language fallback)", ["--help"], { env: { LANG: "de_" + a(5000) }, ...BACK(LOCALE_BACK) });
V("LANG of 2100 e-acute (4200 bytes)", ["--help"], { env: { LANG: a(2100, "é") }, ...BACK(LOCALE_BACK) });
// bin/cli.js looks no text up for the version, but the binary asks before
// it knows what it will print.
V("LANG of 5000 letters, the version (no text looked up)", ["-v"], { env: { LANG: a(5000) }, ...BACK(LOCALE_BACK) });
V("LANG of 5000 letters, the handler", ["i"], { env: { LANG: a(5000) }, ...BACK(HANDLER) });
V("LANG of 300 letters (one name too long, the directory missing)", ["--help"], { env: { LANG: a(300) }, ...BACK(LOCALE_BACK) });
V("LANG of 900 letters", ["--nope"], { env: { LANG: a(900) }, ...BACK(LOCALE_BACK) });
V("LANG of 1100 letters", ["--help"], { env: { LANG: a(1100) }, ...BACK(LOCALE_BACK) });

// The dynamic loader, which bun goes through and a static binary does not.
V("LD_PRELOAD of a library that is not there, --help", ["--help"], { env: { LD_PRELOAD: "/nonexistent-verify.so" }, normalize: LOADER_LINES, ...BACK(LOADER_BACK) });
V("LD_PRELOAD of a library that is not there, an error", ["--nope"], { env: { LD_PRELOAD: "/nonexistent-verify.so" }, normalize: LOADER_LINES, ...BACK(LOADER_BACK) });
V("LD_AUDIT of a library that is not there, -v", ["-v"], { env: { LD_AUDIT: "/nonexistent-verify.so" }, normalize: LOADER_LINES, ...BACK(LOADER_BACK) });
V("LD_DEBUG=help", ["--help"], { env: { LD_DEBUG: "help" }, ...BACK(LOADER_BACK), skip: { linux: "ld.so writes its page and stops every program, the runner's sh first, so neither side starts" } });

// simdutf's variable: with these values bun 1.4.0 on x64 hangs and 1.4.5
// stops with exit 134, before any program, the --handback check's stand-in
// included, so no case can show there who answered. The Macs the cases run
// on are arm64, where bun runs with them. The cases `gate: SIMDUTF_…` set
// one with which bun runs everywhere.
const SIMDUTF_X64 = "on x64 bun hangs (1.4.0) or stops (1.4.5) with this value before any program, the stand-in's included";
V("SIMDUTF_FORCE_IMPLEMENTATION=1, --help", ["--help"], { env: { SIMDUTF_FORCE_IMPLEMENTATION: "1" }, timeout: 15, ...BACK(SIMDUTF_BACK), skip: { linux: SIMDUTF_X64, win32: SIMDUTF_X64 } });
V("SIMDUTF_FORCE_IMPLEMENTATION=fallback, an error", ["--nope"], { env: { SIMDUTF_FORCE_IMPLEMENTATION: "fallback" }, timeout: 15, ...BACK(SIMDUTF_BACK), skip: { linux: SIMDUTF_X64, win32: SIMDUTF_X64 } });

// macOS: libmalloc's variables make bun (and sh, on both sides) write to stderr.
V("MallocStackLogging (macOS), --help", ["--help"], { env: { MallocStackLogging: "1" }, normalize: LOADER_LINES, ...BACK(LOADER_BACK) });
V("MallocStackLogging (macOS), -v", ["-v"], { env: { MallocStackLogging: "1" }, normalize: LOADER_LINES, ...BACK(LOADER_BACK) });

// A bun on PATH that does not run bin/cli.js (a version manager's shim).
// The binary hands these back now (rs/src/runtime.rs bun_runs), to a bun
// that cannot run any JavaScript, the --handback check's stand-in included:
// so that check sees no JavaScript reached, and counts them among the
// answered. What shows the hand-back is the comparison: the shim's message
// and its exit code 126 on both sides, which only starting the shim gives.
// The cases `gate: a bun that says … to --version` show it to the
// --handback check as well, with a bun that fails only when asked that.
const FAKE_BUN = [
  "mkdir -p <ROOT>/fakebin",
  "printf '#!/bin/sh\\necho \"No version is set for command bun\" >&2\\nexit 126\\n' > <ROOT>/fakebin/bun",
  "chmod +x <ROOT>/fakebin/bun",
];
const NOWIN = { skip: { win32: "a shell script named bun is not bun.exe" } };
V("a bun shim that fails, --help", ["--help"], { setup: FAKE_BUN, env: { PATH: "<ROOT>/fakebin:/usr/bin:/bin" }, ...NOWIN });
V("a bun shim that fails, -v", ["-v"], { setup: FAKE_BUN, env: { PATH: "<ROOT>/fakebin:/usr/bin:/bin" }, ...NOWIN });
V("a bun shim that fails, an error", ["foo"], { setup: FAKE_BUN, env: { PATH: "<ROOT>/fakebin:/usr/bin:/bin" }, ...NOWIN });

// Huge and many arguments inside the vocabulary.
const VA = (name, args, o = {}) => V(name, args, { ...argsMark(args), ...o });
VA("an unknown option of 20000 letters", ["--" + a(20000, "q")]);
VA("2000 unknown words", Array(2000).fill("foo"));
VA("500 different unknown options", Array.from({ length: 500 }, (_, k) => `--o${k}`));
VA("help after 300 words", [...Array(300).fill("foo"), "help"]);
VA("-v and 1000 words", ["-v", ...Array(1000).fill("bar")]);
VA("i and 1000 --watch", ["i", ...Array(1000).fill("--watch")]);
VA("i, 1000 --watch and an unknown", ["i", ...Array(1000).fill("--watch"), "--zz"]);
VA("200 -h", Array(200).fill("-h"));
VA("a word of 50000 letters", [a(50000, "z")]);

// Orders and spellings inside the vocabulary.
for (const line of [
  ["help", "help", "help"], ["--dry", "--dry", "help"], ["-w", "-w", "help"], ["auto", "-r", "help"], ["remove", "-i", "help"], ["install", "-r", "x"],
  ["--version", "i", "--help"], ["i", "-v", "-h"], ["--nope", "help", "help"], ["-x", "-y", "help"], ["--remove", "r", "i"], ["--install", "--remove", "auto"],
  ["auto", "auto", "help"], ["r", "r"], ["i", "install"], ["foo", "--help", "i"], ["version"], ["version", "-v"], ["--watch", "--watch", "foo"],
  ["completion"], ["h"], ["v"], ["auto", "help", "foo"], ["-q", "i", "help"], ["i", "--dry", "--dry", "-w", "-w"],
]) VA(`args ${line.join(" ")}`, line);

// The environment: what changes nothing, and what goes back.
V("COLUMNS=40 through a pipe", ["--help"], { env: { COLUMNS: "40", LINES: "5" } });
V("CLICOLOR_FORCE and TERM=dumb, an error", ["--nope"], { env: { CLICOLOR_FORCE: "1", TERM: "dumb" } });
V("no HOME at all", ["--help"], { env: { HOME: null, USERPROFILE: null, XDG_CONFIG_HOME: null } });
V("a HOME that is relative", ["--help"], { env: { HOME: "rel" } });
V("a TMPDIR that does not exist", ["--nope"], { env: { TMPDIR: "<ROOT>/no-such-tmp" }, skip: { win32: "bun hangs on a TEMP it cannot use" } });
V("LANG=C with LC_ALL empty", ["--help"], { env: { LANG: "C", LC_ALL: "" } });
V("a locale of two dots", ["--help"], { env: { LC_ALL: ".." } });
V("a locale named constructor", ["--nope"], { env: { LANG: "constructor" } });
V("a locale named __proto__", ["--help"], { env: { LANG: "__proto__" } });
V("lower-case node_options", ["--help"], { env: { node_options: "--x" }, ...BACK("names are compared without case (runtime.rs changes_the_runtime)") });
V("JSC_ variables", ["--nope"], { env: { JSC_useJIT: "0", JSC_dumpOptions: "1" } });

// Files in the current directory.
V(".env that is a dangling link", ["--help"], { setup: ["ln -s <ROOT>/nowhere .env"], ...BACK("bun loads it") });
V(".ENV in capitals", ["--help"], { files: { ".ENV": "YARGS_DISABLE_WRAP=1\n" }, handback: { darwin: "a case-insensitive file system: .env is there", win32: "a case-insensitive file system: .env is there" } });
V("bunfig.toml that is a directory", ["-v"], { setup: ["mkdir bunfig.toml"], ...BACK("bun reads bunfig.toml") });
V(".bunfig.toml (hidden) in the current directory", ["--help"], { files: { ".bunfig.toml": 'preload = ["./pre.js"]\n', "pre.js": 'console.log("preloaded");\n' } });
V("a package.json with a yargs key", ["--help"], { files: { "package.json": '{"yargs":{"sort-commands":true,"unknown-options-as-args":true}}\n' } });
V("a package.json with a yargs key, an error", ["--nope"], { files: { "package.json": '{"yargs":{"unknown-options-as-args":true,"halt-at-non-option":true}}\n' } });
V("a node_modules/yargs that is broken", ["--help"], { files: { "node_modules/yargs/package.json": '{"name":"yargs","main":"x.js"}\n', "node_modules/yargs/x.js": "throw new Error('local yargs')\n" } });
V("a tsconfig.json that extends nothing", ["--nope"], { files: { "tsconfig.json": '{"extends":"./nope.json"}\n' } });
V("a bun.lockb that is garbage", ["--help"], { files: { "bun.lockb": "garbage\n", "bun.lock": "{ garbage\n" } });
V(".env.local.example and .env.sample", ["--help"], { files: { ".env.local.example": "YARGS_DISABLE_WRAP=1\n", ".env.sample": "YARGS_DISABLE_WRAP=1\n" } });
V("a CRLF .env", ["--help"], { files: { ".env": "YARGS_DISABLE_WRAP=1\r\n" }, ...BACK("bun loads it") });
V("a .env that is not UTF-8", ["--nope"], { setup: ["printf 'A=\\377\\376\\n' > .env"], ...BACK("bun loads it") });

// A copy of the package in odd places.
const COPY_AT = (dir) => [`mkdir -p "${dir}/bin"`, `cp <REPO>/package.json "${dir}/package.json"`, `cp <REPO>/bin/cli.js "${dir}/bin/cli.js"`];
V("the package in a node_modules of a project with a yargs key", ["--help"], {
  setup: [...COPY_AT("<ROOT>/proj/node_modules/bunto"), `printf '{"yargs":{"sort-commands":true}}\\n' > <ROOT>/proj/package.json`],
  env: { X_PKG: "<ROOT>/proj/node_modules/bunto" },
});
V("the package under a directory with spaces and #", ["--nope"], { setup: COPY_AT("<ROOT>/a b#c/pkg"), env: { X_PKG: "<ROOT>/a b#c/pkg" }, skip: { win32: "a # in a path" } });
V("the package under a directory with non-ASCII", ["--help"], { setup: COPY_AT("<ROOT>/日本/pkg"), env: { X_PKG: "<ROOT>/日本/pkg" } });
V("locales beside the package is a file", ["--help"], { setup: [...COPY_AT("<ROOT>/pkg"), "printf 'x' > <ROOT>/locales"], env: { X_PKG: "<ROOT>/pkg" }, ...BACK("a locales beside the package") });

// stdin.
V("a large stdin is not read", ["--nope"], { stdin: "y\n".repeat(50000) });

// Terminals (Linux and macOS).
V("tty: the help at 81 columns", ["--help"], { tty: "stdout", env: { X_COLS: "81" } });
V("tty: the help at 1000 columns", ["r", "help"], { tty: "stdout", env: { X_COLS: "1000" } });
V("tty: the version on a terminal, TERM unset", ["-v"], { tty: "stdout", env: { TERM: null } });
V("tty: the help, COLUMNS=40 on an 80-column terminal", ["--help"], { tty: "stdout", env: { COLUMNS: "40" } });
V("tty: stdin only is a terminal, an error", ["--nope"], { tty: "stdin" });
V("tty: stdin only is a terminal, the help", ["--help"], { tty: "stdin" });
V("tty: a long LANG on a terminal", ["--help"], { tty: "stdout", env: { LANG: a(5000) }, ...BACK(LOCALE_BACK) });

// ── What pins each repair ───────────────────────────────────────────────

// The locale: a plain name in a short path is still English; anything else
// goes back.
for (const [name, value] of [["LANG", "sr_RS@latin"], ["LANG", "de-DE"], ["LC_ALL", a(80)]]) {
  add(`gate: ${name}=${value.length > 20 ? `${value.length} letters` : value} is still English`, ["--help"], { env: { [name]: value } });
}
for (const [what, value] of [["a space", "de DE"], ["a star", "a*b"], ["a quotation mark", 'a"b'], ["a letter that is not ASCII", "é"], ["a tab", "a\tb"]]) {
  add(`gate: a locale with ${what} goes back`, ["--help"], { env: { LANG: value }, ...BACK(LOCALE_BACK) });
}
add("gate: a locale of 240 letters goes back", ["--nope"], { env: { LC_MESSAGES: a(240) }, ...BACK(LOCALE_BACK) });

// simdutf: with the implementation of this machine (run.sh X_SIMDUTF) bun
// runs, and the binary leaves it to bun all the same; so with any other
// variable of simdutf's.
add("gate: SIMDUTF_FORCE_IMPLEMENTATION of this machine, the help", ["--help"], { env: { X_SIMDUTF: "1" }, ...BACK(SIMDUTF_BACK) });
add("gate: SIMDUTF_FORCE_IMPLEMENTATION of this machine, an error", ["--nope"], { env: { X_SIMDUTF: "1" }, ...BACK(SIMDUTF_BACK) });
add("gate: another variable of simdutf's", ["-v"], { env: { SIMDUTF_NO_SUCH_THING: "1" }, ...BACK(SIMDUTF_BACK) });

// The loaders and allocators, on every system (each means nothing to the
// other systems' loaders, and goes back there as well).
for (const [name, value, args] of [
  ["LD_DEBUG", "nosuchoption", ["--help"]],
  ["LD_LIBRARY_PATH", "<ROOT>/no-such-lib", ["-v"]],
  ["LD_BIND_NOW", "1", ["i", "--help"]],
  ["GLIBC_TUNABLES", "nosuchtunable", ["--help"]],
  ["MALLOC_PERTURB_", "165", ["--nope"]],
  ["MallocScribble", "1", ["--help"]],
  ["OBJC_HELP", "1", ["--help"]],
  ["OBJC_PRINT_OPTIONS", "1", ["-v"]],
]) {
  add(`gate: ${name}=${value}`, args, { env: { [name]: value }, normalize: LOADER_LINES, ...BACK(LOADER_BACK) });
}
// Two allocator settings that profiles and containers often have, seen to
// change nothing for bun, are let through.
add("gate: MALLOC_ARENA_MAX changes nothing", ["--nope"], { env: { MALLOC_ARENA_MAX: "2" } });
add("gate: MallocNanoZone changes nothing", ["--help"], { env: { MallocNanoZone: "0" } });
// These come through run.sh (X_SET), for the command alone: on macOS the
// runner's sh and env take dyld's variables out of what they pass on, and
// LD_SHOW_AUXV makes every program write a page on stdout, which run.sh
// itself cannot take (it reads what dirname writes).
for (const [name, value, args] of [["DYLD_PRINT_LIBRARIES", "1", ["--help"]], ["DYLD_PRINT_APIS", "1", ["--nope"]], ["LD_SHOW_AUXV", "1", ["--nope"]]]) {
  add(`gate: ${name} for the command`, args, { env: { X_SET: `${name}=${value}` }, normalize: LOADER_LINES, ...BACK(LOADER_BACK) });
}
// On macOS dyld stops the binary, before its first line, when a library it
// is to insert is not there: no binary can hand that back (bin/cli.js, which
// /usr/bin/env starts, never sees the variable). Elsewhere it goes back.
add("gate: DYLD_INSERT_LIBRARIES for the command", ["-v"], {
  env: { X_SET: "DYLD_INSERT_LIBRARIES=<ROOT>/no-such.dylib" },
  normalize: LOADER_LINES,
  ...BACK(LOADER_BACK),
  skip: { darwin: "dyld stops the binary before its first line, so it cannot hand back (see the ledger)" },
});

// The bun on PATH is asked its version first (rs/src/runtime.rs bun_runs):
// one that answers as the versions proven do is taken, any other goes back.
// The `bun` here goes first on PATH (run.sh X_PATH) and runs the real one,
// which the setup line finds, for everything but --version.
const WRAPPED_BUN = (version) => [
  "mkdir -p <ROOT>/fakebin",
  `printf '#!/bin/sh\\ncase "$1" in --version) ${version} ;; esac\\nexec "%s" "$@"\\n' "$(command -v bun)" > <ROOT>/fakebin/bun`,
  "chmod +x <ROOT>/fakebin/bun",
];
for (const [what, version, mark] of [
  ["1.4.0", "echo 1.4.0; exit 0", {}],
  ["1.1.13", "echo 1.1.13; exit 0", {}],
  ["1.1.12", "echo 1.1.12; exit 0", BACK(BUN_BACK)],
  ["1.0.36", "echo 1.0.36; exit 0", BACK(BUN_BACK)],
  ["2.0.0", "echo 2.0.0; exit 0", BACK(BUN_BACK)],
  ["a version and a warning", "echo 1.4.0; echo warning >&2; exit 0", BACK(BUN_BACK)],
  ["nothing", "exit 0", BACK(BUN_BACK)],
  ["a failure", "echo 1.4.0; exit 1", BACK(BUN_BACK)],
  ["a version manager's failure", 'echo "No version is set for command bun" >&2; exit 126', BACK(BUN_BACK)],
]) {
  add(`gate: a bun that says ${what} to --version`, ["--help"], { setup: WRAPPED_BUN(version), env: { X_PATH: "<ROOT>/fakebin" }, ...NOWIN, ...mark });
}

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

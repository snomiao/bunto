#!/usr/bin/env node
// Holds the binary's reading of command lines (rs/src/cli.rs) to the yargs
// chain of bin/cli.js, line by line, for many more lines than the parity
// cases have:
//
//   node rs/parity/args.mjs <the bunto binary> [--count <n>] [--jobs <n>]
//
// from the repository root, after `bun run build`. It draws <n> command lines
// (1500; the same on every run) from the words cli.rs models and from some
// it does not, and runs each with `bun bin/cli.js` and with the binary. The
// binary gets a stand-in package (this package.json, and a bin/cli.js that
// only says it was reached), so a hand-back shows. It fails unless
//
//   - where the binary answers, it prints what bin/cli.js prints, on stdout
//     and stderr, with the same exit code;
//   - where bin/cli.js runs a command's handler (which throws at dec02fd),
//     the binary hands back;
//   - every line of words cli.rs models is answered by the binary unless
//     bin/cli.js runs a handler for it.
//
// On a system that rs/parity/systems.json does not name, the binary hands
// every invocation back, and every line has to be handed back.
//
// Each run has an empty home, temp directory and current directory of its
// own in $TMPDIR, PATH and nothing else of this environment (on Windows also
// SystemRoot and PATHEXT), and a registry that is a closed port.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 ? Number(argv[at + 1]) : fallback;
};
const named = argv.find((arg, i) => !arg.startsWith("--") && !["--count", "--jobs"].includes(argv[i - 1]));
if (!named) {
  console.error("usage: args.mjs <the bunto binary> [--count <n>] [--jobs <n>]");
  process.exit(2);
}
// Every run starts in a directory of its own. On Windows the binary may be
// named without its .exe ($RUSTIFY_BIN_DIR/bunto).
const binary = [path.resolve(named), `${path.resolve(named)}.exe`].find((file) => fs.existsSync(file)) ?? path.resolve(named);
const count = option("--count", 1500);
const jobs = option("--jobs", Math.min(4, os.cpus().length));
const repo = process.cwd();
const entry = path.join(repo, "bin", "cli.js");
if (!fs.existsSync(entry)) {
  console.error("args.mjs: no bin/cli.js here; run `bun run build` first");
  process.exit(2);
}

// The words rs/src/cli.rs models, and words it leaves to yargs.
const MODELLED = ["auto", "install", "i", "remove", "r", "help", "foo", "version", "watch", "dry", "w", "h", "v", "x1", "helpme",
  "--help", "-h", "--version", "-v", "--dry", "--watch", "-w", "--remove", "-r", "--install", "-i", "--nope", "--auto", "--helpx", "-x", "-q", "-d"];
const OUTSIDE = ["--no-dry", "--dry=false", "-wh", "--", "-", "true", "false", "1", "--h", "Help", "--Dry", "constructor", "", "a b"];
let seed = 1127;
const below = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return Math.floor(seed / 65536) % n;
};
const lines = [];
for (let k = 0; k < count; k++) {
  // One line in four may hold a word that is not modelled.
  const pool = k % 4 === 0 ? [...MODELLED, ...OUTSIDE] : MODELLED;
  lines.push(Array.from({ length: 1 + below(7) }, () => pool[below(pool.length)]));
}
const native = JSON.parse(fs.readFileSync(path.join(repo, "rs", "parity", "systems.json"), "utf8")).native.includes(process.platform);
const modelled = (line) => native && line.every((word) => MODELLED.includes(word));

const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bunto-args-"));
const standIn = path.join(work, "stand-in");
fs.mkdirSync(path.join(standIn, "bin"), { recursive: true });
fs.copyFileSync(path.join(repo, "package.json"), path.join(standIn, "package.json"));
const MARKER = "__BUNTO_ARGS_HANDED_BACK__";
fs.writeFileSync(path.join(standIn, "bin", "cli.js"), `console.log(${JSON.stringify(MARKER)});\n`);

const windows = process.platform === "win32";
let next = 0;
function run(program, args, extra) {
  const dir = path.join(work, `run-${next++}`);
  for (const sub of ["home", "tmp", "cwd"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, "cwd", ".npmrc"), "registry=http://127.0.0.1:9/\n");
  const env = { PATH: process.env.PATH, HOME: path.join(dir, "home"), USERPROFILE: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "home", ".config"), TMPDIR: path.join(dir, "tmp"), ...extra };
  if (windows) Object.assign(env, { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, TEMP: env.TMPDIR, TMP: env.TMPDIR });
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd: path.join(dir, "cwd"), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (err += data));
    child.on("error", (error) => resolve({ code: null, out, err: String(error) }));
    child.on("close", (code) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, out, err });
    });
  });
}

const failures = [];
const tally = { native: 0, handler: 0, outside: 0 };
async function check(line) {
  const ts = await run("bun", [entry, ...line], {});
  const rs = await run(binary, line, { BUNTO_PACKAGE_ROOT: standIn });
  const handler = ts.err.includes("ReferenceError: getDeps is not defined");
  const back = rs.out.includes(MARKER);
  const shown = JSON.stringify(line);
  if (ts.code === null || rs.code === null) {
    failures.push(`${shown}: could not be run: ${ts.code === null ? ts.err : rs.err}`);
    return;
  }
  if (back) {
    if (handler) tally.handler++;
    else if (!modelled(line)) tally.outside++;
    else failures.push(`${shown}: handed back, but bin/cli.js runs no handler for it (exit ${ts.code})`);
  } else if (handler) failures.push(`${shown}: answered by the binary, but bin/cli.js runs a handler for it`);
  else if (!native) failures.push(`${shown}: answered by the binary, but on ${process.platform} every invocation is meant to be handed back`);
  else if (ts.code !== rs.code || ts.out !== rs.out || ts.err !== rs.err) {
    failures.push(`${shown}: differs\n    bin/cli.js: exit ${ts.code} ${JSON.stringify(ts.out.slice(-200))} ${JSON.stringify(ts.err.slice(-200))}\n    binary:     exit ${rs.code} ${JSON.stringify(rs.out.slice(-200))} ${JSON.stringify(rs.err.slice(-200))}`);
  } else tally.native++;
}
let taken = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (taken < lines.length) await check(lines[taken++]);
}));
fs.rmSync(work, { recursive: true, force: true });

for (const failure of failures.slice(0, 40)) console.log(failure);
if (failures.length > 40) console.log(`… and ${failures.length - 40} more`);
const rest = native ? "outside the words modelled handed back" : `handed back, as every invocation is on ${process.platform}`;
const summary = `${lines.length} command line(s): ${tally.native} answered by the binary as bin/cli.js answers them, ${tally.handler} handed back where bin/cli.js runs a handler, ${tally.outside} ${rest}`;
if (failures.length) {
  console.log(`${failures.length} command line(s) went wrong; ${summary}`);
  process.exit(1);
}
console.log(summary);

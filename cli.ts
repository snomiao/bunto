#!bun

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import bunAuto from ".";
import pkg from "./package.json";
const argv = await yargs(hideBin(process.argv))
  .scriptName(pkg.name)
  .usage("$0 <cmd> [args]")
  .boolean("watch")
  .boolean("remove")
  .command("watch", "auto install missing dependencies")
  .command("remove", "auto remove unused dependencies")
  .command("install", "install missing dependencies")
  .version()
  .help().argv;
await bunAuto(argv);

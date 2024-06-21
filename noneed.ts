import { file, write } from "bun";
import fs from "fs/promises";
import { values } from "rambda";
import { snoflow } from "snoflow";

const path = import.meta.dir + "/notNeededPackages.json";
const localJson = await snoflow([path])
  .map((e) => fs.readFile(e, "utf8"))
  .toFirst();

if (import.meta.main) {
  await updateNotNeededPackages();
}

export const noneed = await snoflow([localJson])
  .map((e) => JSON.parse(e))
  .map((e) => e.packages)
  .map((e) => values(e))
  .flat()
  .map((e) => e.libraryName as string)
  .toArray()
  .then((e) => new Set(e));

async function updateNotNeededPackages() {
  const url =
    "https://raw.githubusercontent.com/DefinitelyTyped/DefinitelyTyped/master/notNeededPackages.json";
  const onlineJson = await snoflow([url])
    .map((e) => fetch(e))
    .map((e) => e.text())
    .toFirst();
  if (localJson !== onlineJson) {
    await write(file(path), onlineJson);
    console.log("Not needed packages updated");
  }
}

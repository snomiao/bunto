import { values } from "rambda";
import { snoflow } from "snoflow";
import notNeedData from "./notNeededPackages.json";

// if (import.meta.main) {
//   const path = import.meta.dir + "/notNeededPackages.json";
//   const localJson = await snoflow([path])
//     .map((e) => fs.readFile(e, "utf8"))
//     .toFirst();
//   await updateNotNeededPackages();

//   async function updateNotNeededPackages() {
//     const url =
//       "https://raw.githubusercontent.com/DefinitelyTyped/DefinitelyTyped/master/notNeededPackages.json";
//     const onlineJson = await snoflow([url])
//       .map((e) => fetch(e))
//       .map((e) => e.text())
//       .toFirst();
//     if (localJson !== onlineJson) {
//       await write(file(path), onlineJson);
//       console.log("Not needed packages updated");
//     }
//     console.log("done");
//   }
// }

export const notneed = await snoflow([notNeedData])
  .map((e) => e.packages)
  .map((e) => values(e))
  .flat()
  .map((e) => e.libraryName as string)
  .toArray()
  .then((e) => new Set(e));

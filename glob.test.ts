import fs from "fs/promises";

it("glob match", async () => {
  // create test file
  await fs.mkdir("./test-7rJz/app/api/auth/[...nextauth]", { recursive: true });
  await fs.writeFile(
    "./test-7rJz/app/api/auth/[...nextauth]/auth.ts",
    "nothing"
  );

  const glob = new Bun.Glob("./test-7rJz/app/api/**/*.ts");

  const scanned = await Array.fromAsync(glob.scan({ dot: true })); // = ['./app/api/auth/[...nextauth]/auth.ts']
  const matched = scanned.filter((e) => glob.match(e)); // = [] !?

  expect(scanned).toEqual(matched); // fail

  // let's check it again

  expect(glob.match("./test-7rJz/app/api/auth/[...nextauth]/auth.ts")).toBe(
    true
  ); // also fail

  // clean test folder
  await fs.rm("./test-7rJz", { recursive: true, force: true });
});

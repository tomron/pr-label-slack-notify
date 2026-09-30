import { build } from "esbuild";
import { mkdir, writeFile, readFile } from "node:fs/promises";
const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  metafile: true,
  legalComments: "linked",
});
await mkdir("dist", { recursive: true });
const files = Object.keys(result.metafile.inputs);
const roots = [
  ...new Set(
    files.flatMap((file) => {
      const match = file.match(/^(node_modules\/(?:@[^/]+\/)?[^/]+)\//);
      return match ? [match[1]] : [];
    }),
  ),
].sort();
const texts = [];
for (const root of roots) {
  for (const file of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "license",
    "license.md",
  ]) {
    try {
      texts.push(
        `\n=== ${root} ===\n${await readFile(`${root}/${file}`, "utf8")}`,
      );
      break;
    } catch {
      /* alternate license name */
    }
  }
}
await writeFile("dist/licenses.txt", texts.join("\n"));

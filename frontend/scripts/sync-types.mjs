// Copies backend/src/shared (the single source of msg types) into src/shared.
// The signed JSON must be byte-identical between frontend and backend (SOT/repo-structure.md).
// `--check` exits 1 if the copy has drifted instead of writing.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";

const src = new URL("../../backend/src/shared/", import.meta.url);
const dst = new URL("../src/shared/", import.meta.url);

const list = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .filter((file) => statSync(new URL(file, dir)).isFile())
        .sort()
    : [];
const same = (file) => readFileSync(new URL(file, src)).equals(readFileSync(new URL(file, dst)));

if (process.argv.includes("--check")) {
  const files = list(src);
  const ok = JSON.stringify(files) === JSON.stringify(list(dst)) && files.every(same);
  if (!ok) {
    console.error("src/shared is out of date. Run `npm run sync-types`.");
    process.exit(1);
  }
  console.log("src/shared is in sync.");
} else {
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log("Copied backend/src/shared to src/shared.");
}

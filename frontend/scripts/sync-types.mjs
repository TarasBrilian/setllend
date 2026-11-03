// Copies backend/src/shared (the single source of msg types) into src/shared.
// The signed JSON must be byte-identical between frontend and backend (SOT/repo-structure.md).
// Tests (`*.test.ts`) stay in the backend, which runs them. `--check` exits 1 if the copy has
// drifted instead of writing.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";

const src = new URL("../../backend/src/shared/", import.meta.url);
const dst = new URL("../src/shared/", import.meta.url);

// Fail before touching the committed copy, e.g. in a frontend-only checkout.
if (!existsSync(src)) {
  console.error("backend/src/shared not found. Run from a full checkout.");
  process.exit(1);
}

const isTest = (file) => file.endsWith(".test.ts");
const list = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .filter((file) => statSync(new URL(file, dir)).isFile() && !isTest(file))
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
  cpSync(src, dst, { recursive: true, filter: (path) => !isTest(path) });
  console.log("Copied backend/src/shared to src/shared.");
}

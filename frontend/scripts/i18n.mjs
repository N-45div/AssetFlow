// Keeps the three message files in step.
//
//   node scripts/i18n.mjs   writes zh-Hant.json from zh-Hans.json (OpenCC,
//                           mainland -> Hong Kong conventions), then fails if
//                           any file is missing a key that en.json has.
//
// zh-Hans is written by hand; zh-Hant is generated, never edited.
import { readFileSync, writeFileSync } from "node:fs";
import * as OpenCC from "opencc-js";

const read = (name) => JSON.parse(readFileSync(new URL(`../messages/${name}.json`, import.meta.url), "utf8"));
const toHongKong = OpenCC.Converter({ from: "cn", to: "hk" });

const convert = (value) =>
  typeof value === "string"
    ? toHongKong(value)
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));

const hant = convert(read("zh-Hans"));
writeFileSync(new URL("../messages/zh-Hant.json", import.meta.url), JSON.stringify(hant, null, 2) + "\n");

const keys = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => (typeof v === "string" ? [prefix + k] : keys(v, `${prefix}${k}.`)));
const expected = new Set(keys(read("en")));
let missing = 0;
for (const name of ["zh-Hans", "zh-Hant"]) {
  const have = new Set(keys(read(name)));
  for (const key of expected) {
    if (!have.has(key)) {
      console.error(`${name}: missing ${key}`);
      missing++;
    }
  }
}
if (missing) process.exit(1);
console.log(`zh-Hant written; ${expected.size} keys in every locale`);

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dataDir = resolve(process.cwd(), "data");
const statePath = resolve(dataDir, "state.json");

const initialState = {
  distributions: [],
  snapshots: [],
  redemptions: []
};

export async function loadState() {
  await mkdir(dataDir, { recursive: true });

  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      await saveState(initialState);
      return structuredClone(initialState);
    }

    throw error;
  }
}

export async function saveState(state) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

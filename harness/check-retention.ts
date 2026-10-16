/**
 * Privacy check: while a build runs, its checkpoint holds every domain, title
 * and page body the model saw. Nothing is uploaded or kept server-side (the
 * build runs on the plain Messages API), so the only copy is the local
 * checkpoint — confirm it is gone after a build.
 *
 * Run: pnpm agent:retention   (after pnpm agent:run)
 */
import { STORAGE_KEYS } from "@homepage/agent-core";
import { FileKVStore, STATE_PATH } from "./node-bridge";

const store = new FileKVStore(STATE_PATH);

let failures = 0;
const check = (label: string, pass: boolean) => {
  console.log(`${pass ? "✅" : "❌"} ${label}`);
  if (!pass) failures++;
};

check("no build checkpoint (page bodies) left in the store", !(await store.get(STORAGE_KEYS.buildCheckpoint)));
check("no build marked as in flight", !(await store.get(STORAGE_KEYS.activeSessionId)));

process.exit(failures === 0 ? 0 : 1);

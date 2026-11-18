/**
 * Append fake entries with a tiny size limit so you can watch rotation happen.
 * Writes to `.data-demo/activity/` by default, never to your real `.data/`.
 *
 *   npm run data:demo-activity -- --max-bytes 2000 --count 30
 *   npm run data:demo-activity -- --dir /some/other/folder
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PROJECT_ROOT } from "../paths";
import { ActivityLog } from "../storage/activity-log";

const { values } = parseArgs({
  options: {
    dir: { type: "string", default: join(PROJECT_ROOT, ".data-demo", "activity") },
    "max-bytes": { type: "string", default: "2000" },
    count: { type: "string", default: "30" },
  },
});

const maxBytes = Number(values["max-bytes"]);
const count = Number(values.count);
const tasks = ["task_0001_demo-login-fix", "task_0002_demo-add-tests"];

const log = new ActivityLog({ dir: values.dir, maxBytes });
await log.init();

for (let i = 0; i < count; i++) {
  const taskId = tasks[i % tasks.length] as string;
  await log.append({
    taskId,
    repo: "demo-repo",
    account: i % 3 === 0 ? "work_2-cursor" : "work_1-claude",
    event: i % 5 === 4 ? "fallback" : "message",
    detail: `Demo entry #${i + 1} for ${taskId}`,
  });
}

console.log(`\nFolder: ${values.dir}  (limit ${maxBytes} bytes per file)\n`);
const files = (await readdir(values.dir)).filter((n) => n.endsWith("_activity.json")).sort();
for (const name of files) {
  const { size } = await stat(join(values.dir, name));
  console.log(`  ${name}  ${String(size).padStart(7)} bytes${size > maxBytes ? "  (single oversized entry)" : ""}`);
}
console.log();
for (const taskId of tasks) {
  console.log(`  history(${taskId}): ${(await log.forTask(taskId)).length} entries`);
}
console.log();

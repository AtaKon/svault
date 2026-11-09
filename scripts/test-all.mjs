import { spawnSync } from "node:child_process";

const steps = [
  ["--import", "tsx", "scripts/run-i18n-check.ts"],
  [
    "--import",
    "tsx",
    "--disable-warning=ExperimentalWarning",
    "--test",
    "server/tests/api.test.ts",
    "scripts/check-i18n.test.mjs",
  ],
];

let failed = false;
for (const args of steps) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);

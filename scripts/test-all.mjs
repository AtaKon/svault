import { spawnSync } from "node:child_process";

const shared = ["--import", "tsx", "--disable-warning=ExperimentalWarning"];
const steps = [
  ["--import", "tsx", "scripts/run-i18n-check.ts"],
  [...shared, "--test", "scripts/check-i18n.test.mjs"],
  [...shared, "--test", "server/tests/api.test.ts"],
];

let failed = false;
for (const args of steps) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);

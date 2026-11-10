import { spawnSync } from "node:child_process";

const shared = ["--import", "tsx", "--disable-warning=ExperimentalWarning"];
const steps = [
  [...shared, "scripts/run-i18n-check.ts"],
  [...shared, "--test", "scripts/check-i18n.test.mjs"],
  ["scripts/pdfjs-render-smoke.mjs"],
  [...shared, "--test", "server/tests/api.test.ts"],
];

let failed = false;
for (const args of steps) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) {
    failed = true;
    const detail = result.error ? ` (${result.error.message})` : "";
    console.error(`\n[test-all] failed: node ${args.join(" ")}${detail}\n`);
  }
}
if (failed) console.error("[test-all] one or more steps failed");
process.exit(failed ? 1 : 0);

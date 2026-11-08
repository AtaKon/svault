#!/usr/bin/env node
/**
 * Print-only Open Food Facts staging checklist.
 *
 * This script NEVER writes to Open Food Facts. The default mode prints what to
 * do manually. `--check` performs GET requests only, against the staging host,
 * to confirm the read paths are reachable.
 *
 *   node scripts/off-staging-check.mjs
 *   node scripts/off-staging-check.mjs --check
 */

const STAGING = (process.env.OFF_STAGING_URL ?? "https://world.openfoodfacts.net").replace(/\/+$/, "");
const CONTACT = process.env.SV_OFF_CONTACT ?? "you@example.com";
const PROJECTS = [
  ["off", "Open Food Facts", "https://world.openfoodfacts.org", "3017620422003"],
  ["obf", "Open Beauty Facts", "https://world.openbeautyfacts.org", "3560070791460"],
  ["opff", "Open Pet Food Facts", "https://world.openpetfoodfacts.org", "8057592732736"],
  ["opf", "Open Products Facts", "https://world.openproductsfacts.org", "5029053527574"],
];

const check = process.argv.includes("--check");

function printChecklist() {
  console.log("Open Food Facts staging checklist\n");
  console.log("Keep SV_OFF_WRITE_ENABLED=false and SV_OFF_DRY_RUN=true while using this list.");
  console.log("Read the full runbook at docs/openfoodfacts-staging.md.\n");
  console.log("1. Create a staging account on https://world.openfoodfacts.net");
  console.log("2. Get a session cookie:");
  console.log(`   curl -i -X POST '${STAGING}/cgi/session.pl' \\`);
  console.log("     -H 'Content-Type: application/x-www-form-urlencoded' \\");
  console.log("     --data-urlencode \"user_id=$OFF_USER\" \\");
  console.log("     --data-urlencode \"password=$OFF_PASSWORD\"");
  console.log("3. Copy the session=... cookie into OFF_COOKIE.");
  console.log("4. Manually run the product edit, front photo, nutrition and per-project checks in the runbook.");
  console.log("5. Manually check Open Prices proof + price, NutriPatrol flag and Folksonomy property.");
  console.log("6. Only then set SV_OFF_WRITE_ENABLED=true and test one project at a time.\n");
  console.log(`User-Agent to use: SVault-staging-check/1.0 (${CONTACT})`);
  console.log("Nothing in this script sends a write request.\n");
}

async function read(url) {
  const headers = {
    "user-agent": `SVault-staging-check/1.0 (${CONTACT})`,
  };
  // Staging protects the site with HTTP Basic off:off.
  headers.authorization = "Basic " + Buffer.from("off:off").toString("base64");
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
    return { status: response.status, ok: response.ok };
  } catch (error) {
    return { status: 0, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runChecks() {
  console.log(`Read-only staging checks against ${STAGING}\n`);
  let failures = 0;
  for (const [id, label, , code] of PROJECTS) {
    const url = `${STAGING}/api/v3/product/${code}?fields=code,product_name,product_type`;
    const result = await read(url);
    const line = `${result.ok ? "ok  " : "fail"} ${id.padEnd(4)} ${label.padEnd(24)} HTTP ${result.status}`;
    console.log(line);
    if (!result.ok) failures++;
  }
  const universal = `${STAGING}/api/v3/product/3560070791460?product_type=all&fields=code,product_type`;
  const universalResult = await read(universal);
  console.log(`${universalResult.ok ? "ok  " : "fail"} all  universal redirect       HTTP ${universalResult.status}`);
  if (!universalResult.ok) failures++;

  console.log("");
  if (failures) {
    console.log(`${failures} read check(s) did not pass. Staging may not mirror every product; verify the URL and code, not SVault, first.`);
    console.log("No writes were attempted.");
    process.exitCode = 1;
  } else {
    console.log("Read checks passed. No writes were attempted.");
    console.log("Continue with the manual write checklist in docs/openfoodfacts-staging.md.");
  }
}

printChecklist();
if (check) await runChecks();
else console.log("Re-run with --check for GET-only staging reachability checks.");

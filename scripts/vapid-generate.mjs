#!/usr/bin/env node
/**
 * Print a fresh VAPID key pair for Web Push.
 *
 * Web Push needs a key pair the browser can verify against: the public key goes
 * to the browser (`VAPID_PUBLIC_KEY`) and the private key never leaves the
 * server (`VAPID_PRIVATE_KEY`). `VAPID_SUBJECT` is a contact address the push
 * service can use if the sender misbehaves; use `mailto:` or an `https://` URL.
 *
 * Usage:
 *   npm run vapid:generate
 *   npm run vapid:generate -- --json     # single JSON object, for scripts
 *
 * The keys are printed with `web-push`'s own generator, which is the same
 * library the server uses to sign, so the pair is known to work.
 */
import { generateVAPIDKeys } from "web-push";

const json = process.argv.includes("--json");
const { publicKey, privateKey } = generateVAPIDKeys();

if (json) {
  console.log(JSON.stringify({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey }, null, 2));
} else {
  console.log("Add these to .env (or the container environment) and restart SVault:\n");
  console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
  console.log("VAPID_SUBJECT=mailto:you@example.com");
  console.log("\nKeep the private key secret. Changing the pair invalidates existing subscriptions:");
  console.log("devices have to enable push again from Settings → Reminders.");
}

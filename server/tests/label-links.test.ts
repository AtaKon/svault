import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  labelPath,
  labelUrl,
  normalisePublicBase,
  parseLabelScan,
} from "../../shared/label-links.js";
import { matrixToSvgPath, qrMatrixFor } from "../../client/qr.js";

const BASE = "https://svault.example.com";
const HOUSE = "hse_abc123";
const ITEM = "itm_abc123";
const PLACE = "loc_abc123";

async function loadZxing() {
  const mod = (await import("@zxing/library")) as unknown as typeof import("@zxing/library") & {
    default?: typeof import("@zxing/library");
  };
  return mod.default ?? mod;
}

/** Rebuild the module grid from the SVG path our renderer writes. */
function gridFromPath(size: number, svgPath: string): boolean[][] {
  const grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const pattern = /M(\d+) (\d+)h1v1h-1z/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(svgPath))) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    assert.ok(x >= 0 && x < size && y >= 0 && y < size, `module outside the matrix: ${x},${y}`);
    grid[y][x] = true;
  }
  return grid;
}

function bitmapFromGrid(zxing: Awaited<ReturnType<typeof loadZxing>>, grid: boolean[][]) {
  const size = grid.length;
  const pixels = new Int32Array(size * size).fill(0xffffffff);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (grid[y][x]) pixels[y * size + x] = 0xff000000;
    }
  }
  return new zxing.BinaryBitmap(new zxing.HybridBinarizer(new zxing.RGBLuminanceSource(pixels, size, size)));
}

test("builds item and place links with the house", () => {
  assert.equal(labelPath("item", ITEM, HOUSE), `/items/${ITEM}?house=${HOUSE}`);
  assert.equal(labelPath("place", PLACE, HOUSE), `/items?location=${PLACE}&house=${HOUSE}`);
  assert.equal(labelPath("item", ITEM), `/items/${ITEM}`);
  assert.equal(labelPath("place", PLACE), `/items?location=${PLACE}`);
});

test("uses the configured public base URL and tolerates a trailing slash", () => {
  assert.equal(normalisePublicBase("https://svault.example.com/"), BASE);
  assert.equal(normalisePublicBase(" https://svault.example.com// "), BASE);
  assert.equal(
    normalisePublicBase("https://svault.example.com/svault/"),
    "https://svault.example.com/svault",
  );
  assert.equal(normalisePublicBase("javascript:alert(1)"), "");
  assert.equal(normalisePublicBase("not a url"), "");
  assert.equal(
    labelUrl({ kind: "item", id: ITEM, houseId: HOUSE, publicBase: "https://svault.example.com/" }),
    `${BASE}/items/${ITEM}?house=${HOUSE}`,
  );
  assert.equal(
    labelUrl({ kind: "place", id: PLACE, houseId: HOUSE, publicBase: BASE }),
    `${BASE}/items?location=${PLACE}&house=${HOUSE}`,
  );
});

test("accepts label links that point at this app", () => {
  assert.deepEqual(parseLabelScan(`${BASE}/items/${ITEM}?house=${HOUSE}`, BASE), {
    kind: "item",
    id: ITEM,
    houseId: HOUSE,
    path: `/items/${ITEM}?house=${HOUSE}`,
  });
  // A trailing slash on the configured base must not break matching.
  assert.deepEqual(parseLabelScan(`https://svault.example.com/items?location=${PLACE}`, `${BASE}/`), {
    kind: "place",
    id: PLACE,
    houseId: null,
    path: `/items?location=${PLACE}`,
  });
  // Deployments under a sub-path keep working.
  assert.equal(
    parseLabelScan("https://svault.example.com/svault/items/" + ITEM, "https://svault.example.com/svault")?.id,
    ITEM,
  );
  // A link without a house still opens the right item.
  assert.equal(parseLabelScan(`${BASE}/items/${ITEM}`, BASE)?.path, `/items/${ITEM}`);
});

test("rejects foreign origins, script URLs and non-label routes", () => {
  assert.equal(parseLabelScan(`https://evil.example.com/items/${ITEM}`, BASE), null);
  assert.equal(parseLabelScan(`https://svault.example.com.evil.test/items/${ITEM}`, BASE), null);
  assert.equal(parseLabelScan(`javascript:alert(1)`, BASE), null);
  assert.equal(parseLabelScan(`data:text/html,<script>alert(1)</script>`, BASE), null);
  assert.equal(parseLabelScan(`vbscript:msgbox(1)`, BASE), null);
  assert.equal(parseLabelScan(`https://user:pass@svault.example.com/items/${ITEM}`, BASE), null);
  assert.equal(parseLabelScan(`${BASE}/recipes/rec_123`, BASE), null);
  assert.equal(parseLabelScan(`${BASE}/items/not-an-item`, BASE), null);
  assert.equal(parseLabelScan(`${BASE}/items?location=unknown`, BASE), null);
  assert.equal(parseLabelScan("", BASE), null);
});

test("scan parsing ignores extra params, drops a malformed house and treats base path forms alike", () => {
  const extra = parseLabelScan(`${BASE}/items/${ITEM}?house=${HOUSE}&foo=bar`, BASE);
  assert.equal(extra?.path, `/items/${ITEM}?house=${HOUSE}`);

  const badHouse = parseLabelScan(`${BASE}/items/${ITEM}?house=../../etc`, BASE);
  assert.equal(badHouse?.houseId, null);
  assert.equal(badHouse?.path, `/items/${ITEM}`);

  const withSlash = parseLabelScan(`${BASE}/svault/items/${ITEM}`, `${BASE}/svault/`);
  const withoutSlash = parseLabelScan(`${BASE}/svault/items/${ITEM}`, `${BASE}/svault`);
  assert.deepEqual(withSlash, withoutSlash);
  assert.equal(parseLabelScan(`${BASE}/svault`, `${BASE}/svault`), null);
  assert.equal(parseLabelScan(`${BASE}/other/items/${ITEM}`, `${BASE}/svault`), null);
});

test("public base normalisation rejects queries, fragments and credentials", () => {
  assert.equal(normalisePublicBase("https://host/svault?x=1"), "");
  assert.equal(normalisePublicBase("https://host/svault#frag"), "");
  assert.equal(normalisePublicBase("https://user:pw@host"), "");
  assert.equal(normalisePublicBase("javascript:alert(1)"), "");
  assert.equal(normalisePublicBase("https://host/"), "https://host");
});

test("draws one SVG square per dark module", () => {
  const size = 3;
  const grid = [
    [true, false, true],
    [false, true, false],
    [true, false, false],
  ];
  assert.equal(matrixToSvgPath((x, y) => grid[y][x], size), "M0 0h1v1h-1zM2 0h1v1h-1zM1 1h1v1h-1zM0 2h1v1h-1z");
});

test("renders a QR code that decodes back to the label link", async () => {
  const zxing = await loadZxing();
  const url = labelUrl({ kind: "item", id: ITEM, houseId: HOUSE, publicBase: BASE });
  const code = await qrMatrixFor(url, zxing);
  assert.ok(code.size >= 21 && code.path.length > 0);
  const grid = gridFromPath(code.size, code.path);
  const bitmap = bitmapFromGrid(zxing, grid);

  const decoded = new zxing.QRCodeReader().decode(bitmap);
  assert.equal(decoded.getText(), url);

  // The camera reader decodes through MultiFormatReader with an empty hint map;
  // QR must come out of that same path before it is treated as a barcode.
  const multi = new zxing.MultiFormatReader().decode(bitmap, new Map());
  assert.equal(multi.getText(), url);
  assert.equal(multi.getBarcodeFormat(), zxing.BarcodeFormat.QR_CODE);
});

test("GET /api/labels returns the configured public base URL", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "svault-labels-"));
  const envKeys = ["DATA_DIR", "NODE_ENV", "SV_REGISTRATION", "PUBLIC_URL"] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  process.env.SV_REGISTRATION = "open";
  process.env.PUBLIC_URL = "https://labels.example.com";
  try {
    const { app } = await import("../index.js");
    const { closeDb } = await import("../db.js");
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;

      const anonymous = await fetch(`${origin}/api/labels`);
      assert.equal(anonymous.status, 401);

      const registration = await fetch(`${origin}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Label Owner", email: "labels@example.com", password: "test password" }),
      });
      assert.equal(registration.status, 201);
      const cookie = (registration.headers.get("set-cookie") ?? "").split(";")[0];

      const response = await fetch(`${origin}/api/labels`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { baseUrl: "https://labels.example.com" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDb();
    }
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

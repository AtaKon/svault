import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { addReceiptQrPayload } from "../../client/receipt-scan-priority.js";
import { matchReceiptQrLink, type ReceiptQrLink } from "../../shared/receipt-qr-links.js";
import { reconcileReceipt } from "../../shared/receipt-reconcile.js";
import { limiters } from "../rate-limit.js";
import { configureReceiptQrFetcherForTests, fetchQrReceiptDraft, readQrReceiptScan } from "../services/receipt-qr.js";
import { parseEntersoftInvoiceHtml } from "../services/receipt-entersoft.js";
import { parseImpactReceiptHtml } from "../services/receipt-impact.js";

const ref = "12345678-1234-1234-1234-123456789abc";
const token = "testAB12";
const entersoftUrl = `https://e-invoicing.gr/edocuments/ViewInvoice/-1/${ref}_${token}`;
const epsilonUrl = "https://epsilondigital-sklavenitis.epsilonnet.gr/fd/12345678123412341234123456789abc:12";
const issuerPath = `/api/GetInvoice?contentType=PEPPOL&intRefDocID=${ref}&hashToken=${token}&ofenm=-1&isPreview=True`;

function item(code: string, description: string, unit: string, qty: string, before: string, discount: string, amount: string) {
  return `<tr>
    <td data-title="Κωδικός">${code}</td><td data-title="Περιγραφή">${description}</td>
    <td data-title="Μ.Μ.">${unit}</td><td data-title="Ποσότητα">${qty}&nbsp;</td>
    <td data-title="Τιμή μονάδας">2,00</td><td data-title="Αξία προ έκπτωσης">${before}</td>
    <td data-title="Έκπτωση">${discount}</td><td data-title="ΦΠΑ%">13%</td>
    <td data-title="Συνολική Αξία">${amount}</td>
  </tr>`;
}

const invoice = `<div class="BoldBlueHeader">ΔΟΚΙΜΑΣΤΙΚΟ ΚΑΤΑΣΤΗΜΑ</div>
  <div>Αρ. Παραστατικού: 12 3456</div><div>2026</div>
  <div>Ημ/νία έκδοσης: 11-11-2026</div><div>Έναρξης Αποστολής: 2026-11-12</div>
  <table><tbody>
    ${item("SKU-A", "ΜΗΛΑ &amp; ΑΧΛΑΔΙΑ", "Κιλό", "1,250", "4,00", "0,50", "3,50")}
    ${item("PERTEL", "Περιβαλλοντικό τέλος", "Τεμάχιο", "1,00", "0,10", "0,00", "0,10")}
    <tr><td>Σύνολο</td><td></td><td></td><td>3,60</td></tr>
    <tr><td data-title="Περιγραφή">Σύνολο</td><td data-title="Συνολική Αξία">3,60</td></tr>
  </tbody></table>
  <div>Αξία προ έκπτωσης</div><div>4,10EUR</div>
  <div>Έκπτωση</div><div>0,50EUR</div>
  <div>ΤΕΛΙΚΗ ΑΞΙΑ</div><div>3,60EUR</div>
  <div>Καθαρή Αξία</div><div>3,19EUR</div>
  <div>Φ.Π.Α</div><div>0,41EUR</div>
  <div>ΑΝΑΛΥΣΗ ΦΠΑ</div>
  <div class="row"><div>0%</div><div>ΣΥΝΟΛΟ 7,00EUR</div><div>6,00EUR</div></div>
  <div class="row"><div>13%</div><div>3,19EUR</div><div>0,41EUR</div></div>
  <div>ΣΤΟΙΧΕΙΑ ΠΛΗΡΩΜΗΣ</div>`;

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

/* IMPACT eInvoicing: synthetic fixtures shaped exactly like the observed
 * einvoice.impact.gr/p/EL… viewer markup. */

const impactMarker = "1".repeat(40);
const impactUrl = `https://einvoice.impact.gr/p/EL123456789/${impactMarker}/${"2".repeat(32)}`;

function impactCell(field: string, text: string, extra = "") {
  return `<td class="${extra} field-${field}" data-header="${field}"><span class="field field-${field}"><span class="inner"><span class="value">${text}</span></span></span></td>`;
}

function impactLine(line: Partial<Record<"code" | "description" | "unit" | "quantity" | "net" | "vatCategory" | "vat" | "total", string>>) {
  const cell = (field: string, key: keyof typeof line) =>
    impactCell(field, line[key] ?? "", field === "Description1" || field === "Code" ? "text-left" : "text-right");
  return `<tr>${cell("Code", "code")}${cell("Description1", "description")}${cell("Quantity", "quantity")}${cell("MeasurementUnit", "unit")}${cell("NetTotal", "net")}${cell("VatCategory", "vatCategory")}${cell("VATTotal", "vat")}${cell("Total", "total")}</tr>`;
}

const impactProductHead = `<thead><tr>
    <th class="field field-Code text-left"><span class="label">Κωδικός</span></th>
    <th class="field field-Description1 text-left"><span class="label">Περιγραφή</span></th>
    <th class="field field-Quantity text-right"><span class="label">Ποσότητα</span></th>
    <th class="field field-MeasurementUnit"><span class="label">Μ.Μ.</span></th>
    <th class="field field-NetTotal text-right"><span class="label">Αξία</span></th>
    <th class="field field-VatCategory"><span class="label">Κατηγορία ΦΠΑ</span></th>
    <th class="field field-VATTotal text-right"><span class="label">ΦΠΑ</span></th>
    <th class="field field-Total text-right"><span class="label">Σύνολο</span></th>
  </tr></thead>`;

const impactProductTable = (lines: string[]) =>
  `<table class="table ">${impactProductHead}<tbody>${lines.join("")}</tbody></table>`;

const impactProducts = [
  impactLine({ code: "5201001100017", description: "Example product", unit: "Τεμάχιο", quantity: "1", net: "1,00", vatCategory: "24", vat: "0,24", total: "1,24" }),
  impactLine({ description: "Μήλα Ημαθίας", unit: "Κιλό", quantity: "1,250", net: "3,00", vatCategory: "13", vat: "0,39", total: "3,39" }),
];

function impactBody(lines: string[]) {
  return `<div class="company-info">
    <span class="field field-RegisteredName"><span class="inner"><span class="label">Επωνυμία επιχείρησης</span><span class="value">Example merchant</span></span></span>
    <span class="field field-DateIssued"><span class="inner"><span class="label">Ημ/νία έκδοσης</span><span class="value">20/11/2026 2:22 μ.μ.</span></span></span>
    <span class="field field-IssuerFormatedInvoiceSeriesNumber"><span class="inner"><span class="label">Αρ. Παραστατικού</span><span class="value">ΡΤ 123456</span></span></span>
  </div>
  <div class="section-identity">
    <span class="field field-RegisteredName"><span class="inner"><span class="label">Επωνυμία</span><span class="value">Example customer</span></span></span>
  </div>
  <div class="row section section-details"><div class="col-12">${impactProductTable(lines)}</div></div>
  <div id="mydata"><table id="InvoiceLineTable"><thead><tr><th>myDATA</th></tr></thead><tbody><tr><td>unrelated row</td></tr></tbody></table></div>
  <div class="section section-taxes"><table class="table"><thead><tr>
    <th class="field field-Percentage"><span class="label">ΦΠΑ</span></th>
    <th class="field field-UnderlyingValue"><span class="label">Αξία</span></th>
    <th class="field field-VatAmount"><span class="label">ΦΠΑ</span></th>
  </tr></thead><tbody>
    <tr>${impactCell("Percentage", "24%")}${impactCell("UnderlyingValue", "1,00")}${impactCell("VatAmount", "0,24")}</tr>
    <tr>${impactCell("Percentage", "13%")}${impactCell("UnderlyingValue", "3,00")}${impactCell("VatAmount", "0,39")}</tr>
  </tbody></table></div>
  <table class="table"><tbody>
    <tr class="field field-CurrencyCode text-right"><td class="label">Νόμισμα</td><td class="value">EUR</td></tr>
    <tr class="field field-TotalNetAmount text-right"><td class="label">Καθαρή Αξία</td><td class="value">4,00</td></tr>
    <tr class="field field-TotalVATAmount text-right"><td class="label">ΦΠΑ</td><td class="value">0,63</td></tr>
    <tr class="field field-TotalGrossValue text-right"><td class="label">Συνολική Αξία</td><td class="value">4,63</td></tr>
  </tbody></table>`;
}

function impactDraft(source: string) {
  const parsed = parseImpactReceiptHtml(source);
  assert.ok(parsed.status === "ok");
  return parsed.draft;
}

function invoiceDraft(body: string) {
  const parsed = parseEntersoftInvoiceHtml(body);
  assert.ok(parsed.status === "ok");
  return parsed.draft;
}

afterEach(() => configureReceiptQrFetcherForTests(null));

test("reads a pinned Entersoft document and preserves the amounts and weighted quantity", async () => {
  const requests: string[] = [];
  const frame = issuerPath
    .replace(token, "%74" + token.slice(1))
    .replace("&", "&#38;").replaceAll("&hashToken", "&amp;hashToken");
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return requests.length === 1
      ? html(`<iframe src='${frame}' id='iframeContent'></iframe>`)
      : html(invoice);
  });
  const result = await fetchQrReceiptDraft(entersoftUrl);
  assert.deepEqual(requests, [entersoftUrl, "https://e-invoicing.gr" + issuerPath]);
  assert.ok(result.status === "ok");
  assert.match(result.text, /ΜΗΛΑ/);
  assert.equal(result.draft.purchasedAt, "2026-11-11");
  assert.equal(result.draft.currency, "EUR");
  assert.equal(result.draft.notes, "Αρ. Παραστατικού 12 3456");
  assert.equal(result.draft.total, 3.60);
  assert.equal(result.draft.subtotal, 3.19);
  assert.equal(result.draft.tax, 0.41);
  assert.equal(result.draft.savings, 0.50);
  assert.deepEqual(result.draft.taxBreakdown, [{ rate: 13, net: 3.19, tax: 0.41, gross: 3.6 }]);
  assert.deepEqual(result.draft.lines, [{
    description: "ΜΗΛΑ & ΑΧΛΑΔΙΑ", rawDescription: "ΜΗΛΑ & ΑΧΛΑΔΙΑ",
    quantity: 1.25, unit: "kg", unitPrice: 2.8, lineTotal: 3.5, taxRate: 13, discount: 0.5, barcode: null,
  }]);
  assert.equal(result.excludedCharges, 0.10);
  assert.ok(!JSON.stringify(result).includes(token));
});

test("reports Epsilon verification after its same-origin viewer redirect", async () => {
  const requests: string[] = [];
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: `/DocViewer/${ref}` } })
      : html('<div id="cf-turnstile"></div>');
  });
  const result = await fetchQrReceiptDraft(epsilonUrl);
  assert.equal(result.status, "challenge");
  assert.ok(!("draft" in result));
  assert.equal(requests.length, 2);
});

test("rejects unknown links, escaped redirects and a replaced Entersoft frame", async () => {
  assert.equal(matchReceiptQrLink(entersoftUrl.replace("e-invoicing.gr", "e-invoicing.gr.example")), null);
  assert.equal(matchReceiptQrLink(entersoftUrl.replace("https:", "http:")), null);
  assert.equal(matchReceiptQrLink(entersoftUrl + "?extra=1"), null);

  for (const location of [
    "https://wrong.example/elsewhere",
    "https://epsilondigital-sklavenitis.epsilonnet.gr/unrelated",
    "https://epsilondigital-sklavenitis.epsilonnet.gr/DocViewer/00000000-0000-0000-0000-000000000000",
    `https://epsilondigital-sklavenitis.epsilonnet.gr:8080/DocViewer/${ref}`,
  ]) {
    const requests: string[] = [];
    configureReceiptQrFetcherForTests(async (url) => {
      requests.push(url);
      return new Response(null, { status: 302, headers: { location } });
    });
    assert.equal((await fetchQrReceiptDraft(epsilonUrl)).status, "unavailable");
    assert.deepEqual(requests, [epsilonUrl]);
  }

  const requests: string[] = [];
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return html(`<iframe id="iframeContent" src="${issuerPath.replace(token, "mismatch").replaceAll("&", "&amp;")}"></iframe>`);
  });
  assert.equal((await fetchQrReceiptDraft(entersoftUrl)).status, "unavailable");
  assert.deepEqual(requests, [entersoftUrl]);

  requests.length = 0;
  const duplicate = issuerPath.replace("&isPreview=True", "&hashToken=mismatch").replaceAll("&", "&amp;");
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return html(`<iframe id="iframeContent" src="${duplicate}"></iframe>`);
  });
  assert.equal((await fetchQrReceiptDraft(entersoftUrl)).status, "unavailable");
  assert.deepEqual(requests, [entersoftUrl]);
});

test("passes only the canonical validated receipt URL to the fetcher", async () => {
  const variant = entersoftUrl.replace("https://e-invoicing.gr/", "HTTPS://E-INVOICING.GR:443/");
  assert.equal(matchReceiptQrLink(variant)?.url, entersoftUrl);
  assert.equal(matchReceiptQrLink(entersoftUrl.replace("e-invoicing.gr/", "e-invoicing.gr./")), null);
  assert.equal(matchReceiptQrLink(entersoftUrl.replace("e-invoicing.gr/", "e-invoicing.gr:8443/")), null);
  assert.equal(matchReceiptQrLink("javascript:void(0)"), null);
  assert.equal(matchReceiptQrLink(epsilonUrl.replace("/fd/1", "/fd/g")), null);
  const epsilon = matchReceiptQrLink(epsilonUrl);
  assert.ok(epsilon?.issuer === "epsilon-sklavenitis");
  assert.equal(epsilon.viewerPath, `/docviewer/${ref}`);
  const requests: string[] = [];
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return new Response(null, { status: 404 });
  });
  await readQrReceiptScan("canonical-link-house", variant);
  assert.deepEqual(requests, [entersoftUrl]);
});

test("accepts the shorter Entersoft tokens real receipts print and rejects lookalikes", async () => {
  // Field receipts carry tokens of 6 to 12 alphanumeric characters (7 was
  // observed on a real Lidl receipt); the originally assumed 8 was one
  // issuer's spelling, not the route's shape.
  for (const [token, ofenm] of [["testAB1", "-1"], ["aB12cD34eF56", "12"]] as const) {
    const link = matchReceiptQrLink(`https://e-invoicing.gr/edocuments/ViewInvoice/${ofenm}/${ref}_${token}`);
    assert.ok(link?.issuer === "entersoft");
    assert.deepEqual(link.entersoft, { ofenm, uuid: ref, token });
  }
  // Tokens outside the issuer's shape stay unfetchable, whatever the host.
  for (const token of ["tstAB", "aB12cD34eF567", "tst_AB1"]) {
    assert.equal(matchReceiptQrLink(`https://e-invoicing.gr/edocuments/ViewInvoice/-1/${ref}_${token}`), null);
  }
  // Lookalike hosts and route tails never match, with a short token too.
  for (const url of [
    `https://e-invoicing.gr.example/edocuments/ViewInvoice/-1/${ref}_testAB1`,
    `https://einvoking.gr/edocuments/ViewInvoice/-1/${ref}_testAB1`,
    `https://e-invoicing.gr/edocuments/ViewInvoice/-1/${ref}_testAB1/extra`,
  ]) {
    assert.equal(matchReceiptQrLink(url), null);
  }
  // The whole fetch path follows the shared matcher: the server's own
  // viewer allowlist accepts the short token up to its verification page.
  const shortUrl = `https://e-invoicing.gr/edocuments/ViewInvoice/-1/${ref}_testAB1`;
  const requests: string[] = [];
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return html('<div id="cf-turnstile"></div>');
  });
  assert.equal((await fetchQrReceiptDraft(shortUrl)).status, "challenge");
  assert.deepEqual(requests, [shortUrl]);
});

test("stops a redirect loop and requires the named Entersoft viewer frame", async () => {
  let requests = 0;
  configureReceiptQrFetcherForTests(async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: `/DocViewer/${ref}` } });
  });
  assert.equal((await fetchQrReceiptDraft(epsilonUrl)).status, "unavailable");
  assert.equal(requests, 2);

  requests = 0;
  configureReceiptQrFetcherForTests(async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: new URL(epsilonUrl).pathname } });
  });
  assert.equal((await fetchQrReceiptDraft(epsilonUrl)).status, "unavailable");
  assert.equal(requests, 1);

  requests = 0;
  configureReceiptQrFetcherForTests(async () => {
    requests++;
    return html(invoice);
  });
  assert.equal((await fetchQrReceiptDraft(entersoftUrl)).status, "unavailable");
  assert.equal(requests, 1);
});

test("stops on an oversized or stalled issuer body", { timeout: 2000 }, async () => {
  let cancelled = false;
  const response = (chunk: Uint8Array) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/html" } });
  configureReceiptQrFetcherForTests(async () => response(new Uint8Array(2 * 1024 * 1024 + 1)));
  assert.equal((await fetchQrReceiptDraft(epsilonUrl)).status, "unavailable");
  assert.ok(cancelled);

  cancelled = false;
  configureReceiptQrFetcherForTests(async () => response(new TextEncoder().encode("<html>")));
  assert.equal((await fetchQrReceiptDraft(epsilonUrl, 30)).status, "unavailable");
  assert.ok(cancelled, "the deadline cancels an in-progress body read");
});

test("returns within the scan budget when the second Entersoft request ignores abort", { timeout: 2000 }, async () => {
  const requests: string[] = [];
  let documentSignal: AbortSignal | undefined;
  configureReceiptQrFetcherForTests(async (url, signal) => {
    requests.push(url);
    if (url === entersoftUrl) {
      return html(`<iframe id="iframeContent" src="${issuerPath.replaceAll("&", "&amp;")}"></iframe>`);
    }
    documentSignal = signal;
    return new Promise<Response>(() => undefined);
  });
  const started = performance.now();
  const failed = await readQrReceiptScan("test-budget-house", entersoftUrl, 40);
  assert.equal(failed.status, "unavailable");
  assert.ok(performance.now() - started < 1000);
  assert.ok(documentSignal?.aborted);
  assert.deepEqual(requests, [entersoftUrl, "https://e-invoicing.gr" + issuerPath]);
});

test("aborts a cooperative transport waiting for the Entersoft invoice", { timeout: 2000 }, async () => {
  let documentAborted = false;
  configureReceiptQrFetcherForTests(async (url, signal) => {
    if (url === entersoftUrl) {
      return html(`<iframe id="iframeContent" src="${issuerPath.replaceAll("&", "&amp;")}"></iframe>`);
    }
    return new Promise<Response>((_, reject) => {
      signal.addEventListener("abort", () => {
        documentAborted = true;
        reject(signal.reason);
      }, { once: true });
    });
  });
  const result = await readQrReceiptScan("cooperative-transport-house", entersoftUrl, 40);
  assert.equal(result.status, "unavailable");
  assert.equal(result.issuer, "entersoft");
  assert.ok(documentAborted);
});

test("attributes a timeout to the pending issuer", { timeout: 2000 }, async () => {
  configureReceiptQrFetcherForTests(async () => new Promise<Response>(() => undefined));
  const timeout = await readQrReceiptScan("test-timeout-house", entersoftUrl, 30);
  assert.equal(timeout.status, "unavailable");
  assert.equal(timeout.issuer, "entersoft");
});

test("gives Entersoft verification instructions at either retrieval stage", async () => {
  for (const atInvoice of [false, true]) {
    configureReceiptQrFetcherForTests(async (url) =>
      atInvoice && url === entersoftUrl
        ? html(`<iframe id="iframeContent" src="${issuerPath.replaceAll("&", "&amp;")}"></iframe>`)
        : html('<div id="cf-turnstile"></div>'));
    const result = await fetchQrReceiptDraft(entersoftUrl);
    assert.equal(result.status, "challenge");
    assert.match(result.message ?? "", /Entersoft requires browser verification/);
  }
});

test("reports verification for one link and rejects unknown links", async () => {
  let requests = 0;
  configureReceiptQrFetcherForTests(async (url) => {
    requests++;
    if (url === epsilonUrl) return html('<div id="cf-turnstile"></div>');
    assert.equal(url, entersoftUrl);
    throw new Error("issuer network failure");
  });
  const resolved = await readQrReceiptScan("test-house", epsilonUrl);
  assert.equal(resolved.issuer, "epsilon-sklavenitis");
  assert.equal(resolved.status, "challenge");
  const unknown = await readQrReceiptScan("test-house", "https://e-invoicing.gr/unrelated");
  assert.equal(unknown.status, "unsupported");
  assert.equal(requests, 1);
  const failed = await fetchQrReceiptDraft(entersoftUrl);
  assert.equal(failed.status, "unavailable");
  assert.match(failed.message ?? "", /photo scan and AI re-read/);
});

test("decodes an explicitly declared Greek charset and rejects unlabeled item columns", async () => {
  const decoder = new TextDecoder("windows-1253");
  const encoding = new Map(Array.from({ length: 256 }, (_, value) => [decoder.decode(Uint8Array.of(value)), value]));
  const bytes = Uint8Array.from(invoice, (char) => {
    const value = encoding.get(char);
    assert.notEqual(value, undefined);
    return value!;
  });
  configureReceiptQrFetcherForTests(async (url) => url === entersoftUrl
    ? html(`<iframe id="iframeContent" src="${issuerPath.replaceAll("&", "&amp;")}"></iframe>`)
    : new Response(bytes, { headers: { "content-type": "text/html; charset=windows-1253" } }));
  const decoded = await fetchQrReceiptDraft(entersoftUrl);
  assert.ok(decoded.status === "ok");
  assert.equal(decoded.draft.lines[0].description, "ΜΗΛΑ & ΑΧΛΑΔΙΑ");

  configureReceiptQrFetcherForTests(async (url) => url === entersoftUrl
    ? html(`<iframe id="iframeContent" src="${issuerPath.replaceAll("&", "&amp;")}"></iframe>`)
    : html(invoice.replace('data-title="Συνολική Αξία"', 'data-title="Άγνωστη στήλη"')));
  const incomplete = await fetchQrReceiptDraft(entersoftUrl);
  assert.equal(incomplete.status, "unavailable");
  assert.match(incomplete.message ?? "", /incomplete product line/);
});

test("recognizes an Entersoft frame on a declared Latin-1 viewer page", async () => {
  const viewer = `<p>Café</p><iframe id="iframeContent" src="${issuerPath.replaceAll("&", "&amp;")}"></iframe>`;
  configureReceiptQrFetcherForTests(async (url) => url === entersoftUrl
    ? new Response(Buffer.from(viewer, "latin1"), { headers: { "content-type": "text/html; charset=iso-8859-1" } })
    : html(invoice));
  assert.equal((await fetchQrReceiptDraft(entersoftUrl)).status, "ok");
});

test("parses grouped totals and explicitly free items without taking dates from product names", () => {
  const document = `<table><tbody>
    ${item("SKU-B", "PROMO 12-11-2026", "Τεμάχιο", "1", "1.234,56", "0,00", "1.234,56")}
    ${item("GIFT", "Gift", "Τεμάχιο", "1", "2,00", "2,00", "")}
  </tbody></table><div>ΤΕΛΙΚΗ ΑΞΙΑ 1.234,56EUR</div>`;
  const draft = invoiceDraft(document);
  assert.equal(draft.total, 1234.56);
  assert.equal(draft.purchasedAt, null);
  assert.deepEqual(draft.lines.map((line) => line.lineTotal), [1234.56, 0]);
  assert.equal(parseEntersoftInvoiceHtml(document.replace('data-title="Έκπτωση">2,00', 'data-title="Έκπτωση">1,00')).status, "incomplete");
});

test("reads the VAT summary when the breakdown appears first", () => {
  const document = invoice.replace("<div>Φ.Π.Α</div><div>0,41EUR</div>", "")
    .replace("<div>ΣΤΟΙΧΕΙΑ ΠΛΗΡΩΜΗΣ</div>", "<div>ΣΤΟΙΧΕΙΑ ΠΛΗΡΩΜΗΣ</div><div>Φ.Π.Α</div><div>0,59EUR</div>");
  assert.equal(invoiceDraft(document).tax, 0.59);
  for (const label of ["Αρ.Παραστατικού:12 3456", "Αρ. Παραστατικού : 12 3456&nbsp;"]) {
    const withNumber = document.replace("Αρ. Παραστατικού: 12 3456", label);
    assert.equal(invoiceDraft(withNumber).notes, "Αρ. Παραστατικού 12 3456");
  }
});

test("accepts an issuer column title wrapped across lines", () => {
  const wrapped = invoice.replace('data-title="Συνολική Αξία"', 'data-title="Συνολική\n Αξία"');
  assert.equal(invoiceDraft(wrapped).lines[0].lineTotal, 3.5);
});

test("keeps the issuer's recovery instructions on an undecodable page", async () => {
  configureReceiptQrFetcherForTests(async () => new Response(Uint8Array.of(0xff, 0x41), {
    headers: { "content-type": "text/html" },
  }));
  const epsilon = await fetchQrReceiptDraft(epsilonUrl);
  assert.equal(epsilon.status, "unavailable");
  assert.match(epsilon.message ?? "", /download the receipt PDF/);
  const entersoft = await fetchQrReceiptDraft(entersoftUrl);
  assert.equal(entersoft.status, "unavailable");
  assert.match(entersoft.message ?? "", /photo scan and AI re-read/);
});

test("recognizes a blank total with an explicitly zero unit price", () => {
  const free = item("FREE", "Free sample", "Τεμάχιο", "1", "", "", "")
    .replace('data-title="Τιμή μονάδας">2,00', 'data-title="Τιμή μονάδας">0,00');
  const wrap = (row: string) => `<table><tbody>${row}</tbody></table>`;
  assert.equal(invoiceDraft(wrap(free)).lines[0].lineTotal, 0);
  const unpriced = free.replace('data-title="Τιμή μονάδας">0,00', 'data-title="Τιμή μονάδας">');
  assert.equal(parseEntersoftInvoiceHtml(wrap(unpriced)).status, "incomplete");
});

test("matches only the exact IMPACT route and keeps the original path case", () => {
  const impact = matchReceiptQrLink(impactUrl);
  assert.ok(impact?.issuer === "impact");
  assert.equal(impact.url, impactUrl);
  assert.equal(matchReceiptQrLink(` \n${impactUrl}\t`)?.url, impactUrl);
  // The default port and host case normalize away; the path never changes.
  assert.equal(matchReceiptQrLink(impactUrl.replace("https://einvoice.impact.gr/", "HTTPS://EINVOICE.IMPACT.GR:443/"))?.url, impactUrl);
  const mixedCase = impactUrl.replace(impactMarker, "aB".repeat(20));
  assert.equal(matchReceiptQrLink(mixedCase)?.url, mixedCase);
  const uppercaseHex = `https://einvoice.impact.gr/p/EL123456789/${"AB".repeat(20)}/${"CD".repeat(16)}`;
  assert.equal(matchReceiptQrLink(uppercaseHex)?.url, uppercaseHex);
  const uppercaseMarker = `https://einvoice.impact.gr/p/EL123456789/${"AB".repeat(20)}/${"cd".repeat(16)}`;
  assert.equal(matchReceiptQrLink(uppercaseMarker)?.url, uppercaseMarker);
  const otherGreekReceipt = `https://einvoice.impact.gr/p/EL987654321/${"cD".repeat(20)}/${"Ef".repeat(16)}`;
  assert.deepEqual(matchReceiptQrLink(otherGreekReceipt), { issuer: "impact", url: otherGreekReceipt });
  for (const rejected of [
    impactUrl.replace("https:", "http:"),
    impactUrl + "?extra=1",
    impactUrl + "?",
    impactUrl + "#fragment",
    impactUrl + "#",
    impactUrl.replace("einvoice.impact.gr", "einvoice.impact.gr.example"),
    impactUrl.replace("einvoice.impact.gr/", "einvoice.impact.gr:8443/"),
    impactUrl.replace("/p/EL123456789/", "/p/el123456789/"),
    impactUrl.replace("/p/EL123456789/", "/p/EL12345678/"),
    impactUrl.replace("/p/EL123456789/", "/p/CY123456789/"),
    impactUrl.replace(impactMarker, impactMarker.slice(0, 39)),
    impactUrl.replace(impactMarker, "%31" + impactMarker.slice(1)),
    impactUrl.replace(impactMarker, impactMarker + "0"),
    impactUrl.replace(impactMarker, "g" + impactMarker.slice(1)),
    impactUrl.replace(impactMarker, impactMarker.slice(0, 20) + " " + impactMarker.slice(20)),
    impactUrl.replace(`${impactMarker}/`, `${impactMarker}/2`),
    impactUrl.slice(0, -1),
    impactUrl + "2",
    impactUrl + "/",
    `Scan receipt ${impactUrl}`,
    "javascript:void(0)",
  ]) {
    assert.equal(matchReceiptQrLink(rejected), null, rejected);
  }
});

test("gates the first IMPACT request on the supported URL format", async () => {
  const requests: string[] = [];
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return html("");
  });
  for (const url of [
    impactUrl.replace(impactMarker, "%31" + impactMarker.slice(1)),
    impactUrl.replace("/p/EL", "/p/el"),
    impactUrl.replace("/p/EL", "/p/CY"),
    impactUrl.replace("einvoice.impact.gr", "einvoice.impact.gr.example"),
  ]) {
    assert.deepEqual(await fetchQrReceiptDraft(url), {
      status: "unsupported",
      issuer: null,
      message: "That QR code or link is not from a supported digital receipt issuer.",
    });
  }
  assert.deepEqual(requests, []);
  await fetchQrReceiptDraft(impactUrl.replace("einvoice.impact.gr", "EINVOICE.IMPACT.GR:443"));
  assert.deepEqual(requests, [impactUrl]);
});

test("normalizes an IMPACT photo QR before one pinned receipt fetch", async () => {
  const requests: string[] = [];
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return new Response(impactBody(impactProducts), { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  const links = new Map<string, ReceiptQrLink>();
  assert.equal(addReceiptQrPayload(links, impactUrl.replace("einvoice.impact.gr", "EINVOICE.IMPACT.GR:443")), false);
  const link = links.values().next().value;
  assert.ok(link);
  assert.equal(link.url, impactUrl);
  assert.equal(new URL(link.url).href, link.url);
  const result = await readQrReceiptScan("normalized-impact-qr", link.url);
  assert.ok(result.status === "ok");
  assert.equal(result.issuer, "impact");
  assert.deepEqual(requests, [impactUrl]);
  assert.equal(result.draft.vendorName, "Example merchant");
  assert.equal(result.draft.purchasedAt, "2026-11-20");
  assert.equal(result.draft.currency, "EUR");
  assert.equal(result.draft.notes, "Αρ. Παραστατικού ΡΤ 123456");
  assert.equal(result.draft.total, 4.63);
  assert.equal(result.draft.subtotal, 4.00);
  assert.equal(result.draft.tax, 0.63);
  assert.deepEqual(result.draft.taxBreakdown, [
    { rate: 24, net: 1, tax: 0.24, gross: 1.24 },
    { rate: 13, net: 3, tax: 0.39, gross: 3.39 },
  ]);
  assert.deepEqual(result.draft.lines, [
    {
      description: "Example product", rawDescription: "Example product",
      quantity: 1, unit: null, unitPrice: 1.24, lineTotal: 1.24, taxRate: 24, discount: 0, barcode: null,
    },
    {
      description: "Μήλα Ημαθίας", rawDescription: "Μήλα Ημαθίας",
      quantity: 1.25, unit: "kg", unitPrice: 2.712, lineTotal: 3.39, taxRate: 13, discount: 0, barcode: null,
    },
  ]);
  assert.equal(result.excludedCharges, 0);
  assert.match(result.text, /Example merchant/);
  assert.match(result.text, /Αρ\. Παραστατικού ΡΤ 123456/);
  assert.match(result.text, /Μήλα Ημαθίας/);
  assert.match(result.text, /ΣΥΝΟΛΟ 4\.63/);
  assert.match(result.text, /ΦΠΑ 13% 3\.00 0\.39/);
  assert.ok(!JSON.stringify(result).includes(impactUrl));
  assert.ok(!result.text.includes(impactMarker));
});

test("reports an IMPACT redirect without fetching a second URL, including self-redirects", async () => {
  for (const location of [
    "https://wrong.example/elsewhere",
    `https://einvoice.impact.gr/p/EL123456789/${impactMarker}/${"3".repeat(32)}`,
    `https://einvoice.impact.gr:8080/p/EL123456789/${impactMarker}/${"2".repeat(32)}`,
    `https://einvoice.impact.gr/unrelated`,
    impactUrl,
    `${impactUrl}/`,
    `${new URL(impactUrl).pathname}?tab=receipt`,
  ]) {
    const requests: string[] = [];
    configureReceiptQrFetcherForTests(async (url) => {
      requests.push(url);
      return new Response(null, { status: 302, headers: { location } });
    });
    const result = await fetchQrReceiptDraft(impactUrl);
    assert.equal(result.status, "unavailable");
    assert.equal(result.message, "IMPACT redirected the receipt link. Open the digital receipt in your browser, or continue with the photo scan.");
    assert.ok(!result.message.includes(impactMarker));
    assert.deepEqual(requests, [impactUrl]);
  }
});

test("offers browser recovery for IMPACT verification and unreadable pages", async () => {
  // These are Cloudflare's generic markers. Other interstitials use browser recovery too.
  for (const markup of [
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
    '<div class="cf-turnstile"></div>',
  ]) {
    configureReceiptQrFetcherForTests(async () => html(markup));
    const challenge = await fetchQrReceiptDraft(impactUrl);
    assert.equal(challenge.status, "challenge");
    assert.equal(challenge.message, "IMPACT requires browser verification. Open the digital receipt to verify it, or continue with the photo scan.");
  }

  configureReceiptQrFetcherForTests(async () => new Response(null, { status: 404 }));
  const missing = await fetchQrReceiptDraft(impactUrl);
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.message, "The IMPACT receipt could not be read automatically. Open the digital receipt in your browser, or continue with the photo scan.");
  configureReceiptQrFetcherForTests(async () => new Response(null, { status: 503 }));
  assert.deepEqual(await fetchQrReceiptDraft(impactUrl), missing);

  configureReceiptQrFetcherForTests(async () => html("<p>Verify that you are human to access this receipt.</p>"));
  const unrecognizable = await fetchQrReceiptDraft(impactUrl);
  assert.deepEqual(unrecognizable, missing);

  configureReceiptQrFetcherForTests(async () => html(" \n\t"));
  const empty = await fetchQrReceiptDraft(impactUrl);
  assert.equal(empty.status, "unavailable");
  assert.match(empty.message ?? "", /Open the digital receipt in your browser/);
  assert.ok(!JSON.stringify(empty).includes(impactUrl));

  configureReceiptQrFetcherForTests(async () => Response.json({ error: "Receipt unavailable" }));
  const json = await fetchQrReceiptDraft(impactUrl);
  assert.deepEqual(json, missing);

  configureReceiptQrFetcherForTests(async () => new Response(impactBody(impactProducts), {
    headers: { "content-type": "text/plain" },
  }));
  assert.deepEqual(await fetchQrReceiptDraft(impactUrl), {
    status: "unavailable",
    issuer: "impact",
    message: "The IMPACT receipt could not be read automatically. Open the digital receipt in your browser, or continue with the photo scan.",
  });

  configureReceiptQrFetcherForTests(async () => new Response(new TextEncoder().encode(impactBody(impactProducts))));
  assert.deepEqual(await fetchQrReceiptDraft(impactUrl), missing);
});

test("cancels an oversized IMPACT HTML stream before the body is complete", { timeout: 2000 }, async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(impactBody(impactProducts)));
      controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      // Keep the stream open. Import must stop at the cap rather than wait for EOF.
    },
    cancel() { cancelled = true; },
  });
  configureReceiptQrFetcherForTests(async () => new Response(stream, { headers: { "content-type": "text/html" } }));
  const result = await fetchQrReceiptDraft(impactUrl, 1000);
  assert.equal(result.status, "unavailable");
  assert.match(result.message ?? "", /could not be read automatically/);
  assert.ok(cancelled);
});

test("rejects incomplete and negative IMPACT product lines to photo OCR", async () => {
  const overflow = "9".repeat(310);
  for (const broken of [
    impactLine({ code: "SKU", description: "Blank quantity", unit: "Τεμάχιο", net: "1,00", vat: "0,24", total: "1,24" }),
    impactLine({ description: "Absent quantity cell", total: "1,24" }).replace(impactCell("Quantity", "", "text-right"), ""),
    impactLine({ code: "SKU", description: "Missing total", unit: "Τεμάχιο", quantity: "1", net: "1,00", vat: "0,24" }),
    impactLine({ code: "SKU", description: "Invalid total", unit: "Τεμάχιο", quantity: "1", total: "-" }),
    impactLine({ description: "Malformed decimal", quantity: "1", total: "12,3,4" }),
    impactLine({ code: "SKU", description: "Negative total", unit: "Τεμάχιο", quantity: "1", net: "-1,00", vat: "0,24", total: "-1,24" }),
    impactLine({ code: "SKU", description: "Negative quantity", unit: "Κιλό", quantity: "-0,500", net: "1,00", vat: "0,24", total: "1,24" }),
    impactLine({ description: "Unrepresentable quantity", quantity: overflow, total: "1,24" }),
    impactLine({ description: "Unrepresentable total", quantity: "1", total: overflow }),
  ]) {
    const document = impactBody([broken, ...impactProducts.slice(1)]);
    assert.deepEqual(parseImpactReceiptHtml(document), { status: "incomplete" });
    configureReceiptQrFetcherForTests(async () => html(document));
    const result = await fetchQrReceiptDraft(impactUrl);
    assert.equal(result.status, "unavailable");
    assert.match(result.message ?? "", /incomplete product line/);
  }
});

test("keeps the charged price when the IMPACT line VAT cannot be read", () => {
  const source = impactBody([impactLine({
    description: "Product with unreadable VAT",
    quantity: "1",
    net: "unknown",
    vatCategory: "24",
    vat: "-",
    total: "1,24",
  })]);
  const [line] = impactDraft(source).lines;
  assert.equal(line.quantity, 1);
  assert.equal(line.lineTotal, 1.24);
  assert.equal(line.taxRate, null);
});

test("leaves VAT unset for a zero-net IMPACT line with a charged price", () => {
  const source = impactBody([impactLine({
    description: "Zero net product",
    quantity: "1",
    net: "0,00",
    vatCategory: "24",
    vat: "0,00",
    total: "1,24",
  })]);
  const [line] = impactDraft(source).lines;
  assert.equal(line.lineTotal, 1.24);
  assert.equal(line.taxRate, null);
});

test("retains an explicit zero rate for an IMPACT line with zero net and VAT", () => {
  const line = { description: "Free product", quantity: "1", net: "0,00", vat: "0,00", total: "0,00" };
  const endOfVatRow = `${impactCell("VatAmount", "0,39")}</tr>`;
  const zeroVatRow = `<tr>${impactCell("Percentage", "0%")}${impactCell("UnderlyingValue", "0,00")}${impactCell("VatAmount", "0,00")}</tr>`;
  const source = impactBody([
    impactLine({ ...line, vatCategory: "0%" }),
    impactLine({ ...line, vatCategory: "13%" }),
    impactLine({ ...line, vatCategory: "0" }),
  ]).replace(endOfVatRow, endOfVatRow + zeroVatRow);
  const draft = impactDraft(source);
  assert.ok(draft.taxBreakdown.some((entry) => entry.rate === 0));
  assert.deepEqual(draft.lines.map((row) => row.taxRate), [0, null, null]);
});

test("parses Greek grouping and accented units on IMPACT product lines", () => {
  const draft = impactDraft(impactBody([
    impactLine({ description: "Weighted product", unit: "ΚΙΛΌ", quantity: "1,250", total: "1.234,56" }),
    impactLine({ description: "Unmapped unit", unit: "ΚΙΒΩΤΙΟ", quantity: "1", total: "2,00" }),
    impactLine({ description: "Grams", unit: "ΓΡΑΜΜΆΡΙΟ", quantity: "2", total: "1" }),
    impactLine({ description: "Litres", unit: "ΛΙΤΡΟ", quantity: "1", total: "2" }),
    impactLine({ description: "Millilitres", unit: "ΧΙΛΙΟΣΤΟΛΙΤΡΟ", quantity: "1", total: "3" }),
  ]));
  assert.deepEqual(draft.lines.map(({ quantity, unit, lineTotal }) => ({ quantity, unit, lineTotal })), [
    { quantity: 1.25, unit: "kg", lineTotal: 1234.56 },
    { quantity: 1, unit: null, lineTotal: 2 },
    { quantity: 2, unit: "g", lineTotal: 1 },
    { quantity: 1, unit: "l", lineTotal: 2 },
    { quantity: 1, unit: "ml", lineTotal: 3 },
  ]);
});

test("aborts slow IMPACT responses and preserves the issuer recovery message", { timeout: 2000 }, async () => {
  const fetchers = [
    () => readQrReceiptScan("test-impact-timeout-house", impactUrl, 30),
    () => fetchQrReceiptDraft(impactUrl, 30),
  ];
  for (const fetchReceipt of fetchers) {
    let aborted = false;
    configureReceiptQrFetcherForTests((_url, signal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }));
    assert.deepEqual(await fetchReceipt(), {
      status: "unavailable",
      issuer: "impact",
      message: "The IMPACT receipt could not be read automatically. Open the digital receipt in your browser, or continue with the photo scan.",
    });
    assert.ok(aborted);
  }
});

test("rate limits IMPACT lookups before fetching the issuer again", async (t) => {
  const house = "test-impact-limited-house";
  const env = {
    SV_RATE_LIMIT: process.env.SV_RATE_LIMIT,
    SV_RATE_LIMIT_RECEIPT_QR: process.env.SV_RATE_LIMIT_RECEIPT_QR,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    limiters.receiptQr.reset(house);
    limiters.receiptQrGlobal.reset("all");
  });
  limiters.receiptQrGlobal.reset("all");
  process.env.SV_RATE_LIMIT = "on";
  process.env.SV_RATE_LIMIT_RECEIPT_QR = "1/60";
  let attempts = 0;
  configureReceiptQrFetcherForTests(async () => {
    attempts++;
    return html(impactBody(impactProducts));
  });
  assert.equal((await readQrReceiptScan(house, impactUrl)).status, "ok");
  assert.deepEqual(await readQrReceiptScan(house, impactUrl), {
    status: "unavailable",
    issuer: "impact",
    message: "Too many digital receipt requests. Try again in a few minutes or scan the photo.",
  });
  assert.equal(attempts, 1);
});

test("keeps the IMPACT merchant from company-info and not the customer field", () => {
  const draft = impactDraft(impactBody(impactProducts));
  assert.equal(draft.vendorName, "Example merchant");
  const wrapped = impactBody(impactProducts).replace("Example merchant</span>", "<span>Example merchant</span></span>");
  const wrappedDraft = impactDraft(wrapped);
  assert.equal(wrappedDraft.vendorName, null);
  assert.equal(wrappedDraft.lines.length, 2);
  const inline = impactBody(impactProducts).replace("Example merchant", "Example <b>merchant</b>");
  assert.equal(impactDraft(inline).vendorName, "Example merchant");
  // Without .company-info no vendor is guessed — the later same-name field is
  // the customer — but the unambiguous date and identifier are still read.
  const renamed = impactBody(impactProducts).replace('<div class="company-info">', '<div class="none">');
  const renamedDraft = impactDraft(renamed);
  assert.equal(renamedDraft.vendorName, null);
  assert.equal(renamedDraft.purchasedAt, "2026-11-20");
  assert.equal(renamedDraft.notes, "Αρ. Παραστατικού ΡΤ 123456");
  assert.equal(renamedDraft.lines.length, 2);
  // Fully absent metadata leaves the product lines intact and nothing invented.
  const bare = renamed
    .replace(/<span class="field field-RegisteredName">[\s\S]*?<\/span><\/span><\/span>/g, "")
    .replace(/<span class="field field-DateIssued">[\s\S]*?<\/span><\/span><\/span>/, "")
    .replace(/<span class="field field-IssuerFormatedInvoiceSeriesNumber">[\s\S]*?<\/span><\/span><\/span>/, "");
  const bareDraft = impactDraft(bare);
  assert.equal(bareDraft.vendorName, null);
  assert.equal(bareDraft.purchasedAt, null);
  assert.equal(bareDraft.notes, null);
  assert.equal(bareDraft.lines.length, 2);
});

test("treats the IMPACT VAT breakdown and currency as optional", () => {
  const source = impactBody([impactProducts[0], impactProducts[1].replace(impactCell("VatCategory", "13", "text-right"), impactCell("VatCategory", "13%", "text-right"))])
    .replace(/<table class="table"><thead><tr>\s*<th class="field field-Percentage[\s\S]*?<\/table>/, "")
    .replace('<tr class="field field-CurrencyCode text-right"><td class="label">Νόμισμα</td><td class="value">EUR</td></tr>', "");
  const draft = impactDraft(source);
  assert.deepEqual(draft.taxBreakdown, []);
  assert.deepEqual(draft.lines.map((line) => line.taxRate), [null, 13]);
  assert.equal(draft.tax, 0.63);
  assert.equal(draft.currency, null);
  assert.equal(impactDraft(impactBody(impactProducts).replace(">EUR</td>", ">EURO</td>")).currency, null);
});

test("reads ISO issue dates and leaves unrecognized IMPACT dates unset", () => {
  const source = impactBody(impactProducts);
  const date = "20/11/2026 2:22 μ.μ.";
  assert.equal(impactDraft(source.replace(date, "2026-11-20")).purchasedAt, "2026-11-20");
  assert.equal(impactDraft(source.replace(date, "Date unavailable")).purchasedAt, null);
});

test("confirms the printed IMPACT VAT rate against each line's own amounts", () => {
  const source = impactBody([
    impactLine({ description: "Discounted product", quantity: "1", net: "0,50", vatCategory: "13", vat: "0,07", total: "0,57" }),
    impactLine({ description: "Different line rounding", quantity: "1", net: "0,50", vatCategory: "13", vat: "0,06", total: "0,56" }),
    impactLine({ description: "Mismatched rate", quantity: "1", net: "0,50", vatCategory: "13", vat: "0,12", total: "0,62" }),
    impactLine({ description: "Unknown category", quantity: "1", net: "1,00", vatCategory: "Γ1", vat: "0,24", total: "1,24" }),
  ]);
  assert.deepEqual(impactDraft(source).lines.map((line) => line.taxRate), [13, null, null, null]);
});

test("ignores negative IMPACT tax breakdown entries", () => {
  const source = impactBody(impactProducts)
    .replace(impactCell("UnderlyingValue", "1,00"), impactCell("UnderlyingValue", "-1,00"))
    .replace(impactCell("VatAmount", "0,39"), impactCell("VatAmount", "-0,39"));
  assert.deepEqual(impactDraft(source).taxBreakdown, []);
});

test("ignores unreadable VAT rows only when the remaining rows reconcile", () => {
  const source = impactBody(impactProducts);
  const vatCell = impactCell("VatAmount", "0,39");
  const extraRows = `<tr>${impactCell("Percentage", "-")}${impactCell("UnderlyingValue", "4,00")}${impactCell("VatAmount", "0,63")}</tr>
    <tr>${impactCell("Percentage", "6%")}${impactCell("UnderlyingValue", "")}${impactCell("VatAmount", "")}</tr>`;
  const withExtraRows = source.replace(`${vatCell}</tr>`, `${vatCell}</tr>${extraRows}`);
  assert.deepEqual(impactDraft(withExtraRows).taxBreakdown.map((entry) => entry.rate), [24, 13]);

  const incomplete = withExtraRows.replace(vatCell, impactCell("VatAmount", ""));
  assert.deepEqual(impactDraft(incomplete).taxBreakdown, []);
});

test("finds the complete IMPACT VAT breakdown after a partial table", () => {
  const partial = `<table><tbody>
    <tr>${impactCell("Percentage", "24%")}${impactCell("UnderlyingValue", "1,00")}${impactCell("VatAmount", "0,24")}</tr>
  </tbody></table>`;
  const source = impactBody(impactProducts).replace('<div class="section section-taxes">', `<div class="section section-taxes">${partial}`);
  const draft = impactDraft(source);
  assert.deepEqual(draft.taxBreakdown.map((entry) => entry.rate), [24, 13]);
});

test("retains IMPACT breakdown rates with a one-cent summary difference", () => {
  const source = impactBody(impactProducts)
    .replace('>0,63</td></tr>', '>0,64</td></tr>')
    .replace('>4,00</td></tr>', '>4,01</td></tr>')
    .replace('>4,63</td></tr>', '>4,65</td></tr>');
  const draft = impactDraft(source);
  assert.equal(draft.tax, 0.64);
  assert.equal(draft.subtotal, 4.01);
  assert.equal(draft.total, 4.65);
  assert.deepEqual(draft.taxBreakdown.map(({ rate, tax }) => ({ rate, tax })), [
    { rate: 24, tax: 0.24 },
    { rate: 13, tax: 0.39 },
  ]);
  assert.equal(Number(draft.taxBreakdown.reduce((sum, entry) => sum + entry.gross, 0).toFixed(2)), 4.63);
  const reconciliation = reconcileReceipt({ total: draft.total, savings: draft.savings, lines: draft.lines });
  assert.equal(reconciliation.difference, 0.02);
  assert.equal(reconciliation.ok, true);
  assert.deepEqual(draft.lines.map((line) => line.taxRate), [24, 13]);
});

test("keeps the printed IMPACT totals but drops a VAT breakdown outside the tolerance", () => {
  const source = impactBody(impactProducts).replace(impactCell("VatAmount", "0,24"), impactCell("VatAmount", "0,27"));
  const draft = impactDraft(source);
  assert.equal(draft.tax, 0.63);
  assert.equal(draft.subtotal, 4);
  assert.equal(draft.total, 4.63);
  assert.deepEqual(draft.taxBreakdown, []);
  assert.deepEqual(draft.lines.map((line) => line.taxRate), [null, null]);
});

test("prefers exact IMPACT VAT breakdowns and keeps the first rounded match on a tie", () => {
  const source = impactBody(impactProducts);
  const exact = source.match(/<table class="table"><thead><tr>\s*<th class="field field-Percentage[\s\S]*?<\/table>/)?.[0];
  assert.ok(exact);
  const above = exact.replace(impactCell("VatAmount", "0,24"), impactCell("VatAmount", "0,25"));
  const below = exact.replace(impactCell("VatAmount", "0,24"), impactCell("VatAmount", "0,23"));
  for (const tables of [exact + above + exact, above + exact + below]) {
    assert.equal(impactDraft(source.replace(exact, tables)).taxBreakdown[0].tax, 0.24);
  }
  assert.equal(impactDraft(source.replace(exact, above + below)).taxBreakdown[0].tax, 0.25);
  assert.equal(impactDraft(source.replace(exact, below + above)).taxBreakdown[0].tax, 0.23);
});

test("confirms an explicit IMPACT percentage from its line without a matching breakdown entry", () => {
  const line = { description: "Example product", quantity: "1", net: "1,00", vat: "0,06", total: "1,06" };
  const draft = impactDraft(impactBody([
    impactLine({ ...line, vatCategory: "6%" }),
    impactLine({ ...line, vatCategory: "6" }),
    impactLine({ ...line, vatCategory: "6%", vat: "0,08" }),
  ]));
  assert.deepEqual(draft.taxBreakdown.map((entry) => entry.rate), [24, 13]);
  assert.deepEqual(draft.lines.map((value) => value.taxRate), [6, null, null]);
});

test("rounds a half-cent of IMPACT line VAT up before comparing cents", () => {
  // 0.725 × 20% is exactly 0.145, but binary multiplication can put it below the tie.
  const line = { description: "Example product", quantity: "1", net: "0,725", vatCategory: "20%" };
  const draft = impactDraft(impactBody([
    impactLine({ ...line, vat: "0,15", total: "0,88" }),
    impactLine({ ...line, vat: "0,14", total: "0,87" }),
  ]));
  assert.deepEqual(draft.lines.map((row) => row.taxRate), [20, null]);
});

test("uses product amounts to verify the IMPACT VAT breakdown when summary totals are missing", () => {
  const source = impactBody(impactProducts).replace(/<tr class="field field-Total(?:NetAmount|VATAmount) text-right">[\s\S]*?<\/tr>/g, "");
  const draft = impactDraft(source);
  assert.equal(draft.subtotal, null);
  assert.equal(draft.tax, 0.63);
  assert.deepEqual(draft.taxBreakdown.map((entry) => entry.rate), [24, 13]);
  assert.deepEqual(draft.lines.map((line) => line.taxRate), [24, 13]);

  const mismatched = source.replace(impactCell("VatAmount", "0,24"), impactCell("VatAmount", "0,30"));
  const unverified = impactDraft(mismatched);
  assert.deepEqual(unverified.taxBreakdown, []);
  assert.equal(unverified.tax, null);
  assert.deepEqual(unverified.lines.map((line) => line.taxRate), [null, null]);

  const unreadableNet = source
    .replace(impactCell("NetTotal", "1,00", "text-right"), impactCell("NetTotal", "", "text-right"))
    .replace(impactCell("VatCategory", "13", "text-right"), impactCell("VatCategory", "13%", "text-right"));
  const incompleteEvidence = impactDraft(unreadableNet);
  assert.deepEqual(incompleteEvidence.taxBreakdown, []);
  assert.equal(incompleteEvidence.tax, null);
  assert.deepEqual(incompleteEvidence.lines.map((line) => line.taxRate), [null, 13]);
});

test("uses printed IMPACT summary totals in preference to conflicting line sums", () => {
  const source = impactBody(impactProducts).replace(
    impactCell("NetTotal", "1,00", "text-right"),
    impactCell("NetTotal", "1,04", "text-right"),
  );
  const draft = impactDraft(source);
  assert.equal(draft.subtotal, 4);
  assert.equal(draft.tax, 0.63);
  assert.deepEqual(draft.taxBreakdown.map((entry) => entry.rate), [24, 13]);
  assert.deepEqual(draft.lines.map((line) => line.taxRate), [null, 13]);
});

test("reports unavailable for pages without an IMPACT product table", () => {
  for (const source of ["", '<div class="section-details"><p>Empty viewer</p></div>']) {
    assert.deepEqual(parseImpactReceiptHtml(source), { status: "unavailable" });
  }
});

test("reports a recognized IMPACT product table without lines as incomplete", async () => {
  for (const table of [
    impactProductTable([]),
    impactProductTable(["<tr><td></td></tr>"]),
    impactProductTable([impactLine({ unit: "Τεμάχιο", vatCategory: "24" })]),
    `<table>${impactProductHead}</table>`,
  ]) {
    const source = impactBody(impactProducts).replace(impactProductTable(impactProducts), table) + impactProductTable(impactProducts);
    assert.deepEqual(parseImpactReceiptHtml(source), { status: "incomplete" });
    configureReceiptQrFetcherForTests(async () => html(source));
    const result = await fetchQrReceiptDraft(impactUrl);
    assert.equal(result.status, "unavailable");
    assert.match(result.message ?? "", /incomplete product line/);
  }
});

test("falls back when IMPACT product rows have no table body", () => {
  const source = impactBody(impactProducts).replace(impactProductTable(impactProducts), impactProductTable(impactProducts).replace(/<\/?tbody>/g, ""));
  assert.deepEqual(parseImpactReceiptHtml(source), { status: "incomplete" });
});

test("skips empty, spacer-only, and header-only IMPACT tables around the populated table", () => {
  const productTable = impactProductTable(impactProducts);
  const shells = [
    impactProductTable([]),
    impactProductTable(["<tr><td></td></tr>"]),
    impactProductTable([impactLine({ unit: "Τεμάχιο", vatCategory: "24" })]),
    `<table>${impactProductHead}</table>`,
  ];
  for (const shell of shells) {
    for (const tables of [shell + productTable, productTable + shell]) {
      const source = impactBody(impactProducts).replace(productTable, tables);
      assert.deepEqual(impactDraft(source).lines.map((line) => line.description), ["Example product", "Μήλα Ημαθίας"]);
    }
  }
});

test("does not replace malformed IMPACT products with a later table", () => {
  const incompleteLine = impactLine({ description: "Incomplete product", quantity: "1" });
  const skuOnly = impactLine({ code: "PRODUCT-ID" });
  const productTable = impactProductTable(impactProducts);
  for (const rows of [[incompleteLine], [skuOnly], [impactProducts[0], incompleteLine]]) {
    const source = impactBody(impactProducts).replace(productTable, impactProductTable(rows) + productTable);
    assert.deepEqual(parseImpactReceiptHtml(source), { status: "incomplete" });
  }
});

test("ignores myDATA and commented tables and preserves nested IMPACT details", async () => {
  const unrelated = impactProductTable([impactLine({ description: "myDATA detail", quantity: "1", total: "19,00" })])
    .replace('class="table "', 'class="table table-striped InvoiceLineTable"');
  const headerOnly = `<table>${impactProductHead}</table>`;
  const commented = `<!-- <div class="section-details">${headerOnly}</div> -->`;
  const document = impactBody(impactProducts).replace('<div class="col-12">', `<div class="col-12">${unrelated}<!-- </div> -->`);
  configureReceiptQrFetcherForTests(async () => html(commented + headerOnly + document));
  const result = await fetchQrReceiptDraft(impactUrl);
  assert.ok(result.status === "ok");
  assert.deepEqual(result.draft.lines.map((line) => line.description), ["Example product", "Μήλα Ημαθίας"]);
});

test("decodes named and numeric entities in IMPACT line descriptions", () => {
  const source = impactBody([impactLine({ description: "Grocer&#x27;s&#1;&amp;&#x81;Baker&#8217;s", quantity: "1", total: "1,24" })]);
  assert.equal(impactDraft(source).lines[0].description, "Grocer's & Baker’s");
});

test("replaces null and surrogate numeric entities with replacement characters", () => {
  const source = impactBody([impactLine({ description: "A&#0;B&#xD800;C", quantity: "1", total: "1,24" })]);
  assert.equal(impactDraft(source).lines[0].description, "A\uFFFDB\uFFFDC");
});

test("does not cut an IMPACT description in the middle of a Unicode character", () => {
  const description = "a".repeat(159);
  const source = impactBody([impactLine({ description: description + "&#x1F34E;", quantity: "1", total: "1,24" })]);
  assert.equal(impactDraft(source).lines[0].description, description);
});

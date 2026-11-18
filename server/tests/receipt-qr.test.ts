import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { matchReceiptQrLink } from "../../shared/receipt-qr-links.js";
import { configureReceiptQrFetcherForTests, fetchQrReceiptDraft } from "../services/receipt-qr.js";

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
  <div>Ημ/νία έκδοσης: 11-11-2026</div><div>Έναρξης Αποστολής: 2026-11-12</div>
  <table><tbody>
    ${item("SKU-A", "ΜΗΛΑ &amp; ΑΧΛΑΔΙΑ", "Κιλό", "1,250", "4,00", "0,50", "3,50")}
    ${item("PERTEL", "Περιβαλλοντικό τέλος", "Τεμάχιο", "1,00", "0,10", "0,00", "0,10")}
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

afterEach(() => configureReceiptQrFetcherForTests(null));

test("reads a pinned Entersoft document and preserves the amounts and weighted quantity", async () => {
  const requests: string[] = [];
  const frame = issuerPath
    .replace(token, "%74" + token.slice(1))
    .replaceAll("&", "&amp;");
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return requests.length === 1
      ? html(`<iframe src='${frame}' id='iframeContent'></iframe>`)
      : html(invoice);
  });
  const result = await fetchQrReceiptDraft(entersoftUrl);
  assert.deepEqual(requests, [entersoftUrl, "https://e-invoicing.gr" + issuerPath]);
  assert.equal(result.status, "ok");
  assert.ok(result.draft);
  assert.equal(result.draft.purchasedAt, "2026-11-11");
  assert.equal(result.draft.currency, "EUR");
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
  assert.equal(result.draft, null);
  assert.equal(requests.length, 2);
});

test("rejects unknown links, escaped redirects and a replaced Entersoft frame", async () => {
  assert.equal(matchReceiptQrLink(entersoftUrl.replace("e-invoicing.gr", "e-invoicing.gr.example")), null);
  assert.equal(matchReceiptQrLink(entersoftUrl.replace("https:", "http:")), null);
  assert.equal(matchReceiptQrLink(entersoftUrl + "?extra=1"), null);

  for (const location of [
    "https://wrong.example/elsewhere",
    "https://epsilondigital-sklavenitis.epsilonnet.gr/unrelated",
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
});

test("stops a redirect loop and requires the named Entersoft viewer frame", async () => {
  let requests = 0;
  configureReceiptQrFetcherForTests(async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: `/DocViewer/${ref}` } });
  });
  assert.equal((await fetchQrReceiptDraft(epsilonUrl)).status, "unavailable");
  assert.equal(requests, 4);

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
  // AbortSignal.timeout is unref'ed and the mocked stream has no socket.
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    assert.equal((await fetchQrReceiptDraft(epsilonUrl, Date.now() + 30)).status, "unavailable");
    assert.ok(cancelled, "the deadline cancels an in-progress body read");
  } finally {
    clearTimeout(keepAlive);
  }
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
  assert.equal((await fetchQrReceiptDraft(entersoftUrl)).draft?.lines[0].description, "ΜΗΛΑ & ΑΧΛΑΔΙΑ");

  configureReceiptQrFetcherForTests(async (url) => url === entersoftUrl
    ? html(`<iframe id="iframeContent" src="${issuerPath.replaceAll("&", "&amp;")}"></iframe>`)
    : html(invoice.replace('data-title="Συνολική Αξία"', 'data-title="Άγνωστη στήλη"')));
  assert.equal((await fetchQrReceiptDraft(entersoftUrl)).status, "unavailable");
});

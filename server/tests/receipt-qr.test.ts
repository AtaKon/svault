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
  <div>ΑΝΑΛΥΣΗ ΦΠΑ</div><div>13% 3,19EUR 0,41EUR</div>`;

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

afterEach(() => configureReceiptQrFetcherForTests(null));

test("reads a pinned Entersoft document and preserves the amounts and weighted quantity", async () => {
  const requests: string[] = [];
  configureReceiptQrFetcherForTests(async (url) => {
    requests.push(url);
    return requests.length === 1
      ? html(`<iframe id="iframeContent" src="${issuerPath.replaceAll("&", "&amp;")}"></iframe>`)
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

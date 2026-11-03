import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "@/api";
import { useHouse } from "@/state";
import { Badge, Button, Card, Field, Input, LoadingBlock, PageHeader, Switch, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import { money, qty } from "@/format";
import type { ReceiptTemplate, ReceiptTemplateRules, ReceiptTemplateTest } from "@shared/types";

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const DEFAULT_RULES: ReceiptTemplateRules = {
  keywords: [],
  threshold: 0.7,
  sections: { start: [], end: [] },
  product: {
    pattern: "^(?<name>.+?)\\s+(?<total>\\d+[.,]\\d{2})\\s+(?<rate>\\d{1,2}(?:[.,]\\d+)?)\\s*%$",
    ignore: [],
  },
  quantity: [],
  weight: [],
  discount: { patterns: [] },
  savings: { patterns: [] },
  tax: { start: [], rowPattern: "", summaryPattern: null },
  total: { pattern: null },
};

export function ReceiptTemplateFormPage() {
  const { templateId } = useParams();
  const [search] = useSearchParams();
  const editing = Boolean(templateId);
  const exampleId = search.get("example");
  const { house } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();

  const [templates, setTemplates] = useState<ReceiptTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [country, setCountry] = useState("GR");
  const [vendorName, setVendorName] = useState("");
  const [active, setActive] = useState(true);
  const [threshold, setThreshold] = useState("0.7");
  const [keywords, setKeywords] = useState("");
  const [sectionsStart, setSectionsStart] = useState("");
  const [sectionsEnd, setSectionsEnd] = useState("");
  const [productPattern, setProductPattern] = useState(DEFAULT_RULES.product.pattern);
  const [productIgnore, setProductIgnore] = useState("");
  const [quantityPatterns, setQuantityPatterns] = useState("");
  const [weightPatterns, setWeightPatterns] = useState("");
  const [discountPatterns, setDiscountPatterns] = useState("");
  const [savingsPatterns, setSavingsPatterns] = useState("");
  const [taxStart, setTaxStart] = useState("");
  const [taxRowPattern, setTaxRowPattern] = useState("");
  const [taxSummaryPattern, setTaxSummaryPattern] = useState("");
  const [totalPattern, setTotalPattern] = useState("");

  const [sampleText, setSampleText] = useState("");
  const [testResult, setTestResult] = useState<ReceiptTemplateTest | null>(null);
  const [testErrors, setTestErrors] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const fill = (template: ReceiptTemplate, title?: string) => {
    setName(title ?? template.name);
    setCountry(template.country);
    setVendorName(template.vendorName ?? "");
    setActive(template.active);
    setThreshold(String(template.rules.threshold ?? 0.7));
    setKeywords(template.rules.keywords.join(", "));
    setSectionsStart((template.rules.sections?.start ?? []).join("\n"));
    setSectionsEnd((template.rules.sections?.end ?? []).join("\n"));
    setProductPattern(template.rules.product?.pattern ?? DEFAULT_RULES.product.pattern);
    setProductIgnore((template.rules.product?.ignore ?? []).join("\n"));
    setQuantityPatterns((template.rules.quantity ?? []).join("\n"));
    setWeightPatterns((template.rules.weight ?? []).join("\n"));
    setDiscountPatterns((template.rules.discount?.patterns ?? []).join("\n"));
    setSavingsPatterns((template.rules.savings?.patterns ?? []).join("\n"));
    setTaxStart((template.rules.tax?.start ?? []).join("\n"));
    setTaxRowPattern(template.rules.tax?.rowPattern ?? "");
    setTaxSummaryPattern(template.rules.tax?.summaryPattern ?? "");
    setTotalPattern(template.rules.total?.pattern ?? "");
    setTestResult(null);
    setTestErrors([]);
  };

  useEffect(() => {
    api<ReceiptTemplate[]>(`/api/houses/${house.id}/receipt-templates`)
      .then((list) => {
        setTemplates(list);
        if (editing) {
          const template = list.find((entry) => entry.id === templateId && !entry.builtIn);
          if (template) fill(template);
          else {
            toast.error("Template not found");
            navigate("/receipts?tab=templates", { replace: true });
          }
        } else if (exampleId) {
          const template = list.find((entry) => entry.id === exampleId);
          if (template) fill(template, `${template.name} copy`);
        }
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not load templates"))
      .finally(() => setLoading(false));
  }, [editing, exampleId, house.id, navigate, templateId, toast]);

  const buildRules = (): ReceiptTemplateRules => ({
    keywords: commaList(keywords),
    threshold: Number(threshold) || 0.7,
    sections: { start: lines(sectionsStart), end: lines(sectionsEnd) },
    product: { pattern: productPattern.trim(), ignore: lines(productIgnore) },
    quantity: lines(quantityPatterns),
    weight: lines(weightPatterns),
    discount: { patterns: lines(discountPatterns) },
    savings: { patterns: lines(savingsPatterns) },
    tax: {
      start: lines(taxStart),
      rowPattern: taxRowPattern.trim(),
      summaryPattern: taxSummaryPattern.trim() || null,
    },
    total: { pattern: totalPattern.trim() || null },
  });

  const runTest = async () => {
    if (!sampleText.trim()) {
      toast.error("Paste a sample receipt first");
      return;
    }
    setTesting(true);
    setTestResult(null);
    setTestErrors([]);
    try {
      const result = await api<ReceiptTemplateTest>(`/api/houses/${house.id}/receipt-templates/test`, {
        method: "POST",
        body: { rules: buildRules(), text: sampleText, name: name || "Preview", vendorName: vendorName || null },
      });
      setTestResult(result);
      if (!result.draft.lines.length) toast.push("Template is valid but found no product lines in this sample");
    } catch (err) {
      if (err instanceof ApiError) {
        setTestErrors(Array.isArray(err.details) ? err.details.map(String) : [err.message]);
      } else {
        setTestErrors([err instanceof Error ? err.message : "Could not test the template"]);
      }
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      toast.error("Give the template a name");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        country: country.trim().toUpperCase().slice(0, 2) || "GR",
        vendorName: vendorName.trim() || null,
        active,
        rules: buildRules(),
      };
      if (editing) {
        await api(`/api/houses/${house.id}/receipt-templates/${templateId}`, { method: "PATCH", body });
      } else {
        await api(`/api/houses/${house.id}/receipt-templates`, { method: "POST", body });
      }
      toast.success(editing ? "Template updated" : "Template created");
      navigate("/receipts?tab=templates", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) setTestErrors(err.details.map(String));
      toast.error(err instanceof Error ? err.message : "Could not save the template");
    } finally {
      setSaving(false);
    }
  };

  const loadExample = () => {
    const example = templates.find((template) => template.id === "lidl-gr");
    if (example) fill(example, name || "Lidl copy");
  };

  if (loading) return <LoadingBlock label="Loading template" />;

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/receipts?tab=templates")}
        eyebrow="Receipt template"
        title={editing ? name || "Edit template" : "New receipt template"}
        subtitle="Teach SVault a shop layout with regular expressions, then test it on a real receipt."
        actions={
          <Button icon="check" loading={saving} disabled={!name.trim() || !productPattern.trim()} onClick={() => void save()}>
            {editing ? "Save template" : "Create template"}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <h2 className="font-display text-lg">Identity</h2>
            <Field label="Name" required>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Sklavenitis Greece" maxLength={80} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Shop name" hint="optional">
                <Input value={vendorName} onChange={(event) => setVendorName(event.target.value)} placeholder="Σκλαβενίτης" maxLength={80} />
              </Field>
              <Field label="Country" hint="2-letter code">
                <Input
                  value={country}
                  onChange={(event) => setCountry(event.target.value.toUpperCase().slice(0, 2))}
                  maxLength={2}
                  className="text-center font-mono uppercase"
                />
              </Field>
            </div>
            <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
              <Switch checked={active} onChange={setActive} label="Active" description="Inactive templates are ignored during receipt scanning." />
            </div>
          </Card>

          <Card className="space-y-3 p-4">
            <div>
              <h2 className="font-display text-lg">Detection</h2>
              <p className="text-[11px] text-muted">At least one keyword must appear in the OCR text. More matches raise confidence.</p>
            </div>
            <Field label="Keywords" required hint="comma separated, case-insensitive">
              <Input
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
                placeholder="LIDL, ΛΙΝΤΑ ΕΛΛΑΣ, ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ"
              />
            </Field>
            <Field label="Minimum confidence" hint="0.7 recommended">
              <Input type="number" min="0" max="1" step="0.01" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
            </Field>
          </Card>

          <Card className="space-y-3 p-4">
            <div>
              <h2 className="font-display text-lg">Sections and products</h2>
              <p className="text-[11px] leading-relaxed text-muted">
                Patterns are JavaScript regular expressions. Use named groups: <code>name</code>, <code>total</code> and
                optionally <code>rate</code> for product lines.
              </p>
            </div>
            <Field label="Product lines start after" hint="one regex per line">
              <Textarea rows={2} value={sectionsStart} onChange={(event) => setSectionsStart(event.target.value)} placeholder="ΦΟΡΟΛΟΓΙΚΗ\s+ΑΠΟΔΕΙΞΗ" className="font-mono text-[11px]" />
            </Field>
            <Field label="Product lines end at" hint="one regex per line">
              <Textarea rows={2} value={sectionsEnd} onChange={(event) => setSectionsEnd(event.target.value)} placeholder="^ΣΥΝΟΛΟ(?=\s|$)" className="font-mono text-[11px]" />
            </Field>
            <Field label="Product pattern" required hint="must include name and total groups">
              <Textarea rows={3} value={productPattern} onChange={(event) => setProductPattern(event.target.value)} className="font-mono text-[11px]" />
            </Field>
            <Field label="Ignore lines" hint="one regex per line">
              <Textarea rows={3} value={productIgnore} onChange={(event) => setProductIgnore(event.target.value)} placeholder="^ΣΑΚΟΥ&#10;^ΤΣ\.?Π\.?ΧΡ" className="font-mono text-[11px]" />
            </Field>
          </Card>

          <Card className="space-y-3 p-4">
            <div>
              <h2 className="font-display text-lg">Follow-up lines</h2>
              <p className="text-[11px] leading-relaxed text-muted">
                Optional lines after a product. Quantity groups: <code>qty</code>, <code>unitPrice</code>. Weight adds{" "}
                <code>unit</code>. Discount amount may use <code>amount</code>.
              </p>
            </div>
            <Field label="Quantity lines" hint="one regex per line">
              <Textarea rows={2} value={quantityPatterns} onChange={(event) => setQuantityPatterns(event.target.value)} placeholder="^(?<qty>\d+)\s*[x×]\s*(?<unitPrice>\d+[.,]\d{2})$" className="font-mono text-[11px]" />
            </Field>
            <Field label="Weight lines" hint="one regex per line">
              <Textarea rows={2} value={weightPatterns} onChange={(event) => setWeightPatterns(event.target.value)} placeholder="^(?<qty>\d+(?:[.,]\d+)?)\s*(?<unit>kg|g|l|ml)\s*[x×]\s*(?<unitPrice>\d+[.,]\d{2})" className="font-mono text-[11px]" />
            </Field>
            <Field label="Discount lines" hint="one regex per line">
              <Textarea rows={2} value={discountPatterns} onChange={(event) => setDiscountPatterns(event.target.value)} placeholder="κπτωση&#10;discount" className="font-mono text-[11px]" />
            </Field>
            <Field label="Savings summary lines" hint="receipt-level totals, not products">
              <Textarea rows={2} value={savingsPatterns} onChange={(event) => setSavingsPatterns(event.target.value)} placeholder="YOU SAVED&#10;ΣΥΝΟΛΙΚΗ ΕΚΠΤΩΣΗ" className="font-mono text-[11px]" />
            </Field>
          </Card>

          <Card className="space-y-3 p-4">
            <div>
              <h2 className="font-display text-lg">Tax and total</h2>
              <p className="text-[11px] leading-relaxed text-muted">
                Tax rows can expose <code>rate</code>, <code>net</code>, <code>tax</code> and <code>gross</code>. The
                summary and total patterns may expose <code>total</code>.
              </p>
            </div>
            <Field label="Tax section starts at" hint="one regex per line">
              <Textarea rows={2} value={taxStart} onChange={(event) => setTaxStart(event.target.value)} placeholder="^ΦΠΑ" className="font-mono text-[11px]" />
            </Field>
            <Field label="Tax row pattern" hint="optional">
              <Textarea rows={2} value={taxRowPattern} onChange={(event) => setTaxRowPattern(event.target.value)} placeholder="^[A-ZΑ-Ω]\s+(?<rate>\d{1,2}(?:[.,]\d+)?)\s*%" className="font-mono text-[11px]" />
            </Field>
            <Field label="Tax summary pattern" hint="optional">
              <Input value={taxSummaryPattern} onChange={(event) => setTaxSummaryPattern(event.target.value)} placeholder="^ΣΥΝΟΛΟ(?=\s|$)" className="font-mono text-[11px]" />
            </Field>
            <Field label="Total pattern" hint="optional">
              <Input value={totalPattern} onChange={(event) => setTotalPattern(event.target.value)} placeholder="^ΣΥΝΟΛΟ(?=\s|$)" className="font-mono text-[11px]" />
            </Field>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-lg">Test the template</h2>
                <p className="text-[11px] text-muted">Paste OCR text from a real receipt. Nothing is saved until you press Create.</p>
              </div>
              <Button size="sm" variant="secondary" icon="download" onClick={loadExample}>
                Load Lidl example
              </Button>
            </div>
            <Textarea
              rows={12}
              value={sampleText}
              onChange={(event) => setSampleText(event.target.value)}
              placeholder="Paste a receipt's OCR text here…"
              className="font-mono text-[11px]"
            />
            <Button block icon="sparkles" loading={testing} onClick={() => void runTest()}>
              Test rules
            </Button>
            {testErrors.length > 0 && (
              <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[11px] text-danger">
                <div className="font-medium">Template errors</div>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {testErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          {testResult && (
            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-lg">Test result</h2>
                <Badge tone="brand">
                  <Icon name="sparkles" size={11} /> {Math.round(testResult.template.confidence * 100)}%
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <TestStat label="Lines" value={qty(testResult.draft.lines.length)} />
                <TestStat label="Total" value={money(testResult.draft.total, house.currency)} />
                <TestStat label="Net" value={money(testResult.draft.subtotal, house.currency)} />
                <TestStat label="Tax" value={money(testResult.draft.tax, house.currency)} />
                <TestStat label="Saved" value={money(testResult.draft.savings, house.currency)} />
              </div>
              <div className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line">
                {testResult.draft.lines.slice(0, 40).map((line, index) => (
                  <div key={`${line.description}-${index}`} className="px-3 py-2 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">{line.description}</span>
                      <span className="shrink-0">{money(line.lineTotal, house.currency)}</span>
                    </div>
                    <div className="text-[10px] text-muted">
                      {qty(line.quantity)} {line.unit ?? "pcs"}
                      {line.taxRate != null ? ` · VAT ${line.taxRate}%` : ""}
                      {(line.discount ?? 0) > 0 ? ` · discount ${money(line.discount, house.currency)}` : ""}
                    </div>
                    {line.rawDescription && line.rawDescription !== line.description && (
                      <div className="truncate text-[10px] text-muted">receipt: {line.rawDescription}</div>
                    )}
                  </div>
                ))}
                {testResult.draft.lines.length === 0 && <p className="px-3 py-3 text-xs text-muted">No product lines matched.</p>}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function TestStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-raised px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-medium">{value}</div>
    </div>
  );
}

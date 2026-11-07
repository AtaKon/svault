import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
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
  const { t } = useI18n();
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
            toast.error(t("Template not found"));
            navigate("/receipts?tab=templates", { replace: true });
          }
        } else if (exampleId) {
          const template = list.find((entry) => entry.id === exampleId);
          if (template) fill(template, t("{name} copy", { name: template.name }));
        }
      })
      .catch((err) => toast.error(err instanceof Error ? t(err.message) : t("Could not load templates")))
      .finally(() => setLoading(false));
  }, [editing, exampleId, house.id, navigate, t, templateId, toast]);

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
      toast.error(t("Paste a sample receipt first"));
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
      if (!result.draft.lines.length) toast.push(t("Template is valid but found no product lines in this sample"));
    } catch (err) {
      if (err instanceof ApiError) {
        setTestErrors(Array.isArray(err.details) ? err.details.map(String) : [t(err.message)]);
      } else {
        setTestErrors([err instanceof Error ? t(err.message) : t("Could not test the template")]);
      }
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      toast.error(t("Give the template a name"));
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
      toast.success(editing ? t("Template updated") : t("Template created"));
      navigate("/receipts?tab=templates", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) setTestErrors(err.details.map(String));
      toast.error(err instanceof Error ? t(err.message) : t("Could not save the template"));
    } finally {
      setSaving(false);
    }
  };

  const loadExample = () => {
    const example = templates.find((template) => template.id === "lidl-gr");
    if (example) fill(example, name || "Lidl copy");
  };

  if (loading) return <LoadingBlock label={t("Loading template")} />;

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/receipts?tab=templates")}
        eyebrow={t("Receipt template")}
        title={editing ? name || t("Edit template") : t("New receipt template")}
        subtitle={t("Teach SVault a shop layout with regular expressions, then test it on a real receipt.")}
        actions={
          <Button icon="check" loading={saving} disabled={!name.trim() || !productPattern.trim()} onClick={() => void save()}>
            {editing ? t("Save template") : t("Create template")}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <h2 className="font-display text-lg">{t("Identity")}</h2>
            <Field label={t("Name")} required>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Sklavenitis Greece")} maxLength={80} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Shop name")} hint={t("optional")}>
                <Input value={vendorName} onChange={(event) => setVendorName(event.target.value)} placeholder={t("Σκλαβενίτης")} maxLength={80} />
              </Field>
              <Field label={t("Country")} hint={t("2-letter code")}>
                <Input
                  value={country}
                  onChange={(event) => setCountry(event.target.value.toUpperCase().slice(0, 2))}
                  maxLength={2}
                  className="text-center font-mono uppercase"
                />
              </Field>
            </div>
            <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
              <Switch checked={active} onChange={setActive} label={t("Active")} description={t("Inactive templates are ignored during receipt scanning.")} />
            </div>
          </Card>

          <Card className="space-y-3 p-4">
            <div>
              <h2 className="font-display text-lg">{t("Detection")}</h2>
              <p className="text-[11px] text-muted">{t("At least one keyword must appear in the OCR text. More matches raise confidence.")}</p>
            </div>
            <Field label={t("Keywords")} required hint={t("comma separated, case-insensitive")}>
              <Input
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
                placeholder={"LIDL, ΛΙΝΤΑ ΕΛΛΑΣ, ΦΟΡΟΛΟΓΙΚΗ ΑΠΟΔΕΙΞΗ"}
              />
            </Field>
            <Field label={t("Minimum confidence")} hint={t("0.7 recommended")}>
              <Input type="number" min="0" max="1" step="0.01" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
            </Field>
          </Card>

          <Card className="space-y-3 p-4">
            <div>
              <h2 className="font-display text-lg">{t("Sections and products")}</h2>
              <p className="text-[11px] leading-relaxed text-muted">
                {t("Patterns are JavaScript regular expressions. Use named groups:")} <code>name</code>, <code>total</code> {t("and optionally")} <code>rate</code> {t("for product lines.")}</p>
            </div>
            <Field label={t("Product lines start after")} hint={t("one regex per line")}>
              <Textarea rows={2} value={sectionsStart} onChange={(event) => setSectionsStart(event.target.value)} placeholder="ΦΟΡΟΛΟΓΙΚΗ\\s+ΑΠΟΔΕΙΞΗ" className="font-mono text-[11px]" />
            </Field>
            <Field label={t("Product lines end at")} hint={t("one regex per line")}>
              <Textarea rows={2} value={sectionsEnd} onChange={(event) => setSectionsEnd(event.target.value)} placeholder="^ΣΥΝΟΛΟ(?=\\s|$)" className="font-mono text-[11px]" />
            </Field>
            <Field label={t("Product pattern")} required hint={t("must include name and total groups")}>
              <Textarea rows={3} value={productPattern} onChange={(event) => setProductPattern(event.target.value)} className="font-mono text-[11px]" />
            </Field>
            <Field label={t("Ignore lines")} hint={t("one regex per line")}>
              <Textarea rows={3} value={productIgnore} onChange={(event) => setProductIgnore(event.target.value)} placeholder={"^ΣΑΚΟΥ\n^ΤΣ\\.?Π\\.?ΧΡ"} className="font-mono text-[11px]" />
            </Field>
          </Card>

          <Card className="space-y-3 p-4">
            <div>
              <h2 className="font-display text-lg">{t("Follow-up lines")}</h2>
              <p className="text-[11px] leading-relaxed text-muted">
                {t("Optional lines after a product. Quantity groups:")} <code>qty</code>, <code>unitPrice</code>{t(". Weight adds")}{" "}
                <code>unit</code>{t(". Discount amount may use")} <code>amount</code>.
              </p>
            </div>
            <Field label={t("Quantity lines")} hint={t("one regex per line")}>
              <Textarea rows={2} value={quantityPatterns} onChange={(event) => setQuantityPatterns(event.target.value)} placeholder="^(?<qty>\d+)\s*[x×]\s*(?<unitPrice>\d+[.,]\d{2})$" className="font-mono text-[11px]" />
            </Field>
            <Field label={t("Weight lines")} hint={t("one regex per line")}>
              <Textarea rows={2} value={weightPatterns} onChange={(event) => setWeightPatterns(event.target.value)} placeholder="^(?<qty>\d+(?:[.,]\d+)?)\s*(?<unit>kg|g|l|ml)\s*[x×]\s*(?<unitPrice>\d+[.,]\d{2})" className="font-mono text-[11px]" />
            </Field>
            <Field label={t("Discount lines")} hint={t("one regex per line")}>
              <Textarea rows={2} value={discountPatterns} onChange={(event) => setDiscountPatterns(event.target.value)} placeholder={"έκπτωση\nπροσφορά"} className="font-mono text-[11px]" />
            </Field>
            <Field label={t("Savings summary lines")} hint={t("receipt-level totals, not products")}>
              <Textarea rows={2} value={savingsPatterns} onChange={(event) => setSavingsPatterns(event.target.value)} placeholder={"ΚΕΡΔΙΣΑΤΕ\nΣΥΝΟΛΙΚΗ ΕΚΠΤΩΣΗ"} className="font-mono text-[11px]" />
            </Field>
          </Card>

          <Card className="space-y-3 p-4">
            <div>
              <h2 className="font-display text-lg">{t("Tax and total")}</h2>
              <p className="text-[11px] leading-relaxed text-muted">
                {t("Tax rows can expose")} <code>rate</code>, <code>net</code>, <code>tax</code> {t("and")} <code>gross</code>{t(". The summary and total patterns may expose")} <code>total</code>.
              </p>
            </div>
            <Field label={t("Tax section starts at")} hint={t("one regex per line")}>
              <Textarea rows={2} value={taxStart} onChange={(event) => setTaxStart(event.target.value)} placeholder="^ΦΠΑ" className="font-mono text-[11px]" />
            </Field>
            <Field label={t("Tax row pattern")} hint={t("optional")}>
              <Textarea rows={2} value={taxRowPattern} onChange={(event) => setTaxRowPattern(event.target.value)} placeholder="^[A-ZΑ-Ω]\s+(?<rate>\d{1,2}(?:[.,]\d+)?)\s*%" className="font-mono text-[11px]" />
            </Field>
            <Field label={t("Tax summary pattern")} hint={t("optional")}>
              <Input value={taxSummaryPattern} onChange={(event) => setTaxSummaryPattern(event.target.value)} placeholder="^ΣΥΝΟΛΟ(?=\\s|$)" className="font-mono text-[11px]" />
            </Field>
            <Field label={t("Total pattern")} hint={t("optional")}>
              <Input value={totalPattern} onChange={(event) => setTotalPattern(event.target.value)} placeholder="^ΣΥΝΟΛΟ(?=\\s|$)" className="font-mono text-[11px]" />
            </Field>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-lg">{t("Test the template")}</h2>
                <p className="text-[11px] text-muted">{t("Paste OCR text from a real receipt. Nothing is saved until you press Create.")}</p>
              </div>
              <Button size="sm" variant="secondary" icon="download" onClick={loadExample}>
                {t("Load Lidl example")}</Button>
            </div>
            <Textarea
              rows={12}
              value={sampleText}
              onChange={(event) => setSampleText(event.target.value)}
              placeholder={t("Paste a receipt's OCR text here…")}
              className="font-mono text-[11px]"
            />
            <Button block icon="sparkles" loading={testing} onClick={() => void runTest()}>
              {t("Test rules")}</Button>
            {testErrors.length > 0 && (
              <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[11px] text-danger">
                <div className="font-medium">{t("Template errors")}</div>
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
                <h2 className="font-display text-lg">{t("Test result")}</h2>
                <Badge tone="brand">
                  <Icon name="sparkles" size={11} /> {Math.round(testResult.template.confidence * 100)}%
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <TestStat label={t("Lines")} value={qty(testResult.draft.lines.length)} />
                <TestStat label={t("Total")} value={money(testResult.draft.total, house.currency)} />
                <TestStat label={t("Net")} value={money(testResult.draft.subtotal, house.currency)} />
                <TestStat label={t("Tax")} value={money(testResult.draft.tax, house.currency)} />
                <TestStat label={t("Saved")} value={money(testResult.draft.savings, house.currency)} />
              </div>
              <div className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line">
                {testResult.draft.lines.slice(0, 40).map((line, index) => (
                  <div key={`${line.description}-${index}`} className="px-3 py-2 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">{line.description}</span>
                      <span className="shrink-0">{money(line.lineTotal, house.currency)}</span>
                    </div>
                    <div className="text-[10px] text-muted">
                      {qty(line.quantity)} {line.unit ?? t("pcs")}
                      {line.taxRate != null ? t(" · VAT {rate}%", { rate: line.taxRate }) : ""}
                      {(line.discount ?? 0) > 0 ? t(" · discount {amount}", { amount: money(line.discount, house.currency) }) : ""}
                    </div>
                    {line.rawDescription && line.rawDescription !== line.description && (
                      <div className="truncate text-[10px] text-muted">{t("receipt:")} {line.rawDescription}</div>
                    )}
                  </div>
                ))}
                {testResult.draft.lines.length === 0 && <p className="px-3 py-3 text-xs text-muted">{t("No product lines matched.")}</p>}
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

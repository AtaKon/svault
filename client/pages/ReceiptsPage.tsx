import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, api } from "@/api";
import { useHouse } from "@/state";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  Sheet,
  Skeleton,
  Tabs,
  Textarea,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { ZoomableImage } from "@/components/ZoomableImage";
import { useToast } from "@/components/toast";
import { money, qty, receiptProviderLabel, receiptTemplateLabel, shortDate } from "@/format";
import type {
  PurchaseAnalytics,
  Receipt,
  ReceiptLine,
  ReceiptTemplate,
  Vendor,
  VendorSuggestion,
  VendorSuggestions,
} from "@shared/types";

const SHOP_KINDS = ["shop", "supermarket", "market", "online", "restaurant", "other"];

export function ReceiptsPage() {
  const { house, can } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "receipts";
  const setTab = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "receipts") next.delete("tab");
    else next.set("tab", value);
    setParams(next, { replace: true });
  };
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [detail, setDetail] = useState<Receipt | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);

  const [shopOpen, setShopOpen] = useState(false);
  const [editingShop, setEditingShop] = useState<Vendor | null>(null);
  const [shopName, setShopName] = useState("");
  const [shopKind, setShopKind] = useState("shop");
  const [shopNote, setShopNote] = useState("");
  const [deleteShop, setDeleteShop] = useState<Vendor | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<VendorSuggestions | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestCountry, setSuggestCountry] = useState("GR");
  const [suggestQuery, setSuggestQuery] = useState("");
  const [suggestKind, setSuggestKind] = useState("all");
  const [suggestBusyId, setSuggestBusyId] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<PurchaseAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsRange, setAnalyticsRange] = useState("12");
  const [templates, setTemplates] = useState<ReceiptTemplate[]>([]);
  const [deleteTemplate, setDeleteTemplate] = useState<ReceiptTemplate | null>(null);

  const load = useCallback(async () => {
    try {
      const [receiptList, vendorList] = await Promise.all([
        api<Receipt[]>(`/api/houses/${house.id}/receipts?limit=100`),
        api<Vendor[]>(`/api/houses/${house.id}/vendors`),
      ]);
      setReceipts(receiptList);
      setVendors(vendorList);
      setTemplates(await api<ReceiptTemplate[]>(`/api/houses/${house.id}/receipt-templates`));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load receipts");
      setReceipts([]);
      setVendors([]);
    }
  }, [house.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAnalytics = async (range = analyticsRange) => {
    setAnalyticsLoading(true);
    try {
      const months = range === "all" ? null : Number(range);
      const fromDate = new Date();
      if (months) fromDate.setMonth(fromDate.getMonth() - months);
      const from = months ? fromDate.toISOString().slice(0, 10) : null;
      const query = from ? `?from=${encodeURIComponent(from)}` : "";
      setAnalytics(await api<PurchaseAnalytics>(`/api/houses/${house.id}/purchases/analytics${query}`));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load spending insights");
      setAnalytics(null);
    } finally {
      setAnalyticsLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "insights") void loadAnalytics(analyticsRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, analyticsRange, house.id]);

  const openDetail = async (receipt: Receipt) => {
    setDetail({ ...receipt, lines: [] });
    setDetailLoading(true);
    try {
      setDetail(await api<Receipt>(`/api/receipts/${receipt.id}`));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load the receipt");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const removeReceipt = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api(`/api/receipts/${deleteTarget.id}`, { method: "DELETE" });
      toast.success("Receipt removed — stock stays in inventory");
      setDeleteTarget(null);
      setDetail(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the receipt");
    } finally {
      setBusy(false);
    }
  };

  const openShop = (vendor: Vendor | null) => {
    setEditingShop(vendor);
    setShopName(vendor?.name ?? "");
    setShopKind(vendor?.kind ?? "shop");
    setShopNote(vendor?.note ?? "");
    setShopOpen(true);
  };

  const saveShop = async () => {
    if (!shopName.trim()) return;
    setBusy(true);
    try {
      const body = { name: shopName.trim(), kind: shopKind, note: shopNote.trim() || null };
      if (editingShop) await api(`/api/houses/${house.id}/vendors/${editingShop.id}`, { method: "PATCH", body });
      else await api(`/api/houses/${house.id}/vendors`, { method: "POST", body });
      toast.success(editingShop ? "Shop updated" : "Shop added");
      setShopOpen(false);
      setEditingShop(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the shop");
    } finally {
      setBusy(false);
    }
  };

  const removeShop = async () => {
    if (!deleteShop) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/vendors/${deleteShop.id}`, { method: "DELETE" });
      toast.success("Shop removed");
      setDeleteShop(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the shop");
    } finally {
      setBusy(false);
    }
  };

  const removeTemplate = async () => {
    if (!deleteTemplate) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/receipt-templates/${deleteTemplate.id}`, { method: "DELETE" });
      toast.success("Template removed");
      setDeleteTemplate(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the template");
    } finally {
      setBusy(false);
    }
  };

  const loadSuggestions = async (country = suggestCountry) => {
    setSuggestLoading(true);
    try {
      const data = await api<VendorSuggestions>(
        `/api/houses/${house.id}/vendor-suggestions?country=${encodeURIComponent(country)}`,
      );
      setSuggestions(data);
      setSuggestCountry(data.country);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load suggested shops");
      setSuggestions(null);
    } finally {
      setSuggestLoading(false);
    }
  };

  const openSuggestions = () => {
    setSuggestOpen(true);
    setSuggestQuery("");
    setSuggestKind("all");
    void loadSuggestions();
  };

  const addSuggested = async (entry: VendorSuggestion) => {
    setSuggestBusyId(entry.id);
    try {
      const vendor = await api<Vendor>(`/api/houses/${house.id}/vendors`, {
        method: "POST",
        body: { catalogId: entry.id },
      });
      setVendors((current) => (current ? [...current, vendor].sort((a, b) => a.name.localeCompare(b.name)) : current));
      setSuggestions((current) =>
        current
          ? { ...current, entries: current.entries.map((item) => (item.id === entry.id ? { ...item, added: true } : item)) }
          : current,
      );
      toast.success(`${vendor.name} added`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSuggestions((current) =>
          current
            ? { ...current, entries: current.entries.map((item) => (item.id === entry.id ? { ...item, added: true } : item)) }
            : current,
        );
        toast.push(`${entry.name} is already in your shops`);
      } else {
        toast.error(err instanceof Error ? err.message : "Could not add the shop");
      }
    } finally {
      setSuggestBusyId(null);
    }
  };

  const totalValue = (receipts ?? []).reduce((sum, receipt) => sum + (receipt.total ?? 0), 0);
  const suggestionKinds = ["all", ...Array.from(new Set((suggestions?.entries ?? []).map((entry) => entry.kind)))];
  const visibleSuggestions = (suggestions?.entries ?? []).filter((entry) => {
    if (suggestKind !== "all" && entry.kind !== suggestKind) return false;
    if (!suggestQuery.trim()) return true;
    const needle = suggestQuery.trim().toLowerCase();
    return entry.name.toLowerCase().includes(needle) || entry.kind.toLowerCase().includes(needle);
  });

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Purchases"
        title="Receipts & shops"
        subtitle="Where your things came from — and a whole weekly shop added in one go."
        actions={
          <>
            <div className="hidden sm:block">
              <Button variant="secondary" icon="store" onClick={() => setTab("shops")}>
                Shops
              </Button>
            </div>
            <Button icon="scan" onClick={() => navigate("/receipts/scan")}>
              Scan receipt
            </Button>
          </>
        }
      />

      <Tabs
        items={[
          { value: "receipts", label: "Receipts", count: receipts?.length },
          { value: "shops", label: "Shops", count: vendors?.length },
          { value: "insights", label: "Insights" },
          { value: "templates", label: "Templates", count: templates.filter((template) => !template.builtIn).length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "receipts" ? (
        <>
          {receipts === null ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-[76px]" />
              ))}
            </div>
          ) : receipts.length === 0 ? (
            <EmptyState
              icon="receipt"
              title="No receipts yet"
              body="Scan a shopping receipt once and the whole basket becomes stock, with the shop and prices attached."
              action={
                <Button icon="scan" onClick={() => navigate("/receipts/scan")}>
                  Scan a receipt
                </Button>
              }
            />
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {receipts.map((receipt) => (
                  <button
                    key={receipt.id}
                    onClick={() => void openDetail(receipt)}
                    className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-left shadow-soft transition-colors hover:bg-raised"
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                      <Icon name="receipt" size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{receipt.vendorName ?? "Unknown shop"}</span>
                        <Badge tone={receipt.provider === "ai" ? "brand" : "outline"}>
                          {receiptProviderLabel(receipt.provider, receipt.source)}
                        </Badge>
                      </span>
                      <span className="block text-[11px] text-muted">
                        {receipt.purchasedAt ? shortDate(receipt.purchasedAt) : shortDate(receipt.createdAt)}
                        {receipt.lineCount != null ? ` · ${receipt.lineCount} line${receipt.lineCount === 1 ? "" : "s"}` : ""}
                        {receipt.savings != null && receipt.savings > 0
                          ? ` · saved ${money(receipt.savings, receipt.currency ?? house.currency)}`
                          : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-display text-lg leading-none">{money(receipt.total, receipt.currency ?? house.currency)}</span>
                      <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-muted">total</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-right text-[11px] text-muted">
                {receipts.length} receipt{receipts.length === 1 ? "" : "s"} · {money(totalValue, house.currency)} recorded
              </p>
            </>
          )}
        </>
      ) : tab === "shops" ? (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-lg">Shops & suppliers</h2>
              <p className="text-[11px] text-muted">Used when you add stock, scan a receipt or review where an item came from.</p>
            </div>
            {can("member") && (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="secondary" icon="sparkles" onClick={openSuggestions}>
                  Suggested
                </Button>
                <Button size="sm" variant="secondary" icon="plus" onClick={() => openShop(null)}>
                  Add
                </Button>
              </div>
            )}
          </div>
          {vendors === null ? (
            <Skeleton className="h-32" />
          ) : vendors.length === 0 ? (
            <p className="py-3 text-sm text-muted">No shops yet. Scan a receipt or add one here.</p>
          ) : (
            <div className="divide-y divide-line">
              {vendors.map((vendor) => (
                <div key={vendor.id} className="flex items-center gap-3 py-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-muted">
                    <Icon name="store" size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{vendor.name}</div>
                    <div className="text-[11px] capitalize text-muted">
                      {vendor.kind}
                      {vendor.purchaseCount != null ? ` · ${qty(vendor.purchaseCount)} purchase${vendor.purchaseCount === 1 ? "" : "s"}` : ""}
                      {vendor.note ? ` · ${vendor.note}` : ""}
                    </div>
                  </div>
                  {can("member") && <IconButton icon="pencil" label="Edit shop" onClick={() => openShop(vendor)} />}
                  {can("admin") && (
                    <IconButton icon="trash" label="Delete shop" className="hover:text-danger" onClick={() => setDeleteShop(vendor)} />
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : tab === "templates" ? (
        <TemplatesPanel
          templates={templates}
          canEdit={can("admin")}
          onNew={() => navigate("/receipts/templates/new")}
          onEdit={(template) => navigate(`/receipts/templates/${template.id}`)}
          onClone={(template) => navigate(`/receipts/templates/new?example=${template.id}`)}
          onDelete={setDeleteTemplate}
        />
      ) : (
        <InsightsPanel
          data={analytics}
          loading={analyticsLoading}
          range={analyticsRange}
          onRangeChange={setAnalyticsRange}
          currency={house.currency}
          onScan={() => navigate("/receipts/scan")}
        />
      )}

      <Card className="flex items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="store" size={17} />
        </span>
        <div className="text-[11px] leading-relaxed text-muted">
          Every receipt keeps the shop, date, line prices and the original photo. Stock lots remember the shop too, so
          “where did this come from?” has an answer long after the paper is gone.
        </div>
      </Card>

      <Sheet
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.vendorName ?? "Receipt"}
        description={
          detail
            ? [
                detail.purchasedAt ? shortDate(detail.purchasedAt) : null,
                detail.lines?.length ? `${detail.lines.length} lines` : null,
                receiptProviderLabel(detail.provider, detail.source),
                receiptTemplateLabel(detail.templateId),
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
        wide
        footer={
          detail ? (
            <div className="flex gap-2">
              {can("member") && (
                <Button variant="secondary" block icon="trash" className="text-danger" onClick={() => setDeleteTarget(detail)}>
                  Delete record
                </Button>
              )}
              <Button block icon="plus" onClick={() => navigate("/receipts/scan")}>
                Scan another
              </Button>
            </div>
          ) : undefined
        }
      >
        {detailLoading ? (
          <LoadingBlock label="Loading receipt" />
        ) : detail ? (
          <div className="space-y-3">
            {detail.image && (
              <ZoomableImage
                src={detail.image}
                alt={`Receipt from ${detail.vendorName ?? "an unknown shop"}`}
                wrapperClassName="max-h-64 overflow-hidden rounded-xl bg-raised"
                className="max-h-64 w-full object-contain"
              />
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <ReceiptStat label="Total" value={money(detail.total, detail.currency ?? house.currency)} />
              <ReceiptStat
                label="Net"
                value={money(
                  detail.subtotal ??
                    (detail.total != null && detail.tax != null ? detail.total - detail.tax : detail.total),
                  detail.currency ?? house.currency,
                )}
              />
              <ReceiptStat label="Tax" value={money(detail.tax, detail.currency ?? house.currency)} />
              {detail.savings != null && detail.savings > 0 && (
                <ReceiptStat label="Saved" value={money(detail.savings, detail.currency ?? house.currency)} />
              )}
              <ReceiptStat label="Lines" value={qty(detail.lines?.length ?? 0)} />
            </div>
            <div className="divide-y divide-line rounded-xl border border-line">
              {(detail.lines ?? []).map((line: ReceiptLine) => (
                <div key={line.id} className="flex items-start gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{line.description}</div>
                    <div className="text-[11px] text-muted">
                      {qty(line.quantity)} {line.unit ?? "pcs"}
                      {line.itemName ? ` · ${line.itemName}` : " · not linked"}
                      {line.taxRate != null ? ` · VAT ${line.taxRate}%` : ""}
                      {(line.discount ?? 0) > 0 ? ` · discount ${money(line.discount, detail.currency ?? house.currency)}` : ""}
                      {line.barcode ? ` · ${line.barcode}` : ""}
                    </div>
                    {line.rawDescription && line.rawDescription !== line.description && (
                      <div className="truncate text-[10px] text-muted">receipt: {line.rawDescription}</div>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-xs">
                    <div className="font-medium">
                      {money(line.lineTotal ?? (line.unitPrice != null ? line.unitPrice * line.quantity : null), detail.currency ?? house.currency)}
                    </div>
                    {line.unitPrice != null && (
                      <div className="text-[10px] text-muted">
                        {money(line.unitPrice, detail.currency ?? house.currency)} / {line.unit ?? "unit"}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {(detail.lines ?? []).length === 0 && <p className="px-3 py-3 text-sm text-muted">No product lines stored.</p>}
            </div>
            {detail.taxBreakdown.length > 0 && (
              <div className="rounded-xl bg-raised px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">VAT split</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {detail.taxBreakdown.map((entry, index) => (
                    <Badge key={`${entry.rate ?? "tax"}-${index}`} tone="outline">
                      {entry.rate != null ? `${entry.rate}%` : "Tax"} · {money(entry.tax, detail.currency ?? house.currency)}
                      <span className="font-normal opacity-70">net {money(entry.net, detail.currency ?? house.currency)}</span>
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {detail.notes && <p className="rounded-xl bg-raised px-3 py-2 text-[11px] text-muted">{detail.notes}</p>}
            <p className="text-[11px] text-muted">
              Deleting this record keeps every stock batch it created. Remove or adjust that stock from the item pages.
            </p>
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={suggestOpen}
        onClose={() => setSuggestOpen(false)}
        title="Suggested shops"
        description="Common supermarkets, delis, kiosks and online shops in Greece."
        wide
      >
        {suggestLoading ? (
          <LoadingBlock label="Loading suggested shops" />
        ) : suggestions ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <Input
                  value={suggestQuery}
                  onChange={(event) => setSuggestQuery(event.target.value)}
                  placeholder="Search shops"
                  className="pl-9"
                  inputMode="search"
                />
              </div>
              {suggestions.countries.length > 1 ? (
                <Select
                  value={suggestions.country}
                  onChange={(event) => {
                    setSuggestCountry(event.target.value);
                    void loadSuggestions(event.target.value);
                  }}
                  className="w-[140px] shrink-0"
                >
                  {suggestions.countries.map((country) => (
                    <option key={country.code} value={country.code}>
                      {country.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Badge tone="outline" className="h-11 shrink-0 px-3">
                  <Icon name="mapPin" size={12} />
                  {suggestions.countries.find((country) => country.code === suggestions.country)?.name ?? suggestions.country}
                </Badge>
              )}
            </div>

            <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1">
              {suggestionKinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setSuggestKind(kind)}
                  className={
                    suggestKind === kind
                      ? "shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-bg"
                      : "shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                  }
                >
                  {kind === "all" ? "All" : kind}
                </button>
              ))}
            </div>

            <div className="divide-y divide-line rounded-xl border border-line">
              {visibleSuggestions.map((entry) => (
                <div key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                    <Icon name={entry.kind === "kiosk" ? "cup" : "store"} size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{entry.name}</div>
                    <div className="text-[11px] capitalize text-muted">{entry.kind}</div>
                  </div>
                  {entry.added ? (
                    <Badge tone="brand">
                      <Icon name="check" size={11} /> added
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="plus"
                      loading={suggestBusyId === entry.id}
                      disabled={suggestBusyId !== null}
                      onClick={() => void addSuggested(entry)}
                    >
                      Add
                    </Button>
                  )}
                </div>
              ))}
              {visibleSuggestions.length === 0 && (
                <p className="px-3 py-4 text-sm text-muted">No shops match that search or type.</p>
              )}
            </div>

            <p className="text-[11px] leading-relaxed text-muted">
              This list is a starting point, not a limit. Add any local deli, kiosk or market by hand under Shops. The
              catalogue is country-based, so more countries can be added later without changing how receipts work.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">Could not load the suggested shops. Try again from the Shops tab.</p>
        )}
      </Sheet>

      <Sheet
        open={shopOpen}
        onClose={() => {
          setShopOpen(false);
          setEditingShop(null);
        }}
        title={editingShop ? "Edit shop" : "New shop"}
        description="A supermarket, market stall, online shop or anywhere else you buy from."
        footer={
          <Button block loading={busy} disabled={!shopName.trim()} onClick={() => void saveShop()}>
            {editingShop ? "Save shop" : "Add shop"}
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <Input value={shopName} onChange={(event) => setShopName(event.target.value)} placeholder="Corner Market" autoFocus maxLength={80} />
          </Field>
          <Field label="Type">
            <Select value={shopKind} onChange={(event) => setShopKind(event.target.value)}>
              {SHOP_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note" hint="optional">
            <Textarea rows={2} value={shopNote} onChange={(event) => setShopNote(event.target.value)} maxLength={300} placeholder="Opening hours, loyalty card, delivery day…" />
          </Field>
        </div>
      </Sheet>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void removeReceipt()}
        title="Delete this receipt?"
        body="The receipt, its image and line details are removed. Stock and price history stay in the house."
        confirmLabel="Delete receipt"
        loading={busy}
      />

      <ConfirmDialog
        open={Boolean(deleteShop)}
        onClose={() => setDeleteShop(null)}
        onConfirm={() => void removeShop()}
        title={`Delete ${deleteShop?.name ?? "shop"}?`}
        body="Existing stock keeps its price, but loses the shop link. Receipts will show the name they were scanned with."
        confirmLabel="Delete shop"
        loading={busy}
      />

      <ConfirmDialog
        open={Boolean(deleteTemplate)}
        onClose={() => setDeleteTemplate(null)}
        onConfirm={() => void removeTemplate()}
        title={`Delete ${deleteTemplate?.name ?? "template"}?`}
        body="Receipts already parsed with this template keep their data. Future scans from this shop will use the generic parser unless another template matches."
        confirmLabel="Delete template"
        loading={busy}
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone="outline">
          <Icon name="receipt" size={11} /> receipt-first inventory
        </Badge>
        <Badge tone="outline">
          <Icon name="store" size={11} /> every batch knows its shop
        </Badge>
      </div>
    </div>
  );
}

function TemplatesPanel({
  templates,
  canEdit,
  onNew,
  onEdit,
  onClone,
  onDelete,
}: {
  templates: ReceiptTemplate[];
  canEdit: boolean;
  onNew: () => void;
  onEdit: (template: ReceiptTemplate) => void;
  onClone: (template: ReceiptTemplate) => void;
  onDelete: (template: ReceiptTemplate) => void;
}) {
  const builtIn = templates.filter((template) => template.builtIn);
  const custom = templates.filter((template) => !template.builtIn);
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg">Receipt templates</h2>
            <p className="text-[11px] text-muted">
              A template teaches SVault a shop's layout: product lines, quantities, discounts, totals and VAT.
            </p>
          </div>
          {canEdit && (
            <Button size="sm" icon="plus" onClick={onNew}>
              New template
            </Button>
          )}
        </div>

        <div className="divide-y divide-line">
          {builtIn.map((template) => (
            <div key={template.id} className="flex items-center gap-3 py-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <Icon name="sparkles" size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{template.name}</span>
                  <Badge tone="brand">built-in</Badge>
                </div>
                <div className="text-[11px] text-muted">
                  {template.country} · {template.rules.keywords.length} detection signals · read-only
                </div>
              </div>
              {canEdit && (
                <Button size="sm" variant="secondary" icon="plus" onClick={() => onClone(template)}>
                  Clone
                </Button>
              )}
            </div>
          ))}

          {custom.map((template) => (
            <div key={template.id} className="flex items-center gap-3 py-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-muted">
                <Icon name="receipt" size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{template.name}</span>
                  {!template.active && <Badge tone="warn">inactive</Badge>}
                </div>
                <div className="text-[11px] text-muted">
                  {template.vendorName ?? "Any shop"} · {template.country} · v{template.version} ·{" "}
                  {template.rules.keywords.length} detection signals
                </div>
              </div>
              {canEdit && (
                <>
                  <IconButton icon="pencil" label="Edit template" onClick={() => onEdit(template)} />
                  <IconButton icon="trash" label="Delete template" className="hover:text-danger" onClick={() => onDelete(template)} />
                </>
              )}
            </div>
          ))}

          {custom.length === 0 && (
            <p className="py-4 text-sm text-muted">
              No custom templates yet. Start from the Lidl or Sklavenitis example or create one for another shop.
            </p>
          )}
        </div>
      </Card>

      <Card className="flex items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="key" size={17} />
        </span>
        <div className="text-[11px] leading-relaxed text-muted">
          Templates are selected by detection keywords and a confidence threshold. Unknown layouts fall back to the
          generic parser or the AI provider. Product names still use learned aliases, so correcting one line teaches
          that shop's shorthand for next time.
        </div>
      </Card>
    </div>
  );
}

function ReceiptStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-raised px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-medium">{value}</div>
    </div>
  );
}

function InsightsPanel({
  data,
  loading,
  range,
  onRangeChange,
  currency,
  onScan,
}: {
  data: PurchaseAnalytics | null;
  loading: boolean;
  range: string;
  onRangeChange: (value: string) => void;
  currency: string;
  onScan: () => void;
}) {
  const ranges = [
    { value: "3", label: "3 months" },
    { value: "6", label: "6 months" },
    { value: "12", label: "12 months" },
    { value: "all", label: "All time" },
  ];
  const monthLabel = (month: string) => {
    if (!/^\d{4}-\d{2}$/.test(month)) return month;
    return new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  };

  return (
    <div className="space-y-4">
      <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1">
        {ranges.map((entry) => (
          <button
            key={entry.value}
            type="button"
            onClick={() => onRangeChange(entry.value)}
            className={
              range === entry.value
                ? "shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-medium text-bg"
                : "shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
            }
          >
            {entry.label}
          </button>
        ))}
      </div>

      {loading ? (
        <LoadingBlock label="Adding up receipts" />
      ) : !data || data.totals.receipts === 0 ? (
        <EmptyState
          icon="receipt"
          title="No spending yet"
          body="Scan a receipt with prices and tax to see what you spend at each shop, how much is tax and how prices move."
          action={
            <Button icon="scan" onClick={onScan}>
              Scan a receipt
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <SpendStat label="Total spend" value={money(data.totals.total, currency)} hint={`${qty(data.totals.receipts)} receipts`} tone="brand" />
            <SpendStat label="Net" value={money(data.totals.net, currency)} hint="before tax" />
            <SpendStat label="Tax / VAT" value={money(data.totals.tax, currency)} hint="included" tone="warn" />
            <SpendStat label="Money saved" value={money(data.totals.savings, currency)} hint="discounts" />
            <SpendStat label="Average basket" value={money(data.totals.average, currency)} hint="per receipt" />
          </div>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">Spending by month</h2>
              <Badge tone="outline">{money(data.totals.total, currency)}</Badge>
            </div>
            <div className="space-y-2">
              {data.monthly.map((entry) => {
                const max = Math.max(...data.monthly.map((month) => month.total), 1);
                return (
                  <div key={entry.month} className="grid grid-cols-[68px_1fr_76px] items-center gap-2 text-[11px]">
                    <span className="truncate text-muted">{monthLabel(entry.month)}</span>
                    <div className="h-2 overflow-hidden rounded-full bg-raised">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(3, (entry.total / max) * 100)}%` }} />
                    </div>
                    <span className="text-right font-medium">{money(entry.total, currency)}</span>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Based on receipts in this period. Net is the amount before tax; tax is what was included in the total.
            </p>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="font-display text-lg">By shop</h2>
                <Badge tone="outline">{qty(data.byVendor.length)} shops</Badge>
              </div>
              <div className="divide-y divide-line">
                {data.byVendor.map((vendor) => (
                  <div key={`${vendor.vendorId ?? vendor.vendorName}`} className="flex items-center gap-3 py-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                      <Icon name="store" size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{vendor.vendorName}</div>
                      <div className="text-[10px] text-muted">
                        {qty(vendor.receipts)} receipt{vendor.receipts === 1 ? "" : "s"} · net {money(vendor.net, currency)} · tax{" "}
                        {money(vendor.tax, currency)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-medium">{money(vendor.total, currency)}</div>
                      <div className="text-[10px] text-muted">
                        avg {money(vendor.receipts ? vendor.total / vendor.receipts : 0, currency)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="font-display text-lg">Tax split</h2>
                <Badge tone="outline">{money(data.totals.tax, currency)}</Badge>
              </div>
              {data.taxRates.length === 0 ? (
                <p className="py-3 text-sm text-muted">
                  No VAT rate breakdown was read from these receipts. The total tax figure is still included above.
                </p>
              ) : (
                <div className="divide-y divide-line">
                  {data.taxRates.map((entry) => (
                    <div key={`${entry.rate ?? "other"}`} className="flex items-center gap-3 py-2.5 text-xs">
                      <Badge tone="outline">{entry.rate != null ? `${entry.rate}%` : "Tax"}</Badge>
                      <div className="min-w-0 flex-1 text-[10px] text-muted">
                        net {money(entry.net, currency)} · gross {money(entry.gross, currency)}
                      </div>
                      <div className="text-sm font-medium">{money(entry.tax, currency)}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-display text-lg">Spending by category</h2>
              <Badge tone="outline">items</Badge>
            </div>
            {data.byCategory.length === 0 ? (
              <p className="py-3 text-sm text-muted">No categorised receipt lines in this period.</p>
            ) : (
              <div className="space-y-2">
                {data.byCategory.map((entry) => {
                  const max = Math.max(...data.byCategory.map((category) => category.total), 1);
                  return (
                    <div key={entry.categoryId ?? entry.categoryName} className="grid grid-cols-[1fr_1.2fr_76px] items-center gap-2 text-[11px]">
                      <span className="truncate">{entry.categoryName}</span>
                      <div className="h-2 overflow-hidden rounded-full bg-raised">
                        <div className="h-full rounded-full bg-brand/70" style={{ width: `${Math.max(3, (entry.total / max) * 100)}%` }} />
                      </div>
                      <span className="text-right font-medium">{money(entry.total, currency)}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Category totals use the item each receipt line was matched to, so they improve as items are categorised.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function SpendStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "brand" | "warn";
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">{label}</span>
        <span
          className={
            tone === "warn"
              ? "flex h-7 w-7 items-center justify-center rounded-lg bg-warn-soft text-warn"
              : tone === "brand"
                ? "flex h-7 w-7 items-center justify-center rounded-lg bg-brand-soft text-brand"
                : "hidden"
          }
        >
          <Icon name={tone === "warn" ? "receipt" : "price"} size={14} />
        </span>
      </div>
      <div className="mt-1.5 font-display text-xl leading-none">{value}</div>
      {hint && <div className="mt-1 text-[10px] text-muted">{hint}</div>}
    </div>
  );
}

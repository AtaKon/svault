import { useCallback, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Badge, Button, Card, Input, PageHeader, Sheet, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { ZoomableImage } from "@/components/ZoomableImage";
import { useToast } from "@/components/toast";
import { qty as formatQty } from "@/format";
import type { Item, OffProduct } from "@shared/types";

interface ScanResponse {
  code: string;
  match: "local" | "external" | "none";
  item: Item | null;
  product?: OffProduct | null;
}

function packageSize(quantity: string | null | undefined): { amount: string; unit: string } | null {
  const text = String(quantity ?? "").replace(/,/g, ".");
  const normalize = (unit: string) => (unit === "gr" ? "g" : unit === "lt" ? "l" : unit.toLowerCase());
  const multi = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(kg|gr|g|mg|lt|l|ml|cl|dl|oz|lb)\b/i.exec(text);
  if (multi) {
    const amount = Number(multi[1]) * Number(multi[2]);
    if (Number.isFinite(amount) && amount > 0) {
      return { amount: String(Math.round(amount * 1000) / 1000), unit: normalize(multi[3]) };
    }
  }
  const single = /(\d+(?:\.\d+)?)\s*(kg|gr|g|mg|lt|l|ml|cl|dl|oz|lb)\b/i.exec(text);
  if (single) {
    const amount = Number(single[1]);
    if (Number.isFinite(amount) && amount > 0) return { amount: String(amount), unit: normalize(single[2]) };
  }
  return null;
}

export function ScanPage() {
  const { house } = useHouse();
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const [recent, setRecent] = useState<ScanResponse[]>([]);
  const [stockBusy, setStockBusy] = useState<"add" | "remove" | null>(null);

  const lookup = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      setBusy(true);
      try {
        const data = await api<ScanResponse>(`/api/houses/${house.id}/scan?code=${encodeURIComponent(trimmed)}`);
        setResult(data);
        setRecent((current) => [data, ...current.filter((entry) => entry.code !== trimmed)].slice(0, 6));
        if (data.match === "local") navigator.vibrate?.([30, 40, 30]);
      } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Lookup failed"));
      } finally {
        setBusy(false);
      }
    },
    [house.id, toast],
  );

  const adjust = async (action: "add" | "remove") => {
    if (!result?.item) return;
    setStockBusy(action);
    try {
      const updated = await api<Item>(`/api/items/${result.item.id}/stock`, {
        method: "POST",
        body: { action, quantity: 1, unit: result.item.unit },
      });
      setResult({ ...result, item: updated as unknown as Item });
      toast.success(t(action === "add" ? "Added one {item}" : "Removed one {item}", { item: updated.name }));
      window.dispatchEvent(new Event("sv:refresh-badges"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not update stock"));
    } finally {
      setStockBusy(null);
    }
  };

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    void lookup(manual);
    setManual("");
  };

  const createItem = () => {
    if (!result) return;
    const query = new URLSearchParams({ barcode: result.code });
    if (result.product?.code) query.set("offCode", result.product.code);
    if (result.product?.name) query.set("name", result.product.name);
    if (result.product?.brand) query.set("brand", result.product.brand);
    if (result.product?.genericName) query.set("description", result.product.genericName);
    const size = packageSize(result.product?.quantity);
    if (size) {
      query.set("unit", size.unit);
      query.set("quantity", size.amount);
    }
    if (result.product?.image) query.set("image", result.product.image);
    navigate(`/items/new?${query.toString()}`);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={t("Barcode")}
        title={t("Scan & stock")}
        subtitle={t("Point at a barcode to add, use or create an item.")}
        actions={
          <div className="hidden sm:block">
            <Badge tone="outline">
              <Icon name="wifi" size={11} /> {t("local first")}
            </Badge>
          </div>
        }
      />

      {!result ? (
        <>
          <BarcodeScanner onDetected={(code) => void lookup(code)} />
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              <Icon name="key" size={13} /> {t("Or type it")}
            </div>
            <form onSubmit={submitManual} className="flex gap-2">
              <Input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder={t("EAN, UPC or any code")}
                inputMode="numeric"
                autoComplete="off"
              />
              <Button type="submit" variant="secondary" loading={busy} disabled={!manual.trim()}>
                {t("Find")}
              </Button>
            </form>
            <p className="mt-2 text-[11px] text-muted">
              {t("Unknown products are looked up online when possible, then you can create the item in two taps.")}
            </p>
          </Card>
          <Card className="flex items-center gap-3 p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <Icon name="receipt" size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{t("Shopping receipt?")}</div>
              <div className="text-[11px] text-muted">{t("Photograph it once and add the whole basket, with the shop recorded.")}</div>
            </div>
            <Button size="sm" variant="secondary" icon="arrowUpRight" onClick={() => navigate("/receipts/scan")}>
              {t("Scan")}
            </Button>
          </Card>
          {recent.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-2 font-display text-lg">{t("This session")}</h2>
              <div className="space-y-1">
                {recent.map((entry) => (
                  <button
                    key={entry.code}
                    onClick={() => setResult(entry)}
                    className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-raised"
                  >
                    <Icon name="barcode" size={14} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate">{entry.item?.name ?? entry.product?.name ?? entry.code}</span>
                    <span className="font-mono text-[10px] text-muted">{entry.code}</span>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </>
      ) : null}

      {busy && !result && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
          <Spinner size={16} /> {t("Looking up barcode…")}
        </div>
      )}

      <Sheet
        open={Boolean(result)}
        onClose={() => setResult(null)}
        title={
          result?.match === "local"
            ? result.item?.name
            : result?.product?.name
              ? result.product.name
              : t("Unknown barcode")
        }
        description={result ? t("Code {code}", { code: result.code }) : undefined}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              block
              onClick={() => {
                setResult(null);
              }}
            >
              {t("Scan next")}
            </Button>
            {result?.match === "local" && result.item ? (
              <Button block icon="arrowUpRight" onClick={() => navigate(`/items/${result.item!.id}`)}>
                {t("Open item")}
              </Button>
            ) : (
              <Button block icon="plus" onClick={createItem}>
                {t("Create item")}
              </Button>
            )}
          </div>
        }
      >
        {result?.match === "local" && result.item ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-raised text-muted">
                {result.item.image ? (
                  <ZoomableImage
                    src={result.item.image}
                    alt={result.item.name}
                    wrapperClassName="h-full w-full"
                    className="h-full w-full object-cover"
                  />
                ) : result.item.categoryIcon ? (
                  <span className="text-2xl">{result.item.categoryIcon}</span>
                ) : (
                  <Icon name="box" size={24} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{result.item.name}</span>
                  {result.item.isLow && <Badge tone="warn">{t("low")}</Badge>}
                </div>
                <div className="text-xs text-muted">{result.item.categoryName ?? t("Uncategorised")}{result.item.brand ? ` · ${result.item.brand}` : ""}</div>
                <div className="mt-1 font-display text-2xl leading-none">
                  {formatQty(result.item.quantity)} <span className="text-xs text-muted">{result.item.unit}</span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                icon="minus"
                loading={stockBusy === "remove"}
                disabled={stockBusy !== null || result.item.quantity <= 0}
                onClick={() => void adjust("remove")}
              >
                {t("Use one")}
              </Button>
              <Button icon="plus" loading={stockBusy === "add"} disabled={stockBusy !== null} onClick={() => void adjust("add")}>
                {t("Add one")}
              </Button>
            </div>
            <div className="rounded-xl bg-raised px-3 py-2 text-[11px] text-muted">
              {t("Need a different amount or a price? Open the item and choose “Adjust stock”.")}
            </div>
          </div>
        ) : result ? (
          <div className="space-y-4">
            {result.product?.image && (
              <ZoomableImage
                src={result.product.image}
                alt={result.product.name ?? t("Product photo")}
                wrapperClassName="mx-auto h-32 w-fit"
                className="h-full rounded-2xl object-contain"
              />
            )}
            <div className="rounded-xl bg-raised p-3 text-sm">
              {result.product ? (
                <div className="space-y-1">
                  {result.product.name && <div className="font-medium">{result.product.name}</div>}
                  {result.product.brand && <div className="text-xs text-muted">{result.product.brand}</div>}
                  {result.product.quantity && <div className="text-xs text-muted">{result.product.quantity}</div>}
                  {(result.product.categories ?? []).length > 0 && (
                    <div className="text-[11px] text-muted">{(result.product.categories ?? []).slice(0, 4).join(" · ")}</div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted">
                  {t("This code is not in your vault and the online lookup found nothing. Create it manually — the barcode will be attached for next time.")}
                </div>
              )}
            </div>
            <div className={cn("text-[11px] leading-relaxed text-muted")}>
              {t("The create screen will be pre-filled. Set the unit, starting quantity and location, and it is ready to scan.")}
            </div>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

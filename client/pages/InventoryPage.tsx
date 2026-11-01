import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, qs } from "@/api";
import { useHouse } from "@/state";
import { Button, Card, EmptyState, Input, PageHeader, Select, Skeleton, Tabs, cn, useDebounced } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ItemCard } from "@/components/ItemCard";
import { qty } from "@/format";
import type { Category, Item, ItemDetail, Location } from "@shared/types";

export function InventoryPage() {
  const { house } = useHouse();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<Item[] | null>(null);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);

  const query = params.get("q") ?? "";
  const categoryId = params.get("category") ?? "";
  const locationId = params.get("location") ?? "";
  const low = params.get("low") === "1";
  const expiring = params.get("expiring") === "1";
  const sort = params.get("sort") ?? "name";
  const [search, setSearch] = useState(query);
  const debouncedSearch = useDebounced(search, 250);

  useEffect(() => {
    setSearch(query);
  }, [query]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debouncedSearch) next.set("q", debouncedSearch);
    else next.delete("q");
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  useEffect(() => {
    Promise.all([
      api<Category[]>(`/api/houses/${house.id}/categories`),
      api<Location[]>(`/api/houses/${house.id}/locations`),
    ])
      .then(([cats, locs]) => {
        setCategories(cats);
        setLocations(locs);
      })
      .catch(() => undefined);
  }, [house.id]);

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: Item[]; total: number }>(
        `/api/houses/${house.id}/items${qs({ q: query, categoryId, locationId, low: low ? 1 : undefined, expiring: expiring ? 1 : undefined, sort, limit: 500 })}`,
      );
      setItems(data.items);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load items");
    }
  }, [house.id, query, categoryId, locationId, low, expiring, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const onUpdated = (detail: ItemDetail) => {
    setItems((current) => (current ? current.map((item) => (item.id === detail.id ? detail : item)) : current));
    if (low && !detail.isLow) setItems((current) => current?.filter((item) => item.id !== detail.id) ?? null);
  };

  const activeFilters = useMemo(
    () =>
      [
        low && { label: "Running low", clear: () => setParam("low", null) },
        expiring && { label: "Expiring soon", clear: () => setParam("expiring", null) },
        categoryId && { label: categories.find((c) => c.id === categoryId)?.name ?? "Category", clear: () => setParam("category", null) },
        locationId && { label: locations.find((l) => l.id === locationId)?.name ?? "Place", clear: () => setParam("location", null) },
      ].filter(Boolean) as { label: string; clear: () => void }[],
    [low, expiring, categoryId, locationId, categories, locations],
  );

  return (
    <div>
      <PageHeader
        eyebrow={`${qty(total)} item${total === 1 ? "" : "s"}`}
        title="Inventory"
        subtitle="Everything stored in this house, with live quantities."
        actions={
          <>
            <div className="hidden sm:block">
              <Button variant="secondary" icon="scan" onClick={() => navigate("/scan")}>
                Scan
              </Button>
            </div>
            <Button icon="plus" onClick={() => navigate("/items/new")}>
              Add
            </Button>
          </>
        }
      />

      <div className="sticky top-[57px] z-20 -mx-4 mb-4 space-y-2 border-b border-line/70 bg-bg/90 px-4 py-2.5 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Icon name="search" size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search items or barcode"
              className="pl-9 pr-9"
              inputMode="search"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink"
                aria-label="Clear search"
              >
                <Icon name="close" size={15} />
              </button>
            )}
          </div>
          <button
            onClick={() => navigate("/scan")}
            className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-muted transition-colors hover:text-ink sm:flex"
            aria-label="Scan a barcode"
          >
            <Icon name="scan" size={19} />
          </button>
          <Select value={sort} onChange={(e) => setParam("sort", e.target.value === "name" ? null : e.target.value)} className="w-[96px] shrink-0 sm:w-[130px]">
            <option value="name">A–Z</option>
            <option value="recent">Recent</option>
            <option value="quantity">Low stock</option>
            <option value="value">Value</option>
          </Select>
        </div>

        <div className="flex items-center gap-2 overflow-hidden">
          <Tabs
            items={[{ value: "", label: "All" }, ...categories.map((cat) => ({ value: cat.id, label: cat.name }))]}
            value={categoryId}
            onChange={(value) => setParam("category", value || null)}
            className="min-w-0 flex-1"
          />
        </div>

        <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1">
          <FilterChip active={low} onClick={() => setParam("low", low ? null : "1")} icon="alert">
            Running low
          </FilterChip>
          <FilterChip active={expiring} onClick={() => setParam("expiring", expiring ? null : "1")} icon="clock">
            Expiring soon
          </FilterChip>
          {locations.map((location) => (
            <FilterChip
              key={location.id}
              active={locationId === location.id}
              onClick={() => setParam("location", locationId === location.id ? null : location.id)}
            >
              <span className="mr-1">{location.icon}</span>
              {location.name}
            </FilterChip>
          ))}
        </div>

        {activeFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeFilters.map((filter) => (
              <button
                key={filter.label}
                onClick={filter.clear}
                className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand"
              >
                {filter.label}
                <Icon name="close" size={11} />
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="mb-3 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

      {!items ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-[82px]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="box"
          title={query || activeFilters.length ? "Nothing matches" : "No items yet"}
          body={
            query || activeFilters.length
              ? "Try a different search or clear the filters."
              : "Add what is in the fridge, the closet or the cabin. You can scan a barcode to start."
          }
          action={
            <div className="flex gap-2">
              <Button icon="plus" onClick={() => navigate("/items/new")}>
                Add item
              </Button>
              <Button variant="secondary" icon="scan" onClick={() => navigate("/scan")}>
                Scan
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {items.map((item) => (
              <ItemCard key={item.id} item={item} onUpdated={onUpdated} />
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between text-[11px] text-muted">
            <span>
              Showing {items.length} of {total}
            </span>
            <button className="font-medium text-brand hover:underline" onClick={() => void load()}>
              Refresh
            </button>
          </div>
        </>
      )}

      <Card className="mt-5 flex items-center gap-3 p-3.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="barcode" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Scan instead of typing</div>
          <div className="text-[11px] text-muted">Unknown barcodes can fill in the product name automatically.</div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => navigate("/scan")}>
          Open
        </Button>
      </Card>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: "alert" | "clock";
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
        active ? "border-brand/40 bg-brand-soft text-brand" : "border-line bg-surface text-muted hover:text-ink",
      )}
    >
      {icon && <Icon name={icon} size={11} />}
      {children}
    </button>
  );
}

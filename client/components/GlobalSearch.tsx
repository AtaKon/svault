import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, qs } from "@/api";
import { useHouse } from "@/state";
import { useI18n } from "@/i18n";
import { Icon } from "@/components/icons";
import { Spinner, cn, useDebounced } from "@/components/ui";
import type { SearchHit, SearchResponse, SearchType } from "@shared/types";

const RECENT_KEY = "sv-recent-searches";
const RECENT_LIMIT = 8;

const GROUP_LABEL: Record<SearchType, string> = {
  items: "Items",
  recipes: "Recipes",
  receipts: "Purchases",
  bills: "Bills",
  shops: "Shops",
};

const GROUP_ICON: Record<SearchType, "box" | "book" | "receipt" | "price" | "store"> = {
  items: "box",
  recipes: "book",
  receipts: "receipt",
  bills: "price",
  shops: "store",
};

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeRecent(entries: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, RECENT_LIMIT)));
  } catch {
    /* private mode or a full quota: search still works without history */
  }
}

export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { house } = useHouse();
  const { t } = useI18n();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 250);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults(null);
    setError(null);
    setActive(0);
    setRecent(readRecent());
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const trimmed = debounced.trim();
    if (trimmed.length < 2) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api<SearchResponse>(`/api/houses/${house.id}/search${qs({ q: trimmed, limit: 6 })}`, {
      signal: controller.signal,
    })
      .then((data) => {
        setResults(data);
        setError(null);
        setActive(0);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? t(err.message) : t("Could not search"));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [open, debounced, house.id, t]);

  const flat = useMemo(
    () =>
      (results?.groups ?? []).flatMap((group) =>
        group.hits.map((hit) => ({ ...hit, group: group.type })),
      ),
    [results],
  );

  const remember = useCallback((value: string) => {
    const term = value.trim();
    if (term.length < 2) return;
    const next = [term, ...readRecent().filter((entry) => entry.toLowerCase() !== term.toLowerCase())].slice(
      0,
      RECENT_LIMIT,
    );
    writeRecent(next);
    setRecent(next);
  }, []);

  const openHit = useCallback(
    (hit: SearchHit) => {
      remember(query);
      onClose();
      navigate(hit.route);
    },
    [navigate, onClose, query, remember],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!flat.length) return;
      event.preventDefault();
      setActive((current) => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        return (next + flat.length) % flat.length;
      });
      return;
    }
    if (event.key === "Enter") {
      const hit = flat[active];
      if (hit) {
        event.preventDefault();
        openHit(hit);
      }
    }
  };

  if (!open) return null;

  const trimmed = query.trim();
  let runningOffset = 0;
  const groupsWithOffset = (results?.groups ?? []).map((group) => {
    const start = runningOffset;
    runningOffset += group.hits.length;
    return { group, start };
  });

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-bg sm:items-center sm:justify-start sm:bg-black/45 sm:px-4 sm:pt-20 sm:backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={t("Search everything")}
    >
      <button
        type="button"
        aria-label={t("Close")}
        tabIndex={-1}
        className="absolute inset-0 hidden cursor-default sm:block"
        onClick={onClose}
      />
      <div className="relative flex min-h-0 w-full flex-1 flex-col border-line bg-surface shadow-soft sm:max-w-xl sm:flex-none sm:rounded-2xl sm:border">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <Icon name="search" size={18} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("Search everything")}
            aria-label={t("Search everything")}
            aria-controls="sv-search-results"
            aria-activedescendant={flat.length ? `sv-search-hit-${active}` : undefined}
            autoComplete="off"
            inputMode="search"
            className="h-10 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted/60"
          />
          {loading && <Spinner size={16} className="text-muted" />}
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-muted hover:bg-raised hover:text-ink"
          >
            {t("Close")}
          </button>
        </div>

        <div id="sv-search-results" role="listbox" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:max-h-[60dvh]">
          <span className="sr-only" role="status">
            {trimmed.length >= 2 ? t("{count} results", { count: flat.length }) : ""}
          </span>
          {error && <div className="m-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

          {!trimmed && recent.length > 0 && (
            <div>
              <div className="flex items-center justify-between px-2 pb-1 pt-1">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{t("Recent searches")}</span>
                <button
                  type="button"
                  className="text-[11px] font-medium text-brand hover:underline"
                  onClick={() => {
                    writeRecent([]);
                    setRecent([]);
                  }}
                >
                  {t("Clear recent searches")}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5 px-2 pb-2">
                {recent.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => setQuery(entry)}
                    className="rounded-full border border-line bg-raised px-2.5 py-1 text-xs text-muted transition-colors hover:text-ink"
                  >
                    {entry}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!trimmed && (
            <p className="px-2 py-3 text-xs text-muted">{t("Search items, recipes, purchases, bills and shops")}</p>
          )}

          {trimmed.length > 0 && trimmed.length < 2 && (
            <p className="px-2 py-3 text-xs text-muted">{t("Type at least 2 characters")}</p>
          )}

          {trimmed.length >= 2 && !loading && results && flat.length === 0 && !error && (
            <p className="px-2 py-3 text-xs text-muted">{t("No matches for “{query}”", { query: trimmed })}</p>
          )}

          {flat.length > 0 && (
            <div className="space-y-2">
              {groupsWithOffset.map(({ group, start }) => {
                return (
                  <div key={group.type}>
                    <div className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                      <Icon name={GROUP_ICON[group.type]} size={11} />
                      {t(GROUP_LABEL[group.type])}
                    </div>
                    <div className="space-y-0.5">
                      {group.hits.map((hit, index) => {
                        const flatIndex = start + index;
                        return (
                          <button
                            key={`${hit.type}:${hit.id}`}
                            id={`sv-search-hit-${flatIndex}`}
                            type="button"
                            role="option"
                            aria-selected={flatIndex === active}
                            onMouseEnter={() => setActive(flatIndex)}
                            onClick={() => openHit(hit)}
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                              flatIndex === active ? "bg-brand-soft text-ink" : "hover:bg-raised",
                            )}
                          >
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                              <Icon name={GROUP_ICON[hit.type]} size={14} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium">{hit.title}</span>
                              {hit.subtitle && <span className="block truncate text-[11px] text-muted">{hit.subtitle}</span>}
                            </span>
                            <Icon name="chevronRight" size={13} className="shrink-0 text-muted" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="hidden border-t border-line px-3 py-1.5 text-[10px] text-muted sm:block">
          <span className="mr-3">
            <kbd className="rounded border border-line bg-raised px-1">↑</kbd>{" "}
            <kbd className="rounded border border-line bg-raised px-1">↓</kbd> {t("to move")}
          </span>
          <span className="mr-3">
            <kbd className="rounded border border-line bg-raised px-1">↵</kbd> {t("to open")}
          </span>
          <span>
            <kbd className="rounded border border-line bg-raised px-1">Esc</kbd> {t("to close")}
          </span>
        </div>
      </div>
    </div>
  );
}

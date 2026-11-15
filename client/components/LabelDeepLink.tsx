import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/state";

/**
 * A printed QR label carries the house it was printed for (`?house=hse_…`), so
 * scanning a cabin-shelf label while the app is open on another house still
 * lands on the right inventory. The parameter is consumed once and removed, so
 * a later manual house switch is not overridden. Unknown houses are ignored.
 */
export function useLabelHouseBinding() {
  const { houses, house, selectHouse } = useAuth();
  const [params, setParams] = useSearchParams();
  const wanted = params.get("house");

  useEffect(() => {
    if (!wanted) return;
    // Wait for the house list; an empty list means it has not loaded yet.
    if (houses.length === 0) return;
    // Consume the parameter whether or not the house is known, so a stale
    // `?house=` cannot linger in the URL and switch houses on a later update.
    if (houses.some((entry) => entry.id === wanted) && house?.id !== wanted) selectHouse(wanted);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("house");
        return next;
      },
      { replace: true },
    );
  }, [wanted, houses, house?.id, selectHouse, setParams]);
}

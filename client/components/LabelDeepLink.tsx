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
    if (!houses.some((entry) => entry.id === wanted)) return;
    if (house?.id !== wanted) selectHouse(wanted);
    const next = new URLSearchParams(params);
    next.delete("house");
    setParams(next, { replace: true });
  }, [wanted, houses, house?.id, params, selectHouse, setParams]);
}

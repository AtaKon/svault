import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { ApiError, handler, parseBody, requireHouse } from "../http.js";
import { SEARCH_TYPES, searchHouse } from "../services/search.js";
import type { SearchType } from "../../shared/types.js";

export const searchRoutes = Router();
searchRoutes.use(requireAuth);

const searchQuery = z.object({
  q: z.string().trim().min(2, "Search for at least 2 characters").max(120),
  types: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

function requestedTypes(value: string | undefined): SearchType[] {
  if (!value) return SEARCH_TYPES;
  const types: SearchType[] = [];
  for (const part of value.split(",")) {
    const type = part.trim().toLowerCase();
    if (!type) continue;
    if (!(SEARCH_TYPES as string[]).includes(type)) {
      throw new ApiError(400, "Unknown search type");
    }
    if (!types.includes(type as SearchType)) types.push(type as SearchType);
  }
  return types.length ? types : SEARCH_TYPES;
}

searchRoutes.get(
  "/:houseId/search",
  handler(async (req, res) => {
    // House membership is the only visibility rule these record types have;
    // each query below is additionally scoped to house_id.
    const { houseId } = await requireHouse(req);
    const query = parseBody(searchQuery, req.query);
    const types = requestedTypes(query.types);
    res.json(await searchHouse(houseId, query.q, types, query.limit ?? 6));
  }),
);

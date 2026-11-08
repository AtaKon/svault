import { OFF_API_BASE } from "../../config.js";
import type { OffProjectId, OffProjectInfo, OffProductType } from "../../../shared/types.js";

/**
 * One registry for every Open Food Facts product database.
 *
 * The four projects run the same Product Opener code but expose different
 * fields (nutrition vs. ingredients vs. packaging). Keeping the differences in
 * one typed table stops `if (project === ...)` chains from spreading through
 * the reader, writer and UI.
 *
 * Capability flags are deliberately conservative: a flag is only enabled after
 * the Phase 0 probe or a staging test proves it. See docs/openfoodfacts-spike.md.
 */

export interface OffProjectCapabilities {
  read: boolean;
  write: boolean;
  images: boolean;
  fullTextSearch: boolean;
  structuredSearch: boolean;
  taxonomy: boolean;
  knowledgePanels: boolean;
  robotoff: boolean;
  folksonomy: boolean;
  openPrices: boolean;
  nutripatrol: boolean;
  nutrition: boolean;
  scores: boolean;
}

export interface OffProjectDefinition {
  id: OffProjectId;
  label: string;
  shortLabel: string;
  productType: OffProductType;
  /** Public site, used for links in the UI. */
  site: string;
  /** API origin used for reads and writes. */
  base: string;
  /** Fields that are worth proposing first. */
  highValueFields: string[];
  /** Fields that must never be sent to this project. */
  unsupportedFields: string[];
  /** Local category words that suggest this project when the type is unknown. */
  categoryHints: string[];
  capabilities: OffProjectCapabilities;
}

function envBase(name: string, fallback: string): string {
  const value = String(process.env[name] ?? "").trim();
  return (value || fallback).replace(/\/+$/, "");
}

export const OFF_PROJECTS: Record<OffProjectId, OffProjectDefinition> = {
  off: {
    id: "off",
    label: "Open Food Facts",
    shortLabel: "Food",
    productType: "food",
    site: "https://world.openfoodfacts.org",
    base: envBase("OFF_API_BASE", OFF_API_BASE),
    highValueFields: [
      "name",
      "brand",
      "quantity",
      "categories",
      "ingredients",
      "nutrition",
      "labels",
      "packaging",
      "image_front",
      "image_ingredients",
      "image_nutrition",
    ],
    unsupportedFields: [],
    categoryHints: ["food", "drink", "snack", "dairy", "bakery", "meat", "produce", "beverage"],
    capabilities: {
      read: true,
      write: true,
      images: true,
      fullTextSearch: true,
      structuredSearch: true,
      taxonomy: true,
      knowledgePanels: true,
      robotoff: true,
      folksonomy: true,
      openPrices: true,
      nutripatrol: true,
      nutrition: true,
      scores: true,
    },
  },
  obf: {
    id: "obf",
    label: "Open Beauty Facts",
    shortLabel: "Beauty",
    productType: "beauty",
    site: "https://world.openbeautyfacts.org",
    base: envBase("OFF_BEAUTY_API_BASE", "https://world.openbeautyfacts.org"),
    highValueFields: ["name", "brand", "quantity", "categories", "ingredients", "image_front", "image_ingredients"],
    unsupportedFields: ["nutrition", "nutriscore", "nova", "ecoscore"],
    categoryHints: ["beauty", "cosmetic", "skincare", "shampoo", "soap", "perfume", "makeup", "hygiene"],
    capabilities: {
      read: true,
      write: true,
      images: true,
      fullTextSearch: false,
      structuredSearch: true,
      taxonomy: true,
      knowledgePanels: true,
      robotoff: false,
      folksonomy: false,
      openPrices: false,
      nutripatrol: false,
      nutrition: false,
      scores: false,
    },
  },
  opff: {
    id: "opff",
    label: "Open Pet Food Facts",
    shortLabel: "Pet food",
    productType: "petfood",
    site: "https://world.openpetfoodfacts.org",
    base: envBase("OFF_PETF_API_BASE", "https://world.openpetfoodfacts.org"),
    highValueFields: [
      "name",
      "brand",
      "quantity",
      "categories",
      "ingredients",
      "nutrition",
      "image_front",
      "image_ingredients",
      "image_nutrition",
    ],
    unsupportedFields: ["nutriscore", "nova", "ecoscore"],
    categoryHints: ["pet", "cat", "dog", "kitten", "puppy", "animal", "petfood"],
    capabilities: {
      read: true,
      write: true,
      images: true,
      fullTextSearch: false,
      structuredSearch: true,
      taxonomy: true,
      knowledgePanels: true,
      robotoff: false,
      folksonomy: false,
      openPrices: false,
      nutripatrol: false,
      nutrition: true,
      scores: false,
    },
  },
  opf: {
    id: "opf",
    label: "Open Products Facts",
    shortLabel: "Products",
    productType: "product",
    site: "https://world.openproductsfacts.org",
    base: envBase("OFF_PRODUCTS_API_BASE", "https://world.openproductsfacts.org"),
    highValueFields: ["name", "brand", "quantity", "categories", "packaging", "image_front", "image_ingredients"],
    unsupportedFields: ["nutrition", "nutriscore", "nova", "ecoscore"],
    categoryHints: ["household", "cleaning", "paper", "baby", "pet accessory", "stationery", "product"],
    capabilities: {
      read: true,
      write: true,
      images: true,
      fullTextSearch: false,
      structuredSearch: true,
      taxonomy: true,
      knowledgePanels: true,
      robotoff: false,
      folksonomy: false,
      openPrices: false,
      nutripatrol: false,
      nutrition: false,
      scores: false,
    },
  },
};

export const OFF_PROJECT_IDS = Object.keys(OFF_PROJECTS) as OffProjectId[];

export function isOffProjectId(value: unknown): value is OffProjectId {
  return typeof value === "string" && value in OFF_PROJECTS;
}

export function offProject(id: OffProjectId): OffProjectDefinition {
  return OFF_PROJECTS[id];
}

export function offProjectForProductType(value: unknown): OffProjectId | null {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "food":
      return "off";
    case "beauty":
      return "obf";
    case "petfood":
    case "pet-food":
      return "opff";
    case "product":
      return "opf";
    default:
      return null;
  }
}

export function offProjectForDomain(value: string): OffProjectId | null {
  const host = (() => {
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return String(value ?? "").toLowerCase();
    }
  })();
  if (host.includes("openbeautyfacts")) return "obf";
  if (host.includes("openpetfoodfacts")) return "opff";
  if (host.includes("openproductsfacts")) return "opf";
  if (host.includes("openfoodfacts")) return "off";
  return null;
}

export function offProjectBase(id: OffProjectId): string {
  return OFF_PROJECTS[id].base;
}

export function offProductEndpoint(id: OffProjectId, code: string): string {
  return `${offProjectBase(id)}/api/v3/product/${encodeURIComponent(code)}`;
}

/** Universal lookup: whichever instance owns the barcode answers. */
export function offUniversalEndpoint(code: string): string {
  return `${OFF_PROJECTS.off.base}/api/v3/product/${encodeURIComponent(code)}?product_type=all`;
}

export function offProjectInfo(id: OffProjectId): OffProjectInfo {
  const project = OFF_PROJECTS[id];
  return {
    id: project.id,
    label: project.label,
    shortLabel: project.shortLabel,
    productType: project.productType,
    site: project.site,
    capabilities: { ...project.capabilities },
  };
}

export function offProjectList(): OffProjectInfo[] {
  return OFF_PROJECT_IDS.map(offProjectInfo);
}

export const BILL_TYPE_VALUES = [
  "electricity",
  "water",
  "natural_gas",
  "heating_oil",
  "internet_telecom",
  "rent",
  "building_fees",
  "municipal_fees",
  "insurance",
  "other",
] as const;

export type BillType = (typeof BILL_TYPE_VALUES)[number];

export const BILL_TYPE_LABELS: Record<BillType, string> = {
  electricity: "Electricity",
  water: "Water",
  natural_gas: "Natural gas",
  heating_oil: "Heating oil",
  internet_telecom: "Internet & telecom",
  rent: "Rent",
  building_fees: "Building fees (common charges)",
  municipal_fees: "Municipal fees",
  insurance: "Home insurance",
  other: "Other",
};

import type { LabelKind } from "@shared/label-links";
import { QrSvg } from "@/components/QrCode";
import type { QrMatrix } from "@/qr";

/** One printable label: a QR code plus the little text a shelf needs. */
export interface LabelEntry {
  key: string;
  kind: LabelKind;
  name: string;
  /** Item place, when the item has a batch somewhere. */
  place: string | null;
  /** Item unit, when it helps whoever reads the shelf. */
  unit: string | null;
  /** Absolute deep link encoded in the QR code. */
  url: string;
}

export type LabelPresetId = "small" | "medium" | "a4";

export interface LabelPreset {
  id: LabelPresetId;
  /** English label; the page translates it through t(). */
  label: string;
  widthMm: number;
  heightMm: number;
  paddingMm: number;
  qrMm: number;
  gapMm: number;
  namePt: number;
  metaPt: number;
  housePt: number;
}

export const LABEL_PRESETS: LabelPreset[] = [
  { id: "small", label: "Small · 38 × 25 mm", widthMm: 38, heightMm: 25, paddingMm: 1.2, qrMm: 17, gapMm: 1, namePt: 6.5, metaPt: 4.5, housePt: 4 },
  { id: "medium", label: "Medium · 50 × 30 mm", widthMm: 50, heightMm: 30, paddingMm: 1.5, qrMm: 22, gapMm: 1.4, namePt: 8, metaPt: 5.5, housePt: 4.5 },
  { id: "a4", label: "A4 sheet · 3 × 8 · 70 × 37 mm", widthMm: 70, heightMm: 37, paddingMm: 2, qrMm: 28, gapMm: 2, namePt: 10, metaPt: 6.5, housePt: 5.5 },
];

export const A4_SHEET = { widthMm: 210, heightMm: 297 };

export interface LabelFields {
  name: boolean;
  place: boolean;
  unit: boolean;
  house: boolean;
}

/**
 * Print CSS, scoped by class and only mounted by the labels page. The sheet is
 * portalled to `document.body` so a normal `window.print()` hides the whole app
 * chrome without relying on `visibility` tricks: everything except the sheet is
 * `display: none` while printing.
 */
export const LABEL_STYLES = `
.sv-sheet {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  box-sizing: border-box;
  width: 210mm;
  min-height: 297mm;
  background: #fff;
  color: #111;
}
.sv-label {
  box-sizing: border-box;
  display: flex;
  align-items: stretch;
  background: #fff;
  color: #111;
  overflow: hidden;
  border: 0.15mm dashed #d6d6d6;
  break-inside: avoid;
  page-break-inside: avoid;
}
.sv-label-qr {
  flex: none;
  height: 100%;
}
.sv-label-qr svg {
  display: block;
  width: 100%;
  height: 100%;
}
.sv-label-text {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  flex: 1 1 auto;
  gap: 0.4mm;
  overflow: hidden;
}
.sv-label-name {
  font-weight: 700;
  line-height: 1.1;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow-wrap: anywhere;
}
.sv-label-meta,
.sv-label-house {
  line-height: 1.15;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sv-label-house {
  color: #555;
}
.sv-print-root {
  display: none;
}
@media print {
  @page {
    size: A4;
    margin: 0;
  }
  html,
  body {
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
  }
  body > *:not(.sv-print-root) {
    display: none !important;
  }
  .sv-print-root {
    display: block !important;
  }
  .sv-sheet,
  .sv-label {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`;

export function LabelCard({
  entry,
  preset,
  matrix,
  fields,
  houseName,
}: {
  entry: LabelEntry;
  preset: LabelPreset;
  matrix?: QrMatrix;
  fields: LabelFields;
  houseName: string;
}) {
  const meta = [fields.place ? entry.place : null, fields.unit ? entry.unit : null].filter(Boolean).join(" · ");
  return (
    <div
      className="sv-label"
      style={{
        width: `${preset.widthMm}mm`,
        height: `${preset.heightMm}mm`,
        padding: `${preset.paddingMm}mm`,
        gap: `${preset.gapMm}mm`,
      }}
    >
      <div className="sv-label-qr" style={{ width: `${preset.qrMm}mm` }}>
        {matrix ? <QrSvg matrix={matrix} title={entry.url} /> : null}
      </div>
      <div className="sv-label-text">
        {fields.name && (
          <div className="sv-label-name" style={{ fontSize: `${preset.namePt}pt` }}>
            {entry.name}
          </div>
        )}
        {meta && (
          <div className="sv-label-meta" style={{ fontSize: `${preset.metaPt}pt` }}>
            {meta}
          </div>
        )}
        {fields.house && houseName && (
          <div className="sv-label-house" style={{ fontSize: `${preset.housePt}pt` }}>
            {houseName}
          </div>
        )}
      </div>
    </div>
  );
}

/** A full A4 sheet. Labels flow and break between pages, never inside a label. */
export function LabelSheet({
  entries,
  preset,
  matrices,
  fields,
  houseName,
}: {
  entries: LabelEntry[];
  preset: LabelPreset;
  matrices: Record<string, QrMatrix>;
  fields: LabelFields;
  houseName: string;
}) {
  return (
    <div className="sv-sheet" style={{ width: `${A4_SHEET.widthMm}mm`, minHeight: `${A4_SHEET.heightMm}mm` }}>
      {entries.map((entry) => (
        <LabelCard
          key={entry.key}
          entry={entry}
          preset={preset}
          matrix={matrices[entry.url]}
          fields={fields}
          houseName={houseName}
        />
      ))}
    </div>
  );
}

/** How many labels of this size fit on one A4 sheet. */
export function labelsPerSheet(preset: LabelPreset): number {
  return Math.max(1, Math.floor(A4_SHEET.widthMm / preset.widthMm) * Math.floor(A4_SHEET.heightMm / preset.heightMm));
}

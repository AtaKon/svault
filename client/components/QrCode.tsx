import { useEffect, useMemo, useState } from "react";
import { qrMatrixFor, type QrMatrix } from "@/qr";

/**
 * Inline SVG QR code. The matrix includes the quiet zone, so the white border
 * survives printing on a coloured shelf label.
 */
export function QrSvg({
  matrix,
  title,
  className,
}: {
  matrix: QrMatrix;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      className={className}
      role="img"
      aria-label={title ?? "QR code"}
      shapeRendering="crispEdges"
      focusable="false"
    >
      <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
      <path d={matrix.path} fill="#000000" />
    </svg>
  );
}

/**
 * Encode every value once. The labels page prints a handful of links at a
 * time, so a plain Promise.all keeps this simple and keeps the print button
 * disabled until every QR code is ready.
 */
export function useQrMatrices(values: string[]): {
  matrices: Record<string, QrMatrix>;
  loading: boolean;
  failed: boolean;
} {
  const key = values.join("\n");
  const wanted = useMemo(() => Array.from(new Set(key ? key.split("\n") : [])), [key]);
  const [state, setState] = useState<{ matrices: Record<string, QrMatrix>; loading: boolean; failed: boolean }>({
    matrices: {},
    loading: false,
    failed: false,
  });

  useEffect(() => {
    let live = true;
    if (wanted.length === 0) {
      setState({ matrices: {}, loading: false, failed: false });
      return;
    }
    setState((current) => ({ ...current, loading: true, failed: false }));
    void Promise.all(wanted.map(async (value) => [value, await qrMatrixFor(value)] as const))
      .then((entries) => {
        if (live) setState({ matrices: Object.fromEntries(entries), loading: false, failed: false });
      })
      .catch(() => {
        if (live) setState({ matrices: {}, loading: false, failed: true });
      });
    return () => {
      live = false;
    };
  }, [wanted]);

  return state;
}

import { useState, type PointerEvent } from "react";
import { api } from "@/api";
import { Badge, Button, Field, Input, Sheet, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/toast";
import type { Photo, PhotoLabel } from "@shared/types";
import { useI18n } from "@/i18n";

const SPLITS: Photo["split"][] = ["unassigned", "train", "val", "test"];

export function PhotoViewer({
  photo,
  photos,
  onClose,
  onUpdated,
  onDeleted,
  canEdit,
  onNavigate,
}: {
  photo: Photo;
  photos: Photo[];
  onClose: () => void;
  onUpdated: (photo: Photo) => void;
  onDeleted: (photoId: string) => void;
  canEdit: boolean;
  onNavigate: (photoId: string) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [pending, setPending] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [labelText, setLabelText] = useState("");
  const [busy, setBusy] = useState(false);
  const [labelBusy, setLabelBusy] = useState(false);

  const index = photos.findIndex((entry) => entry.id === photo.id);

  const toLocal = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      rect,
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canEdit) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = toLocal(event);
    setPending(null);
    setDrag({ x1: x, y1: y, x2: x, y2: y });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const { x, y } = toLocal(event);
    setDrag({ ...drag, x2: x, y2: y });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const { x, y } = toLocal(event);
    const nx = Math.min(drag.x1, x);
    const ny = Math.min(drag.y1, y);
    const nw = Math.abs(x - drag.x1);
    const nh = Math.abs(y - drag.y1);
    setDrag(null);
    if (nw < 0.02 || nh < 0.02) {
      setPending(null);
      return;
    }
    setPending({ x: nx, y: ny, w: nw, h: nh });
  };

  const addLabel = async () => {
    if (!labelText.trim()) {
      toast.error(t("Give the label a name first"));
      return;
    }
    setLabelBusy(true);
    try {
      const label = await api<PhotoLabel>(`/api/photos/${photo.id}/labels`, {
        method: "POST",
        body: { label: labelText.trim(), x: pending?.x, y: pending?.y, w: pending?.w, h: pending?.h },
      });
      onUpdated({ ...photo, labels: [...photo.labels, label] });
      setLabelText("");
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not save the label"));
    } finally {
      setLabelBusy(false);
    }
  };

  const removeLabel = async (labelId: string) => {
    try {
      await api(`/api/photos/${photo.id}/labels/${labelId}`, { method: "DELETE" });
      onUpdated({ ...photo, labels: photo.labels.filter((label) => label.id !== labelId) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not remove the label"));
    }
  };

  const setSplit = async (split: Photo["split"]) => {
    try {
      const updated = await api<Photo>(`/api/photos/${photo.id}`, { method: "PATCH", body: { split } });
      onUpdated(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not update the split"));
    }
  };

  const removePhoto = async () => {
    setBusy(true);
    try {
      await api(`/api/photos/${photo.id}`, { method: "DELETE" });
      onDeleted(photo.id);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Could not delete the photo"));
    } finally {
      setBusy(false);
    }
  };

  const box = pending ??
    (drag
      ? {
          x: Math.min(drag.x1, drag.x2),
          y: Math.min(drag.y1, drag.y2),
          w: Math.abs(drag.x2 - drag.x1),
          h: Math.abs(drag.y2 - drag.y1),
        }
      : null);

  return (
    <Sheet
      open
      onClose={onClose}
      wide
      title={photo.originalName}
      description={t(photo.labels.length === 1
        ? "{width} × {height} · {count} label"
        : "{width} × {height} · {count} labels", {
        width: photo.width ?? "?",
        height: photo.height ?? "?",
        count: photo.labels.length,
      })}
      footer={
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" icon="arrowLeft" disabled={index <= 0} onClick={() => onNavigate(photos[index - 1].id)}>
              {t("Prev")}</Button>
            <Button
              size="sm"
              variant="ghost"
              iconRight="chevronRight"
              disabled={index < 0 || index >= photos.length - 1}
              onClick={() => onNavigate(photos[index + 1].id)}
            >
              {t("Next")}</Button>
          </div>
          <div className="flex gap-2">
            {canEdit && (
              <Button variant="ghost" size="sm" icon="trash" className="text-danger hover:bg-danger-soft" loading={busy} onClick={() => void removePhoto()}>
                {t("Delete")}</Button>
            )}
            <Button size="sm" variant="secondary" onClick={onClose}>
              {t("Close")}</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div
          className={cn("relative mx-auto w-full select-none overflow-hidden rounded-xl bg-raised", canEdit && "cursor-crosshair touch-none")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
        >
          <img src={photo.url} alt={photo.originalName} className="block h-auto w-full" draggable={false} />
          {photo.labels.map((label) => {
            if (label.x == null || label.y == null || label.w == null || label.h == null) return null;
            return (
              <div
                key={label.id}
                className="pointer-events-none absolute rounded border-2 border-brand bg-brand/10"
                style={{ left: `${label.x * 100}%`, top: `${label.y * 100}%`, width: `${label.w * 100}%`, height: `${label.h * 100}%` }}
              >
                <span className="absolute -top-5 left-0 rounded bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-brand-ink">
                  {label.label}
                </span>
              </div>
            );
          })}
          {box && (
            <div
              className="pointer-events-none absolute rounded border-2 border-dashed border-white bg-white/10"
              style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
            />
          )}
        </div>

        {canEdit && (
          <>
            <div className="flex items-end gap-2">
              <Field label={pending ? t("Label this box") : t("Add a label / class")} className="flex-1">
                <Input
                  value={labelText}
                  onChange={(event) => setLabelText(event.target.value)}
                  placeholder={t("milk carton, boot, chair…")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void addLabel();
                  }}
                  maxLength={80}
                />
              </Field>
              <Button variant="secondary" loading={labelBusy} onClick={() => void addLabel()} icon={pending ? "check" : "tag"}>
                {pending ? t("Save box") : t("Label")}
              </Button>
            </div>
            <p className="text-[11px] text-muted">
              {pending ? t("A box is selected. Name it and save.") : canEdit ? t("Drag on the photo to draw a bounding box, or add a label without a box for classification.") : ""}
            </p>
          </>
        )}

        {photo.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {photo.labels.map((label) => (
              <span key={label.id} className="inline-flex items-center gap-1.5 rounded-full bg-raised px-2 py-1 text-[11px]">
                {label.label}
                {label.x == null && <span className="text-muted">{t("no box")}</span>}
                {canEdit && (
                  <button onClick={() => void removeLabel(label.id)} aria-label={t("Remove label")} className="text-muted hover:text-danger">
                    <Icon name="close" size={11} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Dataset split")}</div>
          <div className="flex flex-wrap gap-1.5">
            {SPLITS.map((split) => (
              <button
                key={split}
                onClick={() => void setSplit(split)}
                disabled={!canEdit}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                  photo.split === split ? "border-brand/40 bg-brand-soft text-brand" : "border-line bg-surface text-muted hover:text-ink",
                )}
              >
                {t(split)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {photo.labels.length === 0 && <Badge tone="warn">{t("unlabeled")}</Badge>}
          {labelBusy && (
            <span className="flex items-center gap-1.5">
              <Spinner size={11} />
              <span>{t("Saving")}</span>
            </span>
          )}
        </div>
      </div>
    </Sheet>
  );
}

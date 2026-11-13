import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, imageSize, prepareImage, qs } from "@/api";
import { useHouse } from "@/state";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Sheet,
  Skeleton,
  Textarea,
  cn,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { PhotoViewer } from "@/components/PhotoViewer";
import { useToast } from "@/components/toast";
import { qty } from "@/format";
import type { Photo, PhotoCollection } from "@shared/types";

export function PhotosPage() {
  const { t } = useI18n();
  const { house, can } = useHouse();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const collectionId = params.get("collection") ?? "";
  const itemId = params.get("itemId") ?? "";
  const unlabeled = params.get("unlabeled") === "1";

  const [collections, setCollections] = useState<PhotoCollection[] | null>(null);
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [total, setTotal] = useState(0);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [datasetOpen, setDatasetOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [deleteCollectionOpen, setDeleteCollectionOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedCollection = (collections ?? []).find((folder) => folder.id === collectionId) ?? null;

  const loadCollections = useCallback(async () => {
    try {
      const data = await api<PhotoCollection[]>(`/api/houses/${house.id}/collections`);
      setCollections(data);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load folders"));
      setCollections([]);
    }
  }, [house.id, toast]);

  const loadPhotos = useCallback(async (offset = 0) => {
    try {
      const data = await api<{ photos: Photo[]; total: number }>(
        `/api/houses/${house.id}/photos${qs({ collectionId, unlabeled: unlabeled ? 1 : undefined, itemId, limit: 120, offset })}`,
      );
      setPhotos((current) => (offset > 0 ? [...(current ?? []), ...data.photos] : data.photos));
      setTotal(data.total);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load photos"));
      if (offset === 0) setPhotos([]);
    }
  }, [house.id, collectionId, unlabeled, itemId, toast]);

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  useEffect(() => {
    setPhotos(null);
    void loadPhotos();
  }, [loadPhotos]);
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const upload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const list = Array.from(files).slice(0, 30);
    setUploading({ done: 0, total: list.length });
    try {
      const form = new FormData();
      const meta: { width: number | null; height: number | null; originalName: string; capturedAt: string | null }[] = [];
      for (const file of list) {
        const prepared = await prepareImage(file, { maxSize: 2200, quality: 0.92 });
        const size = await imageSize(prepared);
        form.append("photos", prepared);
        meta.push({
          width: size?.width ?? null,
          height: size?.height ?? null,
          originalName: file.name,
          capturedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        });
        setUploading((current) => (current ? { ...current, done: current.done } : current));
      }
      form.append("meta", JSON.stringify(meta));
      if (collectionId) form.append("collectionId", collectionId);
      await api(`/api/houses/${house.id}/photos`, { method: "POST", body: form });
      toast.success(t("{count} photos uploaded", { count: list.length }));
      await Promise.all([loadPhotos(), loadCollections()]);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Upload failed"));
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const createFolder = async (name: string, description: string) => {
    setBusy(true);
    try {
      const folder = await api<PhotoCollection>(`/api/houses/${house.id}/collections`, {
        method: "POST",
        body: { name, description: description || null },
      });
      await loadCollections();
      setFolderOpen(false);
      setParam("collection", folder.id);
      toast.success(t("Folder created"));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not create the folder"));
    } finally {
      setBusy(false);
    }
  };

  const deleteCollection = async () => {
    if (!selectedCollection) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/collections/${selectedCollection.id}`, { method: "DELETE" });
      toast.success(t("Folder deleted"));
      setDeleteCollectionOpen(false);
      setParam("collection", null);
      await Promise.all([loadCollections(), loadPhotos()]);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not delete the folder"));
    } finally {
      setBusy(false);
    }
  };

  const viewerPhoto = photos?.find((photo) => photo.id === viewerId) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/more")}
        eyebrow={t("{count} photos", { count: total })}
        title={t("Photo library")}
        subtitle={t("Folders of photos, labelled for training your own vision models.")}
        actions={
          <>
            <Button
              variant="secondary"
              icon="upload"
              aria-label={t("Import dataset")}
              title={t("Import dataset")}
              onClick={() => setDatasetOpen(true)}
              disabled={!can("member")}
            >
              <span className="hidden sm:inline">{t("Import dataset")}</span>
            </Button>
            <Button
              variant="secondary"
              icon="image"
              aria-label={t("Review")}
              title={t("Review")}
              onClick={() => setReviewOpen(true)}
            >
              <span className="hidden sm:inline">{t("Review")}</span>
            </Button>
            <div className="hidden sm:block">
              <Button variant="secondary" icon="download" onClick={() => setExportOpen(true)}>
                {t("Export")}</Button>
            </div>
            <Button icon="upload" onClick={() => fileRef.current?.click()} loading={Boolean(uploading)}>
              {t("Upload")}</Button>
          </>
        }
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => void upload(event.target.files)}
      />

      {uploading && (
        <Card className="p-3">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>{t("Preparing and uploading")} {uploading.total} {t("photos…")}</span>
            <span>{t("keep the app open")}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
          </div>
        </Card>
      )}

      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <button
          onClick={() => {
            const next = new URLSearchParams(params);
            next.delete("collection");
            next.delete("unlabeled");
            setParams(next, { replace: true });
          }}
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
            !collectionId ? "border-brand/40 bg-brand-soft" : "border-line bg-surface hover:bg-raised",
          )}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-brand">
            <Icon name="grid" size={16} />
          </span>
          <span>
            <span className="block text-[12px] font-medium">{t("All photos")}</span>
            <span className="block text-[10px] text-muted">{qty(collections?.reduce((sum, folder) => sum + folder.photoCount, 0) ?? 0)}</span>
          </span>
        </button>
        {(collections ?? []).map((folder) => (
          <button
            key={folder.id}
            onClick={() => setParam("collection", folder.id)}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
              collectionId === folder.id ? "border-brand/40 bg-brand-soft" : "border-line bg-surface hover:bg-raised",
            )}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-muted">
              <Icon name="folder" size={16} />
            </span>
            <span className="max-w-[140px]">
              <span className="block truncate text-[12px] font-medium">{folder.name}</span>
              <span className="block text-[10px] text-muted">
                {qty(folder.photoCount)} · {qty(folder.labeledCount)} {t("labelled")}</span>
            </span>
          </button>
        ))}
        <button
          onClick={() => setFolderOpen(true)}
          className="flex shrink-0 items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-left text-muted transition-colors hover:text-ink"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface">
            <Icon name="plus" size={16} />
          </span>
          <span className="text-[12px] font-medium">{t("New folder")}</span>
        </button>
      </div>

      {collectionId && selectedCollection && (
        <Card className="flex items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{selectedCollection.name}</span>
              <Badge tone="neutral">{qty(selectedCollection.photoCount)} {t("photos")}</Badge>
            </div>
            <div className="text-[11px] text-muted">{selectedCollection.description || t("No description")}</div>
          </div>
          {can("member") && (
            <IconButton icon="trash" label={t("Delete folder")} onClick={() => setDeleteCollectionOpen(true)} className="hover:text-danger" />
          )}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setParam("unlabeled", unlabeled ? null : "1")}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
            unlabeled ? "border-warn/40 bg-warn-soft text-warn" : "border-line bg-surface text-muted hover:text-ink",
          )}
        >
          {t("Unlabelled only")}</button>
        {itemId && (
          <button onClick={() => setParam("itemId", null)} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
            {t("Linked to item")} <Icon name="close" size={11} />
          </button>
        )}
        <span className="ml-auto text-[11px] text-muted">{photos ? t("{count} shown", { count: photos.length }) : ""}</span>
      </div>

      {!photos ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, index) => (
            <Skeleton key={index} className="aspect-square" />
          ))}
        </div>
      ) : photos.length === 0 ? (
        <EmptyState
          icon="image"
          title={t("No photos here yet")}
          body={t("Upload photos of your shelves, products or rooms. Draw boxes and name them, then export a YOLO or COCO dataset.")}
          action={
            <Button icon="upload" onClick={() => fileRef.current?.click()}>
              {t("Upload photos")}</Button>
          }
        />
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {photos.map((photo) => (
            <button
              key={photo.id}
              onClick={() => setViewerId(photo.id)}
              className="group relative aspect-square overflow-hidden rounded-xl border border-line bg-raised"
            >
              <img src={photo.url} alt={photo.originalName} loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1.5 pt-4 text-[10px] text-white">
                <span className="truncate">{photo.labels[0]?.label ?? t("unlabeled")}</span>
                {photo.labels.length > 0 && <span>{photo.labels.length}</span>}
              </div>
              {photo.split !== "unassigned" && (
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[9px] font-semibold uppercase text-white">
                  {t(photo.split)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {photos && photos.length < total && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            loading={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              await loadPhotos(photos.length);
              setLoadingMore(false);
            }}
          >
            {t("Load more ·")} {total - photos.length} {t("left")}</Button>
        </div>
      )}

      <Card className="flex items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="image" size={17} />
        </span>
        <div className="text-[11px] leading-relaxed text-muted">
          {t("Every label becomes a class in the export. Boxes are written as normalized YOLO coordinates and as COCO annotations, together with train/val/test splits,")} <code>data.yaml</code> {t("and a manifest. Photos without boxes still export as classification samples.")}<div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" icon="download" onClick={() => setExportOpen(true)}>
              {t("Export dataset")}</Button>
          </div>
        </div>
      </Card>

      {viewerPhoto && (
        <PhotoViewer
          photo={viewerPhoto}
          photos={photos ?? []}
          onClose={() => setViewerId(null)}
          canEdit={can("member")}
          onNavigate={(id) => setViewerId(id)}
          onUpdated={(updated) => {
            setPhotos((current) => current?.map((photo) => (photo.id === updated.id ? updated : photo)) ?? current);
            void loadCollections();
          }}
          onDeleted={(photoId) => {
            setPhotos((current) => current?.filter((photo) => photo.id !== photoId) ?? current);
            setTotal((current) => Math.max(0, current - 1));
            void loadCollections();
          }}
        />
      )}

      <NewFolderSheet open={folderOpen} onClose={() => setFolderOpen(false)} busy={busy} onCreate={createFolder} />

      <Sheet
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title={t("Export training dataset")}
        description={selectedCollection ? selectedCollection.name : t("All photos in this house")}
        footer={
          <Button variant="secondary" block onClick={() => setExportOpen(false)}>
            {t("Done")}</Button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {t("Download a zip with the images, labels, class list, splits and a manifest. Use it directly with YOLOv8/Ultralytics or COCO-based tooling.")}</p>
          <a
            href={`/api/houses/${house.id}/photos/export${qs({ format: "yolo", collectionId })}`}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 transition-colors hover:bg-raised"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <Icon name="download" size={18} />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-medium">{t("YOLO dataset")}</span>
              <span className="block text-[11px] text-muted">{"images/ + labels/ by split, data.yaml, classes.txt"}</span>
            </span>
            <Icon name="arrowUpRight" size={16} className="text-muted" />
          </a>
          <a
            href={`/api/houses/${house.id}/photos/export${qs({ format: "coco", collectionId })}`}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 transition-colors hover:bg-raised"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-muted">
              <Icon name="download" size={18} />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-medium">{t("COCO dataset")}</span>
              <span className="block text-[11px] text-muted">{t("annotations.coco.json with absolute boxes")}</span>
            </span>
            <Icon name="arrowUpRight" size={16} className="text-muted" />
          </a>
          <p className="text-[11px] text-muted">
            {t("Only photos with bounding boxes produce YOLO label rows. Add boxes by opening a photo and dragging on it.")}</p>
        </div>
      </Sheet>

      <ConfirmDialog
        open={deleteCollectionOpen}
        onClose={() => setDeleteCollectionOpen(false)}
        onConfirm={() => void deleteCollection()}
        title={t("Delete {name}?", { name: selectedCollection?.name ?? t("folder") })}
        body={t("Photos stay in the library but are no longer in this folder.")}
        confirmLabel={t("Delete folder")}
        loading={busy}
      />

      <DatasetImportSheet
        open={datasetOpen}
        houseId={house.id}
        onClose={() => setDatasetOpen(false)}
        onImported={async () => {
          setDatasetOpen(false);
          await Promise.all([loadPhotos(), loadCollections()]);
        }}
      />

      <LabelReviewSheet
        open={reviewOpen}
        houseId={house.id}
        canDelete={can("admin")}
        onClose={() => setReviewOpen(false)}
        onChanged={() => void Promise.all([loadPhotos(), loadCollections()])}
      />
    </div>
  );
}

function NewFolderSheet({
  open,
  onClose,
  busy,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  busy: boolean;
  onCreate: (name: string, description: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("New photo folder")}
      description={t("Group a shelf, a product type or a room.")}
      footer={
        <Button block loading={busy} disabled={!name.trim()} onClick={() => void onCreate(name, description)}>
          {t("Create folder")}</Button>
      }
    >
      <div className="space-y-3">
        <Field label={t("Folder name")} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Fridge shelf 2, boots, pantry jars…")} autoFocus maxLength={80} />
        </Field>
        <Field label={t("Description")} hint={t("optional")}>
          <Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
        </Field>
      </div>
    </Sheet>
  );
}

interface DatasetPreview {
  kind: "yolo" | "coco";
  classes: string[];
  splits: Record<string, number>;
  labelled: number;
  total: number;
  errors: string[];
  files: { path: string; name: string; split: string; labels: number }[];
}

function DatasetImportSheet({
  open,
  houseId,
  onClose,
  onImported,
}: {
  open: boolean;
  houseId: string;
  onClose: () => void;
  onImported: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [collectionName, setCollectionName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPreview(null);
    setMapping({});
    setCollectionName("");
  }, [open]);

  const inspect = async (next: File | null) => {
    if (!next) return;
    setFile(next);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("dataset", next);
      const data = await api<DatasetPreview>(`/api/houses/${houseId}/photos/dataset/preview`, {
        method: "POST",
        body: form,
      });
      setPreview(data);
      setMapping(Object.fromEntries(data.classes.map((name) => [name, name])));
      toast.success(t("Read {total} images ({labelled} labelled)", { total: data.total, labelled: data.labelled }));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not read the dataset"));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const importNow = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("dataset", file);
      form.append("mapping", JSON.stringify(mapping));
      form.append("collectionName", collectionName.trim() || t("Imported dataset"));
      const result = await api<{ imported: number; skipped: number; labels: number; errors: { file: string; error: string }[] }>(
        `/api/houses/${houseId}/photos/dataset/import`,
        { method: "POST", body: form },
      );
      toast.success(t("Imported {photos} photos and {labels} labels", { photos: result.imported, labels: result.labels }));
      if (result.errors.length) toast.push(t("{count} files were skipped", { count: result.errors.length }));
      await onImported();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not import the dataset"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      wide
      title={t("Import a YOLO or COCO dataset")}
      description={t("Preserve boxes and splits, then map imported class names to your labels.")}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("Cancel")}</Button>
          <Button onClick={() => void importNow()} loading={busy} disabled={!preview || !preview.total}>
            {t("Import dataset")}</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-line bg-surface p-3 transition-colors hover:bg-raised">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
            <Icon name="upload" size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{file?.name ?? t("Choose a dataset zip")}</span>
            <span className="block text-[11px] text-muted">{"images + labels/classes.txt/data.yaml, or images + annotations.json"}</span>
          </span>
          <input type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => void inspect(event.target.files?.[0] ?? null)} />
        </label>

        {preview && (
          <>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <Badge tone="brand">{preview.kind.toUpperCase()}</Badge>
              <Badge tone="outline">{preview.total} {t("images")}</Badge>
              <Badge tone="outline">{preview.labelled} {t("labelled")}</Badge>
              <Badge tone="outline">{t("train ")}{' '}{preview.splits.train ?? 0}</Badge>
              <Badge tone="outline">{t("val ")}{' '}{preview.splits.val ?? 0}</Badge>
              <Badge tone="outline">{t("test ")}{' '}{preview.splits.test ?? 0}</Badge>
              <Badge tone="outline">{t("unassigned ")}{' '}{preview.splits.unassigned ?? 0}</Badge>
            </div>
            {preview.errors.length > 0 && (
              <div className="rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-[11px] text-warn">
                {preview.errors.slice(0, 3).map((message) => t(message)).join(" · ")}
                {preview.errors.length > 3 ? t(" · +{count} more", { count: preview.errors.length - 3 }) : ""}
              </div>
            )}
            <Field label={t("Folder name")}>
              <Input value={collectionName || t("Imported dataset")} onChange={(event) => setCollectionName(event.target.value)} maxLength={80} />
            </Field>
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Class mapping")}</div>
              <div className="space-y-1.5">
                {preview.classes.map((name) => (
                  <div key={name} className="flex items-center gap-2">
                    <span className="w-1/2 truncate text-[12px]">{name}</span>
                    <Input
                      value={mapping[name] ?? ""}
                      onChange={(event) => setMapping((current) => ({ ...current, [name]: event.target.value }))}
                      placeholder={t("target label or __skip")}
                      className="h-9 flex-1 text-[12px]"
                    />
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-muted">{t("Use")} <code>__skip</code> {t("to drop a class.")}</p>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

interface ReviewPhoto extends Photo {
  labelCount: number;
  boxCount: number;
  reason: "unlabeled" | "classification-only" | "boxes";
}

function LabelReviewSheet({
  open,
  houseId,
  canDelete,
  onClose,
  onChanged,
}: {
  open: boolean;
  houseId: string;
  canDelete: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [photos, setPhotos] = useState<ReviewPhoto[]>([]);
  const [index, setIndex] = useState(0);
  const [labels, setLabels] = useState<{ label: string; count: number }[]>([]);
  const [rename, setRename] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [review, labelList] = await Promise.all([
        api<{ photos: ReviewPhoto[] }>(`/api/houses/${houseId}/photos/review`),
        api<{ label: string; count: number }[]>(`/api/houses/${houseId}/labels`),
      ]);
      setPhotos(review.photos);
      setLabels(labelList);
      setIndex((current) => Math.min(current, Math.max(0, review.photos.length - 1)));
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not load the review queue"));
    }
  }, [houseId, toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const current = photos[index] ?? null;

  const setSplit = async (split: "unassigned" | "train" | "val" | "test") => {
    if (!current) return;
    await api(`/api/photos/${current.id}`, { method: "PATCH", body: { split } });
    setPhotos((rows) => rows.map((row) => (row.id === current.id ? { ...row, split } : row)));
    onChanged();
  };

  const deleteCurrent = async () => {
    if (!current || !canDelete) return;
    await api(`/api/houses/${houseId}/photos/delete-bulk`, { method: "POST", body: { photoIds: [current.id] } });
    setPhotos((rows) => rows.filter((row) => row.id !== current.id));
    setIndex((value) => Math.max(0, Math.min(value, photos.length - 2)));
    onChanged();
    toast.success(t("Photo deleted"));
  };

  const bulkLabel = async (action: "rename" | "merge" | "delete") => {
    if (!rename.trim() && action !== "delete") return;
    setBusy(true);
    try {
      const result = await api<{ affected: number }>(`/api/houses/${houseId}/photos/labels/bulk`, {
        method: "POST",
        body: { action, from: rename.trim(), to: target.trim() || undefined },
      });
      toast.success(
        result.affected === 1
          ? t("{count} label updated", { count: result.affected })
          : t("{count} labels updated", { count: result.affected }),
      );
      setRename("");
      setTarget("");
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Could not update labels"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === "ArrowRight") setIndex((value) => Math.min(value + 1, photos.length - 1));
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(0, value - 1));
      if (event.key.toLowerCase() === "d" && canDelete) void deleteCurrent();
      if (event.key.toLowerCase() === "s" && current) {
        const order = ["unassigned", "train", "val", "test"] as const;
        void setSplit(order[(order.indexOf(current.split as any) + 1) % order.length]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Sheet open={open} onClose={onClose} wide title={t("Review labels")} description={t("← → move · S changes split · D deletes (owner/admin)")}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 text-[11px]">
          <Badge tone="danger">{photos.filter((photo) => photo.reason === "unlabeled").length} {t("unlabeled")}</Badge>
          <Badge tone="warn">{photos.filter((photo) => photo.reason === "classification-only").length} {t("classification only")}</Badge>
          <Badge tone="outline">{photos.length} {t("in queue")}</Badge>
        </div>

        {current ? (
          <div className="grid gap-4 sm:grid-cols-[1.2fr_1fr]">
            <div className="overflow-hidden rounded-xl border border-line bg-raised">
              <img src={current.url} alt={current.originalName} className="max-h-[420px] w-full object-contain" />
            </div>
            <div className="space-y-3">
              <div>
                <div className="truncate text-sm font-medium">{current.originalName}</div>
                <div className="text-[11px] text-muted">
                  {current.labelCount} {t("labels ·")} {current.boxCount} {t("boxes ·")} {t(current.split)}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {current.labels.map((label) => (
                  <Badge key={label.id} tone={label.w !== null ? "brand" : "warn"}>
                    {label.label}
                  </Badge>
                ))}
                {!current.labels.length && <Badge tone="danger">{t("No labels")}</Badge>}
              </div>
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Split")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {(["unassigned", "train", "val", "test"] as const).map((split) => (
                    <Button key={split} size="sm" variant={current.split === split ? "primary" : "secondary"} onClick={() => void setSplit(split)}>
                      {t(split)}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setIndex((value) => Math.max(0, value - 1))} disabled={index === 0}>
                  {t("Previous")}</Button>
                <Button size="sm" variant="secondary" onClick={() => setIndex((value) => Math.min(value + 1, photos.length - 1))} disabled={index >= photos.length - 1}>
                  {t("Next")}</Button>
                {canDelete && (
                  <Button size="sm" variant="danger" onClick={() => void deleteCurrent()}>
                    {t("Delete photo")}</Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
            {t("Nothing to review. Every photo has a label.")}</div>
        )}

        <div className="rounded-xl border border-line p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t("Bulk label actions")}</div>
          <div className="space-y-2">
            <select
              value={rename}
              onChange={(event) => setRename(event.target.value)}
              className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-[12px]"
            >
              <option value="">{t("Choose a label…")}</option>
              {labels.map((entry) => (
                <option key={entry.label} value={entry.label}>
                  {entry.label} ({entry.count})
                </option>
              ))}
            </select>
            <Input value={target} onChange={(event) => setTarget(event.target.value)} placeholder={t("Rename/merge target")} className="h-9 text-[12px]" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={busy} disabled={!rename.trim() || !target.trim()} onClick={() => void bulkLabel("rename")}>
                {t("Rename")}</Button>
              <Button size="sm" variant="secondary" loading={busy} disabled={!rename.trim() || !target.trim()} onClick={() => void bulkLabel("merge")}>
                {t("Merge")}</Button>
              <Button size="sm" variant="danger" loading={busy} disabled={!rename.trim()} onClick={() => void bulkLabel("delete")}>
                {t("Delete label")}</Button>
            </div>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

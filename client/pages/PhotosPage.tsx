import { useCallback, useEffect, useRef, useState } from "react";
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
import { plural, qty } from "@/format";
import type { Photo, PhotoCollection } from "@shared/types";

export function PhotosPage() {
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
  const [deleteCollectionOpen, setDeleteCollectionOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedCollection = (collections ?? []).find((folder) => folder.id === collectionId) ?? null;

  const loadCollections = useCallback(async () => {
    try {
      const data = await api<PhotoCollection[]>(`/api/houses/${house.id}/collections`);
      setCollections(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load folders");
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
      toast.error(err instanceof Error ? err.message : "Could not load photos");
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
      toast.success(`${plural(list.length, "photo")} uploaded`);
      await Promise.all([loadPhotos(), loadCollections()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
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
      toast.success("Folder created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the folder");
    } finally {
      setBusy(false);
    }
  };

  const deleteCollection = async () => {
    if (!selectedCollection) return;
    setBusy(true);
    try {
      await api(`/api/houses/${house.id}/collections/${selectedCollection.id}`, { method: "DELETE" });
      toast.success("Folder deleted");
      setDeleteCollectionOpen(false);
      setParam("collection", null);
      await Promise.all([loadCollections(), loadPhotos()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete the folder");
    } finally {
      setBusy(false);
    }
  };

  const viewerPhoto = photos?.find((photo) => photo.id === viewerId) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        back={() => navigate("/more")}
        eyebrow={`${qty(total)} photos`}
        title="Photo library"
        subtitle="Folders of photos, labelled for training your own vision models."
        actions={
          <>
            <div className="hidden sm:block">
              <Button variant="secondary" icon="download" onClick={() => setExportOpen(true)}>
                Export
              </Button>
            </div>
            <Button icon="upload" onClick={() => fileRef.current?.click()} loading={Boolean(uploading)}>
              Upload
            </Button>
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
            <span>Preparing and uploading {uploading.total} photos…</span>
            <span>keep the app open</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
          </div>
        </Card>
      )}

      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <button
          onClick={() => {
            setParam("collection", null);
            setParam("unlabeled", null);
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
            <span className="block text-[12px] font-medium">All photos</span>
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
                {qty(folder.photoCount)} · {qty(folder.labeledCount)} labelled
              </span>
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
          <span className="text-[12px] font-medium">New folder</span>
        </button>
      </div>

      {collectionId && selectedCollection && (
        <Card className="flex items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{selectedCollection.name}</span>
              <Badge tone="neutral">{qty(selectedCollection.photoCount)} photos</Badge>
            </div>
            <div className="text-[11px] text-muted">{selectedCollection.description || "No description"}</div>
          </div>
          {can("member") && (
            <IconButton icon="trash" label="Delete folder" onClick={() => setDeleteCollectionOpen(true)} className="hover:text-danger" />
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
          Unlabelled only
        </button>
        {itemId && (
          <button onClick={() => setParam("itemId", null)} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
            Linked to item <Icon name="close" size={11} />
          </button>
        )}
        <span className="ml-auto text-[11px] text-muted">{photos ? `${photos.length} shown` : ""}</span>
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
          title="No photos here yet"
          body="Upload photos of your shelves, products or rooms. Draw boxes and name them, then export a YOLO or COCO dataset."
          action={
            <Button icon="upload" onClick={() => fileRef.current?.click()}>
              Upload photos
            </Button>
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
                <span className="truncate">{photo.labels[0]?.label ?? "unlabeled"}</span>
                {photo.labels.length > 0 && <span>{photo.labels.length}</span>}
              </div>
              {photo.split !== "unassigned" && (
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 py-0.5 text-[9px] font-semibold uppercase text-white">
                  {photo.split}
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
            Load more · {total - photos.length} left
          </Button>
        </div>
      )}

      <Card className="flex items-start gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon name="image" size={17} />
        </span>
        <div className="text-[11px] leading-relaxed text-muted">
          Every label becomes a class in the export. Boxes are written as normalized YOLO coordinates and as COCO
          annotations, together with train/val/test splits, <code>data.yaml</code> and a manifest. Photos without boxes
          still export as classification samples.
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" icon="download" onClick={() => setExportOpen(true)}>
              Export dataset
            </Button>
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
        title="Export training dataset"
        description={selectedCollection ? selectedCollection.name : "All photos in this house"}
        footer={
          <Button variant="secondary" block onClick={() => setExportOpen(false)}>
            Done
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Download a zip with the images, labels, class list, splits and a manifest. Use it directly with
            YOLOv8/Ultralytics or COCO-based tooling.
          </p>
          <a
            href={`/api/houses/${house.id}/photos/export${qs({ format: "yolo", collectionId })}`}
            className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 transition-colors hover:bg-raised"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <Icon name="download" size={18} />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-medium">YOLO dataset</span>
              <span className="block text-[11px] text-muted">images/ + labels/ by split, data.yaml, classes.txt</span>
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
              <span className="block text-sm font-medium">COCO dataset</span>
              <span className="block text-[11px] text-muted">annotations.coco.json with absolute boxes</span>
            </span>
            <Icon name="arrowUpRight" size={16} className="text-muted" />
          </a>
          <p className="text-[11px] text-muted">
            Only photos with bounding boxes produce YOLO label rows. Add boxes by opening a photo and dragging on it.
          </p>
        </div>
      </Sheet>

      <ConfirmDialog
        open={deleteCollectionOpen}
        onClose={() => setDeleteCollectionOpen(false)}
        onConfirm={() => void deleteCollection()}
        title={`Delete ${selectedCollection?.name ?? "folder"}?`}
        body="Photos stay in the library but are no longer in this folder."
        confirmLabel="Delete folder"
        loading={busy}
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
      title="New photo folder"
      description="Group a shelf, a product type or a room."
      footer={
        <Button block loading={busy} disabled={!name.trim()} onClick={() => void onCreate(name, description)}>
          Create folder
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Folder name" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Fridge shelf 2, boots, pantry jars…" autoFocus maxLength={80} />
        </Field>
        <Field label="Description" hint="optional">
          <Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
        </Field>
      </div>
    </Sheet>
  );
}

import { type Attachment, ATTACHMENT_LIMITS, PREVIEWABLE_IMAGE_TYPES } from "@my-ai-slaves/shared";
import {
  AlertCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileIcon,
  Loader2Icon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/** One file in the tray: uploading, uploaded (has `attachment`) or failed. */
export interface PendingFile {
  key: string;
  name: string;
  size: number;
  /** Local preview for images, revoked when removed. */
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  attachment: Attachment | null;
  error: string | null;
}

let counter = 0;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Upload-as-you-attach. Paste (⌘V an image or file), drop, or pick files; each one uploads right
 * away so sending is instant. `ids` are the uploaded attachment ids to send with the message.
 */
export function useAttachments() {
  const [files, setFiles] = useState<PendingFile[]>([]);

  const add = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    setFiles((current) => {
      const room = ATTACHMENT_LIMITS.maxFiles - current.length;
      if (room <= 0) return current;
      const accepted = incoming.slice(0, room);

      const next = accepted.map((file): PendingFile => {
        const key = `f${++counter}`;
        const tooBig = file.size > ATTACHMENT_LIMITS.maxBytes;
        const pending: PendingFile = {
          key,
          name: file.name || "pasted-image.png",
          size: file.size,
          previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
          status: tooBig ? "error" : "uploading",
          attachment: null,
          error: tooBig ? "Larger than 20 MB" : null,
        };
        if (!tooBig) {
          api
            .uploadAttachment(file)
            .then((attachment) =>
              setFiles((list) => list.map((f) => (f.key === key ? { ...f, status: "ready", attachment } : f))),
            )
            .catch((e: unknown) =>
              setFiles((list) =>
                list.map((f) =>
                  f.key === key ? { ...f, status: "error", error: e instanceof Error ? e.message : String(e) } : f,
                ),
              ),
            );
        }
        return pending;
      });
      return [...current, ...next];
    });
  }, []);

  const remove = useCallback((key: string) => {
    setFiles((list) => {
      const gone = list.find((f) => f.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return list.filter((f) => f.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    setFiles((list) => {
      for (const f of list) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      return [];
    });
  }, []);

  /** Attach pasted files/images; plain-text pastes go through untouched. */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const pasted = Array.from(e.clipboardData.files);
      if (pasted.length === 0) return;
      e.preventDefault();
      add(pasted.map((f, i) => (f.name ? f : new File([f], `pasted-image-${i + 1}.png`, { type: f.type }))));
    },
    [add],
  );

  return {
    files,
    add,
    remove,
    clear,
    onPaste,
    ids: files.filter((f) => f.status === "ready" && f.attachment).map((f) => (f.attachment as Attachment).id),
    uploading: files.some((f) => f.status === "uploading"),
    failed: files.some((f) => f.status === "error"),
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

/** Wraps an input area: highlights while files are dragged over it and attaches dropped files. */
export function DropZone({
  attachments,
  className,
  children,
}: {
  attachments: AttachmentsState;
  className?: string;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        attachments.add(Array.from(e.dataTransfer.files));
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-signal/60 bg-signal-soft/80 text-[13px] font-medium text-signal-ink">
          Drop to attach
        </div>
      )}
    </div>
  );
}

/** Paperclip button that opens the file picker. */
export function AttachButton({ attachments, disabled }: { attachments: AttachmentsState; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        title="Attach files (or paste / drop them)"
        aria-label="Attach files"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon />
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          attachments.add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </>
  );
}

/** Chips for the files being attached to a message, with image thumbnails. */
export function AttachmentTray({ attachments }: { attachments: AttachmentsState }) {
  const [viewing, setViewing] = useState<string | null>(null);
  if (attachments.files.length === 0) return null;
  const images = attachments.files
    .filter((f) => f.previewUrl)
    .map((f) => ({ key: f.key, src: f.previewUrl as string, name: f.name, size: f.size }));
  const viewIndex = images.findIndex((i) => i.key === viewing);
  return (
    <>
      <ImageViewer images={images} index={viewIndex} onIndex={(i) => setViewing(images[i]?.key ?? null)} />
      <ul className="flex flex-wrap gap-1.5" aria-label="Attached files">
        {attachments.files.map((f) => (
          <li
            key={f.key}
            title={f.error ?? f.name}
            className={cn(
              "group flex h-9 max-w-56 items-center gap-2 rounded-md border bg-surface pr-1 pl-1 text-xs",
              f.status === "error" ? "border-danger/50 text-danger-ink" : "border-rule text-ink-2",
            )}
          >
            <span className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-paper-2">
              {f.previewUrl ? (
                <button
                  type="button"
                  aria-label={`View ${f.name}`}
                  title={`View ${f.name}`}
                  onClick={() => setViewing(f.key)}
                  className="size-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
                >
                  <img src={f.previewUrl} alt="" className="size-full object-cover" />
                </button>
              ) : (
                <FileIcon className="size-3.5 text-muted-foreground" />
              )}
              {f.status === "uploading" && (
                <span className="absolute inset-0 flex items-center justify-center bg-surface/70">
                  <Loader2Icon className="size-3.5 animate-spin text-ink-2" />
                </span>
              )}
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate font-medium">{f.name}</span>
              <span className="num text-[10px] text-muted-foreground">
                {f.status === "error" ? (
                  <span className="inline-flex items-center gap-0.5 text-danger-ink">
                    <AlertCircleIcon className="size-2.5" /> {f.error}
                  </span>
                ) : f.status === "uploading" ? (
                  "Uploading…"
                ) : (
                  formatBytes(f.size)
                )}
              </span>
            </span>
            <button
              type="button"
              aria-label={`Remove ${f.name}`}
              onClick={() => attachments.remove(f.key)}
              className="ml-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
            >
              <XIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Read-only list of files already sent with a task or reply. Images open in the in-app viewer. */
export function AttachmentList({ files, className }: { files: Attachment[]; className?: string }) {
  const [viewing, setViewing] = useState<string | null>(null);
  if (files.length === 0) return null;
  const images = files
    .filter((a) => PREVIEWABLE_IMAGE_TYPES.includes(a.mime))
    .map((a) => ({ key: a.id, src: `/api/attachments/${a.id}`, name: a.name, size: a.size }));
  const viewIndex = images.findIndex((i) => i.key === viewing);
  return (
    <>
      <ImageViewer images={images} index={viewIndex} onIndex={(i) => setViewing(images[i]?.key ?? null)} />
      <ul className={cn("flex flex-wrap gap-1.5", className)}>
        {files.map((a) => {
          const image = PREVIEWABLE_IMAGE_TYPES.includes(a.mime);
          return (
            <li key={a.id}>
              {image ? (
                <button
                  type="button"
                  onClick={() => setViewing(a.id)}
                  aria-label={`View ${a.name}`}
                  title={`${a.name} · ${formatBytes(a.size)}`}
                  className="block size-14 cursor-zoom-in overflow-hidden rounded-md border border-rule bg-paper-2 transition-colors hover:border-rule-strong focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
                >
                  <img src={`/api/attachments/${a.id}`} alt={a.name} className="size-full object-cover" />
                </button>
              ) : (
                <span
                  title={a.name}
                  className="flex h-8 max-w-56 items-center gap-1.5 rounded-md border border-rule bg-surface px-2 text-xs text-ink-2"
                >
                  <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{a.name}</span>
                  <span className="num shrink-0 text-[10px] text-muted-foreground">{formatBytes(a.size)}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export interface ViewerImage {
  key: string;
  src: string;
  name: string;
  size: number;
}

/**
 * Full-size view of an attached image, inside the app (a new tab would leave the desktop app).
 * ← / → step through the other images of the same message; Esc or a click outside closes it.
 */
export function ImageViewer({
  images,
  index,
  onIndex,
}: {
  images: ViewerImage[];
  /** -1 = closed. */
  index: number;
  onIndex: (index: number) => void;
}) {
  const image = images[index];
  const many = images.length > 1;
  const step = (by: number) => onIndex((index + by + images.length) % images.length);
  return (
    <DialogPrimitive.Root open={Boolean(image)} onOpenChange={(open) => !open && onIndex(-1)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (!many) return;
            if (e.key === "ArrowRight") step(1);
            else if (e.key === "ArrowLeft") step(-1);
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onIndex(-1);
          }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-6 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          {image && (
            <>
              <img
                src={image.src}
                alt={image.name}
                className="max-h-[calc(100vh-7rem)] max-w-full rounded-md object-contain shadow-float"
              />
              <div className="flex max-w-full items-center gap-2 text-xs text-white/80">
                <DialogPrimitive.Title className="truncate font-medium text-white">{image.name}</DialogPrimitive.Title>
                <span className="num shrink-0">{formatBytes(image.size)}</span>
                {many && (
                  <span className="num shrink-0">
                    · {index + 1} / {images.length}
                  </span>
                )}
              </div>
              {many && (
                <>
                  <button
                    type="button"
                    aria-label="Previous image"
                    onClick={() => step(-1)}
                    className="absolute top-1/2 left-4 flex size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
                  >
                    <ChevronLeftIcon className="size-5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Next image"
                    onClick={() => step(1)}
                    className="absolute top-1/2 right-4 flex size-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
                  >
                    <ChevronRightIcon className="size-5" />
                  </button>
                </>
              )}
              <DialogPrimitive.Close className="absolute top-4 right-4 flex size-9 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]">
                <XIcon className="size-4" />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

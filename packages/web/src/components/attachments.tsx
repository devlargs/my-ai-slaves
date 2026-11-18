import { type Attachment, ATTACHMENT_LIMITS, PREVIEWABLE_IMAGE_TYPES } from "@my-ai-slaves/shared";
import { AlertCircleIcon, FileIcon, Loader2Icon, PaperclipIcon, XIcon } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from "react";
import { toast } from "sonner";
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
      if (room <= 0) {
        toast.error(`Attach at most ${ATTACHMENT_LIMITS.maxFiles} files.`);
        return current;
      }
      const accepted = incoming.slice(0, room);
      if (accepted.length < incoming.length) toast.error(`Only the first ${room} file(s) were added.`);

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
  if (attachments.files.length === 0) return null;
  return (
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
              <img src={f.previewUrl} alt="" className="size-full object-cover" />
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
  );
}

/** Read-only list of files already sent with a task or reply. Images show a server-side preview. */
export function AttachmentList({ files, className }: { files: Attachment[]; className?: string }) {
  if (files.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)}>
      {files.map((a) => {
        const image = PREVIEWABLE_IMAGE_TYPES.includes(a.mime);
        return (
          <li key={a.id}>
            {image ? (
              <a
                href={`/api/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
                title={`${a.name} · ${formatBytes(a.size)}`}
                className="block size-14 overflow-hidden rounded-md border border-rule bg-paper-2 transition-colors hover:border-rule-strong focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
              >
                <img src={`/api/attachments/${a.id}`} alt={a.name} className="size-full object-cover" />
              </a>
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
  );
}

import { useState } from "react";
import { addPaste, clearPastes, shouldCollapse } from "@/lib/pasted-text";
import { cn, storageGet, storageRemove, storageSet } from "@/lib/utils";
import { draftKey } from "./drafts";

/**
 * The message box. Uncontrolled on purpose: a keystroke re-renders nothing (the composer around it,
 * with its pickers and prompt lists, re-renders only when the box goes empty ↔ non-empty), so typing
 * stays instant even while a task streams. Read the text from `inputRef` when sending.
 * The text is saved as a draft under `draft` on every change and restored on mount, so it survives
 * leaving the page; the sender removes the draft once the message is sent.
 */
export function MessageInput({
  inputRef,
  draft,
  onHasText,
  onText,
  onSubmit,
  onPaste,
  className,
  ...props
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onHasText: (hasText: boolean) => void;
  /** Called with the full text on every change (only pass it when something shows the text live). */
  onText?: (text: string) => void;
  onSubmit: () => void;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  className?: string;
  "aria-label": string;
  placeholder: string;
}) {
  const [initial] = useState(() => storageGet(draftKey(draft)) ?? "");
  return (
    <textarea
      ref={inputRef}
      {...props}
      defaultValue={initial}
      onInput={(e) => {
        const text = e.currentTarget.value;
        if (text) storageSet(draftKey(draft), text);
        else {
          storageRemove(draftKey(draft));
          clearPastes(draftKey(draft));
        }
        onHasText(text.trim().length > 0);
        onText?.(text);
      }}
      onPaste={(e) => {
        onPaste(e);
        if (e.defaultPrevented) return;
        // Long text shows as "[Pasted text #1 +204 lines]"; the full text is sent in its place.
        const text = e.clipboardData.getData("text/plain");
        if (!shouldCollapse(text)) return;
        e.preventDefault();
        insertText(e.currentTarget, addPaste(draftKey(draft), text));
      }}
      onKeyDown={(e) => {
        // Enter sends; Shift+Enter adds a new line. Skip while an IME is composing.
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        }
      }}
      className={cn(
        "block w-full resize-y bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-muted-foreground/80 focus:outline-none",
        className,
      )}
    />
  );
}

/** Type `text` at the cursor: keeps undo working and fires the box's input handler. */
function insertText(box: HTMLTextAreaElement, text: string) {
  box.focus();
  if (document.execCommand("insertText", false, text)) return;
  box.setRangeText(text, box.selectionStart, box.selectionEnd, "end");
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

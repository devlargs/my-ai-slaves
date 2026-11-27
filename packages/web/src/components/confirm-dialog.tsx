import type * as React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";

/** Wraps a trigger; asks before running `onConfirm`. If it throws, the dialog stays open and shows why. */
export function ConfirmButton({
  title,
  description,
  confirmLabel = "Confirm",
  destructive = true,
  onConfirm,
  children,
  ...buttonProps
}: {
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown> | unknown;
  children: React.ReactNode;
} & Omit<React.ComponentProps<typeof Button>, "onClick" | "title">) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) setError(null);
  };
  return (
    <>
      <Button {...buttonProps} onClick={() => openChange(true)}>
        {children}
      </Button>
      <Dialog open={open} onOpenChange={openChange}>
        <DialogContent>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div>{description}</div>
          </DialogDescription>
          {error && (
            <p role="alert" className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs text-danger-ink">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => openChange(false)}>
              Cancel
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await onConfirm();
                  openChange(false);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

import type { FsBrowseResponse } from "@my-ai-slaves/shared";
import { ArrowUpIcon, FolderGit2Icon, FolderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, attempt } from "@/lib/api";

export function FolderBrowserDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
}) {
  const [data, setData] = useState<FsBrowseResponse | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async (path?: string) => {
    setLoading(true);
    const res = await attempt(api.browse(path));
    setLoading(false);
    if (res) {
      setData(res);
      setPathInput(res.path);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load on open
  useEffect(() => {
    if (open && !data) void load();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Choose a repository folder</DialogTitle>
        <DialogDescription>Folders on this Mac. Git repositories are marked.</DialogDescription>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void load(pathInput);
          }}
        >
          <Input value={pathInput} onChange={(e) => setPathInput(e.target.value)} className="font-mono text-xs" />
          <Button type="submit" variant="outline" disabled={loading}>
            Go
          </Button>
        </form>
        <div className="h-80 overflow-auto rounded-md border">
          {data?.parent && (
            <button
              type="button"
              onClick={() => void load(data.parent ?? undefined)}
              className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-sm cursor-pointer hover:bg-accent"
            >
              <ArrowUpIcon className="size-4 text-muted-foreground" /> ..
            </button>
          )}
          {data?.dirs.length === 0 && <p className="p-3 text-sm text-muted-foreground">No sub-folders.</p>}
          {data?.dirs.map((d) => (
            <button
              type="button"
              key={d.path}
              onClick={() => void load(d.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm cursor-pointer hover:bg-accent"
            >
              {d.isGitRepo ? (
                <FolderGit2Icon className="size-4 text-primary" />
              ) : (
                <FolderIcon className="size-4 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              {d.isGitRepo && <Badge>git</Badge>}
            </button>
          ))}
        </div>
        <DialogFooter className="items-center">
          <span className="mr-auto truncate font-mono text-[11px] text-muted-foreground">
            {data?.isGitRepo ? "This folder is a git repository" : "Not a git repository"}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!data?.isGitRepo}
            onClick={() => {
              if (data) onPick(data.path);
              onOpenChange(false);
            }}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

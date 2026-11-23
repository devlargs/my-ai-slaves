import { type LucideIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { setTheme, type ThemePref, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemePref; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "Match the system", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** Three-way appearance switch for the sidebar footer: System / Light / Dark. */
export function ThemeToggle() {
  const theme = useTheme();
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <span className="text-[11px] text-muted-foreground">Appearance</span>
      <div role="radiogroup" aria-label="Appearance" className="flex rounded-full border border-rule bg-surface p-0.5">
        {OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = theme === value;
          return (
            <Tooltip key={value} content={label}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={label}
                onClick={() => setTheme(value)}
                className={cn(
                  "inline-flex size-6 cursor-pointer items-center justify-center rounded-full transition-colors duration-150",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--color-focus)",
                  active ? "bg-paper-3 text-ink" : "text-muted-foreground hover:text-ink",
                )}
              >
                <Icon className="size-3.5" />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

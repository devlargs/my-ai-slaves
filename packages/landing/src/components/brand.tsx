/** The app's mark: a draining queue (same drawing as the app icon and sidebar). */
export function Mark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect width="64" height="64" rx="14" fill="var(--color-ink)" />
      <rect x="12" y="13" width="40" height="10" rx="5" fill="var(--color-signal)" />
      <rect x="12" y="27" width="30" height="10" rx="5" fill="var(--color-paper)" />
      <rect x="12" y="41" width="20" height="10" rx="5" fill="var(--color-paper)" fillOpacity="0.4" />
    </svg>
  );
}

/** The mark's three bars alone, drawn large as a quiet background shape. */
export function MarkBars({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 38" aria-hidden="true" className={className}>
      <rect x="0" y="0" width="40" height="10" rx="5" fill="currentColor" />
      <rect x="0" y="14" width="30" height="10" rx="5" fill="currentColor" />
      <rect x="0" y="28" width="20" height="10" rx="5" fill="currentColor" />
    </svg>
  );
}

export function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76-1.47.02-2.83.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.25 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.08 2.65-2.14.84-1.22 1.18-2.41 1.2-2.47-.03-.01-2.3-.88-2.33-3.5zM14.2 6.13c.6-.74 1.01-1.75.9-2.77-.87.04-1.93.58-2.55 1.31-.56.65-1.05 1.69-.92 2.69.97.07 1.96-.49 2.57-1.23z" />
    </svg>
  );
}

export function WindowsLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M3 5.1 10.4 4v7.1H3V5.1zm0 13.8 7.4 1.1v-7H3v5.9zm8.3 1.2L21 21.5V13h-9.7v7.1zM11.3 3.9V11H21V2.5l-9.7 1.4z" />
    </svg>
  );
}

export function GitHubLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49l-.01-1.7c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.85.09-.66.35-1.12.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.1 10.1 0 0 0 22 12.23C22 6.58 17.52 2 12 2z" />
    </svg>
  );
}

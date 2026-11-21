import path from "node:path";

// In-place updates on macOS. The app is unsigned, so Squirrel.Mac (which
// insists on a Developer ID signature) is out. Instead, once the DMG has been
// downloaded and checked, a detached shell script waits for the app to quit,
// copies the new bundle over the old one, deletes the DMG and reopens the app:
// the same close → replace → relaunch the NSIS installer does on Windows.
//
// Opening the DMG in Finder for a manual drag is only the very last resort
// (the copy failed even with an administrator password): a copy that can't be
// replaced where it runs (still on the DMG, translocated) installs into
// /Applications instead, and a folder the user can't write to asks for an
// administrator password, the way an installer would.
//
// Pure and Electron-free, so it can be unit-tested (test/updater.test.ts).

/**
 * Where the update goes. `exePath` is `app.getPath("exe")`, e.g.
 * `/Applications/My AI Slaves.app/Contents/MacOS/My AI Slaves`.
 *
 * Normally the `.app` bundle the running executable lives in. A copy that
 * can't be replaced in place installs into /Applications under the same name
 * instead: one still running from the mounted DMG (`/Volumes/…`, read-only),
 * or App Translocation (macOS runs a quarantined app from a randomised
 * read-only copy until it has been moved at least once).
 *
 * Null when there's no bundle at all: a dev run (plain Electron binary).
 */
export function macUpdateTarget(exePath: string): string | null {
  const macosDir = path.posix.dirname(exePath);
  const contentsDir = path.posix.dirname(macosDir);
  const bundle = path.posix.dirname(contentsDir);
  if (path.posix.basename(macosDir) !== "MacOS") return null;
  if (path.posix.basename(contentsDir) !== "Contents") return null;
  if (!bundle.endsWith(".app") || !path.posix.isAbsolute(bundle)) return null;
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) {
    return path.posix.join("/Applications", path.posix.basename(bundle));
  }
  return bundle;
}

export const MAC_UPDATE_SCRIPT_NAME = "my-ai-slaves-update.sh";

/**
 * The script the old app hands the update to. Arguments: the old app's pid,
 * the verified DMG, and the bundle to replace (which may not exist yet).
 *
 * `swap` mode does the replacing: the new bundle is copied next to the old one
 * first and swapped in with two renames, so the old app is only moved aside
 * once a complete copy is ready, and is put back if the swap fails. When it
 * fails as this user (a folder they can't write to), it runs again through
 * macOS's administrator password prompt, and hands the bundle back to the user
 * so the next update needs no password. Only if that fails too (or is
 * cancelled) is the DMG opened in Finder to drag over by hand.
 *
 * The app is always reopened as the user, never as root: the new version, or
 * the old one if anything failed.
 */
export const MAC_UPDATE_SCRIPT = `#!/bin/bash
if [ "$1" = "swap" ]; then
  SRC="$2"
  APP="$3"
  OWNER="$4"
  NEW="$APP.new"
  OLD="$APP.old"
  rm -rf "$NEW" "$OLD"
  ditto "$SRC" "$NEW" || { rm -rf "$NEW"; exit 1; }
  if [ -e "$APP" ]; then
    mv "$APP" "$OLD" || { rm -rf "$NEW"; exit 1; }
  fi
  if ! mv "$NEW" "$APP"; then
    [ -e "$OLD" ] && mv "$OLD" "$APP"
    rm -rf "$NEW"
    exit 1
  fi
  rm -rf "$OLD"
  if [ "$(id -u)" = "0" ] && [ -n "$OWNER" ]; then
    chown -R "$OWNER" "$APP"
  fi
  # Copied out of a DMG the app downloaded itself, so it shouldn't carry a
  # quarantine flag, but make sure Gatekeeper doesn't ask about it again
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null
  exit 0
fi

PID="$1"
DMG="$2"
APP="$3"
UPDATED=0

# Wait for the old app to quit (it force-exits within a few seconds)
for _ in $(seq 1 120); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done

MNT="$(mktemp -d "\${TMPDIR:-/tmp}/my-ai-slaves-update.XXXXXX")"
# The download was already checked against GitHub's sha256, so -noverify
if hdiutil attach "$DMG" -nobrowse -noautoopen -noverify -quiet -mountpoint "$MNT"; then
  SRC="$(find "$MNT" -maxdepth 1 -name '*.app' -type d -print -quit)"
  if [ -z "$SRC" ]; then
    echo "No app found in the DMG"
  elif /bin/bash "$0" swap "$SRC" "$APP"; then
    UPDATED=1
  else
    echo "Could not replace $APP as $(id -un); asking for an administrator password"
    if osascript \\
      -e 'on run argv' \\
      -e 'do shell script "/bin/bash " & quoted form of item 1 of argv & " swap " & quoted form of item 2 of argv & " " & quoted form of item 3 of argv & " " & quoted form of item 4 of argv with prompt "My AI Slaves wants to install its update." with administrator privileges' \\
      -e 'end run' \\
      "$0" "$SRC" "$APP" "$(id -un)"; then
      UPDATED=1
    fi
  fi
  hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
else
  echo "Could not mount the DMG"
fi
rmdir "$MNT" 2>/dev/null

if [ "$UPDATED" = "1" ]; then
  echo "Updated $APP"
  rm -f "$DMG"
  open "$APP"
else
  # Last resort: show the new version so it can be dragged over by hand
  echo "Update not installed; opening the DMG"
  [ -e "$APP" ] && open "$APP"
  open "$DMG"
fi
rm -f "$0"
`;

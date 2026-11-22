# iOS Sideload (Raycast Extension)

Confirm and sideload configured iOS apps with Makefile-style incremental build detection.

## Features

- **Confirmation Screen on Launch**: Opens a review view showing connected iOS device, Apple Team ID, and the planned action (`Install Only` vs `Build + Install`) for each configured project before running anything.
- **Makefile-style Dependency Check**: Compares source file timestamps against the built `.app` bundle (and optionally `embedded.mobileprovision` expiration) so update-only runs skip unnecessary builds, while modified projects rebuild automatically.
- **Local Config File + Raycast Settings**: Stores personal settings (`projectDirs`, `teamId`, `deviceId`) locally in `~/.config/raycast/ios-sideload.json`, with optional overrides in Raycast Extension Settings and per-project overrides via `Configure Project…` (`Cmd+Shift+E`).

## Configuration

Create `~/.config/raycast/ios-sideload.json` (or run **Open Config File** `Cmd+Shift+C` inside the extension):

```json
{
  "projectDirs": [
    "~/Workspace/apps/MyApp",
    "~/Workspace/apps/AnotherApp"
  ],
  "teamId": "ABCDE12345",
  "deviceId": "00000000-0000000000000000"
}
```

Any non-empty value set in **Raycast Settings → Extensions → iOS Sideload** overrides the corresponding field in `~/.config/raycast/ios-sideload.json`.

## Development

```bash
npm install
npm run dev
```

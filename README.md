# `@twinedo/rn-netinspect`

React Native NetInspect is a React Native Network Inspector for inspecting app network requests.

## Quick Start

Use it in this order:

1. Install the package.
2. Add `installRNNetInspect()` once at app startup inside `if (__DEV__)`.
3. Start the dashboard/server with `npx rn-netinspect-server`.
4. Run or reload your React Native app in the simulator, emulator, or device.
5. Open `http://localhost:5555` on your computer.
6. Trigger network requests in the app.

Starting the server before launching the app is recommended so the earliest requests are captured.
If the app started before the server, start the server and reload the app.
After startup, the dashboard should show the live app instance in the `Metro / RN Apps` section within a few seconds.
Only iOS simulators and Android devices visible to `adb` appear in the left-side device list.

## Install

```bash
npm install -D @twinedo/rn-netinspect
```

## Run

```bash
npx rn-netinspect-server
```

Then open `http://localhost:5555` on your computer.

## Use

```js
if (__DEV__) {
  const { installRNNetInspect } = require("@twinedo/rn-netinspect");
  installRNNetInspect({ appName: "My RN App" });
}
```

Call `installRNNetInspect()` once at app startup in development mode. It patches `fetch` and `XMLHttpRequest`, then forwards request lifecycle events to your React Native NetInspect server.

If the React Native NetInspect server is not running, the client logs a development warning on startup. Requests made before the server is available are not captured, so reload the app after starting the server if needed.

## Options

```js
installRNNetInspect({
  inspectorUrl: "http://127.0.0.1:5555",
  appName: "My RN App",
  captureBodies: true,
  patchFetch: true,
  patchXHR: true,
});
```

If `inspectorUrl` is omitted, the client auto-detects the dev host from Metro when possible.

Fallback defaults:
- iOS Simulator: `http://127.0.0.1:5555`
- Android Emulator: `http://10.0.2.2:5555`

For a physical device, pass your computer's LAN IP explicitly if auto-detection does not resolve correctly:

```js
installRNNetInspect({
  inspectorUrl: "http://192.168.1.10:5555",
  appName: "My RN App",
});
```

## Example

```js
if (__DEV__) {
  const { installRNNetInspect } = require("@twinedo/rn-netinspect");
  installRNNetInspect({ appName: "Internship Mobile" });
}
```

## Server

The same package also ships the server CLI. Start it with:

```bash
npx rn-netinspect-server
```

The client sends events to:

```txt
POST /api/ingest
```

The client cannot automatically spawn the host-side Node.js server from inside the React Native runtime. The recommended workflow is to run `npx rn-netinspect-server` alongside your app start command.

## Log Colors

React Native NetInspect logs use a consistent colored `[RN NetInspect]` prefix to make them easy to spot in Metro and terminal output.

If you want to disable colors:

- set `NO_COLOR=1` in the environment, or
- set `global.__RN_INSPECTOR_NO_COLOR__ = true` before calling `installRNNetInspect()`

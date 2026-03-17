# `@twinedo/rn-netinspect`

React Native NetInspect is a React Native Network Inspector for inspecting app network requests.

## Install

```bash
npm install -D @twinedo/rn-netinspect
```

## Run

```bash
npx rn-netinspect-server
```

Then open `http://localhost:5555`.

## Use

```js
if (__DEV__) {
  const { installRNNetInspect } = require("@twinedo/rn-netinspect");
  installRNNetInspect({ appName: "My RN App" });
}
```

Call `installRNNetInspect()` once at app startup in development mode. It patches `fetch` and `XMLHttpRequest`, then forwards request lifecycle events to your React Native NetInspect server.

If the React Native NetInspect server is not running, the client logs a development warning on startup.

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

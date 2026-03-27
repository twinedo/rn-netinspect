<p align="center">
  <img src="https://raw.githubusercontent.com/twinedo/rn-netinspect/6411701027319155e3ef817dc7a42a0d76fe8b34/assets/readme/banner.svg" alt="React Native NetInspect banner" width="100%" />
</p>

<h1 align="center">React Native NetInspect</h1>
<p align="center">Inspect React Native traffic across simulator, emulator, and real devices.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@twinedo/rn-netinspect"><img alt="npm version" src="https://img.shields.io/npm/v/@twinedo/rn-netinspect?color=00d4ff&label=npm"></a>
  <img alt="platforms" src="https://img.shields.io/badge/platforms-iOS%20%7C%20Android-1f2937">
  <img alt="runtime" src="https://img.shields.io/badge/runtime-React%20Native-111827">
  <img alt="license" src="https://img.shields.io/npm/l/@twinedo/rn-netinspect?color=7c3aed">
</p>

<p align="center">
  Dashboard on <code>:19826</code>. Optional proxy on <code>:8899</code>. Direct capture from <code>fetch</code> and <code>XMLHttpRequest</code>.
</p>

## Preview

<table>
  <tr>
    <td width="50%">
      <img src="https://raw.githubusercontent.com/twinedo/rn-netinspect/6411701027319155e3ef817dc7a42a0d76fe8b34/assets/readme/preview-dashboard.svg" alt="NetInspect dashboard preview" width="100%" />
    </td>
    <td width="50%">
      <img src="https://raw.githubusercontent.com/twinedo/rn-netinspect/6411701027319155e3ef817dc7a42a0d76fe8b34/assets/readme/preview-routing.svg" alt="NetInspect device routing preview" width="100%" />
    </td>
  </tr>
</table>

## Why This Exists

- See request method, URL, headers, body, status, duration, and response payload in one place.
- Works across iOS Simulator, Android Emulator, USB-connected Android devices, and Wi-Fi-connected real devices.
- Supports direct client capture, Android emulator proxy flow, and Android real-device `adb reverse` flow.
- Keeps setup local: run one server on your machine and inspect requests from your app immediately.

## Install

```bash
npm install -D @twinedo/rn-netinspect
```

## Quick Start

This is the simplest setup for both iOS Simulator and Android Emulator.

### 1. Add it once at app startup

Use this in development mode:

```js
if (__DEV__) {
  void import("@twinedo/rn-netinspect").then(({ installRNNetInspect }) => {
    installRNNetInspect({
      appName: "My RN App",
      // inspectorUrl: "http://10.0.2.2:19826", // Android emulator reaches the host machine through 10.0.2.2.
    });
  });
}
```

Why this setup:
- works in stricter ESLint setups without disabling rules
- keeps the library development-only
- usually works for both Simulator and Emulator without extra setup
- if Android Emulator does not connect automatically, uncomment `inspectorUrl`

### 2. Start the server

```bash
npx rn-netinspect-server
```

### 3. Open the dashboard

```txt
http://localhost:19826
```

### 4. Run your app

- iOS: `npm run ios`
- Android: `npm run android`

Then trigger requests in the app and watch them appear in the dashboard.

## If You Need Extra Setup

Most developers should start with the quick start above first.

### Android Emulator

If the Android Emulator does not connect, uncomment this line:

```js
inspectorUrl: "http://10.0.2.2:19826", // Android emulator reaches the host machine through 10.0.2.2.
```

`10.0.2.2` is how the Android Emulator reaches your computer.

### Real Devices

Real devices may need a manual `inspectorUrl`.

- iPhone over Wi-Fi: `http://<your-computer-lan-ip>:19826`
- Android over Wi-Fi: `http://<your-computer-lan-ip>:19826`
- Android over USB: use `adb reverse tcp:19826 tcp:19826`

If you want the server to auto-manage `adb reverse` for physical Android devices, run:

```bash
npx rn-netinspect-server --auto-connect
```

### Android Proxy Warning

Android proxy mode changes global device network settings.
This can affect the whole emulator or phone, not just your app.

Use proxy mode only when you really need it.

To clear old Android proxy settings:

```bash
adb shell settings put global http_proxy :0
adb shell settings put global https_proxy :0
adb shell settings delete global http_proxy
adb shell settings delete global https_proxy
adb shell settings delete global global_http_proxy_host
adb shell settings delete global global_http_proxy_port
adb shell settings delete global global_http_proxy_exclusion_list
```

### If It Still Does Not Connect

If the dashboard opens but no requests appear:

- start the server before launching or reloading the app
- reload the app after the server is already running
- on Android Emulator, uncomment `inspectorUrl: "http://10.0.2.2:19826"`
- on real devices, make sure the device can reach your computer

## Options

```js
installRNNetInspect({
  inspectorUrl: "http://127.0.0.1:19826",
  appName: "My RN App",
  captureBodies: true,
  patchFetch: true,
  patchXHR: true,
});
```

## Server API

The client sends events to:

```txt
POST /api/ingest
```

The dashboard also uses:

```txt
GET  /api/health
POST /api/register
```

## Troubleshooting

### The dashboard opens, but no requests appear

- make sure the app points to the correct `inspectorUrl`
- reload the app after the server is already running
- on physical devices, verify the phone can open the same URL in its browser

### Android app says it cannot connect to `127.0.0.1:8899`

That is proxy configuration, not the direct client.

- On an emulator, prefer the direct client URL `http://10.0.2.2:19826`
- On a real device, prefer `adb reverse` or a LAN IP
- Clear any old Android global proxy settings if necessary

### Android phone has Wi-Fi but no internet after testing

Clear Android proxy settings:

```bash
adb shell settings put global http_proxy :0
adb shell settings put global https_proxy :0
adb shell settings delete global http_proxy
adb shell settings delete global https_proxy
```

Then check the phone Wi-Fi settings and ensure proxy is disabled.

## Log Colors

React Native NetInspect logs use a colored `[RN NetInspect]` prefix.

To disable colors:
- set `NO_COLOR=1`, or
- set `global.__RN_INSPECTOR_NO_COLOR__ = true` before calling `installRNNetInspect()`

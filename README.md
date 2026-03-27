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

## App Setup

Add `installRNNetInspect()` once at app startup in development mode.

```js
if (__DEV__) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { installRNNetInspect } = require("@twinedo/rn-netinspect");
  installRNNetInspect({ appName: "My RN App" });
}
```

If your project allows `require()` inside a dev-only guard, this is the recommended setup.

If ESLint reports `@typescript-eslint/no-require-imports`, either keep the one-line disable above or use this fallback:

```js
if (__DEV__) {
  void import("@twinedo/rn-netinspect").then(({ installRNNetInspect }) => {
    installRNNetInspect({ appName: "My RN App" });
  });
}
```

Important:
- Keep the `require("@twinedo/rn-netinspect")` call inside `if (__DEV__)`.
- This is the recommended setup because the inspector stays development-only and should not be included in production builds.

If you already know the inspector URL for the current device, you can pass it explicitly:

```js
installRNNetInspect({
  appName: "My RN App",
  inspectorUrl: "http://127.0.0.1:19826",
});
```

For Android emulator, use:

```js
installRNNetInspect({
  appName: "My RN App",
  inspectorUrl: "http://10.0.2.2:19826", // Android emulator reaches the host machine through 10.0.2.2.
});
```

## Start The Server

Run the dashboard/server on your computer:

```bash
npx rn-netinspect-server
```

Safe default behavior:
- direct client capture is available immediately
- iOS system proxy is manual
- Android emulator proxy is manual
- Android device `adb reverse` auto-connect is off by default

If you want the server to auto-manage `adb reverse` for physical Android devices, start it with:

```bash
npx rn-netinspect-server --auto-connect
```

Then open:

```txt
http://localhost:19826
```

Start the server before launching or reloading the app when possible.

## Expo Vs React Native CLI

### Expo Dev Client

Use Expo's dev client and choose a Metro host mode that matches your device setup.

- iOS Simulator: `npx expo start --dev-client`
- Android Emulator: `npx expo start --dev-client --host lan`
- Android real device over USB with `adb reverse`: `npx expo start --dev-client --host localhost`
- Real devices over Wi-Fi: `npx expo start --dev-client --host lan`

If you use Expo environment variables, a good pattern is:

```bash
EXPO_PUBLIC_RN_NETINSPECT_URL=http://127.0.0.1:19826
```

or for Wi-Fi:

```bash
EXPO_PUBLIC_RN_NETINSPECT_URL=http://192.168.1.10:19826
```

### React Native CLI

Use the normal React Native flow for your platform:

- iOS Simulator: `npx react-native run-ios`
- Android Emulator: `npx react-native run-android`
- Android real device over USB: use `adb reverse` when needed
- Real devices over Wi-Fi: pass your computer LAN IP explicitly to `inspectorUrl`

## Recommended Defaults

Use these URLs for each environment:

- iOS Simulator: `http://127.0.0.1:19826`
- Android Emulator: `http://10.0.2.2:19826`
- Android real device over USB with `adb reverse`: `http://127.0.0.1:19826`
- iPhone real device on Wi-Fi: `http://<your-computer-lan-ip>:19826`
- Android real device on Wi-Fi: `http://<your-computer-lan-ip>:19826`

If `inspectorUrl` is omitted, the client tries to infer the host automatically from Metro when possible.

## iOS Simulator

1. Start the server:

```bash
npx rn-netinspect-server
```

2. Start your app.

Expo Dev Client:

```bash
npx expo start --dev-client
```

React Native CLI:

```bash
npx react-native run-ios
```

3. Use this config in the app if you want to be explicit:

```js
installRNNetInspect({
  appName: "My RN App",
  inspectorUrl: "http://127.0.0.1:19826",
});
```

4. Open `http://localhost:19826` on your Mac.

5. Trigger requests in the simulator.

Notes:
- iOS Simulator can reach your Mac through loopback.
- If requests do not appear, reload the app after the server is running.

## Android Emulator

1. Start the server:

```bash
npx rn-netinspect-server
```

2. Start your app.

Expo Dev Client:

```bash
npx expo start --dev-client --host lan
```

React Native CLI:

```bash
npx react-native run-android
```

3. Use this config in the app if you want to be explicit:

```js
installRNNetInspect({
  appName: "My RN App",
  inspectorUrl: "http://10.0.2.2:19826", // Android emulator reaches the host machine through 10.0.2.2.
});
```

4. Open `http://localhost:19826` on your computer.

5. Trigger requests in the emulator.

Important:
- Android Emulator cannot use `127.0.0.1:19826` to reach your host machine.
- Use `10.0.2.2:19826` for the direct client.

### About Android Emulator Proxy Mode

The dashboard may also offer Android proxy connect for emulators.
That uses ADB to change Android global proxy settings on the emulator.

This is not the default path. Prefer direct client mode with `http://10.0.2.2:19826` first.

Proxy mode changes device-wide settings inside that emulator instance, so it can interfere with Expo reload, browser access, and unrelated apps until cleared.

If you use proxy mode and want to clear it later:

```bash
adb shell settings put global http_proxy :0
adb shell settings put global https_proxy :0
adb shell settings delete global http_proxy
adb shell settings delete global https_proxy
```

## iPhone Real Device

Use Wi-Fi and your computer's LAN IP.

1. Make sure the iPhone and your computer are on the same network.

2. Find your computer LAN IP, for example `192.168.1.10`.

3. Start the server:

```bash
npx rn-netinspect-server
```

4. Start your app.

Expo Dev Client:

```bash
npx expo start --dev-client --host lan
```

React Native CLI:

Use your usual device run flow, then make sure the app can reach the LAN IP.

5. Configure the app with your LAN IP:

```js
installRNNetInspect({
  appName: "My RN App",
  inspectorUrl: "http://192.168.1.10:19826",
});
```

6. Run or reload the app on the iPhone.

7. Open `http://localhost:19826` on your computer.

8. Trigger requests in the app.

If it does not connect:
- confirm the phone can open `http://192.168.1.10:19826` in Safari
- confirm your computer firewall allows the Node process
- confirm both devices are on the same Wi-Fi

## Android Real Device

There are 2 supported ways.

### Option A: USB + `adb reverse` (Recommended)

This is the safest setup because it does not require a device-wide HTTP proxy.

1. Connect the Android phone by USB.

2. Confirm ADB sees the device:

```bash
adb devices
```

3. Start the server:

```bash
npx rn-netinspect-server
```

4. Reverse the dashboard port from device to computer:

```bash
adb reverse tcp:19826 tcp:19826
```

5. If you also need Metro over USB, reverse Metro too:

```bash
adb reverse tcp:8081 tcp:8081
```

6. Start your app.

Expo Dev Client:

```bash
npx expo start --dev-client --host localhost
```

React Native CLI:

Use your usual USB device run flow after `adb reverse` is active.

7. Configure the app with loopback:

```js
installRNNetInspect({
  appName: "My RN App",
  inspectorUrl: "http://127.0.0.1:19826",
});
```

8. Run or reload the app on the phone.

9. Open `http://localhost:19826` on your computer.

Notes:
- `adb reverse` only works while the device is attached to ADB.
- This is the recommended setup for physical Android devices during development.
- If you want the server to auto-connect `adb reverse` during scans, use `npx rn-netinspect-server --auto-connect`.

### Option B: Wi-Fi + LAN IP

Use this when the phone is not attached by USB.

1. Make sure the phone and your computer are on the same Wi-Fi.

2. Find your computer LAN IP, for example `192.168.1.10`.

3. Start the server:

```bash
npx rn-netinspect-server
```

4. Start your app.

Expo Dev Client:

```bash
npx expo start --dev-client --host lan
```

React Native CLI:

Use your normal Wi-Fi device flow.

5. Configure the app with your LAN IP:

```js
installRNNetInspect({
  appName: "My RN App",
  inspectorUrl: "http://192.168.1.10:19826",
});
```

6. Run or reload the app on the phone.

7. Verify the phone browser can open:

```txt
http://192.168.1.10:19826
```

## Very Important: Android Proxy Warning

Commands like these change Android global system proxy settings on the connected device:

```bash
adb shell settings put global http_proxy <host>:<port>
adb shell settings put global https_proxy <host>:<port>
```

That can affect the whole device, not just your app.
If the proxy is wrong or unreachable, the device may lose internet access until the settings are cleared.

Only use device-wide Android proxy settings if you explicitly want that behavior and understand the impact.

`rn-netinspect-server` does not enable Android emulator proxy automatically by default.

To clear them:

```bash
adb shell settings put global http_proxy :0
adb shell settings put global https_proxy :0
adb shell settings delete global http_proxy
adb shell settings delete global https_proxy
adb shell settings delete global global_http_proxy_host
adb shell settings delete global global_http_proxy_port
adb shell settings delete global global_http_proxy_exclusion_list
```

Also verify the current Wi-Fi network on the phone has `Proxy = None`.

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

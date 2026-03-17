#!/usr/bin/env node
/**
 * React Native NetInspect v2.0
 * Zero dependencies — pure Node.js built-ins
 *
 * Auto-detects:
 *   • iOS Simulators  (via xcrun simctl)  → configures Mac system proxy
 *   • Android Emulators (via adb)         → pushes proxy via adb shell
 *   • React Native Metro processes        → detected via lsof / ps
 *
 * Usage:  npx rn-netinspect-server
 * Dashboard: http://localhost:5555
 */

'use strict';
const http  = require('http');
const https = require('https');
const net   = require('net');
const url   = require('url');
const crypto = require('crypto');
const { exec } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────
const PROXY_PORT     = parseInt(process.env.PROXY_PORT || '8899', 10);
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '5555', 10);
const SCAN_INTERVAL  = 5000;
const IOS_AUTO_SYSTEM_PROXY = false;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[96m',
  yellow: '\x1b[93m',
  red: '\x1b[91m',
};

function supportsColor() {
  return !!(process.stdout && process.stdout.isTTY);
}

function inspectorPrefix() {
  const label = '[RN NetInspect]';
  if (!supportsColor()) return label;
  return `${ANSI.bold}${ANSI.cyan}${label}${ANSI.reset}`;
}

function inspectorLog(message) {
  console.log(`${inspectorPrefix()} ${message}`);
}

function inspectorError(message) {
  const body = supportsColor() ? `${ANSI.red}${message}${ANSI.reset}` : message;
  console.error(`${inspectorPrefix()} ${body}`);
}

// ─── Request store ────────────────────────────────────────────────────────────
const requests = [];
const MAX_REQUESTS = 500;
let requestIdCounter = 0;
const directRequestIds = new Map();
const connectedApps = new Map();
const APP_STALE_MS = 20000;

function addRequest(entry) {
  requests.unshift(entry);
  if (requests.length > MAX_REQUESTS) requests.pop();
  broadcastWS({ type: 'request', data: entry });
}
function updateRequest(id, patch) {
  const idx = requests.findIndex(r => r.id === id);
  if (idx !== -1) {
    Object.assign(requests[idx], patch);
    broadcastWS({ type: 'update', data: requests[idx] });
  }
}

function toPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function safeJsonParse(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function clampText(value, max = 50000) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= max) return safeJsonParse(text);
  return text.slice(0, max) + '\n…[truncated]';
}

function clampLabel(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 80) : fallback;
}

function parseTargetUrl(input) {
  try {
    const parsed = new URL(String(input));
    const scheme = parsed.protocol.replace(':', '') || 'http';
    const defaultPort = scheme === 'https' ? '443' : '80';
    const host = parsed.port && parsed.port !== defaultPort
      ? `${parsed.hostname}:${parsed.port}`
      : parsed.hostname;
    return { scheme, host, path: `${parsed.pathname || '/'}${parsed.search || ''}` || '/' };
  } catch {
    return { scheme: 'http', host: '', path: typeof input === 'string' ? input : '/' };
  }
}

function isInspectorControlRequest(target) {
  const host = String(target && target.host || '').toLowerCase();
  const path = String(target && target.path || '');
  const normalizedHost = host.replace(/:\d+$/, '');
  const isDashboardHost = (
    normalizedHost === 'localhost' ||
    normalizedHost === '127.0.0.1' ||
    normalizedHost === '0.0.0.0' ||
    normalizedHost === '::1'
  );
  const isControlPath = (
    path === '/api/health' ||
    path === '/api/register' ||
    path === '/api/ingest'
  );
  return isDashboardHost && isControlPath;
}

function registerAppClient(payload, req) {
  const body = toPlainObject(payload);
  const runtimeHost = clampLabel(body.runtimeHost, req && req.socket ? req.socket.remoteAddress || 'unknown' : 'unknown');
  const platform = clampLabel(body.platform, 'unknown');
  const appName = clampLabel(body.appName, 'React Native');
  const installId = clampLabel(body.installId, `${appName}-${platform}-${runtimeHost}`);
  const id = `${installId}@${runtimeHost}`;
  connectedApps.set(id, {
    id,
    installId,
    appName,
    platform,
    runtimeHost,
    lastSeen: Date.now(),
  });
  return connectedApps.get(id);
}

function ingestDirectEvent(payload, req) {
  const phase = payload && payload.phase;
  const requestKey = payload && payload.requestKey;
  if (!requestKey) return { ok: false, error: 'requestKey is required' };

  const reqData = toPlainObject(payload.request);
  const resData = toPlainObject(payload.response);
  const timing = toPlainObject(payload.timing);
  registerAppClient({
    installId: payload && payload.installId,
    appName: reqData.appName || payload.appName,
    platform: payload && payload.platform,
    runtimeHost: payload && payload.runtimeHost,
  }, req);

  if (phase === 'start') {
    const target = parseTargetUrl(reqData.url || reqData.path || '/');
    if (isInspectorControlRequest(target)) {
      return { ok: true, id: null, skipped: true };
    }
    const entry = {
      id: ++requestIdCounter,
      requestKey,
      method: String(reqData.method || 'GET').toUpperCase(),
      scheme: target.scheme,
      host: target.host,
      path: target.path,
      startTime: reqData.startTime || Date.now(),
      requestHeaders: toPlainObject(reqData.headers),
      requestBody: clampText(reqData.body),
      status: null,
      responseHeaders: {},
      responseBody: null,
      duration: null,
      responseSize: 0,
      error: null,
      connectTime: timing.connectTime || 0,
      waitTime: timing.waitTime || 0,
      receiveTime: timing.receiveTime || 0,
      source: 'rn-direct',
      transport: reqData.transport || 'fetch',
      appName: reqData.appName || 'React Native',
    };
    directRequestIds.set(requestKey, entry.id);
    addRequest(entry);
    return { ok: true, id: entry.id };
  }

  const id = directRequestIds.get(requestKey);
  if (!id) return { ok: false, error: 'Unknown requestKey' };

  if (phase === 'finish') {
    const patch = {
      status: Number.isFinite(resData.status) ? resData.status : 200,
      responseHeaders: toPlainObject(resData.headers),
      responseBody: clampText(resData.body),
      responseSize: Number.isFinite(resData.size) ? resData.size : (typeof resData.body === 'string' ? Buffer.byteLength(resData.body) : 0),
      duration: Number.isFinite(timing.duration) ? timing.duration : null,
      connectTime: Number.isFinite(timing.connectTime) ? timing.connectTime : 0,
      waitTime: Number.isFinite(timing.waitTime) ? timing.waitTime : 0,
      receiveTime: Number.isFinite(timing.receiveTime) ? timing.receiveTime : 0,
      error: null,
    };
    updateRequest(id, patch);
    directRequestIds.delete(requestKey);
    return { ok: true, id };
  }

  if (phase === 'error') {
    updateRequest(id, {
      error: String(payload.error || 'Request failed'),
      duration: Number.isFinite(timing.duration) ? timing.duration : null,
      connectTime: Number.isFinite(timing.connectTime) ? timing.connectTime : 0,
      waitTime: Number.isFinite(timing.waitTime) ? timing.waitTime : 0,
      receiveTime: Number.isFinite(timing.receiveTime) ? timing.receiveTime : 0,
    });
    directRequestIds.delete(requestKey);
    return { ok: true, id };
  }

  return { ok: false, error: 'Unsupported phase' };
}

// ─── Device registry ──────────────────────────────────────────────────────────
let devices     = [];
let rnProcesses = [];
let autoConnectEnabled = true;

function pruneConnectedApps() {
  const now = Date.now();
  for (const [id, app] of connectedApps.entries()) {
    if (!app || now - app.lastSeen > APP_STALE_MS) connectedApps.delete(id);
  }
}

function listConnectedApps() {
  pruneConnectedApps();
  return [...connectedApps.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(app => ({
      port: null,
      name: 'app',
      pid: app.id,
      label: `${app.appName}  ${app.platform}  ${app.runtimeHost}`,
    }));
}

function broadcastDevices() {
  pruneConnectedApps();
  broadcastWS({ type: 'devices', data: { devices, rnProcesses: [...listConnectedApps(), ...rnProcesses] } });
}

// ─── Shell helper ─────────────────────────────────────────────────────────────
function sh(cmd) {
  return new Promise(resolve => {
    exec(cmd, { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim() });
    });
  });
}

// ─── iOS detection ────────────────────────────────────────────────────────────
async function detectiOSSimulators() {
  const r = await sh('xcrun simctl list devices --json 2>/dev/null');
  if (!r.ok || !r.out) return [];
  try {
    const data = JSON.parse(r.out);
    const booted = [];
    for (const [runtime, devList] of Object.entries(data.devices || {})) {
      for (const dev of devList) {
        if (dev.state === 'Booted') {
          booted.push({
            id: 'ios-' + dev.udid,
            type: 'ios',
            name: dev.name,
            udid: dev.udid,
            runtime: runtime.replace(/com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-/g, '.'),
            status: 'booted',
            proxyStatus: 'unknown',
            detail: '',
          });
        }
      }
    }
    return booted;
  } catch { return []; }
}

async function getMacProxyServices() {
  const [orderR, routeR] = await Promise.all([
    sh('networksetup -listnetworkserviceorder 2>/dev/null'),
    sh("route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}'"),
  ]);
  const defaultDevice = routeR.out.trim();
  const services = [];

  if (orderR.ok && orderR.out) {
    let pending = null;
    for (const line of orderR.out.split('\n')) {
      const svcMatch = line.match(/^\(\d+\)\s(.+)$/);
      if (svcMatch) {
        const raw = svcMatch[1].trim();
        pending = {
          service: raw.replace(/^\*/, '').trim(),
          disabled: raw.startsWith('*'),
        };
        continue;
      }

      const portMatch = line.match(/^\(Hardware Port:\s*(.*?),\s*Device:\s*([^)]+)\)$/);
      if (portMatch && pending) {
        services.push({
          ...pending,
          hardwarePort: portMatch[1].trim(),
          device: portMatch[2].trim(),
        });
        pending = null;
      }
    }
  }

  const candidates = services.filter(s => !s.disabled && /wi-?fi|ethernet/i.test(s.hardwarePort));
  const preferred = candidates.find(s => s.device === defaultDevice) || candidates[0] || null;
  return {
    defaultDevice,
    services: candidates,
    preferredService: preferred ? preferred.service : 'Wi-Fi',
  };
}

async function inspectMacProxyService(service) {
  const [webR, secureR] = await Promise.all([
    sh(`networksetup -getwebproxy "${service}" 2>/dev/null`),
    sh(`networksetup -getsecurewebproxy "${service}" 2>/dev/null`),
  ]);
  if (!webR.ok && !secureR.ok) {
    return { service, enabled: false, ours: false, webEnabled: false, secureEnabled: false, webOurs: false, secureOurs: false };
  }

  const parseProxyInfo = output => {
    const enabled = /enabled:\s*yes/i.test(output);
    const sm = output.match(/server:\s*(\S+)/i);
    const pm = output.match(/port:\s*(\d+)/i);
    const server = sm ? sm[1] : '';
    const port = pm ? parseInt(pm[1], 10) : 0;
    return { enabled, server, port, ours: enabled && server === '127.0.0.1' && port === PROXY_PORT };
  };

  const web = parseProxyInfo(webR.out || '');
  const secure = parseProxyInfo(secureR.out || '');
  return {
    service,
    enabled: web.enabled || secure.enabled,
    ours: web.ours && secure.ours,
    webEnabled: web.enabled,
    secureEnabled: secure.enabled,
    webOurs: web.ours,
    secureOurs: secure.ours,
    server: web.server || secure.server,
    port: web.port || secure.port,
  };
}

async function checkMacProxyStatus() {
  const ctx = await getMacProxyServices();
  const status = await inspectMacProxyService(ctx.preferredService);
  return { ...status, service: ctx.preferredService, defaultDevice: ctx.defaultDevice };
}

async function setMacSystemProxy(enable) {
  const ctx = await getMacProxyServices();
  const service = ctx.preferredService;
  if (enable) {
    for (const candidate of ctx.services) {
      if (candidate.service === service) continue;
      const status = await inspectMacProxyService(candidate.service);
      if (status.webOurs || status.secureOurs) {
        await sh(`networksetup -setwebproxystate "${candidate.service}" off 2>&1`);
        await sh(`networksetup -setsecurewebproxystate "${candidate.service}" off 2>&1`);
      }
    }
    const [w1, w2, s1, s2] = await Promise.all([
      sh(`networksetup -setwebproxy "${service}" 127.0.0.1 ${PROXY_PORT} 2>&1`),
      sh(`networksetup -setwebproxystate "${service}" on 2>&1`),
      sh(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${PROXY_PORT} 2>&1`),
      sh(`networksetup -setsecurewebproxystate "${service}" on 2>&1`),
    ]);
    return {
      ok: w1.ok && w2.ok && s1.ok && s2.ok,
      service,
      device: ctx.defaultDevice,
      webOk: w1.ok && w2.ok,
      httpsOk: s1.ok && s2.ok,
    };
  } else {
    const targets = new Set([service]);
    for (const candidate of ctx.services) {
      const status = await inspectMacProxyService(candidate.service);
      if (status.webOurs || status.secureOurs) targets.add(candidate.service);
    }
    for (const target of targets) {
      await sh(`networksetup -setwebproxystate "${target}" off 2>&1`);
      await sh(`networksetup -setsecurewebproxystate "${target}" off 2>&1`);
    }
    return { ok: true, service, device: ctx.defaultDevice, clearedServices: [...targets] };
  }
}

function formatMacProxySetDetail(result) {
  if (result.ok) return `Mac-wide proxy active on "${result.service}"`;
  const failed = [];
  if (result.webOk === false) failed.push('HTTP');
  if (result.httpsOk === false) failed.push('HTTPS');
  return failed.length > 0
    ? `Failed to enable ${failed.join(' + ')} proxy on "${result.service}"`
    : 'Failed — try: sudo npx rn-netinspect-server';
}

function formatMacProxyStatusDetail(status) {
  if (status.ours) return `Mac-wide proxy active on "${status.service}"`;
  const partial = [];
  if (status.webOurs) partial.push('HTTP');
  if (status.secureOurs) partial.push('HTTPS');
  return partial.length > 0
    ? `Partial proxy on "${status.service}" (${partial.join(' + ')})`
    : 'Uses macOS proxy; enabling it will capture host Mac traffic too';
}

// ─── Android detection ────────────────────────────────────────────────────────
async function detectAndroidEmulators() {
  const which = await sh('which adb 2>/dev/null');
  if (!which.ok && !which.out) return [];
  const r = await sh('adb devices -l 2>/dev/null');
  if (!r.ok) return [];
  const lines = r.out.split('\n').slice(1).filter(l => l.trim() && !l.includes('offline') && !l.includes('daemon'));
  const result = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const serial = parts[0];
    if (!serial || serial === 'List') continue;
    const modelR = await sh(`adb -s ${serial} shell getprop ro.product.model 2>/dev/null`);
    const avdR   = await sh(`adb -s ${serial} emu avd name 2>/dev/null`);
    const name   = (avdR.out ? avdR.out.split('\n')[0].trim() : '') || modelR.out || serial;
    const proxyR = await sh(`adb -s ${serial} shell settings get global http_proxy 2>/dev/null`);
    const curProxy = proxyR.out || '';
    const ours = curProxy.includes(`10.0.2.2:${PROXY_PORT}`) || curProxy.includes(`127.0.0.1:${PROXY_PORT}`);
    result.push({
      id: 'android-' + serial,
      type: 'android',
      name,
      serial,
      status: 'running',
      proxyStatus: ours ? 'connected' : 'disconnected',
      detail: curProxy && curProxy !== 'null' ? `proxy: ${curProxy}` : 'no proxy set',
    });
  }
  return result;
}

async function setAndroidProxy(serial, enable) {
  const host = serial.startsWith('emulator') ? '10.0.2.2' : '127.0.0.1';
  if (enable) {
    const r = await sh(`adb -s ${serial} shell settings put global http_proxy ${host}:${PROXY_PORT} 2>&1`);
    await sh(`adb -s ${serial} shell settings put global https_proxy ${host}:${PROXY_PORT} 2>&1`);
    return r;
  } else {
    const r = await sh(`adb -s ${serial} shell settings put global http_proxy :0 2>&1`);
    await sh(`adb -s ${serial} shell settings put global https_proxy :0 2>&1`);
    return r;
  }
}

// ─── Metro / RN process detection ─────────────────────────────────────────────
async function detectRNProcesses() {
  const procs = [];
  for (const port of [8081, 8082, 8080, 19000, 19001]) {
    const r = await sh(`lsof -iTCP:${port} -sTCP:LISTEN -n -P 2>/dev/null | tail -n +2 | head -2`);
    if (r.out) {
      for (const line of r.out.split('\n').filter(Boolean)) {
        const p = line.split(/\s+/);
        if (p[0] && p[1]) procs.push({ port, name: p[0], pid: p[1], label: `Metro :${port}  pid ${p[1]}` });
      }
    }
  }
  const psR = await sh("ps aux 2>/dev/null | grep -iE '(metro|react.native|expo start)' | grep -v grep | head -4");
  if (psR.out) {
    for (const line of psR.out.split('\n').filter(Boolean)) {
      const p = line.split(/\s+/);
      const pid = p[1];
      if (pid && !procs.find(x => x.pid === pid)) {
        const cmd = p.slice(10).join(' ');
        procs.push({ port: null, name: 'rn', pid, label: (cmd.length > 58 ? cmd.slice(0, 58) + '…' : cmd) });
      }
    }
  }
  return procs;
}

// ─── Auto-connect scan loop ───────────────────────────────────────────────────
async function scanAndAutoConnect() {
  try {
    const [iosDevs, androidDevs, rnProcs] = await Promise.all([
      detectiOSSimulators(),
      detectAndroidEmulators(),
      detectRNProcesses(),
    ]);

    const allDevices = [...iosDevs, ...androidDevs];

    if (autoConnectEnabled) {
      // iOS Simulator shares macOS proxy settings, so auto-enabling it would
      // capture unrelated desktop traffic as well. Keep it manual by default.
      if (iosDevs.length > 0) {
        const status = await checkMacProxyStatus();
        for (const dev of iosDevs) {
          if (!status.ours && IOS_AUTO_SYSTEM_PROXY) {
            const res = await setMacSystemProxy(true);
            dev.proxyStatus = res.ok ? 'connected' : 'error';
            dev.detail = formatMacProxySetDetail(res);
          } else {
            dev.proxyStatus = status.ours ? 'connected' : 'disconnected';
            dev.detail = formatMacProxyStatusDetail(status);
          }
        }
      }

      // Android: push proxy via adb for any not yet connected
      for (const dev of androidDevs) {
        if (dev.proxyStatus !== 'connected') {
          const res = await setAndroidProxy(dev.serial, true);
          dev.proxyStatus = res.ok ? 'connected' : 'error';
          dev.detail = res.ok ? `adb → 10.0.2.2:${PROXY_PORT}` : `adb error: ${res.err}`;
          if (res.ok) {
            inspectorLog(`Android proxy connected: ${dev.name} → 10.0.2.2:${PROXY_PORT}`);
          }
        }
      }
    } else {
      // Just refresh statuses without connecting
      for (const dev of iosDevs) {
        const status = await checkMacProxyStatus();
        dev.proxyStatus = status.ours ? 'connected' : 'disconnected';
        dev.detail = formatMacProxyStatusDetail(status);
      }
    }

    devices     = allDevices;
    rnProcesses = rnProcs;
    broadcastDevices();
  } catch (e) {
    inspectorError(`Scan error: ${e.message}`);
  }
}

// ─── Manual device action (from dashboard) ────────────────────────────────────
async function handleDeviceAction(action, deviceId) {
  const dev = devices.find(d => d.id === deviceId);
  if (!dev) return { ok: false, error: 'Device not found' };

  if (action === 'connect') {
    if (dev.type === 'ios') {
      const res = await setMacSystemProxy(true);
      dev.proxyStatus = res.ok ? 'connected' : 'error';
      dev.detail = formatMacProxySetDetail(res);
    } else if (dev.type === 'android') {
      const res = await setAndroidProxy(dev.serial, true);
      dev.proxyStatus = res.ok ? 'connected' : 'error';
      dev.detail = res.ok ? `adb → 10.0.2.2:${PROXY_PORT}` : res.err;
    }
  } else if (action === 'disconnect') {
    if (dev.type === 'ios') {
      await setMacSystemProxy(false);
      dev.proxyStatus = 'disconnected';
      dev.detail = 'Mac-wide proxy cleared';
    } else if (dev.type === 'android') {
      await setAndroidProxy(dev.serial, false);
      dev.proxyStatus = 'disconnected';
      dev.detail = 'adb proxy cleared';
    }
  }

  broadcastDevices();
  return { ok: true, device: dev };
}

// ─── WebSocket (no deps) ──────────────────────────────────────────────────────
const wsClients = new Set();

function upgradeToWS(req, socket) {
  const key    = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.on('error', () => wsClients.delete(socket));
  socket.on('close', () => wsClients.delete(socket));
  wsClients.add(socket);
  sendWS(socket, { type: 'init',    data: requests.slice(0, 100) });
  sendWS(socket, { type: 'devices', data: { devices, rnProcesses: [...listConnectedApps(), ...rnProcesses] } });
}

function encodeWS(data) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126)      { header = Buffer.alloc(2);  header[0]=0x81; header[1]=len; }
  else if (len<65536) { header = Buffer.alloc(4);  header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
  else                { header = Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
  return Buffer.concat([header, payload]);
}
function sendWS(s,d)    { try { if(!s.destroyed) s.write(encodeWS(d)); } catch(_){} }
function broadcastWS(d) { const f=encodeWS(d); for(const s of wsClients){try{if(!s.destroyed)s.write(f);}catch(_){}} }

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>React Native NetInspect</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#161b22;--bg2:#1e2630;--bg3:#27313d;--bg4:#313c49;
  --border:#354150;--border2:#445265;
  --text:#eef3f8;--text2:#c4d0dd;--text3:#8d9cb0;
  --accent:#00d4ff;--green:#00e676;--red:#ff4444;
  --orange:#ff9800;--yellow:#ffeb3b;--purple:#bb86fc;--pink:#f48fb1;
  --mono:'JetBrains Mono',monospace;--sans:'Space Grotesk',sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:
  radial-gradient(circle at top left, rgba(0,212,255,.08), transparent 28%),
  linear-gradient(180deg, #1b2430 0%, var(--bg) 100%);
  color:var(--text);font-family:var(--sans);font-size:14px;height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* ── Topbar ── */
.topbar{display:flex;align-items:center;gap:12px;padding:0 16px;height:54px;background:rgba(30,38,48,.92);border-bottom:1px solid var(--border);flex-shrink:0;user-select:none;backdrop-filter:blur(10px)}
.logo{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-weight:700;font-size:15px;color:var(--accent)}
.logo-dot{width:7px;height:7px;background:var(--accent);border-radius:50%;box-shadow:0 0 7px var(--accent);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 7px var(--accent)}50%{opacity:.3;box-shadow:0 0 2px var(--accent)}}
.sep{width:1px;height:18px;background:var(--border2)}
.badge{font-family:var(--mono);font-size:12px;color:var(--text2);background:rgba(49,60,73,.9);border:1px solid var(--border2);border-radius:5px;padding:4px 9px}
.badge span{color:var(--accent);font-weight:600}
.topbar-right{margin-left:auto;display:flex;align-items:center;gap:7px}
.ws-dot{width:6px;height:6px;border-radius:50%;background:var(--text3);flex-shrink:0;transition:background .3s}
.ws-dot.ok{background:var(--green);box-shadow:0 0 5px var(--green)}
.ws-dot.err{background:var(--red)}
.ws-lbl{font-size:12px;color:var(--text3);font-family:var(--mono)}
.counter{font-family:var(--mono);font-size:12px;color:var(--text3);background:rgba(49,60,73,.9);border:1px solid var(--border);border-radius:5px;padding:4px 9px}
.counter b{color:var(--text2)}
.btn{display:flex;align-items:center;gap:6px;background:rgba(49,60,73,.9);border:1px solid var(--border2);border-radius:6px;color:var(--text2);font-size:12px;font-family:var(--mono);padding:7px 12px;cursor:pointer;transition:all .15s;white-space:nowrap}
.btn:hover{background:var(--bg3);color:var(--text)}
.btn.danger:hover{border-color:var(--red);color:var(--red)}

/* ── Main layout ── */
.layout{display:flex;flex:1;overflow:hidden}

/* ── Sidebar ── */
.sidebar{width:272px;background:rgba(30,38,48,.92);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}
.sb-head{padding:10px 12px;font-size:11px;font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}
/* toggle */
.toggle-wrap{display:flex;align-items:center;gap:5px;cursor:pointer}
.toggle-label{font-size:11px;color:var(--text3);font-family:var(--mono)}
.toggle{width:26px;height:14px;border-radius:7px;background:var(--bg4);border:1px solid var(--border2);position:relative;cursor:pointer;flex-shrink:0;transition:background .2s}
.toggle.on{background:rgba(0,230,118,.25);border-color:var(--green)}
.toggle-knob{position:absolute;width:8px;height:8px;border-radius:50%;background:var(--text3);top:2px;left:2px;transition:all .2s}
.toggle.on .toggle-knob{background:var(--green);left:14px}
/* device cards */
.device-scroll{overflow-y:auto;padding:6px;flex:1}
.device-scroll::-webkit-scrollbar{width:3px}
.device-scroll::-webkit-scrollbar-thumb{background:var(--border2)}
.d-card{background:rgba(39,49,61,.96);border:1px solid var(--border2);border-radius:10px;padding:10px 12px;margin-bottom:8px;transition:border-color .2s,background .15s}
.d-card.connected{border-color:rgba(0,230,118,.3)}
.d-card.error{border-color:rgba(255,68,68,.3)}
.d-card-top{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.d-icon{font-size:15px;flex-shrink:0}
.d-name{font-size:13px;color:var(--text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.d-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:var(--text3)}
.d-dot.connected{background:var(--green);box-shadow:0 0 4px var(--green)}
.d-dot.error{background:var(--red)}
.d-detail{font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:8px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.d-actions{display:flex;gap:4px;align-items:center}
.d-btn{font-family:var(--mono);font-size:11px;padding:5px 9px;border-radius:5px;border:1px solid var(--border2);background:var(--bg4);color:var(--text2);cursor:pointer;transition:all .15s}
.d-btn.conn:hover{border-color:var(--green);color:var(--green)}
.d-btn.disconn:hover{border-color:var(--red);color:var(--red)}
.d-refresh{margin-left:auto;font-size:13px;background:none;border:none;color:var(--text3);cursor:pointer;padding:2px 4px;transition:color .15s}
.d-refresh:hover{color:var(--accent)}
.empty-sb{padding:16px 12px;font-family:var(--mono);font-size:11px;color:var(--text3);text-align:center;line-height:1.8}
.scan-btn{display:block;width:100%;margin-top:8px;padding:7px;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;color:var(--text2);font-family:var(--mono);font-size:11px;cursor:pointer;transition:all .15s}
.scan-btn:hover{border-color:var(--accent);color:var(--accent)}
/* RN list */
.rn-list{padding:4px 6px 6px}
.rn-item{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;border:1px solid var(--border);margin-bottom:5px;background:var(--bg3)}
.rn-dot{width:5px;height:5px;border-radius:50%;background:var(--green);animation:pulse 2s infinite;flex-shrink:0}
.rn-lbl{font-family:var(--mono);font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-divider{border-bottom:1px solid var(--border)}

/* ── Right pane ── */
.right{display:flex;flex-direction:column;flex:1;overflow:hidden}

/* ── Filter bar ── */
.filterbar{display:flex;align-items:center;gap:9px;padding:10px 12px;background:rgba(30,38,48,.92);border-bottom:1px solid var(--border);flex-shrink:0}
.sw{position:relative;flex:1;max-width:280px}
.sw svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--text3);pointer-events:none}
.si{width:100%;background:rgba(22,27,34,.9);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:13px;padding:8px 10px 8px 29px;outline:none;transition:border-color .15s}
.si:focus{border-color:var(--accent)}.si::placeholder{color:var(--text3)}
.mf{display:flex;gap:3px}
.mf-btn{font-family:var(--mono);font-size:11px;font-weight:700;padding:5px 9px;border-radius:5px;border:1px solid var(--border);cursor:pointer;letter-spacing:.4px;background:var(--bg4);color:var(--text2);transition:all .15s}
.mf-btn:hover{color:var(--text2)}
.mf-btn.on.ALL{background:rgba(255,255,255,.06);border-color:var(--text2);color:var(--text)}
.mf-btn.on.GET{background:rgba(0,230,118,.1);border-color:var(--green);color:var(--green)}
.mf-btn.on.POST{background:rgba(0,212,255,.1);border-color:var(--accent);color:var(--accent)}
.mf-btn.on.PUT{background:rgba(255,152,0,.1);border-color:var(--orange);color:var(--orange)}
.mf-btn.on.PATCH{background:rgba(187,134,252,.1);border-color:var(--purple);color:var(--purple)}
.mf-btn.on.DELETE{background:rgba(255,68,68,.1);border-color:var(--red);color:var(--red)}

/* ── Content area ── */
.content{display:flex;flex:1;overflow:hidden}

/* ── Request list ── */
.req-list{width:42%;min-width:340px;border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0;background:rgba(22,27,34,.55)}
.req-list::-webkit-scrollbar{width:3px}
.req-list::-webkit-scrollbar-thumb{background:var(--border2)}
.req-item{display:flex;align-items:center;gap:9px;padding:12px 12px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s;position:relative;overflow:hidden}
.req-item::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:transparent;transition:background .15s}
.req-item:hover{background:var(--bg2)}
.req-item.active{background:var(--bg3)}.req-item.active::before{background:var(--accent)}
.req-item.is-err::before{background:var(--red)!important}
.req-item.new-in{animation:sIn .2s ease}
@keyframes sIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.mtag{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.4px;padding:3px 6px;border-radius:4px;flex-shrink:0;min-width:52px;text-align:center}
.m-GET{background:rgba(0,230,118,.12);color:var(--green)}
.m-POST{background:rgba(0,212,255,.12);color:var(--accent)}
.m-PUT{background:rgba(255,152,0,.12);color:var(--orange)}
.m-PATCH{background:rgba(187,134,252,.12);color:var(--purple)}
.m-DELETE{background:rgba(255,68,68,.12);color:var(--red)}
.m-OTHER,.m-HEAD,.m-OPTIONS,.m-CONNECT{background:rgba(255,255,255,.06);color:var(--text2)}
.tfill.GET{background:var(--green)}
.tfill.POST{background:var(--accent)}
.tfill.PUT{background:var(--orange)}
.tfill.PATCH{background:var(--purple)}
.tfill.DELETE{background:var(--red)}
.tfill.OTHER,.tfill.HEAD,.tfill.OPTIONS,.tfill.CONNECT{background:var(--text2)}
.req-info{flex:1;overflow:hidden;min-width:0}
.rurl{font-family:var(--mono);font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.45}
.rmeta{display:flex;gap:7px;margin-top:2px;align-items:center}
.rsrc{font-size:10px;color:var(--accent);font-family:var(--mono);padding:2px 5px;border-radius:999px;background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.22);flex-shrink:0}
.rhost{font-size:11px;color:var(--text3);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.rdur{font-size:11px;color:var(--text3);font-family:var(--mono);flex-shrink:0}
.tbar{height:2px;background:var(--border);border-radius:1px;margin-top:3px}
.tfill{height:100%;border-radius:1px;background:var(--accent);transition:width .3s}
.spill{font-family:var(--mono);font-size:11px;font-weight:600;padding:3px 6px;border-radius:4px;flex-shrink:0}
.s-1xx{background:rgba(255,255,255,.08);color:var(--text2)}
.s-2xx{background:rgba(0,230,118,.1);color:var(--green)}
.s-3xx{background:rgba(255,235,59,.1);color:var(--yellow)}
.s-4xx{background:rgba(255,152,0,.1);color:var(--orange)}
.s-5xx{background:rgba(255,68,68,.1);color:var(--red)}
.s-pending{background:rgba(255,255,255,.04);color:var(--text3)}
.s-err{background:rgba(255,68,68,.1);color:var(--red)}
.no-res{padding:36px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--text3)}

/* ── Detail ── */
.detail{flex:1;overflow-y:auto;background:rgba(22,27,34,.35);display:flex;flex-direction:column}
.detail::-webkit-scrollbar{width:3px}
.detail::-webkit-scrollbar-thumb{background:var(--border2)}
.detail-mobilebar{display:none;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border);background:rgba(30,38,48,.96);position:sticky;top:0;z-index:2}
.back-btn{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;color:var(--text2);padding:6px 10px;cursor:pointer}
.back-btn:hover{border-color:var(--accent);color:var(--accent)}
.detail-mobiletitle{font-family:var(--mono);font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px}
.empty-st{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text3);padding:40px}
.empty-icon{width:50px;height:50px;border:2px solid var(--border2);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px}
.empty-title{font-size:17px;font-weight:500;color:var(--text2)}
.empty-sub{font-family:var(--mono);font-size:12px;color:var(--text3);text-align:center;line-height:1.8}
.empty-code{background:var(--bg3);border:1px solid var(--border2);border-radius:9px;padding:14px 18px;font-family:var(--mono);font-size:12px;color:var(--text2);line-height:1.9;text-align:left}
.c{color:var(--text3)}.k{color:var(--accent)}.s{color:var(--green)}.n{color:var(--purple)}
.dh{padding:16px 18px 14px;border-bottom:1px solid var(--border);background:rgba(30,38,48,.92);flex-shrink:0}
.durl{font-family:var(--mono);font-size:13px;color:var(--text);word-break:break-all;line-height:1.6;margin-bottom:10px}
.durl .dm{color:var(--accent);font-weight:700;margin-right:5px}
.dh-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.dh-actions .cbtn{margin-left:0}
.dstats{display:flex;gap:14px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:2px}
.stat-l{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px}
.stat-v{font-family:var(--mono);font-size:13px;color:var(--text);font-weight:500}
.stat-v.ok{color:var(--green)}.stat-v.warn{color:var(--orange)}.stat-v.err{color:var(--red)}
.stat-v.src{color:var(--accent)}
.tabs{display:flex;border-bottom:1px solid var(--border);background:rgba(30,38,48,.92);flex-shrink:0;padding:0 12px}
.tab{padding:10px 13px;font-size:12px;font-family:var(--mono);color:var(--text2);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap}
.tab:hover{color:var(--text2)}.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.tb{display:inline-block;background:var(--bg4);border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px;color:var(--text3)}
.tab.active .tb{background:var(--accent);color:#000}
.tc{display:none;flex:1}.tc.active{display:flex;flex-direction:column;flex:1}
.sec{border-bottom:1px solid var(--border)}
.sec-h{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:pointer;user-select:none;background:rgba(30,38,48,.88);transition:background .1s}
.sec-h:hover{background:var(--bg3)}
.sec-t{font-size:11px;font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text2);display:flex;align-items:center;gap:5px}
.sec-cnt{font-size:10px;background:var(--bg4);border:1px solid var(--border2);border-radius:3px;padding:1px 5px;color:var(--text3)}
.sec-chev{color:var(--text3);transition:transform .2s;font-size:11px}
.sec-chev.open{transform:rotate(90deg)}
.sec-b{display:none}.sec-b.open{display:block}
.htable{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px}
.htable tr{border-bottom:1px solid var(--border)}
.htable tr:last-child{border-bottom:none}
.htable tr:hover td{background:var(--bg3)}
.htable td{padding:8px 14px;vertical-align:top}
.hkey{color:var(--text3);width:38%;word-break:break-all}
.hval{color:var(--text);word-break:break-all}
.bv{padding:14px;flex:1}
.btbar{display:flex;align-items:center;gap:7px;margin-bottom:8px}
.btype{font-family:var(--mono);font-size:11px;color:var(--purple);background:rgba(187,134,252,.1);border:1px solid rgba(187,134,252,.25);border-radius:5px;padding:3px 8px}
.bsize{font-family:var(--mono);font-size:11px;color:var(--text3)}
.cbtn{margin-left:auto;font-family:var(--mono);font-size:11px;background:var(--bg4);border:1px solid var(--border2);border-radius:5px;color:var(--text2);padding:5px 10px;cursor:pointer;transition:all .15s}
.cbtn:hover{color:var(--accent);border-color:var(--accent)}
.bpre{background:rgba(30,38,48,.92);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-family:var(--mono);font-size:12px;line-height:1.8;color:var(--text2);overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow-y:auto}
.bpre::-webkit-scrollbar{width:3px;height:3px}.bpre::-webkit-scrollbar-thumb{background:var(--border2)}
.jk{color:#7ecfff}.js{color:#98e4a0}.jn{color:#ffb86c}.jb{color:#ff79c6}.jnull{color:#6272a4}
.no-body{font-family:var(--mono);font-size:12px;color:var(--text3);padding:16px 14px;text-align:center}
.curl-tools{padding:14px;display:flex;flex-direction:column;gap:14px}
.curl-box{background:rgba(30,38,48,.92);border:1px solid var(--border);border-radius:8px;padding:12px 14px}
.curl-title{font-family:var(--mono);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text2);margin-bottom:10px}
.curl-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.curl-textarea{width:100%;min-height:160px;resize:vertical;background:rgba(22,27,34,.92);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-family:var(--mono);font-size:12px;line-height:1.7;padding:12px 14px;outline:none}
.curl-textarea:focus{border-color:var(--accent)}
.curl-note{font-family:var(--mono);font-size:11px;color:var(--text3);line-height:1.7}
.curl-preview-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.curl-preview-url{font-family:var(--mono);font-size:12px;color:var(--text);word-break:break-all;line-height:1.7}
.curl-err{font-family:var(--mono);font-size:12px;color:var(--red);background:rgba(255,68,68,.08);border:1px solid rgba(255,68,68,.2);border-radius:8px;padding:12px 14px}
.ptable{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px}
.ptable tr{border-bottom:1px solid var(--border)}.ptable tr:last-child{border-bottom:none}
.ptable tr:hover td{background:var(--bg3)}.ptable td{padding:8px 14px}
.pk{color:var(--yellow);width:35%;word-break:break-all}.pv{color:var(--text);word-break:break-all}
.tline{padding:12px}
.trow{display:flex;align-items:center;gap:9px;padding:5px 0;border-bottom:1px solid var(--border)}
.tlbl{font-family:var(--mono);font-size:11px;color:var(--text3);width:96px;flex-shrink:0}
.twrap{flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden}
.tbar2{height:100%;border-radius:3px}
.tms{font-family:var(--mono);font-size:11px;color:var(--text2);width:62px;text-align:right;flex-shrink:0}
.toast{position:fixed;bottom:18px;right:18px;background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:10px 16px;font-family:var(--mono);font-size:12px;color:var(--text);opacity:0;transform:translateY(6px);transition:all .2s;pointer-events:none;z-index:999}
.toast.show{opacity:1;transform:translateY(0)}
*{scrollbar-width:thin;scrollbar-color:var(--border2) transparent}
@media (max-width: 1180px){
  .topbar{flex-wrap:wrap;height:auto;padding:10px 14px}
  .topbar-right{width:100%;justify-content:flex-end}
  .layout{min-height:0}
  .sidebar{display:none}
  .req-list{width:100%;min-width:0;border-right:none}
  .detail{display:none}
  body.compact-detail-open .req-list{display:none}
  body.compact-detail-open .detail{display:flex;width:100%}
  body.compact-detail-open .detail-mobilebar{display:flex}
}
@media (max-width: 760px){
  .filterbar{flex-wrap:wrap}
  .sw{max-width:none;width:100%}
  .mf{flex-wrap:wrap}
  .tab{padding:10px 10px;font-size:11px}
}
</style>
</head>
<body>

<div class="topbar">
  <div class="logo"><div class="logo-dot"></div>React Native NetInspect</div>
  <div class="sep"></div>
  <div class="badge">Proxy <span>:${PROXY_PORT}</span></div>
  <div class="badge">Dashboard <span>:${DASHBOARD_PORT}</span></div>
  <div class="sep"></div>
  <div class="ws-dot" id="wsDot"></div>
  <div class="ws-lbl" id="wsLbl">connecting...</div>
  <div class="sep"></div>
  <div class="counter"><b id="reqCount">0</b> requests</div>
  <div class="topbar-right">
    <button class="btn" onclick="togglePause()"><span id="pIcon">⏸</span> <span id="pLbl">Pause</span></button>
    <button class="btn danger" onclick="clearAll()">✕ Clear</button>
  </div>
</div>

<div class="layout">
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sb-divider">
      <div class="sb-head">
        Simulators / Emulators
        <div class="toggle-wrap" onclick="toggleAuto()">
          <span class="toggle-label">Auto ADB</span>
          <div class="toggle on" id="autoToggle"><div class="toggle-knob"></div></div>
        </div>
      </div>
      <div class="device-scroll" id="deviceList">
        <div class="empty-sb">⟳ Scanning…<button class="scan-btn" onclick="triggerScan()">↺ Scan now</button></div>
      </div>
    </div>
    <div>
      <div class="sb-head">Metro / RN Apps</div>
      <div class="rn-list" id="rnList">
        <div class="empty-sb" style="padding:8px 10px">No processes found</div>
      </div>
    </div>
  </div>

  <!-- Right -->
  <div class="right">
    <div class="filterbar">
      <div class="sw">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input class="si" id="si" placeholder="Filter URL, host, status…" oninput="applyF()"/>
      </div>
      <div class="mf">
        <button class="mf-btn on ALL" data-m="ALL" onclick="filterM(this)">ALL</button>
        <button class="mf-btn GET"    data-m="GET"    onclick="filterM(this)">GET</button>
        <button class="mf-btn POST"   data-m="POST"   onclick="filterM(this)">POST</button>
        <button class="mf-btn PUT"    data-m="PUT"    onclick="filterM(this)">PUT</button>
        <button class="mf-btn PATCH"  data-m="PATCH"  onclick="filterM(this)">PATCH</button>
        <button class="mf-btn DELETE" data-m="DELETE" onclick="filterM(this)">DELETE</button>
      </div>
    </div>
    <div class="content">
      <div class="req-list" id="reqList"></div>
      <div class="detail" id="detail">
          <div class="empty-st">
          <div class="empty-icon">🔍</div>
          <div class="empty-title">Waiting for requests</div>
          <div class="empty-sub">Android can be auto-configured here.<br>iOS Simulator uses the Mac system proxy, so enabling it also captures host Mac traffic.</div>
          <div class="empty-code">
            <span class="c">// Android manual fallback:</span><br>
            <span class="n">adb</span> shell settings put global<br>
            &nbsp;&nbsp;http_proxy <span class="s">10.0.2.2:8899</span><br><br>
            <span class="c">// iOS Simulator uses macOS proxy settings</span><br>
            <span class="c">// "Enable Mac-wide" affects desktop traffic too</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
let allReqs=[], selId=null, activeM='ALL', searchQ='', paused=false, tabState={}, curlState={}, autoOn=true, ws, maxT=1;
const COMPACT_BREAKPOINT=1180;

function normReqId(id){return String(id)}
function isCompactLayout(){return window.innerWidth<=COMPACT_BREAKPOINT}
function openDetailPane(){if(isCompactLayout())document.body.classList.add('compact-detail-open')}
function closeDetailPane(){document.body.classList.remove('compact-detail-open')}
function syncLayoutMode(){
  document.body.classList.toggle('compact-layout',isCompactLayout());
  if(!isCompactLayout()||!selId)document.body.classList.remove('compact-detail-open');
}

function connectWS(){
  const dot=document.getElementById('wsDot'), lbl=document.getElementById('wsLbl');
  const wsProto=window.location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(wsProto+'//'+window.location.host+'/ws');
  ws.onopen=()=>{dot.className='ws-dot ok';lbl.textContent='live'};
  ws.onclose=()=>{dot.className='ws-dot err';lbl.textContent='disconnected';setTimeout(connectWS,2500)};
  ws.onerror=()=>{dot.className='ws-dot err';lbl.textContent='error'};
  ws.onmessage=(e)=>{
    const msg=JSON.parse(e.data);
    if(msg.type==='init'){allReqs=msg.data;renderList()}
    else if(msg.type==='request'){if(!paused){allReqs.unshift(msg.data);if(allReqs.length>500)allReqs.pop();renderList(msg.data.id)}}
    else if(msg.type==='update'){
      const i=allReqs.findIndex(r=>r.id===msg.data.id);
      if(i!==-1){allReqs[i]=msg.data;refreshItem(msg.data);if(normReqId(selId)===normReqId(msg.data.id))renderDetail(msg.data)}
    }
    else if(msg.type==='devices')renderDevices(msg.data);
    upCount();
  };
}

function renderDevices({devices,rnProcesses}){
  const dl=document.getElementById('deviceList'), rl=document.getElementById('rnList');
  if(!devices||devices.length===0){
    dl.innerHTML='<div class="empty-sb">No simulators/emulators found.<br>Physical devices register under Metro / RN Apps.<button class="scan-btn" onclick="triggerScan()">↺ Scan now</button></div>';
  } else {
    dl.innerHTML=devices.map(d=>{
      const icon=d.type==='ios'?'📱':'🤖';
      const sc=d.proxyStatus==='connected'?'connected':d.proxyStatus==='error'?'error':'';
          const dc=d.proxyStatus==='connected'?'connected':d.proxyStatus==='error'?'error':'';
          const isCon=d.proxyStatus==='connected';
          const connectLabel=d.type==='ios'?'⊕ Enable Mac-wide':'⊕ Connect';
          const disconnectLabel=d.type==='ios'?'⊗ Disable Mac-wide':'⊗ Disconnect';
      return \`<div class="d-card \${sc}">
        <div class="d-card-top"><span class="d-icon">\${icon}</span><span class="d-name">\${esc(d.name)}</span><span class="d-dot \${dc}"></span></div>
        <div class="d-detail" title="\${esc(d.detail||d.runtime||d.serial||'')}">\${esc(d.detail||d.runtime||d.serial||'')}</div>
        <div class="d-actions">
          \${isCon
            ? \`<button class="d-btn disconn" onclick="devAction('disconnect','\${d.id}')">\${disconnectLabel}</button>\`
            : \`<button class="d-btn conn" onclick="devAction('connect','\${d.id}')">\${connectLabel}</button>\`}
          <button class="d-refresh" onclick="triggerScan()" title="Refresh">↺</button>
        </div>
      </div>\`;
    }).join('');
  }
  if(!rnProcesses||rnProcesses.length===0){
    rl.innerHTML='<div class="empty-sb" style="padding:6px 8px">No Metro or app clients</div>';
  } else {
    rl.innerHTML=rnProcesses.map(p=>\`<div class="rn-item"><div class="rn-dot"></div><div class="rn-lbl" title="\${esc(p.label)}">\${esc(p.label)}</div></div>\`).join('');
  }
}

function devAction(action,id){
  fetch('/api/device',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,deviceId:id})})
    .then(r=>r.json()).then(d=>{
      if(!d.ok)return showToast('✗ '+(d.error||'Failed'));
      const dev=d.device||{};
      const msg=action==='connect'
        ? (dev.type==='ios'?'✓ Mac-wide proxy enabled':'✓ Proxy connected')
        : (dev.type==='ios'?'✓ Mac-wide proxy disabled':'✓ Disconnected');
      showToast(msg);
    })
    .catch(()=>showToast('✗ Request failed'));
}
function triggerScan(){fetch('/api/scan',{method:'POST'}).catch(()=>{});showToast('↺ Scanning…')}
function toggleAuto(){
  autoOn=!autoOn;
  document.getElementById('autoToggle').classList.toggle('on',autoOn);
  fetch('/api/autoconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:autoOn})});
  showToast(autoOn?'Android auto-connect on':'Android auto-connect off');
}

function filtered(){
  return allReqs.filter(r=>{
    if(activeM!=='ALL'&&r.method!==activeM)return false;
    if(searchQ){const q=searchQ.toLowerCase();const f=(r.host||'')+(r.path||'');return f.toLowerCase().includes(q)||String(r.status||'').includes(q)||r.method.toLowerCase().includes(q)}
    return true;
  });
}
function renderList(nid=null){
  const list=document.getElementById('reqList'), items=filtered();
  if(items.length===0){list.innerHTML='<div class="no-res">No requests match filters</div>';return}
  maxT=Math.max(1,...items.filter(r=>r.duration).map(r=>r.duration));
  list.innerHTML=items.map(r=>ihtml(r,r.id===nid)).join('');
  upCount();
}
function ihtml(r,isNew){
  const sc=r.error?'s-err':r.status?'s-'+String(r.status)[0]+'xx':'s-pending';
  const st=r.error?'ERR':r.status||'…';
  const mc='m-'+(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','CONNECT'].includes(r.method)?r.method:'OTHER');
  const path=r.path?(r.path.length>52?r.path.slice(0,52)+'…':r.path):'/';
  const host=r.host?(r.host.length>28?r.host.slice(0,28)+'…':r.host):'';
  const dur=r.duration?(r.duration<1000?r.duration+'ms':(r.duration/1000).toFixed(2)+'s'):'';
  const bp=r.duration?Math.max(3,(r.duration/maxT)*100):0;
  const isErr=r.error||(r.status&&r.status>=400);
  const sourceTag=r.source==='rn-direct'?'<span class="rsrc">RN</span>':r.source==='curl-import'?'<span class="rsrc">cURL</span>':'';
  const methodKey=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','CONNECT'].includes(r.method)?r.method:'OTHER';
  return \`<div class="req-item \${normReqId(selId)===normReqId(r.id)?'active':''} \${isErr?'is-err':''} \${isNew?'new-in':''}" data-id="\${r.id}" onclick="selReq('\${r.id}')">
    <span class="mtag \${mc}">\${r.method}</span>
    <div class="req-info">
      <div class="rurl">\${esc(path)}</div>
      <div class="rmeta">\${sourceTag}<span class="rhost">\${esc(host)}</span>\${dur?\`<span class="rdur">\${dur}</span>\`:''}</div>
      \${bp?\`<div class="tbar"><div class="tfill \${methodKey}" style="width:\${bp}%"></div></div>\`:''}
    </div>
    <span class="spill \${sc}">\${st}</span>
  </div>\`;
}
function refreshItem(r){
  const el=document.querySelector(\`[data-id="\${r.id}"]\`);
  if(!el)return;
  const tmp=document.createElement('div');
  tmp.innerHTML=ihtml(r,false);
  const ne=tmp.firstChild;
  ne.onclick=()=>selReq(r.id);
  el.replaceWith(ne);
}
function upCount(){document.getElementById('reqCount').textContent=allReqs.length}

function selReq(id){
  selId=normReqId(id);
  document.querySelectorAll('.req-item').forEach(e=>e.classList.toggle('active',e.dataset.id===normReqId(id)));
  const r=allReqs.find(x=>normReqId(x.id)===normReqId(id));if(r){renderDetail(r);openDetailPane()}
}
function renderDetail(r){
  const tab=tabState[normReqId(r.id)]||'request';
  const fullUrl=(r.scheme||'http')+'://'+(r.host||'')+(r.path||'');
  const authHeader=getHeaderValue(r.requestHeaders,'authorization');
  const sc=r.error?'err':!r.status?'':r.status<300?'ok':r.status<500?'warn':'err';
  const dur=r.duration?(r.duration<1000?r.duration+' ms':(r.duration/1000).toFixed(2)+'s'):'—';
  const size=r.responseSize?fmtB(r.responseSize):'—';
  const rqH=Object.keys(r.requestHeaders||{}).length, rsH=Object.keys(r.responseHeaders||{}).length;
  const sourceLabel=r.source==='rn-direct'?(r.transport==='xhr'?'RN XHR':'RN Fetch'):r.source==='curl-import'?'cURL':'Proxy';
  const tabs=[
    {key:'request',label:'Request',badge:rqH},
    {key:'response',label:'Response',badge:rsH},
    {key:'params',label:'Params'},
    {key:'timing',label:'Timing'},
    {key:'raw',label:'Raw'},
    {key:'curl',label:'cURL'},
  ];
  document.getElementById('detail').innerHTML=\`
    <div class="detail-mobilebar">
      <button class="back-btn" onclick="closeDetailPane()">← Back</button>
      <div class="detail-mobiletitle">Request Detail</div>
    </div>
    <div class="dh">
      <div class="durl"><span class="dm">\${r.method}</span>\${esc(fullUrl)}</div>
      <div class="dh-actions">
        <button class="cbtn" onclick="cpTxt(\\\`\${esc(fullUrl)}\\\`)">Copy URL</button>
        \${authHeader?\`<button class="cbtn" onclick="copyAuth('\${r.id}')">Copy Auth</button>\`:''}
      </div>
      <div class="dstats">
        <div class="stat"><div class="stat-l">Status</div><div class="stat-v \${sc}">\${r.error?'Error':r.status||'Pending'}</div></div>
        <div class="stat"><div class="stat-l">Duration</div><div class="stat-v">\${dur}</div></div>
        <div class="stat"><div class="stat-l">Size</div><div class="stat-v">\${size}</div></div>
        <div class="stat"><div class="stat-l">Protocol</div><div class="stat-v">\${(r.scheme||'http').toUpperCase()}</div></div>
        <div class="stat"><div class="stat-l">Source</div><div class="stat-v src">\${sourceLabel}</div></div>
        <div class="stat"><div class="stat-l">Time</div><div class="stat-v">\${r.startTime?new Date(r.startTime).toLocaleTimeString():'—'}</div></div>
      </div>
    </div>
    <div class="tabs">
      \${tabs.map(t=>\`<div class="tab \${tab===t.key?'active':''}" onclick="setT('\${r.id}','\${t.key}')">\${t.label}\${t.badge!=null?\`<span class="tb">\${t.badge}</span>\`:''}</div>\`).join('')}
    </div>
    <div class="tc \${tab==='request'?'active':''}">\${hSec('Request Headers',r.requestHeaders)}\${bSec('Request Body',r.requestBody,r.requestHeaders)}</div>
    <div class="tc \${tab==='response'?'active':''}">\${hSec('Response Headers',r.responseHeaders)}\${bSec('Response Body',r.responseBody,r.responseHeaders)}</div>
    <div class="tc \${tab==='params'?'active':''}">\${pSec(r.path)}</div>
    <div class="tc \${tab==='timing'?'active':''}">\${tSec(r)}</div>
    <div class="tc \${tab==='raw'?'active':''}">\${rawSec(r)}</div>
    <div class="tc \${tab==='curl'?'active':''}">\${curlSec(r)}</div>
  \`;
}
function setT(id,t){tabState[normReqId(id)]=t;const r=allReqs.find(x=>normReqId(x.id)===normReqId(id));if(r)renderDetail(r)}
function hSec(title,headers){
  const entries=Object.entries(headers||{});
  return \`<div class="sec"><div class="sec-h" onclick="togSec(this)"><div class="sec-t">\${title}<span class="sec-cnt">\${entries.length}</span></div><span class="sec-chev open">▶</span></div>
    <div class="sec-b open">\${entries.length===0?'<div class="no-body">No headers</div>':\`<table class="htable">\${entries.map(([k,v])=>\`<tr><td class="hkey">\${esc(k)}</td><td class="hval">\${esc(String(v))}</td></tr>\`).join('')}</table>\`}</div></div>\`;
}
function bSec(title,body,headers){
  const ct=(headers&&(headers['content-type']||headers['Content-Type']))||'';
  if(!body)return\`<div class="sec"><div class="sec-h" onclick="togSec(this)"><div class="sec-t">\${title}</div><span class="sec-chev open">▶</span></div><div class="sec-b open"><div class="no-body">No body</div></div></div>\`;
  const isJ=ct.includes('json');
  let rendered='',tl='text/plain';
  if(isJ){tl='application/json';try{rendered=hlJ(JSON.stringify(typeof body==='string'?JSON.parse(body):body,null,2))}catch{rendered=esc(body)}}
  else rendered=esc(String(body));
  const raw=typeof body==='string'?body:JSON.stringify(body,null,2);
  const sz=new Blob([raw]).size;
  return\`<div class="sec"><div class="sec-h" onclick="togSec(this)"><div class="sec-t">\${title}</div><span class="sec-chev open">▶</span></div>
    <div class="sec-b open"><div class="bv"><div class="btbar"><span class="btype">\${tl}</span><span class="bsize">\${fmtB(sz)}</span><button class="cbtn" onclick="cpTxt(\\\`\${esc(raw)}\\\`)">Copy</button></div><pre class="bpre">\${rendered}</pre></div></div></div>\`;
}
function pSec(path){
  if(!path)return'<div class="no-body">No URL</div>';
  try{const u=new URL('http://x'+path);const params=[...u.searchParams.entries()];
    return\`<div class="sec"><div class="sec-h" onclick="togSec(this)"><div class="sec-t">Query String<span class="sec-cnt">\${params.length}</span></div><span class="sec-chev open">▶</span></div>
      <div class="sec-b open">\${params.length===0?'<div class="no-body">No query params</div>':\`<table class="ptable">\${params.map(([k,v])=>\`<tr><td class="pk">\${esc(k)}</td><td class="pv">\${esc(v)}</td></tr>\`).join('')}</table>\`}</div></div>
      <div class="sec"><div class="sec-h" onclick="togSec(this)"><div class="sec-t">Path</div><span class="sec-chev open">▶</span></div>
      <div class="sec-b open"><div style="padding:8px 12px;font-family:var(--mono);font-size:10px;color:var(--text2)">\${esc(u.pathname)}</div></div></div>\`;
  }catch{return\`<div class="bv"><pre class="bpre">\${esc(path)}</pre></div>\`}}
function tSec(r){
  if(!r.startTime)return'<div class="no-body" style="padding:16px">No timing data</div>';
  const total=r.duration||0;
  const row=(lbl,ms,col)=>{const p=total>0?Math.max(1,(ms/total)*100):0;const d=ms<1000?ms+'ms':(ms/1000).toFixed(2)+'s';
    return\`<div class="trow"><div class="tlbl">\${lbl}</div><div class="twrap"><div class="tbar2" style="width:\${p}%;background:\${col}"></div></div><div class="tms">\${d}</div></div>\`};
  return\`<div class="tline">\${row('Connect',r.connectTime||0,'#00d4ff')}\${row('Wait (TTFB)',r.waitTime||0,'#ffeb3b')}\${row('Receive',r.receiveTime||0,'#00e676')}\${row('Total',total,'#ff9800')}</div>\`;
}
function rawSec(r){
  const rqH=Object.entries(r.requestHeaders||{}).map(([k,v])=>\`\${k}: \${v}\`).join('\\n');
  const rqB=r.requestBody?'\\n\\n'+(typeof r.requestBody==='string'?r.requestBody:JSON.stringify(r.requestBody,null,2)):'';
  const rsL=r.status?\`HTTP/1.1 \${r.status}\`:'Pending...';
  const rsH=Object.entries(r.responseHeaders||{}).map(([k,v])=>\`\${k}: \${v}\`).join('\\n');
  const rsB=r.responseBody?'\\n\\n'+(typeof r.responseBody==='string'?r.responseBody:JSON.stringify(r.responseBody,null,2)):'';
  const rawRq=\`\${r.method} \${r.path||'/'} HTTP/1.1\\n\${rqH}\${rqB}\`;
  const rawRs=\`\${rsL}\\n\${rsH}\${rsB}\`;
  return\`<div class="bv"><div class="btbar"><span class="btype">RAW REQUEST</span><button class="cbtn" onclick="cpTxt(\\\`\${esc(rawRq)}\\\`)">Copy</button></div><pre class="bpre">\${esc(rawRq)}</pre></div>
    <div class="bv" style="border-top:1px solid var(--border)"><div class="btbar"><span class="btype">RAW RESPONSE</span><button class="cbtn" onclick="cpTxt(\\\`\${esc(rawRs)}\\\`)">Copy</button></div><pre class="bpre">\${esc(rawRs)}</pre></div>\`;
}
function shellQuote(v){return "'" + String(v==null?'':v).replace(/'/g,"'\\''") + "'"}
function bodyText(v){return typeof v==='string'?v:JSON.stringify(v,null,2)}
function buildCurlCommand(r){
  const flags=[];
  const fullUrl=(r.scheme||'http')+'://'+(r.host||'')+(r.path||'');
  const method=String(r.method||'GET').toUpperCase();
  if(method!=='GET')flags.push('-X '+method);
  for(const [k,v] of Object.entries(r.requestHeaders||{})){
    const nk=String(k).toLowerCase();
    if(['host','content-length','proxy-connection'].includes(nk))continue;
    flags.push('-H '+shellQuote(k+': '+String(v)));
  }
  if(r.requestBody!=null&&method!=='GET'&&method!=='HEAD')flags.push('--data-raw '+shellQuote(bodyText(r.requestBody)));
  flags.push(shellQuote(fullUrl));
  if(flags.length===1)return 'curl '+flags[0];
  return ['curl \\\\',...flags.slice(0,-1).map(f=>'  '+f+' \\\\'),'  '+flags[flags.length-1]].join('\\n');
}
function getCurlState(id){
  const key=normReqId(id);
  if(!curlState[key])curlState[key]={input:'',parsed:null,error:''};
  return curlState[key];
}
function setCurlInput(id,v){getCurlState(id).input=v}
async function pasteCurl(id){
  try{
    const text=await navigator.clipboard.readText();
    const key=normReqId(id), st=getCurlState(key), el=document.getElementById('curlInput-'+key);
    st.input=text;
    if(el)el.value=text;
    showToast('cURL pasted');
  }catch{showToast('Clipboard read blocked')}
}
function splitShellArgs(input){
  const src=String(input||'').replace(/\\\\\\r?\\n/g,' ').trim();
  const out=[];let cur='',quote='',escm=false;
  for(let i=0;i<src.length;i++){
    const ch=src[i];
    if(escm){cur+=ch;escm=false;continue}
    if(quote==="'" ){if(ch===quote)quote='';else cur+=ch;continue}
    if(quote==='"'){if(ch==='\\\\'){escm=true;continue}if(ch===quote)quote='';else cur+=ch;continue}
    if(ch==='\\\\'){escm=true;continue}
    if(ch==="'"||ch==='"'){quote=ch;continue}
    if(/\\s/.test(ch)){if(cur){out.push(cur);cur=''}continue}
    cur+=ch;
  }
  if(escm)cur+='\\\\';
  if(quote)return{error:'Unclosed quote in cURL command'};
  if(cur)out.push(cur);
  return{tokens:out};
}
function parseCurlCommand(input){
  const split=splitShellArgs(input);
  if(split.error)return{error:split.error};
  const tokens=split.tokens||[];
  if(tokens.length===0)return{error:'Paste a cURL command first'};
  if(tokens[0]!=='curl')return{error:'Command must start with curl'};
  let method='',targetUrl='',body=null,user=null,headOnly=false;
  const headers={};const bodies=[];
  for(let i=1;i<tokens.length;i++){
    const t=tokens[i];
    const next=()=>tokens[++i]||'';
    if(t==='-X'||t==='--request'){method=String(next()||'GET').toUpperCase();continue}
    if(t==='-H'||t==='--header'){
      const raw=next();const idx=raw.indexOf(':');
      if(idx===-1)return{error:'Invalid header: '+raw};
      headers[raw.slice(0,idx).trim()]=raw.slice(idx+1).trim();
      continue
    }
    if(['-d','--data','--data-raw','--data-binary','--data-ascii','--data-urlencode'].includes(t)){bodies.push(next());continue}
    if(t==='--url'){targetUrl=next();continue}
    if(t==='-u'||t==='--user'){user=next();continue}
    if(t==='-A'||t==='--user-agent'){headers['User-Agent']=next();continue}
    if(t==='-I'||t==='--head'){headOnly=true;continue}
    if(t==='-k'||t==='--insecure'||t==='-L'||t==='--location'||t==='-s'||t==='--silent'||t==='--compressed'||t==='-i'||t==='--include')continue
    if(/^https?:\\/\\//i.test(t)&&!targetUrl){targetUrl=t;continue}
  }
  if(headOnly)method='HEAD';
  if(bodies.length>0){body=bodies.join('&');if(!method)method='POST'}
  if(!method)method='GET';
  if(user&&!headers.Authorization)headers.Authorization='Basic '+btoa(user);
  if(!targetUrl)return{error:'No URL found in cURL command'};
  try{new URL(targetUrl)}catch{return{error:'Invalid URL in cURL command'}}
  return{parsed:{method,url:targetUrl,headers,body}};
}
function buildNormalizedCurlFromParsed(parsed){
  const parsedUrl=new URL(parsed.url);
  const defaultPort=String(parsedUrl.protocol==='https:'?443:80);
  return buildCurlCommand({
    method:parsed.method,
    scheme:parsedUrl.protocol.replace(':',''),
    host:parsedUrl.port&&parsedUrl.port!==defaultPort
      ? parsedUrl.hostname+':'+parsedUrl.port
      : parsedUrl.hostname,
    path:(parsedUrl.pathname||'/')+(parsedUrl.search||''),
    requestHeaders:parsed.headers,
    requestBody:parsed.body,
  });
}
function copyNormalizedParsedCurl(id){
  const st=getCurlState(id);
  if(!st.parsed)return showToast('Parse a cURL command first');
  return cpTxt(buildNormalizedCurlFromParsed(st.parsed));
}
function curlPreviewMarkup(id,parsed){
  const headerCount=Object.keys(parsed.headers||{}).length;
  return \`<div class="curl-box"><div class="curl-preview-head"><div class="curl-title">Parsed cURL</div><button class="cbtn" onclick="copyNormalizedParsedCurl('\${id}')">Copy Normalized</button></div><div class="curl-preview-url"><span class="dm">\${esc(parsed.method)}</span> \${esc(parsed.url)}</div></div>\${hSec('Parsed Headers',parsed.headers)}\${headerCount===0&&parsed.body==null?'<div class="curl-note">No headers or body detected from the pasted command.</div>':''}\${bSec('Parsed Body',parsed.body,parsed.headers)}</div>\`;
}
function parseCurlIntoState(id){
  const st=getCurlState(id), res=parseCurlCommand(st.input);
  if(res.error){st.error=res.error;st.parsed=null}else{st.error='';st.parsed=res.parsed}
  const r=allReqs.find(x=>normReqId(x.id)===normReqId(id));if(r)renderDetail(r)
}
function curlSec(r){
  const key=normReqId(r.id), st=getCurlState(key), cmd=buildCurlCommand(r);
  return \`<div class="curl-tools">
    <div class="curl-box">
      <div class="curl-title">Generated cURL</div>
      <div class="curl-actions">
        <button class="cbtn" onclick="copyCurl('\${key}')">Copy cURL</button>
      </div>
      <pre class="bpre" id="curlCmd-\${key}">\${esc(cmd)}</pre>
    </div>
    <div class="curl-box">
      <div class="curl-title">Paste cURL</div>
      <div class="curl-actions">
        <button class="cbtn" onclick="pasteCurl('\${key}')">Paste From Clipboard</button>
        <button class="cbtn" onclick="parseCurlIntoState('\${key}')">Parse cURL</button>
      </div>
      <textarea class="curl-textarea" id="curlInput-\${key}" placeholder="Paste a curl command here to inspect its method, URL, headers, and body" oninput="setCurlInput('\${key}',this.value)">\${esc(st.input||'')}</textarea>
      <div class="curl-note">This parser is intended for common cURL commands like <code>-X</code>, <code>-H</code>, <code>--data</code>, <code>--url</code>, and inline URLs.</div>
    </div>
    \${st.error?\`<div class="curl-err">\${esc(st.error)}</div>\`:''}
    \${st.parsed?curlPreviewMarkup(key,st.parsed):''}
  </div>\`;
}
function copyCurl(id){const r=allReqs.find(x=>normReqId(x.id)===normReqId(id));if(r)cpTxt(buildCurlCommand(r))}
function getHeaderValue(headers,name){
  for(const [k,v] of Object.entries(headers||{})){if(String(k).toLowerCase()===String(name).toLowerCase())return v}
  return ''
}
function copyAuth(id){
  const r=allReqs.find(x=>normReqId(x.id)===normReqId(id));
  const auth=r?getHeaderValue(r.requestHeaders,'authorization'):'';
  if(auth)return cpTxt(String(auth));
  showToast('Authorization header not found');
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\`/g,'&#96;')}
function fmtB(b){if(!b)return'0 B';if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(2)+' MB'}
function hlJ(j){return j.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,m=>{let c='jn';if(/^"/.test(m))c=/:$/.test(m)?'jk':'js';else if(/true|false/.test(m))c='jb';else if(/null/.test(m))c='jnull';return\`<span class="\${c}">\${esc(m)}</span>\`})}
function togSec(h){const b=h.nextElementSibling;const ch=h.querySelector('.sec-chev');ch.classList.toggle('open',b.classList.toggle('open'))}
function applyF(){searchQ=document.getElementById('si').value;renderList()}
function filterM(btn){document.querySelectorAll('.mf-btn').forEach(b=>b.classList.remove('on'));btn.classList.add('on');activeM=btn.dataset.m;applyF()}
function togglePause(){paused=!paused;document.getElementById('pIcon').textContent=paused?'▶':'⏸';document.getElementById('pLbl').textContent=paused?'Resume':'Pause';showToast(paused?'Paused':'Resumed')}
function clearAll(){allReqs=[];selId=null;closeDetailPane();renderList();document.getElementById('detail').innerHTML='<div class="empty-st"><div class="empty-icon">✓</div><div class="empty-title">Cleared</div></div>';upCount();fetch('/api/clear',{method:'POST'})}
function cpTxt(t){navigator.clipboard.writeText(t).then(()=>showToast('Copied!'))}
let toastT;
function showToast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2200)}
window.addEventListener('resize',syncLayoutMode);
syncLayoutMode();
connectWS();
</script>
</body>
</html>`;

// ─── Dashboard server ─────────────────────────────────────────────────────────
const dashboardServer = http.createServer(async (req, res) => {
  const p = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');

  const readJSON = () => new Promise(resolve => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch { resolve({}); } });
  });

  if ((p.pathname === '/' || p.pathname === '/index.html') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML); return;
  }
  if (p.pathname === '/api/clear' && req.method === 'POST') {
    requests.length = 0;
    directRequestIds.clear();
    res.writeHead(200); res.end('{}'); return;
  }
  if (p.pathname === '/api/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(requests.slice(0, 200))); return;
  }
  if (p.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      dashboardPort: DASHBOARD_PORT,
      proxyPort: PROXY_PORT,
      requests: requests.length,
      timestamp: Date.now(),
    })); return;
  }
  if (p.pathname === '/api/register' && req.method === 'POST') {
    const b = await readJSON();
    const app = registerAppClient(b, req);
    broadcastDevices();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app, ttlMs: APP_STALE_MS })); return;
  }
  if (p.pathname === '/api/device' && req.method === 'POST') {
    const b = await readJSON();
    const result = await handleDeviceAction(b.action, b.deviceId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result)); return;
  }
  if (p.pathname === '/api/ingest' && req.method === 'POST') {
    const b = await readJSON();
    const result = ingestDirectEvent(b, req);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result)); return;
  }
  if (p.pathname === '/api/scan' && req.method === 'POST') {
    scanAndAutoConnect();
    res.writeHead(200); res.end('{}'); return;
  }
  if (p.pathname === '/api/autoconnect' && req.method === 'POST') {
    const b = await readJSON();
    autoConnectEnabled = !!b.enabled;
    res.writeHead(200); res.end('{}'); return;
  }
  res.writeHead(404); res.end('Not found');
});

dashboardServer.on('upgrade', (req, socket) => {
  if (req.url === '/ws') upgradeToWS(req, socket);
  else socket.destroy();
});

// ─── Proxy server ─────────────────────────────────────────────────────────────
function collectBody(req) {
  return new Promise(resolve => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}
function parseBody(buf, ct) {
  if (!buf || buf.length === 0) return null;
  const s = buf.toString('utf8');
  if (ct && ct.includes('json')) { try { return JSON.parse(s); } catch { return s; } }
  return s;
}

const proxyServer = http.createServer(async (req, res) => {
  const startTime = Date.now(), id = ++requestIdCounter;
  let targetHost, targetPort, targetPath, scheme;
  try {
    const parsed = url.parse(req.url);
    if (parsed.protocol) {
      scheme = parsed.protocol.replace(':', '');
      targetHost = parsed.hostname;
      targetPort = parsed.port ? parseInt(parsed.port) : (scheme === 'https' ? 443 : 80);
      targetPath = parsed.path || '/';
    } else {
      scheme = 'http';
      const [h, p2] = (req.headers.host || '').split(':');
      targetHost = h; targetPort = p2 ? parseInt(p2) : 80; targetPath = req.url;
    }
  } catch { res.writeHead(400); res.end('Bad Request'); return; }

  const entry = {
    id, method: req.method, scheme,
    host: targetHost + (targetPort !== 80 && targetPort !== 443 ? ':' + targetPort : ''),
    path: targetPath, startTime,
    requestHeaders: { ...req.headers }, requestBody: null,
    status: null, responseHeaders: {}, responseBody: null,
    duration: null, responseSize: 0, error: null,
    connectTime: 0, waitTime: 0, receiveTime: 0,
  };
  if (isInspectorControlRequest(entry)) {
    const reqBuf = await collectBody(req);
    const isHTTPS = scheme === 'https' || targetPort === 443;
    const transport = isHTTPS ? https : http;
    const pReq = transport.request({
      hostname: targetHost, port: targetPort, path: targetPath,
      method: req.method, headers: { ...req.headers, host: targetHost },
      rejectUnauthorized: false,
    }, (pRes) => {
      const chunks = [];
      pRes.on('data', c => chunks.push(c));
      pRes.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!res.headersSent) { res.writeHead(pRes.statusCode, pRes.headers); res.end(buf); }
      });
      pRes.on('error', e => {
        if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
      });
    });
    pReq.on('error', e => {
      if (!res.headersSent) { res.writeHead(502); res.end('Proxy error: ' + e.message); }
    });
    if (reqBuf.length > 0) pReq.write(reqBuf);
    pReq.end();
    return;
  }
  addRequest(entry);

  const reqBuf = await collectBody(req);
  if (reqBuf.length > 0) {
    entry.requestBody = parseBody(reqBuf, req.headers['content-type']);
    updateRequest(id, { requestBody: entry.requestBody });
  }

  const isHTTPS = scheme === 'https' || targetPort === 443;
  const transport = isHTTPS ? https : http;
  const t0 = Date.now();

  const pReq = transport.request({
    hostname: targetHost, port: targetPort, path: targetPath,
    method: req.method, headers: { ...req.headers, host: targetHost },
    rejectUnauthorized: false,
  }, (pRes) => {
    const t1 = Date.now();
    entry.connectTime = t1 - t0;
    const chunks = [];
    pRes.on('data', c => chunks.push(c));
    pRes.on('end', () => {
      const t2 = Date.now();
      const buf = Buffer.concat(chunks);
      const ct = pRes.headers['content-type'] || '';
      let body = buf.toString('utf8');
      if (ct.includes('json')) { try { body = JSON.parse(body); } catch {} }
      else if (body.length > 50000) body = body.slice(0, 50000) + '\n…[truncated]';
      entry.status = pRes.statusCode; entry.responseHeaders = pRes.headers;
      entry.responseBody = body; entry.responseSize = buf.length;
      entry.duration = t2 - startTime; entry.waitTime = t1 - t0; entry.receiveTime = t2 - t1;
      updateRequest(id, { status: entry.status, responseHeaders: entry.responseHeaders,
        responseBody: entry.responseBody, responseSize: entry.responseSize,
        duration: entry.duration, connectTime: entry.connectTime,
        waitTime: entry.waitTime, receiveTime: entry.receiveTime });
      if (!res.headersSent) { res.writeHead(pRes.statusCode, pRes.headers); res.end(buf); }
    });
    pRes.on('error', e => {
      entry.error = e.message; entry.duration = Date.now() - startTime;
      updateRequest(id, { error: entry.error, duration: entry.duration });
      if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
    });
  });
  pReq.on('error', e => {
    entry.error = e.message; entry.duration = Date.now() - startTime;
    updateRequest(id, { error: entry.error, duration: entry.duration });
    if (!res.headersSent) { res.writeHead(502); res.end('Proxy error: ' + e.message); }
  });
  if (reqBuf.length > 0) pReq.write(reqBuf);
  pReq.end();
});

proxyServer.on('connect', (req, cSocket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr) || 443;
  const startTime = Date.now(), id = ++requestIdCounter;
  const entry = {
    id, method: 'CONNECT', scheme: 'https', host: host + ':' + port, path: '/', startTime,
    requestHeaders: { ...req.headers }, requestBody: null, status: 200,
    responseHeaders: {}, responseBody: null, duration: null, responseSize: 0, error: null,
    connectTime: 0, waitTime: 0, receiveTime: 0,
  };
  addRequest(entry);
  const sSocket = net.connect(port, host, () => {
    entry.connectTime = Date.now() - startTime;
    updateRequest(id, { status: 200, connectTime: entry.connectTime });
    cSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    sSocket.write(head); sSocket.pipe(cSocket); cSocket.pipe(sSocket);
    sSocket.on('end', () => { entry.duration = Date.now() - startTime; updateRequest(id, { duration: entry.duration }); });
  });
  sSocket.on('error', e => {
    entry.error = e.message; entry.duration = Date.now() - startTime;
    updateRequest(id, { error: entry.error, duration: entry.duration }); cSocket.destroy();
  });
  cSocket.on('error', () => sSocket.destroy());
});

// ─── Start ────────────────────────────────────────────────────────────────────
dashboardServer.listen(DASHBOARD_PORT, "0.0.0.0", () => {
  inspectorLog(`Dashboard running at http://localhost:${DASHBOARD_PORT}`);
  inspectorLog(`Device proxy listening on 127.0.0.1:${PROXY_PORT}`);
  inspectorLog('Auto-detecting simulators, emulators, and Metro processes');
  scanAndAutoConnect();
  setInterval(scanAndAutoConnect, SCAN_INTERVAL);
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
  inspectorLog(`Proxy server listening on 0.0.0.0:${PROXY_PORT}`);
  inspectorLog(`Scanning every ${SCAN_INTERVAL / 1000}s for new devices`);
});
proxyServer.on('error', e => inspectorError(`Proxy error: ${e.message}`));

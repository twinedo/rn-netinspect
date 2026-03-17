let ReactNative;
try {
  ReactNative = require('react-native');
} catch {
  ReactNative = null;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[96m',
  yellow: '\x1b[93m',
};

function supportsColor() {
  if (typeof global !== 'undefined' && global.__RN_INSPECTOR_NO_COLOR__) return false;
  if (typeof process !== 'undefined' && process.env && process.env.NO_COLOR) return false;
  return true;
}

function inspectorPrefix() {
  const label = '[RN NetInspect]';
  if (!supportsColor()) return label;
  return `${ANSI.bold}${ANSI.cyan}${label}${ANSI.reset}`;
}

function inspectorInfo(message) {
  if (typeof console !== 'undefined' && typeof console.log === 'function') {
    console.log(`${inspectorPrefix()} ${message}`);
  }
}

function inspectorWarn(message) {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    const body = supportsColor() ? `${ANSI.yellow}${message}${ANSI.reset}` : message;
    console.warn(`${inspectorPrefix()} ${body}`);
  }
}

function normalizeHeaders(input) {
  if (!input) return {};
  if (typeof input.forEach === 'function') {
    const headers = {};
    input.forEach((value, key) => { headers[key] = value; });
    return headers;
  }
  if (Array.isArray(input)) {
    return input.reduce((acc, pair) => {
      if (Array.isArray(pair) && pair.length >= 2) acc[pair[0]] = pair[1];
      return acc;
    }, {});
  }
  if (typeof input === 'object') return { ...input };
  return {};
}

function serializeBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (typeof body === 'object') {
    try { return JSON.stringify(body); } catch { return String(body); }
  }
  return String(body);
}

function parseRawHeaders(rawHeaders) {
  if (!rawHeaders) return {};
  return rawHeaders
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((acc, line) => {
      const idx = line.indexOf(':');
      if (idx !== -1) acc[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      return acc;
    }, {});
}

function makeRequestKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeUrlValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : '';
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function resolveSourceScriptUrl() {
  const sourceCode = ReactNative && ReactNative.NativeModules
    ? ReactNative.NativeModules.SourceCode
    : null;
  const candidates = [
    global.__RN_INSPECTOR_SCRIPT_URL__,
    sourceCode && sourceCode.scriptURL,
    sourceCode && sourceCode.bundleURL,
    global.location && global.location.href,
  ];

  return candidates.find(value => typeof value === 'string' && /^https?:\/\//i.test(value)) || '';
}

function extractHostnameFromUrl(value) {
  try {
    return new URL(String(value)).hostname || '';
  } catch {
    return '';
  }
}

function resolveInspectorTargets(explicitUrl) {
  const explicit = normalizeUrlValue(explicitUrl);
  const override = normalizeUrlValue(global.__RN_INSPECTOR_BASE_URL__);
  const sourceScriptUrl = resolveSourceScriptUrl();
  const sourceHost = extractHostnameFromUrl(sourceScriptUrl);
  const platform = ReactNative && ReactNative.Platform ? ReactNative.Platform.OS : null;
  const candidates = uniqueValues([
    explicit,
    override,
    sourceHost ? `http://${sourceHost}:5555` : '',
    platform === 'android' ? 'http://10.0.2.2:5555' : '',
    'http://127.0.0.1:5555',
  ]);

  return {
    candidates,
    sourceHost,
    usedFallbackOnly: !explicit && !override && !sourceHost,
  };
}

function detectRuntimeHost(sourceHost) {
  if (sourceHost) return sourceHost;
  const override = global.__RN_INSPECTOR_RUNTIME_HOST__;
  if (typeof override === 'string' && override.trim()) return override.trim();
  const platform = ReactNative && ReactNative.Platform ? ReactNative.Platform.OS : null;
  return platform || 'unknown';
}

function installRNNetInspect({
  inspectorUrl,
  appName = 'React Native',
  captureBodies = true,
  patchFetch = true,
  patchXHR = true,
} = {}) {
  if (global.__RN_INSPECTOR_UNINSTALL__) return global.__RN_INSPECTOR_UNINSTALL__;

  const originalFetch = global.fetch ? global.fetch.bind(global) : null;
  const OriginalXHR = global.XMLHttpRequest;
  const platform = ReactNative && ReactNative.Platform ? ReactNative.Platform.OS || 'unknown' : 'unknown';
  const { candidates: inspectorBaseUrls, sourceHost, usedFallbackOnly } = resolveInspectorTargets(inspectorUrl);
  let activeBaseUrl = inspectorBaseUrls[0] || 'http://127.0.0.1:5555';
  let announcedBaseUrl = '';
  let didWarnMissingServer = false;
  let resolveBaseUrlPromise = null;
  let lastHealthError = '';
  const runtimeHost = detectRuntimeHost(sourceHost);
  const installId = makeRequestKey('install');

  const isInspectorRequest = target => typeof target === 'string' && inspectorBaseUrls.some(baseUrl => target.startsWith(baseUrl));

  const announceBaseUrl = baseUrl => {
    if (!baseUrl || announcedBaseUrl === baseUrl) return;
    announcedBaseUrl = baseUrl;
    inspectorInfo(`Forwarding requests to ${baseUrl}`);
  };

  const formatError = error => {
    if (!error) return 'unknown error';
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    try { return JSON.stringify(error); } catch { return String(error); }
  };

  const warnMissingServer = () => {
    if (didWarnMissingServer) return;
    didWarnMissingServer = true;
    const detail = lastHealthError ? ` Last error: ${lastHealthError}.` : '';
    inspectorWarn(
      `Server not reachable. Tried ${inspectorBaseUrls.join(', ')}.${detail} ` +
      `Start the dashboard/backend before expecting request capture.`
    );
  };

  if (usedFallbackOnly) {
    inspectorWarn(
      'Metro host could not be detected automatically. ' +
      'This fallback works for simulators/emulators, but physical devices should pass ' +
      'inspectorUrl like http://<your-computer-lan-ip>:5555.'
    );
  }

  const ensureReachableBaseUrl = () => {
    if (!originalFetch) {
      lastHealthError = 'global.fetch is unavailable';
      return Promise.resolve(null);
    }
    if (resolveBaseUrlPromise) return resolveBaseUrlPromise;

    resolveBaseUrlPromise = (async () => {
      for (const baseUrl of uniqueValues([activeBaseUrl, ...inspectorBaseUrls])) {
        try {
          const response = await originalFetch(`${baseUrl}/api/health`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response && response.ok) {
            activeBaseUrl = baseUrl;
            didWarnMissingServer = false;
            lastHealthError = '';
            announceBaseUrl(baseUrl);
            return baseUrl;
          }
          lastHealthError = `${baseUrl} responded with status ${response ? response.status : 'unknown'}`;
        } catch (error) {
          lastHealthError = `${baseUrl} -> ${formatError(error)}`;
        }
      }
      return null;
    })();

    return resolveBaseUrlPromise.finally(() => {
      resolveBaseUrlPromise = null;
    });
  };

  const checkServer = () => {
    if (!originalFetch) return Promise.resolve(false);
    return ensureReachableBaseUrl().then(baseUrl => {
      if (!baseUrl) {
        warnMissingServer();
        return false;
      }
      return true;
    });
  };

  const registerClient = async () => {
    if (!originalFetch) return Promise.resolve();
    const baseUrl = await ensureReachableBaseUrl();
    if (!baseUrl) {
      warnMissingServer();
      return undefined;
    }
    return originalFetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appName, platform, runtimeHost, installId }),
    }).catch(() => {
      warnMissingServer();
      return undefined;
    });
  };

  const sendEvent = async payload => {
    if (!originalFetch) return Promise.resolve();
    const baseUrl = announcedBaseUrl || await ensureReachableBaseUrl() || activeBaseUrl;
    if (!baseUrl) return undefined;
    return originalFetch(`${baseUrl}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, appName, platform, runtimeHost, installId }),
    }).catch(() => {
      void ensureReachableBaseUrl();
      return undefined;
    });
  };

  if (patchFetch && originalFetch) {
    global.fetch = async function patchedFetch(resource, init = {}) {
      const url = typeof resource === 'string'
        ? resource
        : (resource && typeof resource.url === 'string' ? resource.url : '');
      if (isInspectorRequest(url)) return originalFetch(resource, init);

      const method = String(init.method || (resource && resource.method) || 'GET').toUpperCase();
      const headers = normalizeHeaders(init.headers || (resource && resource.headers));
      const body = serializeBody(init.body);
      const startTime = Date.now();
      const requestKey = makeRequestKey('fetch');

      void sendEvent({
        phase: 'start',
        requestKey,
        request: { url, method, headers, body, startTime, transport: 'fetch', appName },
      });

      try {
        const response = await originalFetch(resource, init);
        let responseBody = null;
        if (captureBodies && response && typeof response.clone === 'function') {
          try { responseBody = await response.clone().text(); } catch {}
        }
        const responseHeaders = normalizeHeaders(response && response.headers);
        void sendEvent({
          phase: 'finish',
          requestKey,
          response: {
            status: response ? response.status : 200,
            headers: responseHeaders,
            body: responseBody,
            size: typeof responseBody === 'string' ? responseBody.length : 0,
          },
          timing: { duration: Date.now() - startTime },
        });
        return response;
      } catch (error) {
        void sendEvent({
          phase: 'error',
          requestKey,
          error: error && error.message ? error.message : String(error),
          timing: { duration: Date.now() - startTime },
        });
        throw error;
      }
    };
  }

  if (patchXHR && OriginalXHR) {
    function InstrumentedXHR() {
      const xhr = new OriginalXHR();
      const requestKey = makeRequestKey('xhr');
      let method = 'GET';
      let url = '';
      let requestHeaders = {};
      let requestBody = null;
      let startTime = 0;

      const originalOpen = xhr.open;
      const originalSend = xhr.send;
      const originalSetRequestHeader = xhr.setRequestHeader;

      xhr.open = function patchedOpen(nextMethod, nextUrl, ...args) {
        method = String(nextMethod || 'GET').toUpperCase();
        url = String(nextUrl || '');
        return originalOpen.call(xhr, nextMethod, nextUrl, ...args);
      };

      xhr.setRequestHeader = function patchedSetRequestHeader(name, value) {
        requestHeaders[name] = value;
        return originalSetRequestHeader.call(xhr, name, value);
      };

      xhr.send = function patchedSend(body) {
        if (isInspectorRequest(url)) return originalSend.call(xhr, body);

        requestBody = serializeBody(body);
        startTime = Date.now();

        void sendEvent({
          phase: 'start',
          requestKey,
          request: {
            url,
            method,
            headers: requestHeaders,
            body: requestBody,
            startTime,
            transport: 'xhr',
            appName,
          },
        });

        const finalize = () => {
          xhr.removeEventListener('loadend', finalize);
          const duration = Date.now() - startTime;
          if (xhr.status === 0) {
            void sendEvent({
              phase: 'error',
              requestKey,
              error: xhr.responseText || 'XHR request failed',
              timing: { duration },
            });
            return;
          }

          let responseBody = null;
          if (captureBodies) {
            try {
              responseBody = typeof xhr.responseText === 'string' ? xhr.responseText : serializeBody(xhr.response);
            } catch {}
          }

          void sendEvent({
            phase: 'finish',
            requestKey,
            response: {
              status: xhr.status,
              headers: parseRawHeaders(xhr.getAllResponseHeaders()),
              body: responseBody,
              size: typeof responseBody === 'string' ? responseBody.length : 0,
            },
            timing: { duration },
          });
        };

        xhr.addEventListener('loadend', finalize);
        return originalSend.call(xhr, body);
      };

      return xhr;
    }

    InstrumentedXHR.prototype = OriginalXHR.prototype;
    ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(key => {
      if (key in OriginalXHR) InstrumentedXHR[key] = OriginalXHR[key];
    });
    global.XMLHttpRequest = InstrumentedXHR;
  }

  const uninstall = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (originalFetch) global.fetch = originalFetch;
    if (OriginalXHR) global.XMLHttpRequest = OriginalXHR;
    delete global.__RN_INSPECTOR_UNINSTALL__;
  };

  global.__RN_INSPECTOR_UNINSTALL__ = uninstall;
  announceBaseUrl(activeBaseUrl);
  void checkServer();
  void registerClient();
  const heartbeatTimer = typeof setInterval === 'function'
    ? setInterval(() => { void registerClient(); }, 10000)
    : null;
  return uninstall;
}

module.exports = { installRNNetInspect };
module.exports.default = installRNNetInspect;

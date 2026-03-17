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

function resolveInspectorBaseUrl(explicitUrl) {
  if (typeof explicitUrl === 'string' && explicitUrl.trim()) {
    return explicitUrl.replace(/\/+$/, '');
  }

  const override = global.__RN_INSPECTOR_BASE_URL__;
  if (typeof override === 'string' && override.trim()) {
    return override.replace(/\/+$/, '');
  }

  const scriptURL = ReactNative && ReactNative.NativeModules && ReactNative.NativeModules.SourceCode
    ? ReactNative.NativeModules.SourceCode.scriptURL
    : '';
  if (typeof scriptURL === 'string') {
    const match = scriptURL.match(/^https?:\/\/([^/:]+)/i);
    if (match && match[1]) return `http://${match[1]}:5555`;
  }

  const platform = ReactNative && ReactNative.Platform ? ReactNative.Platform.OS : null;
  return platform === 'android' ? 'http://10.0.2.2:5555' : 'http://127.0.0.1:5555';
}

function installRNNetInspect({
  inspectorUrl,
  appName = 'React Native',
  captureBodies = true,
  patchFetch = true,
  patchXHR = true,
} = {}) {
  if (global.__RN_INSPECTOR_UNINSTALL__) return global.__RN_INSPECTOR_UNINSTALL__;

  const baseUrl = resolveInspectorBaseUrl(inspectorUrl);
  const ingestUrl = `${baseUrl}/api/ingest`;
  const healthUrl = `${baseUrl}/api/health`;
  const originalFetch = global.fetch ? global.fetch.bind(global) : null;
  const OriginalXHR = global.XMLHttpRequest;

  const isInspectorRequest = target => typeof target === 'string' && target.startsWith(baseUrl);

  const warnMissingServer = () => {
    inspectorWarn(
      `Server not reachable at ${baseUrl}. ` +
      `Start the dashboard/backend before expecting request capture.`
    );
  };

  const checkServer = () => {
    if (!originalFetch) return Promise.resolve(false);
    return originalFetch(healthUrl)
      .then(res => (res && res.ok ? res.json().catch(() => ({})) : Promise.reject(new Error('bad response'))))
      .then(() => true)
      .catch(() => {
        warnMissingServer();
        return false;
      });
  };

  const sendEvent = payload => {
    if (!originalFetch) return Promise.resolve();
    return originalFetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
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
    if (originalFetch) global.fetch = originalFetch;
    if (OriginalXHR) global.XMLHttpRequest = OriginalXHR;
    delete global.__RN_INSPECTOR_UNINSTALL__;
  };

  global.__RN_INSPECTOR_UNINSTALL__ = uninstall;
  inspectorInfo(`Forwarding requests to ${baseUrl}`);
  void checkServer();
  return uninstall;
}

module.exports = { installRNNetInspect };
module.exports.default = installRNNetInspect;

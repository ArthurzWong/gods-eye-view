// Vercel catch-all Function that hosts God's Eye View's server-side provider
// middleware (the same connect-style `/api/*` handlers the Vite dev server
// mounts). The app ships no standalone production server, so this file is the
// bridge that lets every live data layer (OpenSky, adsb.lol, Celestrak,
// launches, terrain, CCTV, traffic, GBFS, radio, OpenStreetMap, ...) run on
// Vercel's Node runtime.
//
// Two important adaptations for the serverless environment:
// 1. `process.chdir('/tmp')` runs BEFORE the provider modules load, because
//    several of them compute their disk-cache directory from `process.cwd()`
//    at module-load time. `/var/task` is read-only on Vercel; `/tmp` is not.
// 2. The provider plugins are normal Vite plugins, so we hand them a tiny
//    mock of the Vite `server` object and record `server.middlewares.use(...)`
//    calls into our own connect-like stack, which we then dispatch per request.

/** @type {Promise<Array<{ path: string, fn: Function }>> | null} */
let chainPromise = null;

/**
 * Build (once) the recorded middleware stack by running every provider
 * plugin's `configureServer` against a mock Vite server.
 */
async function buildChain() {
  // Redirect `process.cwd()`-based caches to the only writable path before any
  // provider module is evaluated.
  try {
    process.chdir('/tmp');
  } catch {
    /* non-fatal: caches become best-effort */
  }

  const [{ localProviderPlugins }, { apiNotFoundPlugin }] = await Promise.all([
    import('../server/providers/local.js'),
    import('../server/standalone/api-not-found.js'),
  ]);

  /** @type {Array<{ path: string, fn: Function }>} */
  const stack = [];
  const middlewares = {
    use(path, fn) {
      if (typeof path === 'function') {
        fn = path;
        path = '/';
      }
      if (typeof fn === 'function') stack.push({ path, fn });
      return this;
    },
  };

  // Minimal surface the plugins actually touch: `middlewares`, `httpServer`
  // (optional-chained), `restart` (key-setup) and a couple of harmless stubs.
  const mockServer = {
    middlewares,
    httpServer: null,
    ws: { send() {}, close() {} },
    restart: async () => {},
    config: { logger: console },
  };

  const plugins = [...localProviderPlugins(), apiNotFoundPlugin()];
  for (const plugin of plugins) {
    const hook = plugin && plugin.configureServer;
    if (typeof hook === 'function') {
      // Some plugins return a post-hook function; we only need the mounts.
      await hook(mockServer);
    }
  }
  return stack;
}

/** Snapshot the recorded chain (built lazily, reused across warm invocations). */
function getChain() {
  if (!chainPromise) chainPromise = buildChain();
  return chainPromise;
}

/** connect semantics: does mount `path` match request `pathname`? */
function matches(path, pathname) {
  if (path === '/' || path === '') return true;
  return pathname === path || pathname.startsWith(path + '/');
}

/** connect semantics: strip the mount path, keeping the query string. */
function strip(path, url) {
  if (path === '/' || path === '') return url || '/';
  const rest = url.slice(path.length);
  return rest === '' ? '/' : rest;
}

/** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
export default async function handler(req, res) {
  let stack;
  try {
    stack = await getChain();
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: 'API bridge failed to initialise',
        detail: error && error.message ? error.message : String(error),
      }),
    );
    return;
  }

  const originalUrl = req.url || '/';
  const pathname = originalUrl.split('?')[0];
  req.originalUrl = originalUrl;

  let index = 0;
  const next = (err) => {
    if (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: 'API handler error' }));
      }
      return;
    }
    while (index < stack.length) {
      const layer = stack[index++];
      if (!matches(layer.path, pathname)) continue;
      req.url = strip(layer.path, originalUrl);
      try {
        layer.fn(req, res, next);
      } catch (syncError) {
        next(syncError);
      }
      return;
    }
    if (!res.writableEnded) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Unknown API route' }));
    }
  };

  next();
}

// The provider middleware read raw request bodies themselves.
export const config = { api: { bodyParser: false } };

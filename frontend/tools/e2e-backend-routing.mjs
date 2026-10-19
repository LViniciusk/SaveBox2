const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:4200';
const DEFAULT_BACKEND_ORIGIN = 'http://localhost:8080';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function deriveBackendOrigin(frontendValue) {
  const frontend = new URL(frontendValue);
  return frontend.port === '4200'
    ? `${frontend.protocol}//${frontend.hostname}:8080`
    : frontend.origin;
}

function validateLocalBackendOrigin(rawValue) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error('E2E backend authority is invalid.');
  }

  if (
    parsed.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('E2E backend authority is invalid.');
  }

  const authority = rawValue.slice(rawValue.indexOf('//') + 2).split(/[/?#]/, 1)[0].toLowerCase();
  const portMatch = authority.match(/^(?:localhost|127\.0\.0\.1):(\d+)$/) ??
    authority.match(/^\[::1\]:(\d+)$/);
  const port = portMatch ? Number(portMatch[1]) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('E2E backend authority is invalid.');
  }

  return parsed.origin;
}

export function resolveE2EBackendOrigin(environment = process.env) {
  const configured = environment.NANIKA_E2E_BACKEND_URL;
  const raw = configured
    ? configured
    : deriveBackendOrigin(environment.NANIKA_E2E_BASE_URL ?? DEFAULT_FRONTEND_ORIGIN);
  return validateLocalBackendOrigin(raw);
}

export function rewriteE2EBackendRequestUrl(sourceUrl, backendOrigin) {
  let source;
  try {
    source = new URL(sourceUrl);
  } catch {
    throw new Error('E2E backend request URL is invalid.');
  }
  if (source.origin !== DEFAULT_BACKEND_ORIGIN) {
    throw new Error('E2E backend request URL is invalid.');
  }

  const destination = validateLocalBackendOrigin(backendOrigin);
  return new URL(`${source.pathname}${source.search}`, `${destination}/`).toString();
}

export async function installE2EBackendRouting(page, environment = process.env) {
  const destination = resolveE2EBackendOrigin(environment);
  if (destination === DEFAULT_BACKEND_ORIGIN) return;

  await page.route(`${DEFAULT_BACKEND_ORIGIN}/**`, route => {
    const rewritten = rewriteE2EBackendRequestUrl(route.request().url(), destination);
    return route.continue({ url: rewritten });
  });
}

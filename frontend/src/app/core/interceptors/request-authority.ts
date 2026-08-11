export function isUrlWithinBase(
  requestUrl: string,
  configuredBase: string,
  browserOrigin = globalThis.location.origin,
): boolean {
  try {
    const request = new URL(requestUrl, browserOrigin);
    const base = new URL(configuredBase, browserOrigin);

    if (request.origin !== base.origin) return false;

    const basePath = base.pathname.replace(/\/+$/, '') || '/';
    return basePath === '/'
      || request.pathname === basePath
      || request.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

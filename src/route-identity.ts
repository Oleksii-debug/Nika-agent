export type ChatRouteIdentity = {
  origin: string;
  pathname: string;
  key: string;
};

/**
 * Returns the mutation-relevant ChatGPT route identity. Query/hash state is
 * intentionally ignored: the irreversible boundary is the physical
 * conversation pathname, not transient UI/search parameters.
 */
export function getChatRouteIdentity(value: string): ChatRouteIdentity | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || (url.hostname !== 'chatgpt.com' && !url.hostname.endsWith('.chatgpt.com'))) {
      return null;
    }
    const pathname = normalizePathname(url.pathname);
    const origin = `${url.protocol}//${url.hostname.toLowerCase()}`;
    return { origin, pathname, key: `${origin}${pathname}` };
  } catch {
    return null;
  }
}

export function sameChatRoute(expectedUrl: string, observedUrl: string): boolean {
  const expected = getChatRouteIdentity(expectedUrl);
  const observed = getChatRouteIdentity(observedUrl);
  return Boolean(expected && observed && expected.key === observed.key);
}

export function describeRouteMismatch(expectedUrl: string, observedUrl: string): string {
  const expected = getChatRouteIdentity(expectedUrl);
  const observed = getChatRouteIdentity(observedUrl);
  const expectedKey = expected?.key ?? `invalid:${expectedUrl}`;
  const observedKey = observed?.key ?? `invalid:${observedUrl}`;
  return `ROUTE_IDENTITY_MISMATCH: expected=${expectedKey} observed=${observedKey}`;
}

function normalizePathname(pathname: string): string {
  const compact = pathname.replace(/\/{2,}/g, '/');
  if (compact === '/') return '/';
  return compact.replace(/\/+$/, '') || '/';
}

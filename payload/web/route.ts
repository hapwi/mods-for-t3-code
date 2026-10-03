export interface RouteLocation { pathname: string; hash?: string }

/** T3's Electron shell uses hash history; the web app uses browser history. */
export function routePath(value: RouteLocation = location): string {
  const path = value.hash?.startsWith("#/") ? value.hash.slice(1) : value.pathname;
  return path.split(/[?#]/, 1)[0] || "/";
}

// Client fetch helper: raw fetch() does not get Next's basePath auto-prefixed
// (only <Link>/router do). NEXT_PUBLIC_BASE_PATH is set alongside basePath in
// next.config.ts.
export function apiUrl(path: string): string {
  return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
}

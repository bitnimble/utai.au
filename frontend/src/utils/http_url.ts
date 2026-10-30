/** `text` as an http(s) URL, or undefined if it isn't one. */
export function parseHttpUrl(text: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
}

export function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
}

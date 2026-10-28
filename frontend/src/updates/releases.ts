import { z } from 'zod';
import { fetchRetrying, PUBLIC_API_RETRY } from 'src/net/fetch_retrying';

const RELEASES_URL = 'https://api.github.com/repos/bitnimble/utai.au/releases?per_page=30';

const ReleaseSchema = z.object({
  tag_name: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

export type ReleaseNote = {
  version: string;
  /** Markdown, the release's changelog. */
  notes: string;
  url: string;
  apkUrl: string | null;
};

/** Published releases newer than `current`, newest first. */
export async function fetchNewerReleases(current: string): Promise<ReleaseNote[]> {
  const res = await fetchRetrying(
    RELEASES_URL,
    { headers: { Accept: 'application/vnd.github+json' } },
    PUBLIC_API_RETRY,
  );
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return newerReleases(z.array(ReleaseSchema).parse(await res.json()), current);
}

export function newerReleases(releases: ReadonlyArray<z.infer<typeof ReleaseSchema>>, current: string): ReleaseNote[] {
  return releases
    .filter((r) => !r.draft && !r.prerelease && compareVersions(r.tag_name, current) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
    .map((r) => ({
      version: r.tag_name.replace(/^v/, ''),
      notes: r.body ?? '',
      url: r.html_url,
      apkUrl: r.assets.find((a) => a.name.endsWith('.apk'))?.browser_download_url ?? null,
    }));
}

/** Dotted numeric comparison; a prerelease part ranks below its release (1.2.0-rc1 < 1.2.0). */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = rank(pa[i]) - rank(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

function parts(version: string): number[] {
  return version.replace(/^v/, '').split(/[.+-]/).map((p) => parseInt(p, 10));
}

function rank(part: number | undefined): number {
  if (part == null) return 0;
  return Number.isNaN(part) ? -1 : part;
}

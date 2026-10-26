"""Make OnTheSpot's headless download worker report progress.

The web API's queue items carry a `progress` field, but the worker only
reports progress to its Qt GUI (`if self.gui:`), so headless it stays 0 until
post-processing sets 99. This writes `item['progress']` on every downloaded
chunk, and gives yt-dlp a headless progress hook. Fails (non-zero exit) when an
upstream change stops a pattern from matching, so the image build catches it.
"""

import os
import re
import sys

import onthespot

path = os.path.join(os.path.dirname(onthespot.__file__), "downloader.py")
src = open(path, encoding="utf-8").read()

chunk_re = re.compile(
    r'^([ \t]*)if self\.gui:\n([ \t]*)self\.progress\.emit\(item, self\.tr\("Downloading"\), (int\(\(downloaded / total_size\) \* 100\))\)$',
    re.M,
)
src, chunk_sites = chunk_re.subn(
    r'''\1item['progress'] = min(98, \3)\n\1if self.gui:\n\2self.progress.emit(item, self.tr("Downloading"), \3)''',
    src,
)

hook_re = re.compile(
    r"^([ \t]*)if self\.gui:\n[ \t]*ydl_opts\['progress_hooks'\] = \[lambda d: self\.yt_dlp_progress_hook\(item, d\)\]$",
    re.M,
)
src, hook_sites = hook_re.subn(
    r"\1ydl_opts['progress_hooks'] = [lambda d: self.yt_dlp_progress_hook(item, d) if self.gui else _headless_ytdlp_progress(item, d)]",
    src,
)

src += '''

def _headless_ytdlp_progress(item, d):
    if item['item_status'] == 'Cancelled':
        raise Exception("Download cancelled by user.")
    total = d.get('total_bytes') or d.get('total_bytes_estimate')
    if d.get('status') == 'downloading' and total:
        item['progress'] = min(98, int(d.get('downloaded_bytes', 0) * 100 / total))
'''

if chunk_sites == 0 or hook_sites == 0:
    sys.exit(f"onthespot progress patch no longer applies (chunk sites {chunk_sites}, yt-dlp hook sites {hook_sites})")
open(path, "w", encoding="utf-8").write(src)
print(f"patched {chunk_sites} chunk sites, {hook_sites} yt-dlp hook sites")

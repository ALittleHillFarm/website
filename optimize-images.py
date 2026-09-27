#!/usr/bin/env python3
"""
Make the site's photos light enough for a rural phone connection.

    python optimize-images.py            (needs Pillow: pip install pillow)

Safe to re-run: it only rewrites a file when that makes it meaningfully
smaller, and only creates thumbnails that are missing.

  assets/photos/*.jpg        recompressed in place (progressive, no metadata),
                             capped at 1200px on the long edge
  assets/photos/thumbs/      640px-wide copies for cards, rosters and
                             avatars — the page picks them via srcset
  assets/logo-small.png      the header logo, drawn 46px tall
  assets/logo-full.png       the home-page mark, capped at 640px
  store/public/assets/products/*.jpg   same recompression, 900px cap

Photos uploaded through the admin screen never touch this script: the admin
page shrinks them in the browser before they are sent.
"""
import glob
import io
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
THUMB_W = 640


def jpeg_bytes(im, quality=80):
    buf = io.BytesIO()
    im.convert('RGB').save(buf, 'JPEG', quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


def shrink(im, long_edge):
    if max(im.size) > long_edge:
        im = im.copy()
        im.thumbnail((long_edge, long_edge), Image.LANCZOS)
    return im


def recompress(path, long_edge):
    before = os.path.getsize(path)
    im = Image.open(path)
    data = jpeg_bytes(shrink(im, long_edge))
    # Only keep it if it is at least 10% smaller; recompressing an already
    # tight JPEG just loses quality for nothing.
    if len(data) < before * 0.9:
        open(path, 'wb').write(data)
        return before, len(data)
    return before, before


def main():
    saved = 0
    os.makedirs(os.path.join(HERE, 'assets/photos/thumbs'), exist_ok=True)
    for path in sorted(glob.glob(os.path.join(HERE, 'assets/photos/*.jpg'))):
        b, a = recompress(path, 1200)
        saved += b - a
        thumb = os.path.join(HERE, 'assets/photos/thumbs', os.path.basename(path))
        im = Image.open(path)
        if im.size[0] > THUMB_W and not os.path.exists(thumb):
            t = im.copy()
            t.thumbnail((THUMB_W, 10000), Image.LANCZOS)
            open(thumb, 'wb').write(jpeg_bytes(t, 78))

    for path in sorted(glob.glob(os.path.join(HERE, 'store/public/assets/products/*.jpg'))):
        b, a = recompress(path, 900)
        saved += b - a

    logo = Image.open(os.path.join(HERE, 'assets/logo.png'))
    small = logo.copy()
    small.thumbnail((144, 144), Image.LANCZOS)
    small.convert('RGBA').quantize(colors=128, method=Image.FASTOCTREE).save(
        os.path.join(HERE, 'assets/logo-small.png'), optimize=True)

    full_path = os.path.join(HERE, 'assets/logo-full.png')
    full = Image.open(full_path)
    if max(full.size) > 640:
        before = os.path.getsize(full_path)
        full = full.convert('RGBA')
        full.thumbnail((640, 640), Image.LANCZOS)
        full.quantize(colors=256, method=Image.FASTOCTREE).save(full_path, optimize=True)
        saved += before - os.path.getsize(full_path)

    print(f'saved {saved // 1024} KB')


if __name__ == '__main__':
    main()

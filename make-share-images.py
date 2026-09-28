#!/usr/bin/env python3
"""
Link-preview pictures and site icons.

    python make-share-images.py        (needs Pillow; run on Windows for the fonts)

When someone texts or posts a link, the message shows the page's share image
(og:image, 1200x630). Each card is a farm photo on the left and the page's
name on the right in the site's colours. Re-run after changing a card below.

Goat pages need no card: they share the goat's own main photo.

Writes:
  assets/og/<name>.jpg                 one card per page in CARDS
  store/public/assets/og-store.jpg     the store's card
  favicon.ico, apple-touch-icon.png    at the site root (browsers ask there)
  assets/icon-192.png, icon-512.png    for site.webmanifest (home-screen icon)
  store/public/ copies of the icons
"""
import os
import shutil

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = 'C:/Windows/Fonts/'
PAPER = (243, 238, 228)
INK = (30, 27, 22)
MOSS = (79, 115, 54)     # --moss-ink: brand green #59803D, darkened for text on cream
RUST = (198, 40, 47)     # brand red #C6282F
MUTED = (107, 99, 83)
W, H = 1200, 630

# (output, photo, eyebrow, title line 1, title line 2 in italics)
CARDS = [
    ('assets/og/default.jpg', 'assets/photos/20240726_0057.jpg', 'Our herd', 'Nigerian Dwarf', 'dairy goats.'),
    ('assets/og/does.jpg', 'assets/photos/20240726_0117.jpg', 'The herd', 'Meet the does.', ''),
    ('assets/og/bucks.jpg', 'assets/photos/polaris.jpg', 'The herd', 'Meet the bucks.', ''),
    ('assets/og/breeding.jpg', 'assets/photos/20240726_0066.jpg', 'Kidding season', 'This year’s', 'pairings.'),
    ('assets/og/guide.jpg', 'assets/photos/sugar.jpg', 'Thinking about goats?', 'Ten things to know', 'first.'),
    ('assets/og/about.jpg', 'assets/photos/cookie_close_up_2025.jpg', 'Our story', 'Twenty acres in', 'North Idaho.'),
    ('store/public/assets/og-store.jpg', 'store/public/assets/products/20240726_0202.jpg', 'Farm store',
     'Organic feed,', 'picked up locally.'),
]


def font(name, size):
    return ImageFont.truetype(FONTS + name, size)


def cover(im, w, h):
    """Crop-to-fill, like CSS object-fit: cover."""
    im = im.convert('RGB')
    scale = max(w / im.width, h / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    left = (im.width - w) // 2
    top = (im.height - h) // 2
    return im.crop((left, top, left + w, top + h))


def logo(size):
    src = Image.open(os.path.join(HERE, 'assets/logo.png')).convert('RGBA')
    src.thumbnail((size, size), Image.LANCZOS)
    return src


def card(out, photo, eyebrow, line1, line2):
    im = Image.new('RGB', (W, H), PAPER)
    im.paste(cover(Image.open(os.path.join(HERE, photo)), 560, H), (0, 0))
    d = ImageDraw.Draw(im)
    x = 612
    mark = logo(92)
    im.paste(mark, (x, 58), mark)
    d.text((x + 108, 82), 'A Little Hill Farm', font=font('georgia.ttf', 30), fill=INK)
    d.text((x + 108, 122), 'ADGA REGISTERED · POTLATCH, IDAHO', font=font('segoeui.ttf', 15), fill=MUTED)
    d.text((x, 268), eyebrow.upper(), font=font('seguisb.ttf', 20), fill=RUST)
    size = 64
    while size > 40 and max(d.textlength(t, font=font('georgia.ttf', size)) for t in (line1, line2)) > W - x - 48:
        size -= 2
    d.text((x, 310), line1, font=font('georgia.ttf', size), fill=INK)
    if line2:
        d.text((x, 310 + size * 1.15), line2, font=font('georgiai.ttf', size), fill=MOSS)
    d.rectangle((x, H - 58, x + 64, H - 55), fill=MOSS)
    path = os.path.join(HERE, out)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, 'JPEG', quality=84, optimize=True, progressive=True)
    print(f'  {out}  {os.path.getsize(path) // 1024} KB')


def icons():
    src = Image.open(os.path.join(HERE, 'assets/logo.png')).convert('RGBA')

    def square(size, bg=None, pad=0.0):
        canvas = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
        inner = round(size * (1 - 2 * pad))
        m = src.copy()
        m.thumbnail((inner, inner), Image.LANCZOS)
        canvas.paste(m, ((size - m.width) // 2, (size - m.height) // 2), m)
        return canvas

    square(48).save(os.path.join(HERE, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
    # iOS draws transparent pixels black, so the home-screen icon gets paper.
    square(180, PAPER + (255,), 0.06).convert('RGB').save(os.path.join(HERE, 'apple-touch-icon.png'), optimize=True)
    square(192, PAPER + (255,), 0.06).save(os.path.join(HERE, 'assets/icon-192.png'), optimize=True)
    square(512, PAPER + (255,), 0.06).save(os.path.join(HERE, 'assets/icon-512.png'), optimize=True)
    for f in ('favicon.ico', 'apple-touch-icon.png'):
        shutil.copy(os.path.join(HERE, f), os.path.join(HERE, 'store/public', f))
    print('  icons written')


if __name__ == '__main__':
    for c in CARDS:
        card(*c)
    icons()

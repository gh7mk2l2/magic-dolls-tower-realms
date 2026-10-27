import json, numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage
OUT = "/workspace/work/mdtr/apps/client/public/sprites"
import os; os.makedirs(OUT, exist_ok=True)
SPEC = {  # key: (W, H, originY)
 "hero": (150,120,.88), "tower": (120,170,.86), "base": (240,210,.78), "minion": (64,74,.88),
 "super": (160,150,.9), "tree": (100,130,.9), "rock": (64,48,.9), "crystal": (64,90,.9), "decal": (150,150,.5)}
def key_out(img, bg):
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    h, w, _ = a.shape
    border = np.concatenate([a[:8].reshape(-1,3), a[-8:].reshape(-1,3), a[:, :8].reshape(-1,3), a[:, -8:].reshape(-1,3)])
    key = np.median(border, axis=0)
    r, g, b = a[...,0], a[...,1], a[...,2]
    if bg == "green": spill = g - np.maximum(r, b)
    else: spill = np.minimum(r, b) - g
    dist = np.linalg.norm(a - key, axis=2)
    cand = (dist < 95) | (spill > 70)
    lab, _ = ndimage.label(cand)
    edge_labels = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:,0], lab[:,-1]]))) - {0}
    bgmask = np.isin(lab, list(edge_labels))
    strict = dist < 70
    lab2, n2 = ndimage.label(strict)
    sizes = ndimage.sum(np.ones_like(dist), lab2, range(1, n2+1))
    big = np.isin(lab2, [i+1 for i, z in enumerate(sizes) if z > 40])
    bgmask = bgmask | big
    bgmask = ndimage.binary_opening(bgmask, iterations=1)
    alpha = (~bgmask).astype(np.float32)
    alpha = ndimage.gaussian_filter(alpha, 1.0)
    alpha = np.clip((alpha - 0.15) / 0.7, 0, 1)
    # despill near edges
    near = ndimage.binary_dilation(bgmask, iterations=4) & ~bgmask
    s = np.clip(spill, 0, None) * near
    if bg == "green": a[...,1] -= s
    else: a[...,0] -= s; a[...,2] -= s
    rgba = np.dstack([np.clip(a,0,255), alpha*255]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")
def recolor_red_to_blue(im):
    a = np.asarray(im).copy()
    hsv = np.asarray(im.convert("RGB").convert("HSV")).astype(np.int32).copy()
    hdeg = hsv[...,0] * 360 / 255
    m = ((hdeg < 7) | (hdeg > 340)) & (hsv[...,1] > 150) & (hsv[...,2] > 70)
    hsv[...,0][m] = int(218 * 255 / 360)
    rgb = np.asarray(Image.fromarray(hsv.astype(np.uint8), "HSV").convert("RGB"))
    a[...,:3][m] = rgb[m]
    return Image.fromarray(a, "RGBA")
def place(im, W, H, oy):
    bbox = im.getbbox(); im = im.crop(bbox)
    bottom = H if oy == .5 else min(H, round(H*oy + H*0.07))
    s = min((W*0.96)/im.width, (bottom*0.97)/im.height)
    im = im.resize((max(1,round(im.width*s)), max(1,round(im.height*s))), Image.LANCZOS)
    im = im.filter(ImageFilter.UnsharpMask(radius=1, percent=60, threshold=2))
    out = Image.new("RGBA", (W, H), (0,0,0,0))
    out.alpha_composite(im, ((W-im.width)//2, bottom - im.height))
    return out
for f in sorted(os.listdir("art-raw")):
    if not f.endswith(".png"): continue
    k = f[:-4]
    if k == "ground":
        t = Image.open("art-raw/ground.png").convert("RGB").resize((256,256), Image.LANCZOS)
        t = Image.open("art-raw/ground.png").convert("RGB").resize((512,512), Image.LANCZOS)
        A = np.asarray(t).astype(np.float32); B = np.roll(A, (256,256), axis=(0,1))
        yy, xx = np.mgrid[0:512,0:512]
        wA = np.minimum(np.minimum(xx, 511-xx), np.minimum(yy, 511-yy)) / 256.0
        wA = np.clip(wA*1.6, 0, 1)[...,None]
        tile = Image.fromarray((A*wA + B*(1-wA)).astype(np.uint8))
        tile.save(f"{OUT}/ground.png", optimize=True); continue
    if k == "tower-Blue": continue
    bg = "green" if "00ff00" in json.load(open(f"art-raw/{k}.json"))["bg"] else "magenta"
    im = key_out(Image.open(f"art-raw/{f}"), bg)
    W,H,oy = SPEC[k.split("-")[0]]
    place(im,W,H,oy).save(f"{OUT}/{k}.png", optimize=True)
    if k == "tower-Red":
        place(recolor_red_to_blue(im),W,H,oy).save(f"{OUT}/tower-Blue.png", optimize=True)
print(sorted(os.listdir(OUT)))

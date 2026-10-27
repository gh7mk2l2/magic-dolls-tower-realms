import numpy as np
from PIL import Image
from scipy import ndimage as ndi
def key(path):
    im=np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    r,g,b=im[...,0],im[...,1],im[...,2]
    mx=np.maximum(np.maximum(r,g),b); mn=np.minimum(np.minimum(r,g),b)
    # magenta-ish: r and b both high relative to g
    mag = (np.minimum(r,b) - g)
    bgscore = np.clip((mag-35)/45,0,1) * (np.abs(r-b) < 110) * (np.minimum(r,b) > 110)
    bg = bgscore>0.5
    # keep only background connected to borders
    lab,n=ndi.label(bg); border=set(np.unique(np.concatenate([lab[0],lab[-1],lab[:,0],lab[:,-1]])))-{0}
    sizes=ndi.sum(bg,lab,range(1,n+1)); means=ndi.mean(mag,lab,range(1,n+1))
    enclosed=[i+1 for i in range(n) if sizes[i]>1500 and means[i]>70]
    bgc=np.isin(lab,list(border)+enclosed)
    strong=(mag>85)&(np.minimum(r,b)>120)
    near=ndi.binary_dilation(bgc,iterations=6)&(mag>40)&(np.minimum(r,b)>70)
    bgc=bgc|strong|near
    bgc=ndi.binary_closing(bgc,iterations=1)
    alpha=1-bgc.astype(np.float32)
    alpha[:6,:]=0; alpha[-6:,:]=0; alpha[:,:6]=0; alpha[:,-6:]=0
    # soften edge
    alpha=ndi.gaussian_filter(alpha,0.7)
    fg=alpha>0.02
    # remove small blobs
    lab2,n2=ndi.label(fg); sizes=ndi.sum(fg,lab2,range(1,n2+1))
    keep=np.isin(lab2, [i+1 for i,s in enumerate(sizes) if s>800]); alpha*=keep
    # despill: reduce magenta on edges
    spill=np.clip(np.minimum(r,b)-g-10,0,None)*(alpha<0.98)
    out=im.copy(); out[...,0]-=spill*0.6; out[...,2]-=spill*0.6
    rgba=np.dstack([np.clip(out,0,255),alpha*255]).astype(np.uint8)
    return Image.fromarray(rgba)
for n in ["Arcanist-0","Ranger-1","Guardian-1","minion-0","super-0","Assassin-0","Priestess-0","Brawler-0"]:
    k=key(f"{n}.png"); k.save(f"k-{n.split('-')[0]}.png"); print(n,k.size)

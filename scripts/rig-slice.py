import json, numpy as np, colorsys
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
S=0.25  # export scale
RIGS={
 "Arcanist":{"kind":"biped","parts":{
   "head":([(290,90),(845,90),(845,420),(680,470),(620,482),(470,472),(420,452),(290,330)],(560,470),40),
   "armF":([(625,498),(700,503),(770,568),(835,598),(835,655),(760,745),(700,722),(658,620),(625,560)],(640,522),36),
   "armB":([(95,45),(338,45),(338,250),(312,498),(442,503),(458,560),(422,652),(382,702),(378,780),(412,880),(415,955),(345,955),(288,565),(255,565),(95,250)],(452,526),36),
   "legF":([(598,868),(702,868),(702,990),(598,990)],(642,870),0),
   "legB":([(418,858),(532,858),(532,958),(418,958)],(480,860),0)}},
 "Ranger":{"kind":"biped","parts":{
   "head":([(298,105),(655,105),(655,420),(560,446),(470,452),(380,422),(298,385)],(500,446),40),
   "armF":([(595,452),(698,105),(885,105),(885,525),(805,645),(705,748),(600,748),(642,692),(700,642),(662,562),(640,522),(595,502)],(606,480),34),
   "armB":([(195,500),(402,500),(412,560),(332,602),(292,635),(195,625)],(390,522),30),
   "legF":([(510,688),(642,688),(642,945),(518,945)],(552,700),26),
   "legB":([(345,688),(502,688),(472,965),(345,965)],(452,700),26)}},
 "Guardian":{"kind":"biped","parts":{
   "head":([(285,35),(645,35),(645,420),(562,462),(450,442),(390,402),(285,255)],(520,455),40),
   "armB":([(100,325),(292,325),(302,468),(442,474),(458,552),(332,562),(262,635),(178,635),(100,505)],(442,512),34),
   "armF":([(604,458),(658,395),(885,385),(885,655),(700,655),(660,562),(604,542)],(622,502),34),
   "legF":([(608,728),(702,728),(712,968),(568,968),(574,884),(608,884)],(624,742),28),
   "legB":([(328,738),(482,738),(472,990),(328,990)],(432,742),28)}},
 "Assassin":{"kind":"biped","parts":{
   "head":([(300,50),(720,50),(720,380),(600,440),(450,445),(380,410),(300,300)],(520,440),40),
   "armB":([(110,415),(300,415),(360,500),(445,500),(450,560),(330,600),(335,690),(250,695),(110,560)],(440,505),34),
   "armF":([(598,465),(660,470),(740,560),(900,425),(915,625),(780,665),(690,655),(650,590),(600,540)],(608,490),32),
   "legF":([(515,690),(605,690),(605,850),(632,965),(540,965)],(560,700),28),
   "legB":([(450,690),(512,690),(502,800),(472,830),(472,990),(388,990),(394,800),(450,800)],(462,700),26)}},
 "Priestess":{"kind":"biped","parts":{
   "head":([(320,40),(762,40),(762,320),(690,332),(560,412),(470,402),(420,432),(330,342)],(540,420),40),
   "armB":([(95,320),(270,330),(240,470),(300,520),(390,490),(405,555),(340,585),(345,648),(300,648),(250,592),(240,522),(95,472)],(390,500),28),
   "armF":([(640,468),(745,468),(745,520),(800,520),(892,418),(892,500),(882,562),(800,582),(700,562),(645,532)],(660,495),28),
   "legF":([(555,800),(634,800),(617,962),(550,962)],(595,810),0),
   "legB":([(465,800),(552,800),(560,1008),(470,1008)],(510,810),0)}},
 "Brawler":{"kind":"biped","parts":{
   "head":([(335,180),(745,180),(745,340),(660,380),(640,402),(420,402),(335,345)],(530,400),46),
   "armB":([(120,385),(410,380),(442,470),(432,560),(397,640),(392,700),(332,825),(145,825),(120,500)],(400,460),40),
   "armF":([(625,480),(700,385),(930,375),(930,645),(760,685),(680,665),(640,600)],(640,520),40),
   "legF":([(530,742),(668,742),(668,848),(530,848)],(590,750),26),
   "legB":([(305,738),(462,738),(442,872),(300,872)],(395,745),26)}},
 "minion":{"kind":"quad","parts":{
   "head":([(478,175),(885,175),(885,625),(700,625),(560,565),(520,420),(478,330)],(565,485),40),
   "legBN":([(195,640),(357,640),(357,835),(195,835)],(280,645),30),
   "legBF":([(355,680),(417,680),(417,798),(355,798)],(386,684),18),
   "legFN":([(448,680),(602,680),(612,842),(448,842)],(522,684),30),
   "legFF":([(600,660),(678,660),(678,808),(600,808)],(632,666),18)}},
 "super":{"kind":"quad","parts":{
   "head":([(618,245),(1000,245),(1000,735),(780,735),(640,625),(598,450)],(652,522),50),
   "legBN":([(55,560),(302,560),(302,865),(55,865)],(220,605),40),
   "legBF":([(258,690),(392,690),(392,845),(258,845)],(322,702),26),
   "legFN":([(298,590),(612,590),(612,895),(298,895)],(432,645),45),
   "legFF":([(638,640),(802,640),(802,855),(638,855)],(682,664),30)}},
}
ORDER={"biped":["legB","armB","legF","torso","armF","head"],"quad":["legBF","legFF","torso","legBN","legFN","head"]}
def to_blue(img):
    a=np.asarray(img).astype(np.float32)/255; rgb=a[...,:3]
    mx=rgb.max(-1); mn=rgb.min(-1); d=mx-mn+1e-6
    r,g,b=rgb[...,0],rgb[...,1],rgb[...,2]
    h=np.where(mx==r,((g-b)/d)%6,np.where(mx==g,(b-r)/d+2,(r-g)/d+4))*60
    s=np.where(mx>0,d/(mx+1e-6),0)
    red=((h<22)|(h>318))&(s>0.38)&(mx>0.18)
    nh=(h+215)%360  # red->blue
    # hsv->rgb
    c=mx*s; x=c*(1-np.abs((nh/60)%2-1)); m=mx-c; k=(nh//60).astype(int)%6
    lut=[(c,x,0*c),(x,c,0*c),(0*c,c,x),(0*c,x,c),(x,0*c,c),(c,0*c,x)]
    out=rgb.copy()
    for i,(R,G,B) in enumerate(lut):
        sel=red&(k==i); out[...,0]=np.where(sel,R+m,out[...,0]); out[...,1]=np.where(sel,G+m,out[...,1]); out[...,2]=np.where(sel,B+m,out[...,2])
    a[...,:3]=out; return Image.fromarray((a*255).astype(np.uint8))
meta={}
for name,cfg in RIGS.items():
    full=Image.open(f"k-{name}.png").convert("RGBA")
    A=np.asarray(full)[...,3]>20
    ys,xs=np.nonzero(A); foot=(float((xs.min()+xs.max())/2), float(ys.max()))
    W,H=full.size
    masks={}; taken=np.zeros((H,W),bool)
    for pn,(poly,piv,cap) in cfg["parts"].items():
        m=Image.new("L",(W,H),0); ImageDraw.Draw(m).polygon(poly,fill=255)
        mk=(np.asarray(m)>0)&A&~taken; masks[pn]=mk; taken|=mk
    torso=A&~taken
    yy,xx=np.mgrid[0:H,0:W]
    for pn,(poly,piv,cap) in cfg["parts"].items():
        if cap: torso|= masks[pn]&((xx-piv[0])**2+(yy-piv[1])**2<cap**2)
    masks["torso"]=torso
    pivots={pn:cfg["parts"][pn][1] for pn in cfg["parts"]}
    tys,txs=np.nonzero(torso); pivots["torso"]=(float((txs.min()+txs.max())/2), float(tys.max()))
    for team in ("Red","Blue"):
        src=full if team=="Red" else to_blue(full)
        arr=np.asarray(src)
        tiles=[]; x0=0; parts={}
        for pn in ORDER[cfg["kind"]]:
            mk=ndi.binary_dilation(masks[pn],iterations=1)&A
            ys,xs=np.nonzero(mk); l,t,r,b=xs.min(),ys.min(),xs.max()+1,ys.max()+1
            crop=arr[t:b,l:r].copy(); crop[...,3]=np.where(mk[t:b,l:r],crop[...,3],0)
            tile=Image.fromarray(crop).resize((max(1,round((r-l)*S)),max(1,round((b-t)*S))),Image.LANCZOS)
            tiles.append(tile)
            px,py=pivots[pn]
            parts[pn]={"x":x0,"y":0,"w":tile.size[0],"h":tile.size[1],
              "ox":round((l-foot[0])*S,2),"oy":round((t-foot[1])*S,2),
              "px":round((px-foot[0])*S,2),"py":round((py-foot[1])*S,2)}
            x0+=tile.size[0]+2
        atlas=Image.new("RGBA",(x0,max(t.size[1] for t in tiles)),(0,0,0,0)); xx0=0
        for t in tiles: atlas.paste(t,(xx0,0)); xx0+=t.size[0]+2
        atlas.save(f"/workspace/work/mdtr/apps/client/public/sprites/rig-{name}-{team}.png",optimize=True)
        if team=="Red": meta[name]={"kind":cfg["kind"],"order":ORDER[cfg["kind"]],"height":round((foot[1]-ys.min())*S,1) if False else round(float(foot[1]-np.nonzero(A)[0].min())*S,1),"parts":parts}
json.dump(meta,open("/workspace/work/mdtr/apps/client/src/rig-data.json","w"),ensure_ascii=False,indent=1)
print({k:(v["height"],[ (p,q["w"],q["h"]) for p,q in v["parts"].items()]) for k,v in meta.items()})

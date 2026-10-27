import json, base64, urllib.request, concurrent.futures as cf
POSE = "full body, standing in a neutral A-pose, seen from a 3/4 front view with the body turned slightly to the right, BOTH ARMS HELD CLEARLY AWAY FROM THE BODY at about 35 degrees with visible gaps between arms and torso, legs apart and clearly separated with a gap between them, nothing overlapping the torso or face"
BEAST = "seen from a pure side view facing right, standing with all four legs clearly separated and visible with gaps between them, head and jaw clearly separated from the body outline"
STY = "chibi proportions, hand-painted mobile MOBA game character art, crisp clean silhouette, centered, isolated on a perfectly flat solid pure magenta #ff00ff background, no shadow, no ground, no text"
tc="crimson red"
jobs = {
 "Assassin": f"a chibi black-lacquered wooden marionette doll assassin with visible ball joints, short dark hair and a {tc} scarf mask covering the mouth, glowing amber eyes, sleek dark leather outfit with {tc} sash, holding a curved dagger in EACH hand held out to the sides blades pointing outward, {POSE}",
 "Priestess": f"a chibi porcelain flower fairy doll priestess, long pastel pink hair with a big flower crown, white and {tc} petal dress ending above the knees, small leaf wings, holding a short wooden wand topped with a glowing lotus flower in her right hand held out to the side, left hand open with a floating petal, {POSE}",
 "Brawler": f"a chibi stout clay golem doll brawler with cracked stone skin and glowing lava seams, sleeveless {tc} vest, huge stone gauntlet fists, horned bandana, bare stone feet, both big fists held out to the sides, {POSE}",
}
def run(arg):
    k,i = arg
    body=json.dumps({"model":"agnes-image-2.5-flash","prompt":f"{jobs[k]}. {STY}","n":1,"size":"1024x1024"}).encode()
    for _ in range(3):
        try:
            r=urllib.request.Request("https://hub.oaifree.com/v1/images/generations",data=body,headers={"content-type":"application/json"})
            with urllib.request.urlopen(r,timeout=110) as f: j=json.load(f)
            open(f"rig/{k}-{i}.png","wb").write(base64.b64decode(j["data"][0]["b64_json"])); return k,i,"ok"
        except Exception as e: err=str(e)
    return k,i,err
with cf.ThreadPoolExecutor(6) as ex:
    for res in ex.map(run, [(k,i) for k in jobs for i in (0,1)]): print(*res, flush=True)

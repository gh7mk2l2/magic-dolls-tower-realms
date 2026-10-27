import json, base64, urllib.request, concurrent.futures as cf
POSE = "full body, standing in a neutral A-pose, seen from a 3/4 front view with the body turned slightly to the right, BOTH ARMS HELD CLEARLY AWAY FROM THE BODY at about 35 degrees with visible gaps between arms and torso, legs apart and clearly separated with a gap between them, nothing overlapping the torso or face"
BEAST = "seen from a pure side view facing right, standing with all four legs clearly separated and visible with gaps between them, head and jaw clearly separated from the body outline"
STY = "chibi proportions, hand-painted mobile MOBA game character art, crisp clean silhouette, centered, isolated on a perfectly flat solid pure magenta #ff00ff background, no shadow, no ground, no text"
tc="crimson red"
jobs = {
 "Arcanist": f"a chibi porcelain magic doll sorceress with stitched seams and big glowing eyes, wide-brimmed pointed witch hat, {tc} robe with gold star trim ending above the ankles so both legs and small boots are visible, holding a tall staff topped with a glowing star crystal in her right hand pointed outward, left hand open and empty, {POSE}",
 "Ranger": f"a chibi cloth magic doll ranger girl with button details, short silver hair, short hooded cape in {tc}, leather bracers, holding a curved crescent-moon longbow in her left hand held out to the side, right hand empty and open, shorts and light boots, {POSE}",
 "Guardian": f"a chibi wooden-jointed magic doll knight guardian, golden armor with sunrise engravings, {tc} tabard and plume, open-face helmet, round sun-emblem shield strapped on the left forearm held out to the side, short warhammer in the right hand held out to the side, {POSE}",
 "minion": f"a small mutant magic beast creature, four-legged stitched plush body with patchy dark purple fur, oversized jaw, glowing {tc} crystal shards on its back, button eyes, {tc} collar, {BEAST}",
 "super": f"a huge mutant magic beast boss, massive quadruped, one heavy horned head, cracked dark hide with glowing {tc} crystal veins and crystal spikes along the spine, armored clawed legs, {BEAST}",
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

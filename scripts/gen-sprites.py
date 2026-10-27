import json, base64, sys, os, urllib.request, concurrent.futures as cf
STYLE = ("polished 2.5D isometric MOBA game sprite, three-quarter top-down camera view, stylized hand-painted fantasy art, "
         "chibi magic doll toy aesthetic, crisp clean edges, soft rim light, single subject centered, full subject visible, "
         "no ground, no cast shadow, no text, no border, isolated on a perfectly flat solid {bg} background")
G, M = "pure green #00ff00", "pure magenta #ff00ff"
T = {"Red": "crimson red", "Blue": "sapphire blue"}
jobs = {}
for team, tc in T.items():
    jobs[f"hero-Arcanist-{team}"] = (f"a chibi porcelain magic doll sorceress with stitched seams and big glowing eyes, wide-brimmed pointed witch hat, flowing {tc} robe with gold star trim, holding a tall staff topped with a glowing star crystal, standing pose facing the viewer", G if team=="Red" else M)
    jobs[f"hero-Ranger-{team}"] = (f"a chibi cloth magic doll ranger with button details, short silver hair, hooded short cape in {tc}, leather bracers, holding a curved crescent-moon longbow, light boots, standing pose facing the viewer", M)
    jobs[f"hero-Guardian-{team}"] = (f"a chibi wooden-jointed magic doll knight guardian, golden armor with sunrise engravings, {tc} tabard and plume, big round tower shield with a sun emblem, short warhammer, open-face helmet, sturdy standing pose facing the viewer", M)
    jobs[f"tower-{team}"] = (f"a fantasy magic defense tower, tall stone spire wrapped with copper rings and glowing runes, a large faceted {tc} crystal orb floating above the top, octagonal stone base with buttresses, toylike proportions", G)
    jobs[f"base-{team}"] = (f"a fantasy toy-castle citadel home base, round central keep with a huge floating faceted {tc} crystal heart above the roof, four small corner turrets with cone roofs, {tc} banners, wide circular stone foundation, chunky proportions", G)
    jobs[f"minion-{team}"] = (f"a small mutant magic beast creature, four-legged hunched stitched plush body with patchy dark purple fur, oversized jaw, glowing {tc} crystal shards growing from its back, mismatched button eyes, {tc} collar, aggressive walking pose", G)
    jobs[f"super-{team}"] = (f"a huge two-headed mutant magic beast boss, massive quadruped, two heavy horned heads, cracked dark hide with glowing {tc} crystal veins and big crystal spikes along the spine, armored clawed forelegs, broken iron chains, menacing pose", G)
jobs["tree"] = ("a stylized fantasy tree with a dark twisted trunk and round clustered teal-green canopy with faint glowing magical leaves, moody night palette", M)
jobs["rock"] = ("a cluster of three stylized slate grey boulders with a little moss and tiny glowing purple crystals, low wide footprint, moody night palette", M)
jobs["crystal"] = ("a cluster of tall glowing violet and blue magic crystals growing from a small dark rock, moody night palette", G)
jobs["ground"] = ("SEAMLESS TILEABLE TOP-DOWN TEXTURE: dark mossy fantasy battlefield ground seen straight from above, dark teal grass mixed with soil, scattered tiny pebbles and faint magical sparkles, low contrast, even lighting, no objects, fills the entire image edge to edge", None)
only = sys.argv[1:]
def run(k):
    desc, bg = jobs[k]
    prompt = desc if bg is None else f"{desc}. {STYLE.format(bg=bg)}"
    body = json.dumps({"model":"agnes-image-2.5-flash","prompt":prompt,"n":1,"size":"1024x1024"}).encode()
    for attempt in range(3):
        try:
            r = urllib.request.Request("https://hub.oaifree.com/v1/images/generations", data=body, headers={"content-type":"application/json"})
            with urllib.request.urlopen(r, timeout=110) as f: d = json.load(f)
            open(f"art-raw/{k}.png","wb").write(base64.b64decode(d["data"][0]["b64_json"]))
            json.dump({"bg":bg}, open(f"art-raw/{k}.json","w")); return k, "ok"
        except Exception as e: err = str(e)
    return k, err
os.makedirs("art-raw", exist_ok=True)
keys = only or list(jobs)
with cf.ThreadPoolExecutor(6) as ex:
    for k, s in ex.map(run, keys): print(k, s, flush=True)

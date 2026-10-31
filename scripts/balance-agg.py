#!/usr/bin/env python3
# 汇总 balance_report 的逐局 JSONL：胜率(±标准误)、K/D、伤害、死斗比例、复活时长与"全队同时阵亡"时长。
# 用法: python3 scripts/balance-agg.py logs/balance/*.jsonl
import json, sys, statistics as st
names={}
rows={}
games=[]
for f in sys.argv[1:]:
    for line in open(f):
        g=json.loads(line); games.append(g)
for g in games:
    for p in g['players']:
        r=rows.setdefault(p['hero'],dict(n=0,w=0,dr=0,k=0,d=0,dmg=0))
        r['n']+=1; r['k']+=p['k']; r['d']+=p['d']; r['dmg']+=p['dmg']
        if g['winner'] is None: r['dr']+=1
        elif g['winner']==p['team']: r['w']+=1
n=len(games)
dur=[g['ticks']/20 for g in games]
print(f"games={n} avg_dur={st.mean(dur):.0f}s median={st.median(dur):.0f}s draws={sum(g['winner'] is None for g in games)} sudden={sum(g['sudden']>0 for g in games)}")
print(f"red_wins={sum(g['winner']=='Red' for g in games)} blue_wins={sum(g['winner']=='Blue' for g in games)}")
td=[max(g['deaths']) for g in games]
print(f"team deaths max per game: mean={st.mean(td):.1f} p90={sorted(td)[int(.9*n)]} max={max(td)}")
mr=[g['max_respawn_s'] for g in games]
print(f"max respawn seen (s): median={st.median(mr)} p90={sorted(mr)[int(.9*n)]} max={max(mr)}")
ad=[max(g['all_dead_s']) for g in games]
print(f"whole team simultaneously dead (s/game): mean={st.mean(ad):.0f} p90={sorted(ad)[int(.9*n)]} max={max(ad)}")
out=[]
for h,r in sorted(rows.items(), key=lambda x:-x[1]['w']/x[1]['n']):
    wr=r['w']/r['n']; se=(wr*(1-wr)/r['n'])**.5
    out.append((h,wr))
    print(f"{h:13s} n={r['n']:4d} win={wr*100:5.1f}% ±{se*100:4.1f} K={r['k']/r['n']:.2f} D={r['d']/r['n']:.2f} dmg={r['dmg']/r['n']:.0f}")
wrs=[w for _,w in out]
print(f"range {min(wrs)*100:.1f}% .. {max(wrs)*100:.1f}%")

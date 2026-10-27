//! 对局日志工具：
//!
//! ```bash
//! cargo run -p server --bin replay -- logs/xxx.jsonl            # 数值分析报告
//! cargo run -p server --bin replay -- logs/xxx.jsonl --verify   # 用日志中的配置与输入重新模拟，校验结果一致
//! ```

use serde_json::Value;
use shared::{HeroKind, InputFrame, Team};
use sim::{GameConfig, Simulation};
use std::collections::BTreeMap;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("用法: replay <log.jsonl> [--verify]"))?;
    let verify = args.any(|a| a == "--verify");
    let text = std::fs::read_to_string(&path)?;
    let lines: Vec<Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    report(&lines);
    if verify {
        replay(&lines)?;
    }
    Ok(())
}

fn report(lines: &[Value]) {
    let mut deaths_by_hero: BTreeMap<String, u32> = BTreeMap::new();
    let mut towers = Vec::new();
    let mut waves = 0;
    let mut sudden = None;
    let mut inputs = 0u64;
    let mut summary = None;
    for line in lines {
        let t = line["t"].as_u64().unwrap_or(0) as f64 / 20.0;
        let data = &line["data"];
        match line["type"].as_str().unwrap_or("") {
            "input" => inputs += 1,
            "event" => match data["kind"].as_str().unwrap_or("") {
                "Death" => {
                    *deaths_by_hero
                        .entry(data["text"].as_str().unwrap_or("").to_string())
                        .or_default() += 1
                }
                "TowerDestroyed" => {
                    towers.push((t, data["team"].as_str().unwrap_or("?").to_string()))
                }
                "WaveSpawned" => waves += 1,
                "SuddenDeath" => sudden = Some(t),
                _ => {}
            },
            "summary" => summary = Some(data.clone()),
            _ => {}
        }
    }
    println!("== 对局分析 ==");
    println!("输入帧: {inputs}，兵波: {waves}");
    for (t, team) in &towers {
        println!("  {:>6.1}s  {team} 魔法塔陨落", t);
    }
    if let Some(t) = sudden {
        println!("  {:>6.1}s  进入超时死斗", t);
    }
    println!("阵亡记录（按名字）:");
    for (name, n) in &deaths_by_hero {
        println!("  {n:>3}  {name}");
    }
    if let Some(summary) = summary {
        println!(
            "结算: 胜方 {}，时长 {:.1}s，比分 {}:{}",
            summary["winner"].as_str().unwrap_or("平局"),
            summary["ticks"].as_f64().unwrap_or(0.0) / 20.0,
            summary["red_score"],
            summary["blue_score"]
        );
        if let Some(players) = summary["players"].as_array() {
            for p in players {
                println!(
                    "  {:<12} {:<5} {:<9} K{} D{} 伤害{}",
                    p["name"].as_str().unwrap_or(""),
                    p["team"].as_str().unwrap_or(""),
                    p["hero"].as_str().unwrap_or(""),
                    p["kills"],
                    p["deaths"],
                    p["damage"]
                );
            }
        }
    } else {
        println!("（日志中没有结算记录，对局可能未结束）");
    }
}

fn parse<T: serde::de::DeserializeOwned>(v: &Value) -> Option<T> {
    serde_json::from_value(v.clone()).ok()
}

fn replay(lines: &[Value]) -> anyhow::Result<()> {
    let header = lines
        .iter()
        .find(|l| l["type"] == "header")
        .ok_or_else(|| anyhow::anyhow!("缺少 header"))?;
    let config = GameConfig::from_toml(header["data"]["config"].as_str().unwrap_or(""))?;
    let mut sim = Simulation::new(config);
    let mut expected = None;
    for line in lines {
        let t = line["t"].as_u64().unwrap_or(0) as u32;
        let kind = line["type"].as_str().unwrap_or("");
        if kind == "summary" {
            expected = Some(line["data"].clone());
            continue;
        }
        if !matches!(
            kind,
            "join" | "input" | "leave" | "timeout" | "disconnect" | "reconnect"
        ) {
            continue;
        }
        while sim.tick() < t && !sim.is_over() {
            sim.step();
        }
        let data = &line["data"];
        let player = data["player"].as_u64().unwrap_or(0);
        match kind {
            "join" => {
                let team: Option<Team> = parse(&data["requested_team"]).flatten();
                let hero: HeroKind = parse(&data["hero"]).unwrap_or(HeroKind::Arcanist);
                let _ = sim.add_player(player, data["name"].as_str().unwrap_or(""), team, hero);
            }
            "input" => {
                let frame = InputFrame {
                    seq: data["seq"].as_u64().unwrap_or(0) as u32,
                    move_x: data["mx"].as_f64().unwrap_or(0.0) as f32,
                    move_y: data["my"].as_f64().unwrap_or(0.0) as f32,
                    aim_x: data["ax"].as_f64().unwrap_or(0.0) as f32,
                    aim_y: data["ay"].as_f64().unwrap_or(0.0) as f32,
                    attack: data["atk"].as_bool().unwrap_or(false),
                    skills: data["sk"].as_u64().unwrap_or(0) as u8,
                    help: false,
                    accept_help: 0,
                };
                sim.set_input(player, frame);
            }
            "leave" | "timeout" => {
                sim.remove_player(player);
            }
            "disconnect" => {
                sim.set_disconnected(player, true);
            }
            "reconnect" => {
                sim.set_disconnected(player, false);
            }
            _ => {}
        }
    }
    let Some(expected) = expected else {
        println!("回放完成（无结算可比对），tick = {}", sim.tick());
        return Ok(());
    };
    let target = expected["ticks"].as_u64().unwrap_or(0) as u32;
    while sim.tick() < target && !sim.is_over() {
        sim.step();
    }
    let got = serde_json::to_value(sim.summary())?;
    if got["winner"] == expected["winner"]
        && got["ticks"] == expected["ticks"]
        && got["red_score"] == expected["red_score"]
    {
        println!("✔ 回放一致：胜方 {}，tick {}", got["winner"], got["ticks"]);
        Ok(())
    } else {
        anyhow::bail!("✘ 回放不一致\n期望 {expected}\n实际 {got}")
    }
}

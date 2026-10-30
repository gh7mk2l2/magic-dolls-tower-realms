use super::*;

fn input(seq: u32) -> InputFrame {
    InputFrame {
        seq,
        ..InputFrame::default()
    }
}

fn ids_of(sim: &Simulation, kind: EntityKind, team: Team) -> Vec<u32> {
    sim.metas()
        .into_iter()
        .filter(|m| m.kind == kind && m.team == team)
        .map(|m| m.id)
        .collect()
}

fn place(sim: &mut Simulation, id: u32, p: Vec2) {
    let e = sim.entities[&id];
    sim.set_component(e, Position(p));
}

/// 关闭 AI 补位，便于隔离测试规则。
fn quiet() -> Simulation {
    let mut config = GameConfig::default();
    config.world.ai_fill_to = 0;
    config.wave.first_wave_seconds = 100_000;
    config.wave.interval_seconds = 100_000;
    Simulation::new(config)
}

#[test]
fn layout_has_two_towers_one_base_and_zones_per_team() {
    let sim = Simulation::default();
    for team in [Team::Red, Team::Blue] {
        assert_eq!(ids_of(&sim, EntityKind::Base, team).len(), 1);
        assert_eq!(ids_of(&sim, EntityKind::Tower, team).len(), 2);
        assert_eq!(ids_of(&sim, EntityKind::PoisonZone, team).len(), 2);
        let fill = sim.config.world.ai_fill_to;
        assert_eq!(sim.hero_count(team), fill, "AI 补足到 {fill} 名");
    }
    assert_eq!(sim.flow_to_red.dimensions(), (64, 64));
}

#[test]
fn flow_field_leads_minions_to_enemy_base_around_rocks() {
    let sim = Simulation::default();
    let goal = base_position(&sim.config, Team::Blue);
    for start in tower_positions(&sim.config, Team::Red) {
        let mut p = start;
        for _ in 0..2000 {
            let d = sim.flow_to_blue.direction(p);
            p = Vec2 {
                x: p.x + d.x * 8.0,
                y: p.y + d.y * 8.0,
            };
            assert!(!sim.grid.is_blocked_at(p));
        }
        assert!(distance(p, goal) < 80.0, "终点 {p:?}");
    }
}

#[test]
fn human_join_replaces_ai_and_ai_takes_over_on_disconnect() {
    let mut sim = Simulation::default();
    let (hero, team) = sim
        .add_player(7, "甲", Some(Team::Red), HeroKind::Ranger)
        .unwrap();
    assert_eq!(team, Team::Red);
    assert_eq!(sim.hero_count(Team::Red), sim.config.world.ai_fill_to);
    assert_eq!(sim.human_count(Team::Red), 1);
    assert_eq!(sim.player_entity(7), Some(hero));
    assert!(sim.set_disconnected(7, true));
    assert!(sim.hero_state(hero).unwrap().ai);
    assert!(sim.set_disconnected(7, false));
    assert!(sim.remove_player(7));
    assert_eq!(sim.hero_count(Team::Red), sim.config.world.ai_fill_to);
}

#[test]
fn teams_auto_balance_and_cap_at_four() {
    let mut sim = Simulation::default();
    for p in 0..4 {
        assert_eq!(
            sim.add_player(p, "x", Some(Team::Red), HeroKind::Arcanist)
                .unwrap()
                .1,
            Team::Red
        );
    }
    assert_eq!(
        sim.add_player(10, "y", Some(Team::Red), HeroKind::Arcanist)
            .unwrap()
            .1,
        Team::Blue
    );
    for p in 11..14 {
        sim.add_player(p, "z", None, HeroKind::Guardian).unwrap();
    }
    assert_eq!(
        sim.add_player(99, "full", None, HeroKind::Ranger),
        Err(JoinError::TeamsFull)
    );
    assert_eq!(sim.hero_count(Team::Red), 4);
    assert_eq!(sim.hero_count(Team::Blue), 4);
}

#[test]
fn deterministic_replay() {
    let run = || {
        let mut sim = Simulation::default();
        sim.add_player(1, "a", Some(Team::Red), HeroKind::Arcanist)
            .unwrap();
        for t in 1..=600u32 {
            let mut frame = input(t);
            frame.move_x = 1.0;
            frame.attack = true;
            frame.aim_x = 2000.0;
            frame.aim_y = 900.0;
            frame.skills = if t % 40 == 0 { 1 } else { 0 };
            sim.set_input(1, frame);
            sim.step();
        }
        sim.snapshot(true)
    };
    let (a, b) = (run(), run());
    assert_eq!(a.entities, b.entities);
}

#[test]
fn input_queue_acks_in_order_and_rejects_replays() {
    let mut sim = quiet();
    sim.add_player(1, "a", Some(Team::Red), HeroKind::Arcanist)
        .unwrap();
    assert!(sim.set_input(1, input(1)));
    assert!(sim.set_input(1, input(2)));
    assert!(!sim.set_input(1, input(2)), "重复序号必须丢弃");
    sim.step();
    assert_eq!(sim.player_ack(1), 1);
    sim.step();
    assert_eq!(sim.player_ack(1), 2);
}

#[test]
fn heroes_cannot_walk_through_obstacles() {
    let mut sim = quiet();
    let (id, _) = sim
        .add_player(1, "a", Some(Team::Red), HeroKind::Ranger)
        .unwrap();
    let rock = sim.config.obstacles[0].clone();
    place(
        &mut sim,
        id,
        Vec2 {
            x: rock.x - 40.0,
            y: rock.y + rock.h * 0.5,
        },
    );
    for t in 1..200 {
        let mut f = input(t);
        f.move_x = 1.0;
        sim.set_input(1, f);
        sim.step();
    }
    let hero = sim.entity_snapshot(id).unwrap();
    assert!(hero.x < rock.x + 1.0, "穿过了岩石: {}", hero.x);
}

#[test]
fn base_is_invulnerable_until_both_towers_fall_then_victory() {
    let mut sim = quiet();
    let base = ids_of(&sim, EntityKind::Base, Team::Blue)[0];
    let hp = sim.entity_snapshot(base).unwrap().hp;
    assert!(!sim.damage_entity(base, 500.0, Some(Team::Red)));
    assert_eq!(sim.entity_snapshot(base).unwrap().hp, hp);
    assert!(sim.entity_snapshot(base).unwrap().flags & flags::INVULNERABLE != 0);
    let zones = ids_of(&sim, EntityKind::PoisonZone, Team::Blue);
    for tower in ids_of(&sim, EntityKind::Tower, Team::Blue) {
        assert!(sim.damage_entity(tower, 1e6, Some(Team::Red)));
    }
    for zone in zones {
        assert!(sim.entity_snapshot(zone).is_none(), "塔毁后毒区永久消失");
    }
    assert!(!sim.is_base_invulnerable(Team::Blue));
    assert!(sim.damage_entity(base, 1e6, Some(Team::Red)));
    assert_eq!(sim.winner(), Some(Team::Red));
    assert!(sim.is_over());
}

#[test]
fn dead_hero_respawns_at_base() {
    let mut sim = quiet();
    let (id, _) = sim
        .add_player(9, "g", Some(Team::Red), HeroKind::Guardian)
        .unwrap();
    place(
        &mut sim,
        id,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    sim.damage_entity(id, 1e5, Some(Team::Blue));
    assert_eq!(sim.entity_snapshot(id).unwrap().hp, 0.0);
    assert_eq!(sim.blue_score, 1);
    for _ in 0..sim.config.world.respawn_ticks(1) {
        sim.step();
    }
    let hero = sim.entity_snapshot(id).unwrap();
    assert_eq!(hero.hp, hero.max_hp);
    assert_eq!(hero.respawn, 0);
    assert!(hero.x < 400.0);
}

#[test]
fn poison_ticks_each_second_only_inside_enemy_zone() {
    let mut sim = quiet();
    let (id, _) = sim
        .add_player(2, "p", Some(Team::Red), HeroKind::Guardian)
        .unwrap();
    let blue_tower = tower_positions(&sim.config, Team::Blue)[0];
    // 放在塔射程外但毒区内？毒区半径 250 < 塔射程 310，所以关闭塔攻击来隔离毒区。
    for t in ids_of(&sim, EntityKind::Tower, Team::Blue) {
        let e = sim.entities[&t];
        sim.world.get::<&mut Combat>(e).unwrap().damage = 0.0;
    }
    place(
        &mut sim,
        id,
        Vec2 {
            x: blue_tower.x - 150.0,
            y: blue_tower.y,
        },
    );
    let hp0 = sim.entity_snapshot(id).unwrap().hp;
    for _ in 0..(TICK_RATE - 1) {
        sim.step();
    }
    assert_eq!(sim.entity_snapshot(id).unwrap().hp, hp0, "不足 1 秒不结算");
    sim.step();
    let hp1 = sim.entity_snapshot(id).unwrap().hp;
    assert!((hp0 - hp1 - sim.config.poison.dps).abs() < 1.01);
    // 离开毒区后停止掉血。
    place(
        &mut sim,
        id,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    for _ in 0..TICK_RATE * 3 {
        sim.step();
    }
    assert_eq!(sim.entity_snapshot(id).unwrap().hp, hp1);
    // 己方毒区不伤害自己。
    let red_tower = tower_positions(&sim.config, Team::Red)[0];
    place(&mut sim, id, red_tower);
    for _ in 0..TICK_RATE * 3 {
        sim.step();
    }
    assert_eq!(sim.entity_snapshot(id).unwrap().hp, hp1);
}

#[test]
fn each_tower_spawns_waves_that_grow() {
    let mut config = GameConfig::default();
    config.world.ai_fill_to = 0;
    let mut sim = Simulation::new(config);
    let first = sim.config.wave.first_wave_seconds * TICK_RATE;
    for _ in 0..first {
        sim.step();
    }
    let per = sim.config.wave.count_per_tower as usize;
    for team in [Team::Red, Team::Blue] {
        assert_eq!(ids_of(&sim, EntityKind::Minion, team).len(), per * 2);
    }
    let initial_hp = sim
        .metas()
        .into_iter()
        .find(|m| m.kind == EntityKind::Minion)
        .unwrap()
        .hp;
    for _ in 0..sim.config.wave.interval_seconds * TICK_RATE {
        sim.step();
    }
    let max_hp = sim
        .metas()
        .into_iter()
        .filter(|m| m.kind == EntityKind::Minion)
        .map(|m| m.hp)
        .fold(0.0, f32::max);
    assert!(max_hp > initial_hp);
    assert_eq!(sim.wave, 2);
}

#[test]
fn minions_march_toward_enemy_base() {
    let mut config = GameConfig::default();
    config.world.ai_fill_to = 0;
    let mut sim = Simulation::new(config);
    for _ in 0..(sim.config.wave.first_wave_seconds * TICK_RATE + 1) {
        sim.step();
    }
    let red: Vec<u32> = ids_of(&sim, EntityKind::Minion, Team::Red);
    let start: f32 = red
        .iter()
        .map(|&id| sim.entity_snapshot(id).unwrap().x)
        .sum::<f32>()
        / red.len() as f32;
    for _ in 0..TICK_RATE * 8 {
        sim.step();
    }
    let alive: Vec<f32> = red
        .iter()
        .filter_map(|&id| sim.entity_snapshot(id))
        .map(|e| e.x)
        .collect();
    assert!(!alive.is_empty());
    let now = alive.iter().sum::<f32>() / alive.len() as f32;
    assert!(now > start + 300.0, "{start} -> {now}");
}

#[test]
fn delta_snapshots_contain_only_changes_and_removals() {
    let mut sim = quiet();
    let full = sim.snapshot(true);
    assert!(full.full && !full.entities.is_empty());
    sim.step();
    let delta = sim.snapshot(false);
    assert!(
        delta.entities.is_empty(),
        "静止世界的增量快照应为空: {:?}",
        delta.entities.len()
    );
    let tower = ids_of(&sim, EntityKind::Tower, Team::Red)[0];
    sim.damage_entity(tower, 10.0, Some(Team::Blue));
    let delta = sim.snapshot(false);
    assert_eq!(delta.entities.len(), 1);
    sim.damage_entity(tower, 1e6, Some(Team::Blue));
    let delta = sim.snapshot(false);
    assert!(delta.removed.contains(&tower));
}

#[test]
fn skills_damage_stun_and_respect_cooldown() {
    let mut sim = quiet();
    let (me, _) = sim
        .add_player(1, "a", Some(Team::Red), HeroKind::Arcanist)
        .unwrap();
    let (foe, _) = sim
        .add_player(2, "b", Some(Team::Blue), HeroKind::Guardian)
        .unwrap();
    place(
        &mut sim,
        me,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    place(
        &mut sim,
        foe,
        Vec2 {
            x: 1800.0,
            y: 300.0,
        },
    );
    let hp0 = sim.entity_snapshot(foe).unwrap().hp;
    let mut f = input(1);
    f.aim_x = 1800.0;
    f.aim_y = 300.0;
    f.skills = 0b011; // Q 伤害 + E 眩晕
    sim.set_input(1, f.clone());
    sim.step();
    let after = sim.entity_snapshot(foe).unwrap();
    let q = sim.config.skill(HeroKind::Arcanist, 0).damage;
    let e = sim.config.skill(HeroKind::Arcanist, 1).damage;
    assert!((hp0 - after.hp - q - e).abs() < 1.01);
    assert!(after.flags & flags::STUNNED != 0);
    let me_snap = sim.entity_snapshot(me).unwrap();
    assert!(me_snap.cooldowns[0] > 0 && me_snap.cooldowns[1] > 0);
    // 冷却中再次施放无效。
    f.seq = 2;
    sim.set_input(1, f);
    sim.step();
    assert_eq!(sim.entity_snapshot(foe).unwrap().hp, after.hp);
}

#[test]
fn sudden_death_spawns_control_immune_supers_that_end_the_match() {
    let mut config = GameConfig::default();
    config.world.ai_fill_to = 0;
    config.wave.first_wave_seconds = 100_000;
    config.wave.interval_seconds = 100_000;
    config.world.match_seconds = 1;
    let mut sim = Simulation::new(config);
    for _ in 0..TICK_RATE {
        sim.step();
    }
    assert_eq!(sim.phase(), Phase::SuddenDeath);
    let supers = sim
        .metas()
        .into_iter()
        .filter(|m| m.kind == EntityKind::SuperMinion)
        .collect::<Vec<_>>();
    assert_eq!(supers.len(), 4, "每座存活魔法塔孕育一只");
    let snap = sim.entity_snapshot(supers[0].id).unwrap();
    assert!(snap.flags & flags::CONTROL_IMMUNE != 0);
    // 免疫控制：眩晕不生效。
    let (me, _) = sim
        .add_player(1, "a", Some(Team::Blue), HeroKind::Arcanist)
        .unwrap();
    let red_super = supers.iter().find(|m| m.team == Team::Red).unwrap();
    place(
        &mut sim,
        me,
        Vec2 {
            x: red_super.position.x + 200.0,
            y: red_super.position.y,
        },
    );
    let mut f = input(1);
    f.aim_x = red_super.position.x;
    f.aim_y = red_super.position.y;
    f.skills = 0b010;
    sim.set_input(1, f);
    sim.step();
    assert_eq!(
        sim.entity_snapshot(red_super.id).unwrap().flags & flags::STUNNED,
        0
    );
    // 无视护盾与一切，数分钟内结束对局。
    let mut ticks = 0;
    while !sim.is_over() && ticks < TICK_RATE * 60 * 4 {
        sim.step();
        ticks += 1;
    }
    assert!(sim.is_over(), "死斗应在时限内结束");
    assert!(ticks < TICK_RATE * 60 * 3, "用时 {} 秒", ticks / TICK_RATE);
}

#[test]
fn sudden_death_timeout_resolves_by_base_hp() {
    let mut config = GameConfig::default();
    config.world.ai_fill_to = 0;
    config.world.match_seconds = 1;
    config.sudden_death.max_seconds = 1;
    config.sudden_death.speed = 0.0;
    let mut sim = Simulation::new(config);
    let blue_base = ids_of(&sim, EntityKind::Base, Team::Blue)[0];
    for t in ids_of(&sim, EntityKind::Tower, Team::Blue) {
        sim.damage_entity(t, 1e6, Some(Team::Red));
    }
    sim.damage_entity(blue_base, 100.0, Some(Team::Red));
    for _ in 0..TICK_RATE * 3 {
        sim.step();
    }
    assert!(sim.is_over());
    assert_eq!(sim.winner(), Some(Team::Red));
}

#[test]
fn invalid_input_is_sanitized() {
    let mut sim = quiet();
    let (id, _) = sim
        .add_player(3, "r", Some(Team::Red), HeroKind::Ranger)
        .unwrap();
    let before = sim.entity_snapshot(id).unwrap();
    let mut frame = input(1);
    frame.move_x = f32::NAN;
    frame.move_y = f32::INFINITY;
    frame.skills = 0xf8; // 只有非法位
    sim.set_input(3, frame);
    sim.step();
    let after = sim.entity_snapshot(id).unwrap();
    assert!(after.x.is_finite() && after.y.is_finite());
    assert_eq!(before.x, after.x);
}

#[test]
fn full_ai_match_finishes() {
    // 4v4 全 AI 对局在时限+死斗内必定结束，且不 panic。
    let mut config = GameConfig::default();
    config.world.ai_fill_to = 4;
    let limit = (config.world.match_seconds + config.sudden_death.max_seconds + 5) * TICK_RATE;
    let mut sim = Simulation::new(config);
    let mut ticks = 0;
    while !sim.is_over() && ticks < limit {
        sim.step();
        if ticks % 20 == 0 {
            let _ = sim.snapshot(ticks % 200 == 0);
        }
        ticks += 1;
    }
    assert!(sim.is_over());
    let summary = sim.summary();
    assert_eq!(summary.players.len(), 8);
    println!(
        "全 AI 4v4：胜方 {:?}，用时 {} 秒，比分 {}:{}，摧毁塔 {}:{}",
        summary.winner,
        summary.ticks / TICK_RATE,
        summary.red_score,
        summary.blue_score,
        summary.towers_destroyed_red,
        summary.towers_destroyed_blue
    );
}

#[test]
fn custom_team_name_first_wins_and_is_sanitized() {
    let mut sim = quiet();
    assert_eq!(
        sim.team_names(),
        vec!["绯红玩偶团".to_string(), "湛蓝玩偶团".to_string()]
    );
    assert!(sim.set_team_name(Team::Red, "  <火焰>之心战队超长名字  "));
    assert_eq!(sim.team_names()[0], "火焰之心战队超长");
    assert!(!sim.set_team_name(Team::Red, "第二个人"), "先命名者生效");
    assert!(!sim.set_team_name(Team::Blue, "   "), "空名字忽略");
    assert_eq!(sim.snapshot(true).team_names[0], "火焰之心战队超长");
}

#[test]
fn help_request_reaches_team_and_accept_targets_requester() {
    let mut sim = quiet();
    let (a, _) = sim
        .add_player(1, "求救者", Some(Team::Red), HeroKind::Arcanist)
        .unwrap();
    let (b, _) = sim
        .add_player(2, "支援者", Some(Team::Red), HeroKind::Guardian)
        .unwrap();
    let (c, _) = sim
        .add_player(3, "敌人", Some(Team::Blue), HeroKind::Ranger)
        .unwrap();
    sim.snapshot(true);
    assert!(sim.set_input(
        1,
        InputFrame {
            seq: 1,
            help: true,
            ..InputFrame::default()
        }
    ));
    let events = sim.snapshot(false).events;
    let req = events
        .iter()
        .find(|e| e.kind == EventKind::HelpRequest)
        .expect("求救事件");
    assert_eq!(
        (req.source, req.team, req.text.as_str()),
        (a, Some(Team::Red), "求救者")
    );
    // 冷却内重复求救无效
    sim.set_input(
        1,
        InputFrame {
            seq: 2,
            help: true,
            ..InputFrame::default()
        },
    );
    assert!(!sim
        .snapshot(false)
        .events
        .iter()
        .any(|e| e.kind == EventKind::HelpRequest));
    // 敌方不能接受；队友可以
    sim.set_input(
        3,
        InputFrame {
            seq: 1,
            accept_help: a,
            ..InputFrame::default()
        },
    );
    sim.set_input(
        2,
        InputFrame {
            seq: 1,
            accept_help: a,
            ..InputFrame::default()
        },
    );
    let accepted: Vec<_> = sim
        .snapshot(false)
        .events
        .into_iter()
        .filter(|e| e.kind == EventKind::HelpAccepted)
        .collect();
    assert_eq!(accepted.len(), 1);
    assert_eq!((accepted[0].source, accepted[0].target), (b, a));
    let _ = c;
}

// ------------------------------------------------------------ 复活时间按队伍累计翻倍

fn respawn_of(sim: &Simulation, id: u32) -> u32 {
    sim.entity_snapshot(id).unwrap().respawn
}

#[test]
fn respawn_doubles_per_team_death_count() {
    // 例：A 队小明阵亡 1s；A 队小红随后阵亡 2s；B 队小刚阵亡 1s（对面独立计算）。
    let mut sim = quiet();
    let (ming, _) = sim
        .add_player(1, "小明", Some(Team::Red), HeroKind::Arcanist)
        .unwrap();
    let (hong, _) = sim
        .add_player(2, "小红", Some(Team::Red), HeroKind::Priestess)
        .unwrap();
    let (gang, _) = sim
        .add_player(3, "小刚", Some(Team::Blue), HeroKind::Brawler)
        .unwrap();
    for (id, x) in [(ming, 1500.0), (hong, 1500.0), (gang, 1700.0)] {
        place(&mut sim, id, Vec2 { x, y: 300.0 });
    }
    sim.damage_entity(ming, 1e6, Some(Team::Blue));
    assert_eq!(respawn_of(&sim, ming), TICK_RATE, "红队第 1 次阵亡：1 秒");
    sim.damage_entity(hong, 1e6, Some(Team::Blue));
    assert_eq!(
        respawn_of(&sim, hong),
        2 * TICK_RATE,
        "红队第 2 次阵亡：2 秒"
    );
    sim.damage_entity(gang, 1e6, Some(Team::Red));
    assert_eq!(respawn_of(&sim, gang), TICK_RATE, "蓝队独立计数：1 秒");
    assert_eq!(sim.team_deaths(Team::Red), 2);
    assert_eq!(sim.team_deaths(Team::Blue), 1);

    // 1 秒后小明复活、小红还剩 1 秒；小明再阵亡是红队第 3 次：4 秒
    for _ in 0..TICK_RATE {
        sim.step();
    }
    assert_eq!(respawn_of(&sim, ming), 0);
    assert_eq!(respawn_of(&sim, hong), TICK_RATE);
    place(
        &mut sim,
        ming,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    sim.damage_entity(ming, 1e6, Some(Team::Blue));
    assert_eq!(respawn_of(&sim, ming), 4 * TICK_RATE);
    // 快照字段与 HUD 倒计时一致（tick / 20 = 秒）
    let snap = sim.peek_full();
    let ming_snap = snap.entities.iter().find(|e| e.id == ming).unwrap();
    assert_eq!(ming_snap.respawn as f32 / TICK_RATE as f32, 4.0);
}

#[test]
fn respawn_counter_resets_each_match_and_saturates() {
    let mut sim = quiet();
    let (id, _) = sim
        .add_player(1, "甲", Some(Team::Red), HeroKind::Guardian)
        .unwrap();
    // 模拟一局里阵亡了非常多次：不会溢出或 panic，复活时间封顶在 u32::MAX tick
    sim.team_deaths[0] = u32::MAX - 1;
    place(
        &mut sim,
        id,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    sim.damage_entity(id, 1e6, Some(Team::Blue));
    assert_eq!(respawn_of(&sim, id), u32::MAX);
    assert_eq!(sim.team_deaths(Team::Red), u32::MAX);
    sim.team_deaths[0] = u32::MAX;
    assert_eq!(sim.config.world.respawn_ticks(u32::MAX), u32::MAX);
    // 新的一局重新从 1 秒开始
    let fresh = quiet();
    assert_eq!(fresh.team_deaths(Team::Red), 0);
    assert_eq!(fresh.team_deaths(Team::Blue), 0);
}

// ------------------------------------------------------------ 20 名玩偶与新技能效果

fn cast(sim: &mut Simulation, player: u64, seq: u32, slot: u8, aim: Vec2) {
    sim.set_input(
        player,
        InputFrame {
            seq,
            aim_x: aim.x,
            aim_y: aim.y,
            skills: 1 << slot,
            ..InputFrame::default()
        },
    );
    sim.step();
}

fn hp(sim: &Simulation, id: u32) -> f32 {
    sim.entity_snapshot(id).unwrap().hp
}

#[test]
fn ai_lineups_are_unique_across_twenty_heroes() {
    for seed in 1..30u64 {
        let sim = Simulation::with_seed(GameConfig::default(), seed);
        let mut kinds = sim.kinds_in_play(None);
        assert_eq!(kinds.len(), 8);
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds.len(), 8, "种子 {seed}：双方 8 个 AI 互不重复");
    }
    // 真人选了与本队 AI 相同的玩偶 → 该 AI 换人
    let mut sim = Simulation::with_seed(GameConfig::default(), 7);
    let red_ai = sim.kinds_in_play(Some(Team::Red));
    let (_, team) = sim.add_player(1, "人", Some(Team::Red), red_ai[1]).unwrap();
    let mut kinds = sim.kinds_in_play(Some(team));
    kinds.sort();
    kinds.dedup();
    assert_eq!(kinds.len(), 4, "本队阵容去重");
}

#[test]
fn chain_lightning_bounces_between_enemies() {
    let mut sim = quiet();
    let (me, _) = sim
        .add_player(1, "雷", Some(Team::Red), HeroKind::Stormcaller)
        .unwrap();
    let foes: Vec<u32> = (0..3)
        .map(|i| {
            sim.add_player(10 + i, "敌", Some(Team::Blue), HeroKind::Colossus)
                .unwrap()
                .0
        })
        .collect();
    place(
        &mut sim,
        me,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    for (i, &f) in foes.iter().enumerate() {
        place(
            &mut sim,
            f,
            Vec2 {
                x: 1800.0 + i as f32 * 150.0,
                y: 300.0,
            },
        );
    }
    let before: Vec<f32> = foes.iter().map(|&f| hp(&sim, f)).collect();
    cast(
        &mut sim,
        1,
        1,
        0,
        Vec2 {
            x: 1800.0,
            y: 300.0,
        },
    );
    for (i, &f) in foes.iter().enumerate() {
        assert!(hp(&sim, f) < before[i], "第 {i} 个敌人被闪电命中");
    }
    // 伤害逐跳衰减
    assert!(before[0] - hp(&sim, foes[0]) > before[2] - hp(&sim, foes[2]));
}

#[test]
fn shield_absorbs_and_fortify_reduces_damage() {
    let mut sim = quiet();
    let (pal, _) = sim
        .add_player(1, "骑", Some(Team::Red), HeroKind::Paladin)
        .unwrap();
    place(
        &mut sim,
        pal,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    cast(
        &mut sim,
        1,
        1,
        1,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    assert!(sim.entity_snapshot(pal).unwrap().flags & flags::SHIELDED != 0);
    let full = hp(&sim, pal);
    sim.damage_entity(pal, 100.0, Some(Team::Blue));
    assert_eq!(hp(&sim, pal), full, "护盾吸收伤害");

    let (rock, _) = sim
        .add_player(2, "岩", Some(Team::Red), HeroKind::Colossus)
        .unwrap();
    place(
        &mut sim,
        rock,
        Vec2 {
            x: 1500.0,
            y: 600.0,
        },
    );
    cast(
        &mut sim,
        2,
        1,
        1,
        Vec2 {
            x: 1500.0,
            y: 600.0,
        },
    );
    let before = hp(&sim, rock);
    sim.damage_entity(rock, 100.0, Some(Team::Blue));
    assert!((before - hp(&sim, rock) - 60.0).abs() < 1.5, "石肤减伤 40%");
}

#[test]
fn taunt_pull_cloud_haste_regen_stealth_summon() {
    let mut sim = quiet();
    let (rock, _) = sim
        .add_player(1, "岩", Some(Team::Red), HeroKind::Colossus)
        .unwrap();
    let (foe, _) = sim
        .add_player(2, "敌", Some(Team::Blue), HeroKind::Arcanist)
        .unwrap();
    place(
        &mut sim,
        rock,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    place(
        &mut sim,
        foe,
        Vec2 {
            x: 1700.0,
            y: 300.0,
        },
    );
    // 嘲讽：敌人被强制走向巨像
    cast(
        &mut sim,
        1,
        1,
        2,
        Vec2 {
            x: 1700.0,
            y: 300.0,
        },
    );
    assert!(sim.entity_snapshot(foe).unwrap().flags & flags::TAUNTED != 0);
    let x0 = sim.entity_snapshot(foe).unwrap().x;
    for _ in 0..5 {
        sim.step();
    }
    assert!(
        sim.entity_snapshot(foe).unwrap().x < x0,
        "被嘲讽者走向嘲讽者"
    );

    // 拉拽
    let mut sim = quiet();
    let (night, _) = sim
        .add_player(1, "夜", Some(Team::Red), HeroKind::Nightshade)
        .unwrap();
    let (foe, _) = sim
        .add_player(2, "敌", Some(Team::Blue), HeroKind::Arcanist)
        .unwrap();
    place(
        &mut sim,
        night,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    place(
        &mut sim,
        foe,
        Vec2 {
            x: 1950.0,
            y: 300.0,
        },
    );
    cast(
        &mut sim,
        1,
        1,
        0,
        Vec2 {
            x: 1950.0,
            y: 300.0,
        },
    );
    let pulled = sim.entity_snapshot(foe).unwrap();
    assert!(pulled.x < 1750.0, "被拉近：{}", pulled.x);
    assert!(pulled.flags & flags::STUNNED != 0);

    // 毒云：持续掉血
    let mut sim = quiet();
    let (alc, _) = sim
        .add_player(1, "药", Some(Team::Red), HeroKind::Alchemist)
        .unwrap();
    let (foe, _) = sim
        .add_player(2, "敌", Some(Team::Blue), HeroKind::Colossus)
        .unwrap();
    place(
        &mut sim,
        alc,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    place(
        &mut sim,
        foe,
        Vec2 {
            x: 1800.0,
            y: 300.0,
        },
    );
    cast(
        &mut sim,
        1,
        1,
        0,
        Vec2 {
            x: 1800.0,
            y: 300.0,
        },
    );
    let h1 = hp(&sim, foe);
    for _ in 0..40 {
        sim.step();
    }
    assert!(hp(&sim, foe) < h1 - 80.0, "毒云 2 秒内持续伤害");
    let zone_events = sim
        .snapshot(true)
        .events
        .iter()
        .filter(|e| e.kind == EventKind::Zone)
        .count();
    assert!(zone_events >= 1);

    // 加速 + 治疗光环
    let mut sim = quiet();
    let (bard, _) = sim
        .add_player(1, "诗", Some(Team::Red), HeroKind::Bard)
        .unwrap();
    place(
        &mut sim,
        bard,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    cast(&mut sim, 1, 1, 1, Vec2::default());
    assert!(sim.entity_snapshot(bard).unwrap().speed_mul > 1.2);
    sim.damage_entity(bard, 300.0, Some(Team::Blue));
    let low = hp(&sim, bard);
    cast(&mut sim, 1, 2, 2, Vec2::default());
    for _ in 0..40 {
        sim.step();
    }
    assert!(hp(&sim, bard) > low + 50.0, "治疗光环持续回复");

    // 隐身：敌方塔/英雄无法选中，普攻现身
    let mut sim = quiet();
    let (mir, _) = sim
        .add_player(1, "影", Some(Team::Red), HeroKind::Mirage)
        .unwrap();
    place(
        &mut sim,
        mir,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    cast(&mut sim, 1, 1, 1, Vec2::default());
    let snap = sim.entity_snapshot(mir).unwrap();
    assert!(snap.flags & flags::STEALTH != 0);
    let meta = sim.metas().into_iter().find(|m| m.id == mir).unwrap();
    assert!(!sim.targetable(&meta));

    // 召唤：炮台原地驻守并在到期后消失；狼灵会动
    let mut sim = quiet();
    let (art, _) = sim
        .add_player(1, "匠", Some(Team::Red), HeroKind::Artificer)
        .unwrap();
    place(
        &mut sim,
        art,
        Vec2 {
            x: 1500.0,
            y: 300.0,
        },
    );
    let before = ids_of(&sim, EntityKind::Minion, Team::Red).len();
    cast(
        &mut sim,
        1,
        1,
        1,
        Vec2 {
            x: 1600.0,
            y: 300.0,
        },
    );
    let turrets = ids_of(&sim, EntityKind::Minion, Team::Red);
    assert_eq!(turrets.len(), before + 1);
    let turret = sim.entity_snapshot(turrets[0]).unwrap();
    assert_eq!(turret.name.as_deref(), Some("机关炮台"));
    for _ in 0..(10 * TICK_RATE + 2) {
        sim.step();
    }
    assert_eq!(
        ids_of(&sim, EntityKind::Minion, Team::Red).len(),
        before,
        "炮台到期消失"
    );
}

#[test]
fn every_hero_can_cast_all_skills_without_panic() {
    for &kind in HeroKind::ALL.iter() {
        let mut sim = quiet();
        let (me, _) = sim.add_player(1, "测", Some(Team::Red), kind).unwrap();
        let (foe, _) = sim
            .add_player(2, "敌", Some(Team::Blue), HeroKind::Guardian)
            .unwrap();
        place(
            &mut sim,
            me,
            Vec2 {
                x: 1500.0,
                y: 300.0,
            },
        );
        place(
            &mut sim,
            foe,
            Vec2 {
                x: 1700.0,
                y: 300.0,
            },
        );
        for slot in 0..3u8 {
            cast(
                &mut sim,
                1,
                slot as u32 + 1,
                slot,
                Vec2 {
                    x: 1700.0,
                    y: 300.0,
                },
            );
            let cd = sim.entity_snapshot(me).unwrap().cooldowns[slot as usize];
            assert!(cd > 0, "{kind:?} 技能 {slot} 进入冷却");
        }
        for _ in 0..200 {
            sim.step();
        }
    }
}

/// 平衡统计：轮换阵容跑若干局全 AI 4v4，输出各玩偶胜率与 K/D。
///
/// `cargo test -p sim --release -- --ignored balance_report --nocapture`
/// 局数可用环境变量 `BALANCE_MATCHES` 调整（默认 40）。
#[test]
#[ignore]
fn balance_report() {
    let matches: u64 = std::env::var("BALANCE_MATCHES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(40);
    #[derive(Default, Clone)]
    struct Row {
        games: u32,
        wins: u32,
        draws: u32,
        kills: u32,
        deaths: u32,
        damage: f32,
    }
    let mut rows: BTreeMap<HeroKind, Row> = BTreeMap::new();
    let mut total_ticks = 0u64;
    for m in 0..matches {
        // 确定性洗牌，保证每个玩偶出场次数接近
        let mut rng = DeterministicRng(0x9e37_79b9_7f4a_7c15 ^ (m + 1).wrapping_mul(0x2545_f491));
        let mut pool = HeroKind::ALL.to_vec();
        for i in (1..pool.len()).rev() {
            let j = ((rng.next_f32() * (i + 1) as f32) as usize).min(i);
            pool.swap(i, j);
        }
        let mut sim = Simulation::with_seed(GameConfig::default(), m + 1);
        sim.set_ai_lineup(Team::Red, &pool[0..4]);
        sim.set_ai_lineup(Team::Blue, &pool[4..8]);
        let limit =
            (sim.config.world.match_seconds + sim.config.sudden_death.max_seconds + 5) * TICK_RATE;
        while !sim.is_over() && sim.tick() < limit {
            sim.step();
        }
        let summary = sim.summary();
        total_ticks += summary.ticks as u64;
        for p in &summary.players {
            let row = rows.entry(p.hero).or_default();
            row.games += 1;
            match summary.winner {
                Some(w) if w == p.team => row.wins += 1,
                None => row.draws += 1,
                _ => {}
            }
            row.kills += p.kills;
            row.deaths += p.deaths;
            row.damage += p.damage;
        }
    }
    println!(
        "\n平衡统计：{matches} 局，平均 {:.0} 秒/局",
        total_ticks as f64 / matches as f64 / TICK_RATE as f64
    );
    println!(
        "{:<12} {:>4} {:>7} {:>7} {:>7} {:>6} {:>9}",
        "玩偶", "局", "胜率", "场均K", "场均D", "K/D", "场均伤害"
    );
    let config = GameConfig::default();
    let mut sorted: Vec<_> = rows.into_iter().collect();
    sorted.sort_by(|a, b| {
        let wa = a.1.wins as f32 / a.1.games.max(1) as f32;
        let wb = b.1.wins as f32 / b.1.games.max(1) as f32;
        wb.total_cmp(&wa)
    });
    for (kind, r) in sorted {
        let g = r.games.max(1) as f32;
        println!(
            "{:<10} {:>4} {:>6.0}% {:>7.1} {:>7.1} {:>6.2} {:>9.0}",
            config.hero(kind).name,
            r.games,
            r.wins as f32 / g * 100.0,
            r.kills as f32 / g,
            r.deaths as f32 / g,
            r.kills as f32 / r.deaths.max(1) as f32,
            r.damage / g
        );
        let _ = r.draws;
    }
}

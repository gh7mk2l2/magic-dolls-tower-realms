import { HEROES, SKILL_KEYS, TEAM_CSS, TEAM_NAMES, teamNames, applyTeamNames } from './config';
import type { ConnectionStatus } from './network';
import { FLAGS, type EntitySnapshot, type HeroInfo, type HeroKind, type MapInfo, type MatchSummary, type Snapshot, type Team } from './protocol';

const structure = (id: string, label: string) => `<div class="structure" data-structure="${id}"><span>${label}</span><div><i></i></div></div>`;
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (seconds: number) => `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

export function shellMarkup(): string {
  const heroButtons = (Object.keys(HEROES) as HeroKind[]).map((kind, i) => {
    const h = HEROES[kind];
    return `<button class="hero-option${i === 0 ? ' selected' : ''}" data-hero="${kind}" style="--hero-color:${h.css}"><span class="hero-portrait"><img src="${import.meta.env.BASE_URL}sprites/hero-${kind}-Blue.png" alt="" onerror="this.replaceWith('${h.icon}')"></span><b>${h.name}</b><small>${h.title.split(' · ')[1]}</small></button>`;
  }).join('');
  return `
  <div class="ambient"><div class="stars"></div><div class="nebula nebula-a"></div><div class="nebula nebula-b"></div><div class="runes-bg">ᚫ&nbsp;&nbsp;ᛟ&nbsp;&nbsp;ᚱ</div></div>
  <main id="lobby" class="lobby">
    <header class="lobby-header">
      <a class="brand" href="#" aria-label="魔法玩偶：塔域战争"><span class="brand-mark">偶</span><span><b>MAGIC DOLLS</b><small>TOWER REALMS</small></span></a>
      <div class="server-state"><i id="server-dot"></i><span id="server-text">检测服务器…</span><em>协议 v2 · 20Hz</em></div>
    </header>
    <section class="lobby-content">
      <div class="hero-intro">
        <div class="eyebrow"><span></span> 2.5D MOBA-lite · 服务端权威 <span></span></div>
        <h1>魔法玩偶</h1>
        <div class="english-title">塔 域 战 争 &nbsp;·&nbsp; TOWER REALMS WAR</div>
        <p class="intro-copy">魔法塔散发致命魔力辐射，每三十秒孕育一批变异魔兽。<br>击碎敌方两座魔法塔，基地护盾才会崩解——十五分钟未分胜负，超级双头魔兽将终结一切。</p>
        <div class="feature-row"><div><b>2~4</b><span>每队玩偶</span></div><i></i><div><b>30<small>s</small></b><span>魔兽兵波</span></div><i></i><div><b>15<small>min</small></b><span>超时死斗</span></div></div>
        <div class="selected-showcase">
          <div class="showcase-orbit"><i></i><i></i><div id="showcase-icon" class="showcase-icon">✦</div></div>
          <div><small id="showcase-title"></small><h2 id="showcase-name"></h2><p id="showcase-lore"></p><span id="showcase-skill"></span></div>
        </div>
      </div>
      <div class="join-panel-wrap">
        <div class="join-panel">
          <div class="panel-corner top-left"></div><div class="panel-corner bottom-right"></div>
          <div class="panel-heading"><div><small>PREPARE FOR BATTLE</small><h2>召唤玩偶</h2></div><span id="room-count">—</span></div>
          <div class="form-grid">
            <label><span>玩家昵称</span><input id="player-name" maxlength="16" autocomplete="off" placeholder="输入昵称"></label>
            <label><span>房间代号</span><input id="room-name" maxlength="24" autocomplete="off" placeholder="main"></label>
          </div>
          <div class="field-label"><span>选择阵营</span><small>满员时自动平衡</small></div>
          <div class="team-select" role="group">
            <button class="team-option red selected" data-team="Red"><i>◆</i><span><b>${TEAM_NAMES.Red}</b><small>西侧 · 先手</small></span></button>
            <button class="team-option blue" data-team="Blue"><i>◆</i><span><b>${TEAM_NAMES.Blue}</b><small>东侧 · 守望</small></span></button>
          </div>
          <label class="team-name-field"><span>自定义战队名 <small>可选 · 本队第一位命名者生效 · 最多 8 字</small></span><input id="team-name" maxlength="8" autocomplete="off" placeholder="留空使用默认队名"></label>
          <div class="field-label"><span>选择魔法玩偶</span><small>每个玩偶 3 个技能</small></div>
          <div class="hero-select">${heroButtons}</div>
          <div class="join-actions"><button id="play-offline" class="secondary-btn"><span>◈</span><div><b>单机演练</b><small>浏览器内 WASM 模拟</small></div></button><button id="play-online" class="primary-btn"><span>⚔</span><div><b>进入战场</b><small>联网对战</small></div><i>›</i></button></div>
          <p id="join-error" class="join-error" role="alert"></p>
        </div>
        <div class="controls-hint"><span><kbd>WASD</kbd> 移动</span><i></i><span><kbd>鼠标</kbd> 瞄准 · 左键普攻</span><i></i><span><kbd>Q E R</kbd> 技能</span><i></i><span><kbd>Tab</kbd> 战况</span></div>
        <div id="leaderboard" class="leaderboard"></div>
      </div>
    </section>
    <footer class="lobby-footer"><span>✦ 塔域历 847 年 · 魔偶之战</span><span>Phaser 3 · Rust · MessagePack · WebSocket</span></footer>
  </main>
  <div id="game-shell" class="game-shell hidden">
    <div id="game-root"></div>
    <div class="game-vignette"></div><div id="damage-flash"></div><div id="poison-veil"></div><div id="sudden-veil"></div>
    <header class="match-header">
      <div class="team-score red"><div class="team-emblem">◆</div><div><small id="red-team-name">${TEAM_NAMES.Red}</small><div class="structures">${structure('Red-Base', '基地')}${structure('Red-0', '上塔')}${structure('Red-1', '下塔')}</div></div><b id="red-score">0</b></div>
      <div class="match-clock"><small id="phase-label">塔域征战</small><div id="match-time">15:00</div><span><i></i> <em id="wave-label">第 0 波</em></span></div>
      <div class="team-score blue"><b id="blue-score">0</b><div><small id="blue-team-name">${TEAM_NAMES.Blue}</small><div class="structures">${structure('Blue-Base', '基地')}${structure('Blue-0', '上塔')}${structure('Blue-1', '下塔')}</div></div><div class="team-emblem">◆</div></div>
    </header>
    <div class="game-top-tools"><div id="connection-pill" class="connection-pill"><i></i><span>已连接</span><small>20 Hz</small></div><button id="cast-toggle" class="cast-toggle" title="切换施法方式：按住技能键预览范围、松开释放 / 按下立即释放">松开施放</button><button id="audio-toggle" title="切换声音">♪</button><button id="leave-game" title="返回大厅">×</button></div>
    <div id="announcement" class="announcement"></div><div id="event-feed" class="event-feed"></div>
    <aside class="minimap-panel"><div class="minimap-title"><span>战场态势</span><small>MINIMAP</small></div><canvas id="minimap" width="400" height="225"></canvas><div class="minimap-legend"><span><i class="red-dot"></i>绯红</span><b>■塔 ◆基地 ●玩偶 ·魔兽</b><span><i class="blue-dot"></i>湛蓝</span></div></aside>
    <div id="respawn-panel" class="respawn-panel hidden"><small>玩偶修复中</small><b id="respawn-time">3.0</b><span>即将在基地复活</span></div>
    <div id="scoreboard" class="scoreboard hidden"></div>
    <footer class="player-hud">
      <div class="player-portrait"><span id="hud-hero-icon">✦</span><i id="level-badge">0</i></div>
      <div class="vitals"><div class="player-meta"><b id="hud-player-name"></b><span id="hud-hero-name"></span></div><div class="hp-track"><i id="hp-fill"></i><span id="hp-text">0 / 0</span></div><div class="status-row" id="status-row"></div></div>
      <div class="skill-bar">
        <div class="skill basic" data-touch="attack"><div class="skill-icon">⚔</div><kbd>左键</kbd><small>普攻</small></div>
        ${SKILL_KEYS.map((key, i) => `<div class="skill" data-skill="${i}"><div class="skill-icon skill-${i}">✦</div><div class="cooldown-sweep"></div><b class="cooldown-text"></b><kbd>${key}</kbd><small>技能</small></div>`).join('')}
      </div>
      <div class="hud-tip"><span id="net-tip">延迟 —</span><small id="pred-tip">预测 —</small></div>
    </footer>
    <div id="help-prompts" class="help-prompts"></div><button id="help-button" class="help-button" title="向队友求救（G）"><b>🆘</b><span>求救</span><kbd>G</kbd></button>
    <div id="touch-zone" class="touch-zone hidden"></div><div id="touch-cancel" class="touch-cancel">✕<small>取消</small></div><div id="skill-tip" class="skill-tip hidden"></div><div id="hud-toast" class="hud-toast"></div><div id="touch-stick" class="touch-stick hidden"><i></i></div>
    <div id="rotate-hint" class="rotate-hint"><div><b>⟳</b><p>请将手机横过来</p><small>塔域战争需要横屏游玩</small></div></div>
    <div id="result-modal" class="result-modal hidden"><div class="result-card"><div class="result-rays"></div><small>MATCH COMPLETE</small><div id="result-emblem">◆</div><h2 id="result-title">胜利</h2><p id="result-subtitle"></p><div class="result-stats"><div><b id="result-score">0 : 0</b><span>击杀比分</span></div><div><b id="result-time">00:00</b><span>对局时长</span></div><div><b id="result-towers">0 : 0</b><span>摧毁魔法塔</span></div></div><div id="result-table" class="result-table"></div><button id="result-leave" class="primary-btn">返回大厅</button><button id="result-spectate" class="text-btn">继续观战</button></div></div>
  </div>`;
}

/** DOM HUD：顶部比分/倒计时/建筑血条，底部玩家状态与技能冷却，小地图，公告与结算。 */
export class GameHUD {
  private minimap = $<HTMLCanvasElement>('#minimap');
  private ctx = this.minimap.getContext('2d')!;
  private minimapBase: HTMLCanvasElement | null = null;
  private lastAnnouncement = 0;
  private resultShown = false;
  private map: MapInfo | null = null;
  private hero: HeroInfo | null = null;
  private towerSlots = new Map<string, number>();
  private lastHp = -1;
  playerTeam: Team = 'Red';

  show(name: string, heroKind: HeroKind, team: Team, map: MapInfo): void {
    this.playerTeam = team;
    this.map = map;
    this.hero = map.heroes.find((h) => h.kind === heroKind) ?? null;
    this.towerSlots.clear();
    this.lastHp = -1;
    $('#lobby').classList.add('hidden');
    $('#game-shell').classList.remove('hidden');
    $('#hud-player-name').textContent = name;
    const visual = HEROES[heroKind];
    $('#hud-hero-name').textContent = visual.name;
    $('#hud-hero-icon').textContent = visual.icon;
    $('.player-hud').style.setProperty('--hero-color', visual.css);
    document.querySelector<HTMLElement>('.skill-bar')?.style.setProperty('--hero-color', visual.css);
    document.querySelectorAll<HTMLElement>('[data-skill]').forEach((node, i) => {
      const info = this.hero?.skills[i];
      node.querySelector('small')!.textContent = info?.name ?? visual.skills[i];
      node.querySelector('.skill-icon')!.textContent = visual.icons[i];
      node.title = '';
      node.dataset.tipName = info?.name ?? visual.skills[i];
      node.dataset.tipKey = SKILL_KEYS[i];
      node.dataset.tipCd = info ? (info.cooldown_ticks / 20).toFixed(0) : '';
      node.dataset.tipRange = info && info.range > 0 ? String(Math.round(info.range)) : '';
      node.dataset.tipDesc = visual.desc[i];
    });
    const basic = $('[data-touch="attack"]');
    basic.dataset.tipName = '普通攻击'; basic.dataset.tipKey = '左键';
    basic.dataset.tipCd = ''; basic.dataset.tipRange = this.hero ? String(Math.round(this.hero.attack_range)) : '';
    basic.dataset.tipDesc = '按住鼠标左键朝光标方向持续攻击；触屏按住自动攻击最近的敌人。';
    this.resultShown = false;
    $('#result-modal').classList.add('hidden');
    $('#sudden-veil').classList.remove('on');
    this.minimapBase = null;
  }

  /** 技能冷却中仍按下：按钮抖动 + 提示 */
  denySkill(slot: number): void {
    const node = document.querySelector<HTMLElement>(`[data-skill="${slot}"]`);
    if (node) { node.classList.remove('denied'); void node.offsetWidth; node.classList.add('denied'); }
    const left = node?.querySelector('.cooldown-text')?.textContent;
    this.toast(left ? `技能冷却中 · ${left} 秒` : '现在无法施放');
  }

  private toastTimer = 0;
  toast(text: string): void {
    const el = $('#hud-toast');
    el.textContent = text; el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 1100);
  }

  /** 电脑端鼠标悬停技能图标时显示说明卡 */
  bindSkillTips(): void {
    const tip = $('#skill-tip');
    document.querySelectorAll<HTMLElement>('.skill-bar .skill').forEach((node) => {
      node.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse' || !node.dataset.tipName) return;
        const d = node.dataset;
        tip.innerHTML = `<div><b>${d.tipName}</b><kbd>${d.tipKey}</kbd></div><p>${d.tipDesc ?? ''}</p><small>${d.tipCd ? `冷却 ${d.tipCd} 秒` : '无冷却'}${d.tipRange ? ` · 射程 ${d.tipRange}` : ''}</small>`;
        const r = node.getBoundingClientRect();
        tip.style.left = `${r.left + r.width / 2}px`; tip.style.top = `${r.top - 10}px`;
        tip.classList.remove('hidden');
      });
      node.addEventListener('pointerleave', () => tip.classList.add('hidden'));
    });
  }

  hide(): void {
    $('#game-shell').classList.add('hidden');
    $('#lobby').classList.remove('hidden');
    $('#announcement').replaceChildren();
    $('#event-feed').replaceChildren();
    $('#scoreboard').classList.add('hidden');
  }

  status(status: ConnectionStatus, detail?: string): void {
    const pill = $('#connection-pill');
    pill.className = `connection-pill ${status}`;
    const names: Record<ConnectionStatus, string> = { idle: '等待', connecting: '连接中', connected: '已连接', reconnecting: '重连中', offline: '单机演练', closed: '已断开' };
    pill.querySelector('span')!.textContent = detail && status === 'reconnecting' ? `重连 · ${detail}` : names[status];
    if (status === 'offline') pill.querySelector('small')!.textContent = 'WASM';
  }

  latency(ms: number): void {
    $('#connection-pill').querySelector('small')!.textContent = `${ms} ms`;
    $('#net-tip').textContent = `延迟 ${ms} ms`;
  }

  prediction(pending: number, correction: number): void {
    $('#pred-tip').textContent = `预测 ${pending} 帧 · 校正 ${correction.toFixed(1)}`;
  }

  announce(text: string, important = false): void {
    if (!text) return;
    const now = performance.now();
    if (!important && now - this.lastAnnouncement < 1200) return;
    this.lastAnnouncement = now;
    const container = $('#announcement');
    container.replaceChildren();
    const node = document.createElement('div');
    node.className = important ? 'important' : '';
    node.innerHTML = '<i></i><span></span><i></i>';
    node.querySelector('span')!.textContent = text;
    container.append(node);
    setTimeout(() => node.remove(), important ? 4800 : 3400);
  }

  /** 队友求救提示卡：点击或按 F 接受。 */
  helpPrompt(name: string, id: number, onAccept: () => void): void {
    const box = $('#help-prompts');
    box.querySelector(`[data-help="${id}"]`)?.remove();
    const card = document.createElement('button');
    card.className = 'help-prompt';
    card.dataset.help = String(id);
    card.innerHTML = `<b>🆘 ${escapeHtml(name)}</b><span>请求支援</span><em>接受 <kbd>F</kbd></em><i></i>`;
    const accept = (e: Event) => { e.preventDefault(); e.stopPropagation(); onAccept(); };
    card.addEventListener('pointerdown', accept);
    box.prepend(card);
    while (box.children.length > 3) box.lastElementChild?.remove();
    setTimeout(() => card.remove(), 10000);
  }

  clearHelpPrompt(id?: number): void {
    const box = $('#help-prompts');
    if (id === undefined) box.replaceChildren(); else box.querySelector(`[data-help="${id}"]`)?.remove();
  }

  latestHelpId(): number | null {
    const first = $('#help-prompts').firstElementChild as HTMLElement | null;
    return first ? Number(first.dataset.help) : null;
  }

  helpCooldown(seconds: number): void {
    const button = $('#help-button');
    button.classList.toggle('cooling', seconds > 0);
    button.querySelector('span')!.textContent = seconds > 0 ? `${seconds}s` : '求救';
  }

  feed(text: string, team: Team | null): void {
    if (!text) return;
    const feed = $('#event-feed');
    const item = document.createElement('div');
    item.className = team?.toLowerCase() ?? '';
    item.textContent = text;
    feed.prepend(item);
    while (feed.children.length > 5) feed.lastElementChild?.remove();
    setTimeout(() => item.remove(), 6000);
  }

  damageFlash(): void {
    const node = $('#damage-flash');
    node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
  }

  poisoned(on: boolean): void { $('#poison-veil').classList.toggle('on', on); }

  toggleScoreboard(show: boolean, entities: EntitySnapshot[]): void {
    const board = $('#scoreboard');
    board.classList.toggle('hidden', !show);
    if (!show) return;
    const rows = entities.filter((e) => e.kind === 'Hero').sort((a, b) => a.team.localeCompare(b.team) || b.level - a.level);
    board.innerHTML = `<h3>战况</h3><table><tr><th>阵营</th><th>玩偶</th><th>玩家</th><th>击杀</th><th>状态</th></tr>${rows.map((e) =>
      `<tr class="${e.team.toLowerCase()}"><td>${escapeHtml(teamNames[e.team])}</td><td>${HEROES[e.hero ?? 'Arcanist'].name}</td><td>${escapeHtml(e.name ?? '')}${e.flags & FLAGS.AI ? ' <em>AI</em>' : ''}</td><td>${e.level}</td><td>${e.respawn > 0 ? `复活 ${(e.respawn / 20).toFixed(1)}s` : `${Math.ceil(e.hp)} HP`}</td></tr>`).join('')}</table>`;
  }

  update(snapshot: Snapshot, local: EntitySnapshot | undefined, entities: EntitySnapshot[]): void {
    applyTeamNames(snapshot.team_names);
    const redName = $('#red-team-name'), blueName = $('#blue-team-name');
    if (redName.textContent !== teamNames.Red) redName.textContent = teamNames.Red;
    if (blueName.textContent !== teamNames.Blue) blueName.textContent = teamNames.Blue;
    $('#red-score').textContent = String(snapshot.red_score);
    $('#blue-score').textContent = String(snapshot.blue_score);
    $('#match-time').textContent = clock(snapshot.remaining);
    $('#wave-label').textContent = `第 ${snapshot.wave} 波`;
    $('#phase-label').textContent = snapshot.phase === 'Ended' ? '对局结束' : snapshot.phase === 'SuddenDeath' ? '超时死斗' : '塔域征战';
    $('.match-clock').classList.toggle('sudden-death', snapshot.phase === 'SuddenDeath');
    $('#sudden-veil').classList.toggle('on', snapshot.phase === 'SuddenDeath');
    // 首次见到的塔按 y 排序记为 上塔/下塔，之后被摧毁移除也能显示为空血条。
    if (this.towerSlots.size < 4) {
      for (const team of ['Red', 'Blue'] as Team[]) {
        const towers = entities.filter((e) => e.kind === 'Tower' && e.team === team).sort((a, b) => a.y - b.y);
        if (towers.length === 2) towers.forEach((t, i) => this.towerSlots.set(`${team}-${i}`, t.id));
      }
    }
    for (const node of document.querySelectorAll<HTMLElement>('.structure')) {
      const key = node.dataset.structure!;
      const [team, slot] = key.split('-');
      const wanted = slot === 'Base'
        ? entities.find((e) => e.team === team && e.kind === 'Base')
        : entities.find((e) => e.id === this.towerSlots.get(key));
      const ratio = wanted ? Math.max(0, wanted.hp / wanted.max_hp) : (this.towerSlots.has(key) || slot === 'Base' ? 0 : 1);
      node.querySelector('i')!.style.width = `${ratio * 100}%`;
      node.classList.toggle('destroyed', ratio <= 0);
      node.classList.toggle('shielded', !!wanted && (wanted.flags & FLAGS.INVULNERABLE) !== 0);
    }
    if (local) {
      const ratio = Math.max(0, local.hp / local.max_hp);
      $('#hp-fill').style.width = `${ratio * 100}%`;
      $('#hp-text').textContent = `${Math.ceil(Math.max(0, local.hp))} / ${Math.round(local.max_hp)}`;
      $('.hp-track').classList.toggle('low', ratio < 0.3);
      if (this.lastHp >= 0 && local.hp < this.lastHp - 1) this.damageFlash();
      this.lastHp = local.hp;
      $('#level-badge').textContent = String(local.level);
      const respawn = $('#respawn-panel');
      respawn.classList.toggle('hidden', local.respawn <= 0);
      $('#respawn-time').textContent = (local.respawn / 20).toFixed(1);
      const tags: string[] = [];
      if (local.flags & FLAGS.STUNNED) tags.push('<i class="tag stun">眩晕</i>');
      if (local.flags & FLAGS.SLOWED) tags.push('<i class="tag slow">减速</i>');
      if (local.flags & FLAGS.AI) tags.push('<i class="tag ai">AI 托管</i>');
      $('#status-row').innerHTML = tags.join('');
      local.cooldowns.forEach((ticks, index) => {
        const skill = document.querySelector<HTMLElement>(`[data-skill="${index}"]`)!;
        const total = this.hero?.skills[index]?.cooldown_ticks ?? 100;
        const seconds = ticks / 20;
        skill.classList.toggle('cooling', ticks > 0);
        skill.querySelector('.cooldown-text')!.textContent = seconds > 0 ? seconds.toFixed(seconds < 3 ? 1 : 0) : '';
        skill.querySelector<HTMLElement>('.cooldown-sweep')!.style.height = `${Math.min(100, (ticks / total) * 100)}%`;
      });
    }
    this.drawMinimap(entities, local?.id);
  }

  private drawMinimapBase(w: number, h: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const map = this.map!;
    const sx = w / map.width, sy = h / map.height;
    const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#162a2f'); g.addColorStop(1, '#0d1824');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#04070c';
    for (const r of map.obstacles) ctx.fillRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
    ctx.strokeStyle = '#d5bdff22'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
    return canvas;
  }

  private drawMinimap(entities: EntitySnapshot[], localId?: number): void {
    if (!this.map) return;
    const ctx = this.ctx, w = this.minimap.width, h = this.minimap.height;
    const sx = w / this.map.width, sy = h / this.map.height;
    if (!this.minimapBase) this.minimapBase = this.drawMinimapBase(w, h);
    ctx.drawImage(this.minimapBase, 0, 0);
    // 先画毒区，再画单位。
    for (const e of entities) {
      if (e.kind !== 'PoisonZone') continue;
      ctx.fillStyle = e.team === 'Red' ? '#ff5d7a22' : '#5b9dff22';
      ctx.beginPath(); ctx.ellipse(e.x * sx, e.y * sy, e.radius * sx, e.radius * sy, 0, 0, Math.PI * 2); ctx.fill();
    }
    for (const e of entities) {
      if (e.kind === 'PoisonZone' || e.hp <= 0 || e.respawn > 0) continue;
      // 小地图只显示己方魔兽（敌方魔兽属于战争迷雾外信息）。
      if (e.kind === 'Minion' && e.team !== this.playerTeam) continue;
      const x = e.x * sx, y = e.y * sy;
      ctx.fillStyle = TEAM_CSS[e.team];
      if (e.kind === 'Base') {
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-7, -7, 14, 14); ctx.restore();
        if (e.flags & FLAGS.INVULNERABLE) { ctx.strokeStyle = '#ffffff66'; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke(); }
      } else if (e.kind === 'Tower') ctx.fillRect(x - 5, y - 5, 10, 10);
      else if (e.kind === 'SuperMinion') { ctx.fillStyle = '#d27bff'; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); }
      else if (e.kind === 'Hero') { ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.fillRect(x - 1.5, y - 1.5, 3, 3); }
      if (e.id === localId) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  showResult(summary: MatchSummary): void {
    if (this.resultShown) return;
    this.resultShown = true;
    const won = summary.winner === this.playerTeam;
    const draw = summary.winner === null;
    const modal = $('#result-modal');
    modal.classList.remove('hidden');
    modal.classList.toggle('defeat', !won && !draw);
    $('#result-title').textContent = draw ? '平 局' : won ? '胜 利' : '战 败';
    $('#result-subtitle').textContent = draw ? '双方基地同归于尽' : `${teamNames[summary.winner!]}赢得了塔域之战`;
    $('#result-score').textContent = `${summary.red_score} : ${summary.blue_score}`;
    $('#result-towers').textContent = `${summary.towers_destroyed_red} : ${summary.towers_destroyed_blue}`;
    $('#result-time').textContent = clock(Math.floor(summary.ticks / 20));
    $('#result-table').innerHTML = `<table><tr><th></th><th>玩家</th><th>玩偶</th><th>K</th><th>D</th><th>伤害</th></tr>${summary.players.map((p) =>
      `<tr class="${p.team.toLowerCase()}"><td>◆</td><td>${escapeHtml(p.name)}${p.human ? '' : ' <em>AI</em>'}</td><td>${HEROES[p.hero].name}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${Math.round(p.damage)}</td></tr>`).join('')}</table>`;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

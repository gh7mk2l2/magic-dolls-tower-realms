import Phaser from 'phaser';
import './style.css';
import { ArcaneAudio } from './audio';
import { HEROES } from './config';
import { GameConnection } from './network';
import type { HeroKind, Team, Welcome } from './protocol';
import { BattleScene, type TouchState } from './scene';
import { GameHUD, escapeHtml, shellMarkup } from './ui';
import { startRigTest } from './rigtest';

// 调试入口：#rigtest 只展示骨骼动作，不启动大厅
const RIG_TEST = location.hash === '#rigtest';
if (RIG_TEST) startRigTest();

document.querySelector<HTMLDivElement>('#app')!.innerHTML = shellMarkup();

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const audio = new ArcaneAudio();
const hud = new GameHUD();
const connection = new GameConnection();
const touch: TouchState = { moveX: 0, moveY: 0, attack: false, skills: 0, active: false, aim: null, castAim: null };

let selectedHero: HeroKind = (localStorage.getItem('mdtr-hero') as HeroKind) || 'Arcanist';
let selectedTeam: Team = (localStorage.getItem('mdtr-team') as Team) || 'Red';
let game: Phaser.Game | null = null;
let scene: BattleScene | null = null;
let playerName = '';

const nameInput = $<HTMLInputElement>('#player-name');
const teamNameInput = $<HTMLInputElement>('#team-name');
teamNameInput.value = localStorage.getItem('mdtr-team-name') || '';
const roomInput = $<HTMLInputElement>('#room-name');
nameInput.value = localStorage.getItem('mdtr-name') || `玩偶${Math.floor(Math.random() * 900 + 100)}`;
roomInput.value = localStorage.getItem('mdtr-room') || 'main';

function showcase(): void {
  const h = HEROES[selectedHero];
  $('#showcase-icon').textContent = h.icon;
  $('#showcase-icon').style.color = h.css;
  $('#showcase-title').textContent = h.title;
  $('#showcase-name').textContent = h.name;
  $('#showcase-lore').textContent = h.lore;
  $('#showcase-skill').textContent = `Q ${h.skills[0]} · E ${h.skills[1]} · R ${h.skills[2]}`;
  document.querySelectorAll<HTMLElement>('.hero-option').forEach((b) => b.classList.toggle('selected', b.dataset.hero === selectedHero));
  document.querySelectorAll<HTMLElement>('.team-option').forEach((b) => b.classList.toggle('selected', b.dataset.team === selectedTeam));
}
showcase();

document.querySelectorAll<HTMLElement>('.hero-option').forEach((button) => button.addEventListener('click', () => {
  selectedHero = button.dataset.hero as HeroKind; audio.unlock(); audio.play('Click'); showcase();
}));
document.querySelectorAll<HTMLElement>('.team-option').forEach((button) => button.addEventListener('click', () => {
  selectedTeam = button.dataset.team as Team; audio.unlock(); audio.play('Click'); showcase();
}));

async function refreshLobby(): Promise<void> {
  try {
    const [health, rooms, board] = await Promise.all([
      fetch('/api/health').then((r) => r.json()),
      fetch('/api/rooms').then((r) => r.json()),
      fetch('/api/leaderboard').then((r) => r.json()),
    ]) as [{ ok: boolean; storage: { postgres: boolean; redis: boolean } }, { name: string; connected: number }[], { name: string; wins: number }[]];
    $('#server-dot').style.background = '#69d6ad';
    $('#server-text').textContent = `服务器在线${health.storage.postgres ? ' · PG' : ''}${health.storage.redis ? ' · Redis' : ''}`;
    const online = rooms.reduce((sum, r) => sum + r.connected, 0);
    $('#room-count').textContent = `${rooms.length} 房间 · ${online} 在线`;
    $('#leaderboard').innerHTML = board.length
      ? `<b>胜场榜</b>${board.slice(0, 5).map((e, i) => `<span>${i + 1}. ${escapeHtml(e.name)} <em>${e.wins}</em></span>`).join('')}`
      : '';
  } catch {
    $('#server-dot').style.background = '#ffb45e';
    $('#server-text').textContent = '未连接服务器 · 可单机演练';
    $('#room-count').textContent = '离线';
  }
}
void refreshLobby();
const lobbyTimer = setInterval(() => { if (!game) void refreshLobby(); }, 5000);
window.addEventListener('beforeunload', () => clearInterval(lobbyTimer));

/** 部分安卓浏览器 / 内置 WebView 不报告 pointer: coarse，这里综合判断。 */
function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
}

function setTouchMode(on: boolean): void {
  touch.active = on;
  $('#touch-stick').classList.toggle('hidden', !on);
  $('#touch-zone').classList.toggle('hidden', !on);
  document.body.classList.toggle('touch-mode', on);
  // 触屏时把技能栏移到右下角轮盘，电脑端放回底部 HUD
  const bar = document.querySelector<HTMLElement>('.skill-bar');
  if (bar) {
    if (on) { bar.classList.add('touch-skills'); $('#game-shell').appendChild(bar); }
    else { bar.classList.remove('touch-skills'); $('.player-hud').insertBefore(bar, $('.hud-tip')); }
  }
}

/** 手机上尽量进入全屏并锁定横屏（安卓 Chrome 支持；iOS 不支持锁定，会显示旋转提示）。 */
async function enterLandscape(): Promise<void> {
  if (!isTouchDevice()) return;
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch { /* 用户拒绝或不支持 */ }
  try {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await orientation.lock?.('landscape');
  } catch { /* 不支持锁定 */ }
}

function startGame(offline: boolean): void {
  void enterLandscape();
  audio.unlock();
  audio.play('Click');
  playerName = nameInput.value.trim() || '无名玩偶';
  const room = roomInput.value.trim() || 'main';
  if (!offline && !/^[\p{L}\p{N}_-]{1,24}$/u.test(room)) { $('#join-error').textContent = '房间名只能包含文字、数字、-、_'; return; }
  localStorage.setItem('mdtr-name', playerName);
  localStorage.setItem('mdtr-room', room);
  localStorage.setItem('mdtr-hero', selectedHero);
  localStorage.setItem('mdtr-team', selectedTeam);
  $('#join-error').textContent = offline ? '正在加载本地模拟…' : '正在连接…';
  const teamName = teamNameInput.value.trim().slice(0, 8);
  localStorage.setItem('mdtr-team-name', teamName);
  connection.start({ room, name: playerName, team: selectedTeam, hero: selectedHero, team_name: teamName || null }, offline);
}

$('#play-online').addEventListener('click', () => startGame(false));
$('#play-offline').addEventListener('click', () => startGame(true));

connection.onWelcome = (welcome) => {
  $('#join-error').textContent = '';
  if (scene && game && connection.welcome?.entity_id === welcome.entity_id && game.scene.isActive('battle')) {
    // 断线重连成功：保留场景与输入序号（服务端按序号去重），初始全量快照会自动重建状态。
    hud.feed('已重新连接，恢复原玩偶', null);
    return;
  }
  launch(welcome);
};
connection.onSnapshot = (snapshot) => scene?.onSnapshot(snapshot);
connection.onMatchEnd = (summary) => scene?.onMatchEnd(summary);
connection.onPong = (ms) => hud.latency(ms);
connection.onStatus = (status, detail) => hud.status(status, detail);
connection.onError = (message, fatal) => {
  if (fatal) { $('#join-error').textContent = message; leave(false); }
  else hud.feed(message, null);
};

function launch(welcome: Welcome): void {
  hud.show(playerName, selectedHero, welcome.team, welcome.map);
  hud.status(connection.isOffline ? 'offline' : 'connected');
  setTouchMode(isTouchDevice());
  if (!game) {
    scene = new BattleScene();
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game-root',
      backgroundColor: '#071017',
      scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
      render: { antialias: true, powerPreference: 'high-performance' },
      fps: { target: 60 },
      scene: [],
    });
    game.scene.add('battle', scene, true, { connection, hud, audio, welcome, playerName, touch });
    if (location.hash === '#debug') (window as unknown as { __mdtr: unknown }).__mdtr = { game, scene };
  } else {
    scene!.scene.restart({ connection, hud, audio, welcome, playerName, touch });
  }
}

function leave(sendLeave: boolean): void {
  connection.close(sendLeave);
  if (game) { game.destroy(true); game = null; scene = null; }
  document.querySelector('#game-root')!.replaceChildren();
  hud.hide();
  void refreshLobby();
}

$('#leave-game').addEventListener('click', () => leave(true));
$('#result-leave').addEventListener('click', () => leave(true));
$('#result-spectate').addEventListener('click', () => $('#result-modal').classList.add('hidden'));
hud.bindSkillTips();
const castToggle = $('#cast-toggle');
const syncCastLabel = () => { castToggle.textContent = localStorage.getItem('mdtr-quickcast') === '1' ? '按下即放' : '松开施放'; };
syncCastLabel();
castToggle.addEventListener('click', () => {
  const on = localStorage.getItem('mdtr-quickcast') !== '1';
  if (scene) scene.setQuickCast(on); else localStorage.setItem('mdtr-quickcast', on ? '1' : '0');
  syncCastLabel(); hud.toast(on ? '按下技能键立即释放' : '按住技能键预览范围，松开释放');
  castToggle.blur();
});
$('#audio-toggle').addEventListener('click', () => { audio.unlock(); $('#audio-toggle').textContent = audio.toggle() ? '✕' : '♪'; });
// Tab 的默认行为由 Phaser addCapture 阻止；这里不能提前 preventDefault，否则 Phaser 会忽略该按键。

// ---- 触屏：左半屏任意位置按下即出现浮动摇杆 + 点按技能/普攻图标 ----
const stick = $('#touch-stick');
const knob = stick.querySelector<HTMLElement>('i')!;
const zone = $('#touch-zone');
let stickId: number | null = null, stickX = 0, stickY = 0;
const STICK_MAX = 55;
zone.addEventListener('pointerdown', (e) => {
  if (stickId !== null) return;
  stickId = e.pointerId; stickX = e.clientX; stickY = e.clientY;
  zone.setPointerCapture(e.pointerId);
  stick.classList.add('floating');
  stick.style.left = `${e.clientX - 65}px`; stick.style.top = `${e.clientY - 65}px`; stick.style.bottom = 'auto';
  e.preventDefault();
});
zone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== stickId) return;
  const dx = e.clientX - stickX, dy = e.clientY - stickY, len = Math.hypot(dx, dy);
  const k = len > 6 ? Math.min(1, len / STICK_MAX) / len : 0;
  touch.moveX = dx * k; touch.moveY = dy * k;
  knob.style.transform = `translate(${(touch.moveX * STICK_MAX).toFixed(0)}px, ${(touch.moveY * STICK_MAX).toFixed(0)}px)`;
  e.preventDefault();
});
const release = (e: PointerEvent) => {
  if (e.pointerId !== stickId) return;
  stickId = null; touch.moveX = 0; touch.moveY = 0; knob.style.transform = '';
  stick.classList.remove('floating'); stick.style.left = ''; stick.style.top = ''; stick.style.bottom = '';
};
zone.addEventListener('pointerup', release);
zone.addEventListener('pointercancel', release);
// 第一次触摸游戏区域时自动切到触屏模式（兜底检测失败的设备）
$('#game-shell').addEventListener('touchstart', () => { if (!touch.active) setTouchMode(true); }, { passive: true });
// 技能按钮：轻点 = 自动瞄准最近敌人；按住拖动 = 手动瞄准（指示器实时显示）；拖到「取消」上松手 = 取消
const cancelZone = $('#touch-cancel');
const AIM_DRAG = 85;
document.querySelectorAll<HTMLElement>('[data-skill]').forEach((node) => {
  const slot = Number(node.dataset.skill);
  let id: number | null = null, ox = 0, oy = 0;
  node.addEventListener('pointerdown', (e) => {
    if (!touch.active || e.pointerType === 'mouse' || id !== null) return;
    e.preventDefault(); e.stopPropagation();
    if (scene && !scene.skillReady(slot)) { hud.denySkill(slot); return; }
    id = e.pointerId; ox = e.clientX; oy = e.clientY;
    node.setPointerCapture(e.pointerId);
    touch.aim = { slot, dx: 0, dy: 0, cancel: false };
    node.classList.add('aiming'); cancelZone.classList.add('show');
  });
  node.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id || !touch.aim) return;
    touch.aim.dx = (e.clientX - ox) / AIM_DRAG; touch.aim.dy = (e.clientY - oy) / AIM_DRAG;
    const r = cancelZone.getBoundingClientRect();
    touch.aim.cancel = e.clientX >= r.left - 12 && e.clientX <= r.right + 12 && e.clientY >= r.top - 12 && e.clientY <= r.bottom + 12;
    cancelZone.classList.toggle('hot', touch.aim.cancel);
  });
  const end = (e: PointerEvent, fire: boolean) => {
    if (e.pointerId !== id) return;
    id = null; node.classList.remove('aiming'); cancelZone.classList.remove('show', 'hot');
    const aim = touch.aim; touch.aim = null;
    if (!aim || !fire || aim.cancel) return;
    touch.castAim = { slot, dx: aim.dx, dy: aim.dy };
    touch.skills |= 1 << slot;
  };
  node.addEventListener('pointerup', (e) => end(e, true));
  node.addEventListener('pointercancel', (e) => end(e, false));
});
$('#help-button').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); scene?.requestHelp(); });
const attackButton = $('[data-touch="attack"]');
attackButton.addEventListener('touchstart', (e) => { touch.attack = true; attackButton.classList.add('pressed'); e.preventDefault(); }, { passive: false });
attackButton.addEventListener('touchend', () => attackButton.classList.remove('pressed'));
attackButton.addEventListener('touchend', () => { touch.attack = false; });
attackButton.addEventListener('touchcancel', () => { touch.attack = false; });

import Phaser from 'phaser';
import type { HeroKind, Team } from './protocol';
import { HEROES } from './config';

type Draw = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
const colors = { Red: '#ff657f', Blue: '#5b9dff' };

function canvas(scene: Phaser.Scene, key: string, width: number, height: number, draw: Draw): void {
  if (scene.textures.exists(key)) return;
  const texture = scene.textures.createCanvas(key, width, height);
  if (!texture) return;
  const ctx = texture.getContext();
  ctx.clearRect(0, 0, width, height);
  draw(ctx, width, height);
  texture.refresh();
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string): void {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
}

function crystal(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  const gradient = ctx.createLinearGradient(x - size, y - size, x + size, y + size);
  gradient.addColorStop(0, '#f1f4ff'); gradient.addColorStop(0.22, color); gradient.addColorStop(1, '#1a173b');
  ctx.beginPath(); ctx.moveTo(x, y - size * 1.5); ctx.lineTo(x + size * 0.65, y - size * 0.25); ctx.lineTo(x + size * 0.45, y + size); ctx.lineTo(x - size * 0.5, y + size * 0.8); ctx.lineTo(x - size * 0.65, y - size * 0.25); ctx.closePath();
  ctx.fillStyle = gradient; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - size * 1.35); ctx.lineTo(x - size * 0.15, y + size * 0.55); ctx.strokeStyle = '#ffffff77'; ctx.stroke();
}

/** AI 生成的精灵图（public/sprites/<key>.png）。加载失败的键会回退到下方的程序化纹理。 */
import { RIG_KEYS } from './rig';
import { portraitSpriteKeys } from './heroArt';

export const SPRITE_KEYS: string[] = [
  ...RIG_KEYS,
  'ground', 'tree', 'rock', 'crystal',
  'decal-grass', 'decal-flowers', 'decal-stones', 'decal-mushrooms', 'decal-leaves', 'decal-crack', 'decal-rune',
  ...(['Red', 'Blue'] as const).flatMap((t) => [
    `base-${t}`, `tower-${t}`, `minion-${t}`, `super-${t}`,
  ]),
  // 立绘：初始 6 名 + 已集成专属资源的新玩偶（见 heroArt.ts 的命名约定）
  ...portraitSpriteKeys(),
];

export function preloadSprites(scene: Phaser.Scene): void {
  const base = `${import.meta.env.BASE_URL}sprites/`;
  for (const key of SPRITE_KEYS) {
    if (!scene.textures.exists(key)) scene.load.image(key, `${base}${key}.png`);
  }
  scene.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
    console.warn(`精灵图 ${file.key} 加载失败，使用程序化占位图`);
  });
}

export function createWorldTextures(scene: Phaser.Scene): void {
  let seed = 9137;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  canvas(scene, 'ground', 256, 256, (ctx, w, h) => {
    const gradient = ctx.createLinearGradient(0, 0, w, h); gradient.addColorStop(0, '#172c32'); gradient.addColorStop(1, '#101e28'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 380; i++) {
      const x = random() * w, y = random() * h, light = random() > 0.65;
      ctx.fillStyle = light ? '#4e665022' : '#020c1833'; ctx.fillRect(x, y, random() * 3 + 1, random() * 3 + 1);
    }
    for (let i = 0; i < 25; i++) {
      const x = random() * w, y = random() * h;
      ctx.strokeStyle = '#6b8a6320'; ctx.beginPath(); ctx.moveTo(x, y + 4); ctx.lineTo(x - 2, y - 3); ctx.moveTo(x, y + 4); ctx.lineTo(x + 3, y - 2); ctx.stroke();
    }
  });
  canvas(scene, 'road', 128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#343443'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const shade = Math.floor(43 + random() * 24); ctx.fillStyle = `rgb(${shade + 6},${shade + 3},${shade + 16})`;
      const x = random() * w, y = random() * h, rw = 8 + random() * 20;
      ctx.beginPath(); ctx.roundRect(x, y, rw, 4 + random() * 10, 3); ctx.fill();
    }
    ctx.strokeStyle = '#a68ad312'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
  });
  canvas(scene, 'shadow', 128, 48, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2); g.addColorStop(0, '#000000b0'); g.addColorStop(1, '#00000000'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  canvas(scene, 'glow', 128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); g.addColorStop(0, '#ffffffee'); g.addColorStop(0.15, '#ffffff88'); g.addColorStop(0.5, '#ffffff25'); g.addColorStop(1, '#ffffff00'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  canvas(scene, 'particle', 24, 24, (ctx, w, h) => {
    const g = ctx.createRadialGradient(12, 12, 0, 12, 12, 12); g.addColorStop(0, '#fff'); g.addColorStop(0.25, '#ffffffb0'); g.addColorStop(1, '#ffffff00'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  canvas(scene, 'tree', 100, 130, (ctx) => {
    ellipse(ctx, 52, 113, 34, 10, '#050b1480'); ctx.fillStyle = '#222334'; ctx.fillRect(46, 68, 12, 45);
    for (const [x, y, r, c] of [[50, 55, 35, '#183d3c'], [29, 73, 25, '#1c4943'], [71, 73, 26, '#153632'], [51, 28, 27, '#27534a']] as const) { ellipse(ctx, x, y, r, r * 0.85, c); }
    ctx.strokeStyle = '#65a47a35'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(47, 43, 24, Math.PI, Math.PI * 1.8); ctx.stroke();
  });
  canvas(scene, 'rock', 64, 48, (ctx) => {
    ellipse(ctx, 32, 39, 28, 7, '#03081177'); ctx.beginPath(); ctx.moveTo(7, 35); ctx.lineTo(14, 15); ctx.lineTo(35, 6); ctx.lineTo(55, 20); ctx.lineTo(58, 37); ctx.closePath(); ctx.fillStyle = '#2b3943'; ctx.fill(); ctx.beginPath(); ctx.moveTo(14, 15); ctx.lineTo(35, 6); ctx.lineTo(40, 24); ctx.lineTo(7, 35); ctx.closePath(); ctx.fillStyle = '#43505a'; ctx.fill();
  });
  canvas(scene, 'crystal', 64, 90, (ctx) => { ellipse(ctx, 32, 78, 25, 7, '#03081188'); crystal(ctx, 32, 47, 24, '#8468d9'); crystal(ctx, 15, 60, 12, '#5d85cb'); });
  canvas(scene, 'rune', 256, 256, (ctx, w, h) => {
    ctx.translate(w / 2, h / 2); ctx.strokeStyle = '#b792ff90'; ctx.lineWidth = 3;
    for (const radius of [96, 78, 45]) { ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke(); }
    ctx.rotate(Math.PI / 4); ctx.strokeRect(-56, -56, 112, 112); ctx.rotate(Math.PI / 4); ctx.strokeRect(-56, -56, 112, 112);
    for (let i = 0; i < 8; i++) { ctx.rotate(Math.PI / 4); ctx.fillStyle = '#d9c5ff'; ctx.fillRect(85, -2, 16, 4); }
  });
  for (const team of ['Red', 'Blue'] as Team[]) {
    const color = colors[team];
    canvas(scene, `base-${team}`, 240, 210, (ctx) => {
      ellipse(ctx, 120, 176, 105, 25, '#020611aa');
      ctx.beginPath(); ctx.ellipse(120, 157, 94, 40, 0, 0, Math.PI * 2); ctx.fillStyle = '#24253a'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(120, 145, 72, 30, 0, 0, Math.PI * 2); ctx.fillStyle = '#3c3c53'; ctx.fill(); ctx.strokeStyle = '#a5a1bd44'; ctx.stroke();
      for (const x of [65, 175]) { ctx.fillStyle = '#303149'; ctx.fillRect(x - 15, 75, 30, 77); crystal(ctx, x, 69, 19, color); }
      crystal(ctx, 120, 84, 42, color);
      ctx.globalAlpha = 0.4; ellipse(ctx, 120, 85, 58, 75, color); ctx.globalAlpha = 1;
    });
    canvas(scene, `tower-${team}`, 120, 170, (ctx) => {
      ellipse(ctx, 60, 150, 48, 14, '#020611aa');
      ctx.beginPath(); ctx.ellipse(60, 138, 44, 17, 0, 0, Math.PI * 2); ctx.fillStyle = '#343449'; ctx.fill(); ctx.strokeStyle = '#77718a'; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(35, 135); ctx.lineTo(43, 58); ctx.lineTo(77, 58); ctx.lineTo(85, 135); ctx.closePath(); ctx.fillStyle = '#424357'; ctx.fill();
      ctx.fillStyle = '#272a3e'; ctx.fillRect(31, 50, 58, 18); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.strokeRect(31, 50, 58, 18);
      crystal(ctx, 60, 35, 21, color); ctx.globalAlpha = 0.25; ellipse(ctx, 60, 34, 38, 45, color); ctx.globalAlpha = 1;
    });
    canvas(scene, `minion-${team}`, 64, 74, (ctx) => {
      ellipse(ctx, 32, 65, 22, 7, '#02061188');
      ctx.fillStyle = '#25283b'; ctx.beginPath(); ctx.moveTo(15, 60); ctx.lineTo(20, 31); ctx.lineTo(44, 31); ctx.lineTo(50, 60); ctx.closePath(); ctx.fill();
      ellipse(ctx, 32, 27, 15, 16, '#53546b'); ctx.fillStyle = color; ctx.fillRect(22, 23, 20, 5);
      ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(43, 40); ctx.lineTo(56, 17); ctx.stroke();
      ctx.fillStyle = '#d6d4e8'; ctx.beginPath(); ctx.moveTo(55, 17); ctx.lineTo(59, 6); ctx.lineTo(51, 14); ctx.fill();
    });
    canvas(scene, `super-${team}`, 160, 150, (ctx) => {
      ellipse(ctx, 80, 133, 65, 15, '#020611aa');
      ctx.fillStyle = '#342b45'; ctx.beginPath(); ctx.moveTo(35, 125); ctx.lineTo(42, 56); ctx.lineTo(118, 56); ctx.lineTo(128, 125); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(49, 65); ctx.lineTo(28, 26); ctx.moveTo(110, 65); ctx.lineTo(133, 25); ctx.stroke();
      for (const x of [53, 106]) { ellipse(ctx, x, 46, 25, 24, '#555069'); ellipse(ctx, x - 7, 43, 4, 3, color); ellipse(ctx, x + 7, 43, 4, 3, color); }
      crystal(ctx, 80, 83, 24, color);
    });
    canvas(scene, `projectile-${team}`, 40, 20, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 40, 0); g.addColorStop(0, '#ffffff00'); g.addColorStop(1, color); ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(30, 4); ctx.lineTo(38, 10); ctx.lineTo(30, 16); ctx.closePath(); ctx.fill(); ellipse(ctx, 30, 10, 7, 5, '#fff');
    });
  }
  // 程序化兜底立绘：只需要初始 6 名（新玩偶缺资源时借用它们的立绘）
  for (const hero of (Object.keys(HEROES) as HeroKind[]).filter((h) => !HEROES[h].base)) {
    for (const team of ['Red', 'Blue'] as Team[]) {
      const teamColor = colors[team], color = HEROES[hero].css;
      canvas(scene, `hero-${hero}-${team}`, 110, 120, (ctx) => {
        ellipse(ctx, 55, 105, 32, 9, '#02061188');
        ctx.globalAlpha = 0.2; ellipse(ctx, 55, 63, 40, 48, color); ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.moveTo(27, 98); ctx.lineTo(36, 49); ctx.lineTo(73, 49); ctx.lineTo(85, 98); ctx.lineTo(55, 108); ctx.closePath(); ctx.fillStyle = hero === 'Guardian' ? '#544c4d' : '#282940'; ctx.fill(); ctx.strokeStyle = teamColor; ctx.lineWidth = 3; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(37, 55); ctx.lineTo(55, 70); ctx.lineTo(72, 54); ctx.lineTo(65, 89); ctx.lineTo(44, 89); ctx.closePath(); ctx.fillStyle = color; ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
        ellipse(ctx, 55, 37, 18, 20, '#d8c5b7');
        ctx.beginPath(); ctx.arc(55, 34, 21, Math.PI, Math.PI * 2); ctx.lineTo(74, 41); ctx.lineTo(65, 25); ctx.lineTo(43, 20); ctx.lineTo(35, 42); ctx.closePath(); ctx.fillStyle = hero === 'Ranger' ? '#183b39' : '#29243e'; ctx.fill();
        ctx.fillStyle = color; ctx.fillRect(46, 36, 6, 3); ctx.fillRect(60, 36, 6, 3);
        if (hero === 'Arcanist') {
          ctx.strokeStyle = '#b9a2dc'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(82, 91); ctx.lineTo(90, 25); ctx.stroke(); crystal(ctx, 91, 19, 10, color);
        } else if (hero === 'Ranger') {
          ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(82, 61, 27, -Math.PI / 2, Math.PI / 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(82, 34); ctx.lineTo(82, 88); ctx.stroke();
        } else {
          ctx.fillStyle = '#6e6570'; ctx.beginPath(); ctx.arc(83, 65, 22, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke(); crystal(ctx, 83, 65, 8, color);
        }
      });
    }
  }
}

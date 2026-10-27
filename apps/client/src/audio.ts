import type { EventKind } from './protocol';

export class ArcaneAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  unlock(): void {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.18;
      this.master.connect(this.context.destination);
      this.startAmbience();
    }
    void this.context.resume();
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (this.master && this.context) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.18, this.context.currentTime, 0.03);
    return this.muted;
  }

  private tone(frequency: number, duration: number, type: OscillatorType, volume: number, slide = 1): void {
    if (!this.context || !this.master || this.muted) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, now); oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, frequency * slide), now + duration);
    gain.gain.setValueAtTime(0.001, now); gain.gain.exponentialRampToValueAtTime(volume, now + 0.012); gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(gain); gain.connect(this.master); oscillator.start(now); oscillator.stop(now + duration + 0.02);
  }

  private noise(duration: number, volume: number): void {
    if (!this.context || !this.master || this.muted) return;
    const length = Math.floor(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const source = this.context.createBufferSource(); source.buffer = buffer;
    const filter = this.context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1000;
    const gain = this.context.createGain(); gain.gain.value = volume;
    source.connect(filter); filter.connect(gain); gain.connect(this.master); source.start();
  }

  play(kind: EventKind | 'Click'): void {
    if (!this.context) return;
    switch (kind) {
      case 'Click': this.tone(520, 0.08, 'sine', 0.15, 1.35); break;
      case 'Shot': this.tone(380, 0.1, 'triangle', 0.1, 1.8); break;
      case 'Hit': this.noise(0.08, 0.12); this.tone(120, 0.08, 'square', 0.07, 0.6); break;
      case 'Skill': this.tone(210, 0.4, 'sine', 0.2, 3); this.tone(440, 0.35, 'triangle', 0.08, 1.8); break;
      case 'TowerDestroyed': this.noise(0.9, 0.35); this.tone(90, 0.8, 'sawtooth', 0.18, 0.35); break;
      case 'Death': this.tone(280, 0.6, 'sine', 0.18, 0.3); break;
      case 'Respawn': this.tone(330, 0.45, 'sine', 0.14, 2); break;
      case 'Victory': [0, 0.13, 0.26].forEach((delay, i) => setTimeout(() => this.tone([392, 523, 659][i], 0.5, 'triangle', 0.14, 1.02), delay * 1000)); break;
      case 'Announcement': case 'SuddenDeath': this.tone(160, 0.45, 'sine', 0.12, 1.5); break;
    }
  }

  private startAmbience(): void {
    if (!this.context || !this.master) return;
    const bus = this.context.createGain(); bus.gain.value = 0.028;
    const filter = this.context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 260;
    bus.connect(filter); filter.connect(this.master);
    for (const frequency of [55, 82.41]) {
      const oscillator = this.context.createOscillator(); oscillator.type = 'sine'; oscillator.frequency.value = frequency; oscillator.connect(bus); oscillator.start();
    }
  }
}

import { AudioClip, AudioSource, Node, director, resources } from 'cc';
import { eventBus } from './EventBus';
import { EventNames } from './EventNames';
import { dataManager } from '../data/DataManager';

/**
 * 音频系统（core：引擎封装 + 事件接线；阶段 5「音效接入」）。
 *
 * 规则（用户口径 + 宪法 6.7 / 6.13）：
 *  - 资源路径与音量**全部来自 `audio.json`**，本文件零硬编码；
 *  - **BGM 音量明显低于音效**：BGM 实际音量 = `master.bgm_volume × 曲目 volume_scale`，
 *    音效 = `master.sfx_volume × 音效 volume`（避免"只能听到背景音乐"）；
 *  - **升级不配音效**：刻意**不订阅** `on_player_levelup` / `on_buff_offered`；
 *  - 缺素材**静默降级**（只在控制台告警一次），不阻塞玩法；
 *  - 结算音按 `on_run_end` 的 reason 区分：`death` → 失败曲；`clear` → 通关曲；`suspend`（主动退出）不播。
 */
/** 音效定义（`audio.sfx[]`；字段名与配置保持一致）。 */
interface SfxDef { id: string; path: string; volume: number; }
/** BGM 定义（`audio.bgm[]`）。 */
interface BgmDef { id: string; path: string; volume_scale: number; }

class AudioSystem {
  private sfx = new Map<string, { clip: AudioClip; volume: number }>();
  private bgm = new Map<string, { clip: AudioClip; volumeScale: number }>();
  // 说明：内部统一用 volumeScale 存储，来源是配置的 volume_scale。
  private sfxSource: AudioSource | null = null;
  private bgmSource: AudioSource | null = null;
  private bgmVolume = 0.16;
  private sfxVolume = 1;
  private runBgm = '';
  private warned = new Set<string>();
  private wired = false;
  private lastHitSec = 0;
  // ——— 音效节流 / 并发压限（用户反馈：多段命中叠在一起会"突然变大，吓一跳"）———
  /** 同一音效两次播放的最小间隔（ms）。 */
  private sfxMinGapMs = 60;
  /** 并发统计的滑动窗口（ms）。 */
  private sfxWindowMs = 90;
  /** 窗口内最多允许几个音效同时起播，超出直接丢弃。 */
  private sfxMaxInWindow = 4;
  /** 窗口内每多一个并发，音量额外衰减的比例：`1 / (1 + n × k)`。 */
  private sfxDuckPerExtra = 0.6;
  /** 每个音效 id 的上次播放时间戳（ms）。 */
  private lastPlayMs = new Map<string, number>();
  /** 滑动窗口内的播放时间戳（用于并发压限）。 */
  private recentPlays: number[] = [];
  /** 暂停（升级选卡 / 手动暂停）期间静音：否则恢复瞬间会把积压的音效一起炸出来。 */
  private paused = false;

  /** 由 Boot 在配置就绪后调用：建节点 → 加载音频 → 接线事件。 */
  preload(): void {
    if (!dataManager.isLoaded('audio')) {
      console.warn('[Audio] audio.json 未加载：本次运行无音效（玩法不受影响）');
      return;
    }
    const cfg = dataManager.getTable<any>('audio');
    this.bgmVolume = cfg.master?.bgm_volume ?? 0.16;
    this.sfxVolume = cfg.master?.sfx_volume ?? 1;
    // 音效节流参数（可调；缺省为保守值）
    this.sfxMinGapMs = cfg.master?.sfx_min_gap_ms ?? 60;
    this.sfxWindowMs = cfg.master?.sfx_window_ms ?? 90;
    this.sfxMaxInWindow = cfg.master?.sfx_max_in_window ?? 4;
    this.sfxDuckPerExtra = cfg.master?.sfx_duck_per_extra ?? 0.6;
    this.runBgm = cfg.run_bgm ?? '';
    this.ensureSources();

    const jobs: { path: string; kind: 'sfx' | 'bgm'; def: SfxDef | BgmDef }[] = [];
    for (const d of (cfg.bgm ?? [])) {
      jobs.push({ path: d.path, kind: 'bgm', def: d as BgmDef });
    }
    for (const d of (cfg.sfx ?? [])) {
      jobs.push({ path: d.path, kind: 'sfx', def: d as SfxDef });
    }
    let remain = jobs.length;
    if (remain === 0) {
      this.wireEvents();
      return;
    }
    for (const job of jobs) {
      resources.load(job.path, AudioClip, (err, clip) => {
        if (!err && clip) {
          if (job.kind === 'bgm') {
            const def = job.def as BgmDef;
            this.bgm.set(def.id, { clip, volumeScale: def.volume_scale ?? 1 });
          } else {
            const def = job.def as SfxDef;
            this.sfx.set(def.id, { clip, volume: def.volume ?? 1 });
          }
        } else if (!this.warned.has(job.path)) {
          this.warned.add(job.path);
          console.warn(`[Audio] 音频缺失（静默降级）：${job.path}`);
        }
        remain -= 1;
        if (remain === 0) {
          console.log(`[Audio] 音频就绪：音效 ${this.sfx.size} 个 · BGM ${this.bgm.size} 首`
            + `（BGM 音量 ${this.bgmVolume} / 音效 ${this.sfxVolume}）`);
          this.wireEvents();
        }
      });
    }
  }

  /**
   * 播放一次性音效（缺素材静默忽略）。
   *
   * **三层保护**（用户反馈「偶尔音效突然变大，吓一跳」的根因是多段音效叠在一起）：
   *  1. 暂停期间静默（升级选卡 / ESC 暂停），避免恢复瞬间积压的音效一起爆；
   *  2. 同一音效 id 在 `sfx_min_gap_ms` 内只播一次（多个敌人同时受击只响一声）；
   *  3. 滑动窗口内统计并发数 n：音量乘 `1/(1+n×k)` 衰减，超过 `sfx_max_in_window` 直接丢弃。
   */
  play(id: string): void {
    const def = this.sfx.get(id);
    if (!def || !this.sfxSource || this.paused) {
      return;
    }
    const now = Date.now();
    // 2) 同 id 节流
    const last = this.lastPlayMs.get(id) ?? 0;
    if (now - last < this.sfxMinGapMs) {
      return;
    }
    // 3) 滑动窗口并发压限
    while (this.recentPlays.length > 0 && now - this.recentPlays[0] > this.sfxWindowMs) {
      this.recentPlays.shift();
    }
    const concurrent = this.recentPlays.length;
    if (concurrent >= this.sfxMaxInWindow) {
      return;
    }
    this.recentPlays.push(now);
    this.lastPlayMs.set(id, now);
    const duck = 1 / (1 + concurrent * this.sfxDuckPerExtra);
    this.sfxSource.playOneShot(def.clip, this.clamp01(def.volume * this.sfxVolume * duck));
  }

  /** 开始本局 BGM（循环）。 */
  startBgm(): void {
    const def = this.bgm.get(this.runBgm);
    if (!def || !this.bgmSource) {
      return;
    }
    this.bgmSource.stop();
    this.bgmSource.clip = def.clip;
    this.bgmSource.loop = true;
    this.bgmSource.volume = this.clamp01(this.bgmVolume * def.volumeScale);
    this.bgmSource.play();
  }

  /** 停止 BGM（结算 / 退出）。 */
  stopBgm(): void {
    if (this.bgmSource) {
      this.bgmSource.stop();
    }
  }

  private ensureSources(): void {
    const scene = director.getScene();
    if (!scene) {
      console.error('[Audio] 场景未就绪，无法创建音频节点');
      return;
    }
    const node = new Node('AudioRoot');
    scene.addChild(node);
    this.sfxSource = node.addComponent(AudioSource);
    const bgmNode = new Node('Bgm');
    node.addChild(bgmNode);
    this.bgmSource = bgmNode.addComponent(AudioSource);
    this.bgmSource.loop = true;
  }

  /** 事件接线：所有游戏音效在此统一映射（升级刻意不接）。 */
  private wireEvents(): void {
    if (this.wired) {
      return;
    }
    this.wired = true;
    eventBus.on(EventNames.on_run_start, this.startBgm, this);
    eventBus.on(EventNames.on_run_end, this.onRunEnd, this);
    eventBus.on(EventNames.on_skill_cast, () => this.play('skill'), this);
    eventBus.on(EventNames.on_item_used, () => this.play('item_use'), this);
    eventBus.on(EventNames.on_player_hurt, () => this.play('player_hurt'), this);
    eventBus.on(EventNames.on_enemy_died, () => this.play('enemy_died'), this);
    eventBus.on(EventNames.on_pickup_collected, () => this.play('pickup'), this);
    eventBus.on(EventNames.on_boss_telegraph, () => this.play('boss_telegraph'), this);
    // 命中反馈：on_damage_dealt 可能一帧多段（多目标/多段技能），限流避免爆音
    eventBus.on(EventNames.on_damage_dealt, this.onDamageDealt, this);
    // 暂停（升级选卡 / 手动暂停）期间静音：恢复时不补播，避免"一堆音效同时炸出来"
    eventBus.on(EventNames.on_pause_changed, this.onPauseChanged, this);
  }

  /** 暂停开关（升级选卡 / ESC 暂停）：期间所有音效静默。 */
  private onPauseChanged(paused: boolean): void {
    this.paused = !!paused;
    if (this.paused) {
      this.recentPlays.length = 0;
    }
  }

  /** 命中音限流（同一帧多次命中只响一次）。 */
  private onDamageDealt(): void {
    const now = Date.now();
    if (now - this.lastHitSec < 60) {
      return;
    }
    this.lastHitSec = now;
    this.play('hit');
  }

  private onRunEnd(reason?: string): void {
    this.stopBgm();
    if (reason === 'death') {
      this.play('game_over');
    } else if (reason === 'clear') {
      this.play('run_clear');
    }
    // suspend（主动退出到存档）：不播结算音
  }

  private clamp01(v: number): number {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }
}

export const audioSystem = new AudioSystem();

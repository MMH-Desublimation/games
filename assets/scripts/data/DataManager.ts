import { resources } from 'cc';

/**
 * 配置表名常量（assets/resources/config/ 下的文件名，不含扩展名）。
 * 规则（项目宪法 6.7）：所有数值来自 resources/config/*.json，禁止硬编码。
 */
export const ConfigTables = {
  balance: 'balance',
  characters: 'characters',
  skills: 'skills',
  buffs: 'buffs',
  enemies: 'enemies',
  dungeon: 'dungeon',
  meta: 'meta',
  exp_curve: 'exp_curve',
  // 终局模式定义（本体 / 普通地图 / 挑战地图的层数上限、难度与收益公式）
  endgame: 'endgame',
  // 敌人变体（T14-S2：随层解锁的怪物种类，如疾行种 / 幻影种）
  enemy_variants: 'enemy_variants',
  // 演员表（角色 / 怪物 / Boss 的动作表路径与帧网格，纯表现层资源索引）
  actors: 'actors',
  // Boss 专属大招（长蓄力 → 生效 → 收招；键 = Boss 素材 id）
  boss_ultimates: 'boss_ultimates',
  // 局内道具（文档 2.10 的道具框：点击即用；掉落权重与效果）
  // 音频（阶段 5：BGM / 音效 / 结算音；路径与音量）
  audio: 'audio',
  // 特效表（帧几何 / 播放参数；序列帧图放在 resources/fx/<key>/sheet.png）
  fx: 'fx',
} as const;

export type ConfigTableKey = (typeof ConfigTables)[keyof typeof ConfigTables];

/**
 * 配置表管理器（唯一配置访问入口）。
 *
 * 规则（项目宪法 6.7）：
 *  - 禁止模块直接读文件，统一走 DataManager.get / getTable。
 *  - 启动时由 Boot 场景异步加载全部表到内存。
 */
class DataManager {
  private tables: Map<string, any> = new Map();

  /** 启动时异步加载全部配置表到内存（resources/config/ 下的 JSON）。 */
  loadAll(onComplete: (err: Error | null) => void): void {
    const keys = Object.values(ConfigTables);
    let loaded = 0;
    let firstError: Error | null = null;
    for (const key of keys) {
      resources.load(`config/${key}`, (err: Error | null, asset: any) => {
        if (err) {
          if (!firstError) firstError = err;
        } else if (asset && asset.json) {
          this.tables.set(key, asset.json);
        }
        loaded++;
        if (loaded === keys.length) {
          onComplete(firstError);
        }
      });
    }
  }

  /** 取整张表对象。未加载则抛错（开发期尽早暴露问题）。 */
  getTable<T = any>(table: ConfigTableKey): T {
    const t = this.tables.get(table);
    if (t === undefined) {
      throw new Error(`[DataManager] 配置表未加载: ${table}`);
    }
    return t as T;
  }

  /** 按 id 取一条记录，兼容「对象表」（key=id）与「数组表」（元素含 id 字段）。 */
  get<T = any>(table: ConfigTableKey, id: string | number): T {
    const t = this.getTable<any>(table);
    if (Array.isArray(t)) {
      const found = t.find((r) => r.id === id || r.id === String(id));
      if (!found) throw new Error(`[DataManager] ${table} 缺少 id=${id}`);
      return found as T;
    }
    const rec = t[id] ?? t[String(id)];
    if (!rec) throw new Error(`[DataManager] ${table} 缺少 key=${id}`);
    return rec as T;
  }

  /** 表是否已加载。 */
  isLoaded(table: ConfigTableKey): boolean {
    return this.tables.has(table);
  }
}

export const dataManager = new DataManager();

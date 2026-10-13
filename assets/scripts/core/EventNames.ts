/**
 * 全局事件名常量表。
 *
 * 规则（项目宪法 6.6）：禁止在代码中使用字符串字面量作为事件名，
 * 一律引用本表成员；订阅必须在销毁时取消，避免内存泄漏。
 *
 * 命名（项目宪法 6.3）：事件名统一 `on_xxx_yyy` 全小写。
 */
export const EventNames = {
  // —— 局内战斗 ——
  on_enemy_died: 'on_enemy_died',
  on_hunter_spawned: 'on_hunter_spawned',
  on_boss_died: 'on_boss_died',
  on_player_hurt: 'on_player_hurt',
  on_hp_changed: 'on_hp_changed',
  /** 道具框内容变化（掉落 / 使用）：表现层据此刷新道具框（文档 2.10）。 */
  on_item_changed: 'on_item_changed',
  /** 道具使用成功（道具 id, 名称）：表现层据此给出使用反馈。 */
  on_item_used: 'on_item_used',
  on_player_died: 'on_player_died',
  /** 伤害结算完成（x(px), y(px), 伤害值），供表现层（飘字 / 受击特效）订阅。 */
  on_damage_dealt: 'on_damage_dealt',

  // —— 经验 / 金币 / 拾取 ——
  on_exp_gained: 'on_exp_gained',
  on_gold_gained: 'on_gold_gained',
  on_pickup_collected: 'on_pickup_collected',

  // —— 升级 / Buff ——
  on_player_levelup: 'on_player_levelup',
  on_buff_offered: 'on_buff_offered',
  on_buff_pick_requested: 'on_buff_pick_requested',
  on_buff_selected: 'on_buff_selected',

  // —— 技能 ——
  on_skill_used: 'on_skill_used',
  on_skill_ready: 'on_skill_ready',

  // —— 关卡 / Run ——
  on_layer_start: 'on_layer_start',
  on_layer_clear: 'on_layer_clear',
  on_run_start: 'on_run_start',
  on_run_end: 'on_run_end',
  /** 地宫生成完成（携带 DungeonMap）：视图层渲染、实体层/玩家层据此布点。 */
  on_dungeon_built: 'on_dungeon_built',
  /** 玩家进入某个房间（携带 DungeonRoom）：实体层据此按房间刷怪。 */
  on_room_entered: 'on_room_entered',
  /** 玩家抵达出口房：流程层据此推进下一层或结算。 */
  on_exit_reached: 'on_exit_reached',
  /** 出口点封锁状态变化（locked: boolean）：Boss 层击杀 Boss 前封锁，表现层据此着色。 */
  on_exit_lock_changed: 'on_exit_lock_changed',
  /** Boss 行为预警（x(px), y(px), 半径(px), 持续毫秒）：表现层据此标出危险范围。 */
  on_boss_telegraph: 'on_boss_telegraph',
  /** 技能释放（slot(1|2), 技能名）：表现层据此给出释放反馈 / 刷新技能栏。 */
  on_skill_cast: 'on_skill_cast',
  /**
   * 请求开始新的一局（`classId`, `mode`：`base` 本体 / `normal` 普通地图 / `challenge` 挑战地图）。
   *
   * 与 `on_run_start` 的区别（重要）：UI 只发「请求」，由 `dungeon/RunFlow` 先 `gameState.init()`
   * 完成状态初始化，**再**广播 `on_run_start` 作为纯通知。
   * 这样所有开局订阅者（含模块级单例）读到的都是**新一局**的状态；
   * 否则（UI 直接广播 on_run_start）订阅顺序不可控，模块单例可能先于 RunFlow 收到事件，
   * 读到**上一局残留**的携带 Buff —— 表现为「新一局里上一局的技能 buff 仍在生效」。
   */
  on_run_start_requested: 'on_run_start_requested',
  /** 通用危险范围预警（x(px), y(px), 半径(px), 持续毫秒）：与 Boss 预警共用危险范围表现。 */
  on_danger_zone: 'on_danger_zone',
  /**
   * **矩形**危险范围预警（x(px), y(px), 长(px), 宽(px), 角度(弧度), 持续毫秒）。
   * 用于「冲锋路径 / 水柱 / 火焰」这类长条形范围 —— 比用一串圆去近似更准确（用户口径：所见即判定区）。
   */
  on_danger_rect: 'on_danger_rect',
  /**
   * 通用特效播放（fxKey, x(px), y(px), 角度(度), 是否跟随玩家）。
   * 表现层按 `fx.json` 取序列帧播放；资源缺失时静默降级（灰盒先行）。
   */
  on_fx: 'on_fx',
  /** 请求切换局内暂停（暂停按钮 / ESC）：由流程层裁决并广播 on_pause_changed。 */
  on_pause_requested: 'on_pause_requested',
  /** 暂停状态变化（paused: boolean）：视图层据此显示 / 隐藏暂停面板。 */
  on_pause_changed: 'on_pause_changed',
  /** 请求退出本局（暂停面板「退出到存档」）：流程层挂起本局并回到存档界面。 */
  on_run_exit_requested: 'on_run_exit_requested',
  /** 结算界面确认（点击"再来一局"后回到开局面板）。 */
  on_result_confirmed: 'on_result_confirmed',
  /** 层内风险节奏变化（时间压力系数, 收益软上限倍率, 提前离开倍率, 本层停留秒数）：实体层据此刷新休眠怪物。 */
  on_layer_risk_changed: 'on_layer_risk_changed',
  /** 请求生成本层猎杀者（携带当前层数）：由 entities 层负责池化生成（宪法 6.13）。 */
  on_hunter_spawn_requested: 'on_hunter_spawn_requested',

  // —— 存档 ——
  on_save_loaded: 'on_save_loaded',
  on_save_changed: 'on_save_changed',
  /** 存档槽列表变化（新建 / 删除 / 导入），存档界面据此刷新列表。 */
  on_save_slots_changed: 'on_save_slots_changed',
  /** 玩家已选定存档槽（无进行中局面时进入职业选择）。 */
  on_slot_entered: 'on_slot_entered',
  /** 恢复未完成的一局（携带 RunSnapshot）：流程层恢复局内状态并进入对应层。 */
  on_run_resume: 'on_run_resume',
  /** 请求返回存档选择界面（结算后「返回存档」）。 */
  on_slot_panel_open: 'on_slot_panel_open',

  // —— 局外养成 ——
  on_meta_upgraded: 'on_meta_upgraded',
  /** 请求打开局外养成面板（开局面板按钮触发；面板自行订阅并显示）。 */
  on_meta_panel_open: 'on_meta_panel_open',
  /** 请求关闭局外养成面板（返回开局面板）。 */
  on_meta_panel_close: 'on_meta_panel_close',

  // —— 系统 ——
  on_scene_loaded: 'on_scene_loaded',
  on_config_loaded: 'on_config_loaded',
  on_game_pause: 'on_game_pause',
  on_game_resume: 'on_game_resume',
  on_error: 'on_error',
} as const;

/** 事件名联合类型，编译期约束 emit/on 的参数必须为表中成员。 */
export type EventName = (typeof EventNames)[keyof typeof EventNames];

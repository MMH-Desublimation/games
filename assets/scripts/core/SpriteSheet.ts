import { Rect, Size, SpriteFrame } from 'cc';

/**
 * 精灵图集切帧工具（core/：引擎封装，不含玩法逻辑）。
 *
 * 用途：美术资源是一整张「行走图」（如 characters/enemy.png = 4x4 个 16px 帧）时，
 * 在运行时按网格切出其中一帧来显示；帧网格参数来自配置表（禁止硬编码）。
 *
 * 易错点：Sprite 的 RAW 尺寸模式取的是 `originalSize`，
 * 运行时 new 出来的 SpriteFrame 必须显式设置 rect + originalSize，否则尺寸为 0（不可见）。
 *
 * 坐标语义（**已对引擎源码核实** `cocos/2d/assets/sprite-frame.ts::_calculateUV`）：
 * rect 的原点在**纹理左上角**（y 向下）：`t = rect.y / texh`、`b = (rect.y + height) / texh`。
 * 因此第 row 行直接取 `row * cellH`，**不要**再用 `tex.height - (row+1) * cellH` 做“左下角换算”
 * —— 那样会把行序上下颠倒（此前「怪物图消失 / 角色帧错位」即由此引起）。
 *
 * @param source 整图 SpriteFrame（从 resources 加载得到）
 * @param col 列索引（0 起，从左往右）
 * @param row 行索引（0 起，从上往下）
 * @param cols 横向帧数
 * @param rows 纵向帧数
 */
export function sliceFrameByGrid(
  source: SpriteFrame,
  col: number,
  row: number,
  cols: number,
  rows: number,
): SpriteFrame {
  if (cols <= 1 && rows <= 1) {
    return source;
  }
  const tex = source.texture;
  const cellW = tex.width / cols;
  const cellH = tex.height / rows;
  const frame = new SpriteFrame();
  frame.texture = tex;
  // rect 原点在纹理左上角（y 向下）：第 row 行即 row * cellH（见文件头说明）
  frame.rect = new Rect(col * cellW, row * cellH, cellW, cellH);
  frame.originalSize = new Size(cellW, cellH);
  frame.packable = false; // 运行时切片不参与动态合图
  return frame;
}

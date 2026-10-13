import { ImageAsset, Rect, Size, SpriteFrame, Texture2D } from 'cc';

let cached: SpriteFrame | null = null;

/**
 * 1x1 纯白 SpriteFrame（进程内缓存）。
 *
 * 灰盒阶段用「纯色方块 + 尺寸缩放」表达子弹、特效等表现（文档 1.5：灰盒先行），
 * 不依赖任何美术资源；所有使用者共享同一张纹理，便于合批（文档 4.9：降低 draw call）。
 */
export function getWhiteFrame(): SpriteFrame {
  if (cached && cached.isValid) {
    return cached;
  }
  const image = new ImageAsset({
    _data: new Uint8Array([255, 255, 255, 255]),
    _compressed: false,
    width: 1,
    height: 1,
    format: Texture2D.PixelFormat.RGBA8888,
  });
  const texture = new Texture2D();
  texture.image = image;

  const frame = new SpriteFrame();
  frame.texture = texture;
  frame.rect = new Rect(0, 0, 1, 1);
  frame.originalSize = new Size(1, 1);
  frame.packable = false;
  cached = frame;
  return frame;
}

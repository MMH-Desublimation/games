# 素材来源与授权记录（CC0）

> 依据核心文档 8《资源与授权清单》8.5「授权文件清单」：本文件记录**全部**美术与音效素材的
> 来源、作者、协议与在本项目中的实际用途。
>
> 本项目**所有**美术与音效素材均来自**同一个 CC0 素材包**，无任何 CC-BY / 商用受限素材，
> 也**未使用 AI 生成素材**（依据文档 8.4 第 3 条）。

## 授权总览

| 对象 | 协议 | 说明 |
|---|---|---|
| 游戏代码 | **MIT** | 可自由使用、修改、分发，含闭源商用；仅需保留版权与许可声明。全文见根目录 [`LICENSE`](../LICENSE) |
| 美术 / 音效素材 | **CC0 1.0 Universal** | 公共领域，随仓库分发，**不强制署名** |
| 引擎 | **Cocos Creator 3.8** | 引擎源码 MIT；编辑器使用遵循官方协议 |

## Ninja Adventure Asset Pack

| 项 | 内容 |
|---|---|
| 素材包名 | Ninja Adventure - Asset Pack |
| 作者 | **Pixel-boy**（[@Pixel-boy](https://pixel-boy.itch.io/)）与 **AAA**（[Instagram](https://www.instagram.com/challenger.aaa/)） |
| 素材包主页 | https://pixel-boy.itch.io/ninja-adventure-asset-pack |
| 协议 | **CC0 1.0 Universal**（`LICENSE.txt` 随素材包分发，已核对） |
| 支持作者 | [Patreon](https://www.patreon.com/pixelarchipel) |

## 本项目实际使用的素材

所有路径均相对于 `assets/resources/`。

| 分类 | 路径 | 帧网格 | 用途 |
|---|---|---|---|
| 角色 | `actors/player/{yellow,blue,red}/` | 4×7 | 三个职业（战士 / 法师 / 射手）的行走 / 攻击序列帧 |
| 怪物 | `actors/monster/{slime,bear,bluebat,butterfly,cyclope,dragon,lizard,mushroom,panda}/` | 4×4 | 普通怪与精英怪 |
| Boss | `actors/boss/{demon_cyclop2,dragon_blue,giant_bamboo2,squid_red,tengu_red}/` | 4×4 | 每 5 层的 Boss（第 5/10/15/20/25 层） |
| 界面 | `ui/dialogue_box.png`、`ui/choice_box.png` | 九宫格 | 面板底图、选项 / 按钮底图 |
| 界面 | `ui/btn_yes.png`、`ui/btn_no.png` | — | 是 / 否按钮 |
| 界面 | `ui/icon_{keyboard,mouse,gamepad,heart}.png` | — | 操作提示图标、生命图标 |
| 界面 | `ui/ui_font.ttf` | — | **像素艺术字字体**（全部 UI 文本使用） |
| 技能图标 | `ui/skill/{cut,orb_fire,thunder,arrow,vision}.png` | — | 技能栏图标（按职业区分普攻 / 大招） |
| 特效 | `fx/` | 序列帧 | 受击 / 命中 / 爆炸等特效 |
| 背景 | `bg/` | — | 地宫背景图 |
| 音频 | `audio/` | OGG | 音效（时长均 < 2 秒） |

> 说明：`actors/boss/giant_red_samurai/` 为早期选用的 Boss 素材，**现已停用**（保留文件以便回退），
> 未在本作中出场。

## 授权核对记录（文档 8.6 发布前检查）

- [x] 所有素材均有 CC0 证明 —— 素材包内 `LICENSE.txt` 为 CC0 1.0 Universal，已逐项核对；
- [x] `LICENSE` 含 MIT 全文与版权声明；
- [x] `README.md` 含玩法说明、授权声明、构建方法；
- [x] 本文件（`docs/assets_credits.md`）完整；
- [x] 仓库无 `.gitignore` 遗漏的本地构建产物（`library/` / `temp/` / `build/` / `native/` / `profiles/` 均已忽略）；
- [x] 存档导入 / 导出功能已由 `tools/test_save_migration.js` 覆盖（v1 / v2 / v3 / v4 / 损坏档）。

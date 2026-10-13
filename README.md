# 地牢生存（Dungeon Survival）

单机 2D Roguelite 动作游戏 · **Cocos Creator 3.8.7 + TypeScript**。

代码协议 **MIT**（见 [`LICENSE`](LICENSE)），素材协议 **CC0**（见 [`docs/assets_credits.md`](docs/assets_credits.md)）—— 可自由分发与商用。

---

## 玩法

- **打穿 25 层地宫**：每 **5 层** 一个 Boss（共 5 个，各有专属大招；打满一轮后循环登场并继续提升数值）。
- **三职业**：战士 / 法师 / 射手（同一套忍者美术，按职业配色；普攻与技能形态不同）。
- **升级选卡（N 选 1）**：属性类 / 行为型 / 技能型三类强化；行为型与技能型**占携带槽位**，有上限，需要取舍。
- **层内风险三机制**：越待越强的**时间压力**、收益**软上限**、**提前离开倍率** —— 三者在 HUD 上实时显示。
- **终局双模式**（通关本体后解锁）：
  - **普通地图**：无尽层数，难度按轮次缓增；
  - **挑战地图**：难度递进、单层收益按 `1.12^层` 递增（硬上限 50×），**失败保留 50%** 收益。

## 操作

| 操作 | 键位 |
|---|---|
| 移动 | `W` `A` `S` `D` |
| 普攻 | `J`（或鼠标左键 / 触屏普攻键） |
| 技能 | `K`（或触屏技能键） |
| 暂停 / 继续 | `ESC`（或右上角「暂停」） |
| 升级选卡 | `N`（或点击选项） |
| 交互 / 进下一层 | 走到出口点自动触发 |

> 手机端：底部技能键与右上角暂停键均可点击；本作为**单机**，无需联网。

## 快速开始（开发预览）

1. 安装 **Cocos Creator 3.8.7**（Dashboard 里选对应版本）。
2. 用 Creator 打开本目录（`assets/` 同级即为项目根）。
3. 双击 `assets/scenes/scene.scene` 打开主场景，点工具栏的**预览**（浏览器）。
4. 首次打开需要等编辑器把 `assets/resources/` 下的图片**导入完成**（会生成 `.meta`）。

## 构建发布

### 命令行构建（推荐，可脚本化）

```powershell
# Web Mobile（约 40 秒）
& "<Cocos安装目录>\CocosCreator.exe" --project "<项目绝对路径>" --build "platform=web-mobile;debug=false"

# Android（先补全下面的工具链；参数较多，走配置文件见「Android APK」）
& "<Cocos安装目录>\CocosCreator.exe" --project "<项目绝对路径>" --build "configPath=./build-android.json"
```

> `--build "platform=android;packageName=xxx"` 这种**扁平写法对本项目不生效**（实测：校验读的是
> `options.packages.android.packageName`，扁平参数不会被映射进去，会报「packageName 必填项不允许为空」）
> ⇒ 必须用 `configPath` 指向 `build-android.json`。

### 真机快速验证（局域网，30 秒）

不想等 APK 时，用 Web 版直接在手机浏览器验证竖屏适配 / 触摸 / 摇杆：

```powershell
node tools/serve_web.js          # 默认 8080；启动后终端会打印手机可访问的地址
```

手机与电脑连**同一 WiFi**，浏览器打开打印出的 `http://192.168.x.x:8080` 即可。
（手机端可「添加到主屏幕」当 App 用）

### Web（GitHub Pages）

1. 编辑器菜单 **项目 → 构建发布**；平台选 **Web Mobile**，构建目录 `build/web-mobile`；
2. 构建产物（`index.html` + `assets/`）推送到仓库的 `gh-pages` 分支或 `docs/` 目录，在仓库设置里开启 Pages。

> `build/` 已在 `.gitignore` 中忽略，构建产物请**单独发布**，不要提交进主干。

### Android APK（GitHub Releases）

**前置条件（三样缺一不可，Creator 只自带 cmake 与调试签名，不含下列工具）**：

| 组件 | 说明 |
|---|---|
| **JDK** | 推荐 **JDK 17**（Creator 3.8 官方推荐；JDK 8 已不被新 Gradle 支持） |
| **Android SDK** | 需含 `platform-tools`、`build-tools`、`platforms;android-34` |
| **Android NDK** | 推荐 **r23c**（与 Creator 3.8 匹配；NDK 版本不匹配会编译报错） |

安装步骤：

1. 安装 [Android Studio](https://developer.android.com/studio)（自带 JDK 与 SDK 管理器）；
2. 打开 **SDK Manager** → 勾选 `Android SDK Platform 34`、`NDK (Side by side) r23c`、`CMake`；
3. Creator → **偏好设置 → 原生开发环境** 里填好 JDK / Android SDK / NDK 路径；
4. 回来执行上面「命令行构建」里的 Android 命令，产物在 `build/android/proj/build/.../outputs/apk/`。

> 首次原生构建需要**编译引擎 C++**，约 10~30 分钟（之后增量很快）。
> 仓库里已备好 `build-android.json`（包名 / 竖屏方向 / arm64-v8a / 调试签名）。

## 离线自检（改完代码 / 配置后必跑）

```powershell
node tools/validate_configs.js        # 1) 14 张配置表的字段合法性 + 硬上限
node tools/check_imports.js           # 2) 模块引用完整性（防"删了文件但 import 还在"导致启动阻塞）
node tools/test_save_migration.js     # 3) 存档版本迁移（防玩家升级版本后丢档）
node tools/sim_balance.js --meta=0.5  # 4) 数值模拟：逐层 DPS vs 敌方 HP、卡死层判定
```

`sim_balance.js` 的三档口径（宪法 6.14.4）：局外 0% ≈ 89s（**打不过，设计如此**）、50% ≈ 42.6s（达标）、100% ≈ 12.3s。

## 目录结构

```
assets/scripts/
├─ core/        引擎封装、事件总线、状态、对象池、计时器、音频、动作表
├─ combat/      伤害计算、子弹、技能、Buff、行为型技能
├─ entities/    玩家、敌人、Boss 行为、掉落物、实体管理
├─ dungeon/     地宫生成、连通性校验、层内风险、渲染
├─ ui/          界面、HUD、升级选卡、封面、结算、暂停、小地图
├─ data/        配置表加载与访问
├─ save/        存档唯一入口 + 版本迁移（纯函数，可离线测试）
├─ platform/    Web / APK 适配
└─ utils/       纯工具函数
```

## 数值与公式

- **全部数值**在 `assets/resources/config/*.json`（14 张表），代码**零硬编码**。
- 公式与定稿数值集中在《项目宪法》**6.14** 节；`tools/validate_configs.js` 与 `sim_balance.js` 是它的复核工具。

## 开发约定（重要）

1. **禁止硬编码数值** —— 一律走配置表（`DataManager`）。
2. **禁止手写 Cocos `.meta`** —— 一律由编辑器导入生成（手写 meta 会缺 `spriteFrame` 子资源，导致图片加载不到）。
3. **存档结构变更必须 +1 `version`**，并在 `assets/scripts/save/SaveMigration.ts` 提供迁移函数（该文件是纯函数模块，可离线测试）。
4. **事件走 `EventNames` 常量**，禁止字符串字面量；订阅必须在 `onDestroy` 取消。
5. **状态变更走方法**（`GameState` / `MetaState` 是唯一状态源），UI 只订阅、不轮询。
6. 改完**必跑**上面 4 条自检。

## License

依据核心文档 8《资源与授权清单》：

- 游戏代码：[**MIT**](LICENSE) —— 可自由使用、修改、分发，含闭源商用；仅需保留版权与许可声明
  （`Copyright (c) 2026 MMH`）
- 美术与音效素材：**CC0 1.0 Universal**（公共领域），来源见 [`docs/assets_credits.md`](docs/assets_credits.md)
  —— 全部来自 [Ninja Adventure Asset Pack](https://pixel-boy.itch.io/ninja-adventure-asset-pack)
  （作者 Pixel-boy 与 AAA），**不强制署名**，随仓库分发
- 引擎：[Cocos Creator 3.8](https://www.cocos.com/)（引擎源码 MIT，编辑器使用遵循官方协议）

> 本项目所有素材均为 CC0，无 CC-BY / 商用受限素材，也未使用 AI 生成素材。

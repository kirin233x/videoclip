# VideoClip

做启动性能优化时，用来逐帧读启动录屏、计算耗时的小工具。基于 [Tauri 2](https://v2.tauri.app/)，支持 Windows 和 macOS。界面沿用 Ankiki 的「雾紫」风格（规范见 ankiki 仓库的 `design/STYLE.md`）。

以前的做法是用读屏软件挨个打开视频，手动找起点和终点，再把时间抄下来相减。用 VideoClip 的流程是：

1. **拖入视频**：一次可以拖很多个，左侧是视频列表。
2. **逐帧找起点**：用 `←` `→` 一帧一帧地走（按住 `Shift` 一次走 10 帧），找到后按 `S`。
3. **逐帧找终点**：找到后按 `E`。右侧会直接显示这一段用了多少毫秒、多少帧。只标了起点时，显示的是起点到当前帧的耗时。
4. **记录**：起个标签（比如「点击→首帧」），按 `Enter`。同一个视频可以记录多段，比如用同一个起点分别量到首帧和内容完整。

**标记规则**：还没记录的起点和终点各只保留一个，多次按 `S` 以最后一次为准，多次按 `E` 也以最后一次为准。按 `Enter` 后，这一对就固定成一条记录，在时间轴上一直显示，之后的标记不会再影响它；同时待配对的标记清空，开始标下一段。想复用之前某一段的起点，就按 `Q` / `W` 跳到那个标记点，再按 `S`。
5. **汇总和导出**：「记录汇总」页按标签统计平均值、中位数、最小值、最大值和标准差，可以一键导出 Excel。

## 为什么时间是准的

手机录屏基本都是**可变帧率**。录屏时画面不动就少录几帧，所以不能用「帧号 ÷ 帧率」来换算时间。

VideoClip 直接读取 MP4 / MOV 容器里的采样表（`stts` / `ctts` / `elst`），拿到每一帧真实的显示时间戳（PTS）。这一步不需要解码，也不依赖 ffmpeg。耗时 = 终点帧 PTS − 起点帧 PTS。

界面上显示的帧号以 WebView 实际显示的那一帧为准（通过 `requestVideoFrameCallback` 获取），所以帧号、时间和画面始终对得上。仓库里有可变帧率 + B 帧 + 编辑列表的测试视频，解析结果和 ffprobe 逐帧对比一致。

## 为什么逐帧不卡

手机录屏的关键帧间隔通常很长（安卓 `screenrecord` 默认 10 秒一个关键帧）。用 `<video>` 的 seek 做逐帧，每一步都要从前一个关键帧重新解码，越靠后越慢。1080×2400 的录屏实测单步要 750ms 以上，按住方向键 1 秒，画面只刷新 3 次。

所以暂停时的逐帧操作改用 **WebCodecs** 自己解码：
- 解码器一直保持打开，往前走一帧只需再解一帧。
- 解好的帧缓存成位图（约 380MB 上限），往回走直接从缓存里取，空闲时还会往回预取一段。
- 随机跳到很远的位置时，同时让 `<video>` 也去 seek，哪个先好先显示哪个。

同样的视频，单步降到 10–30ms，按住方向键每一帧都能刷新出来。每个解出来的帧都带着自己的帧号，所以画面和帧号天然一致。播放仍然用 `<video>`。系统不支持 WebCodecs，或者不支持这种编码时，会自动退回 `<video>` seek。

## 快捷键（测量页）

| 按键 | 作用 |
| --- | --- |
| `←` `→`（或 `A` `D`、`,` `.`） | 上一帧 / 下一帧 |
| `Shift` + 方向键 | 一次走 10 帧 |
| `空格` | 播放 / 暂停（右下角可以切换 0.1× ~ 1× 速度） |
| `S` / `E` | 把当前帧设为起点 / 终点 |
| `Enter` | 记录这一对（还没有终点时，记录起点到当前帧），记录后标记清空 |
| `Q` / `W` | 跳到上一个 / 下一个标记点（包括已记录的） |
| `1`–`9` | 选择最近用过的标签 |
| `L` | 编辑标签 |
| `↑` `↓` | 上一个 / 下一个视频 |
| `Home` / `End` | 第一帧 / 最后一帧 |
| `Esc` | 清除还没记录的标记 |

## 导出的 Excel

- **明细**：每条记录一行，包括视频、标签、耗时、帧数、起点和终点的帧号与时间、备注、记录时间、文件路径。
- **按标签汇总**：每个标签的次数、平均值、中位数、最小值、最大值、标准差。
- **按视频对比**：每个视频一行、每个标签一列，适合对比同一场景的多次启动，表格底部还有统计行。

在「记录汇总」里筛选后再导出，只会导出筛选出来的记录。

## 什么时候需要 ffmpeg（可选）

MP4 / MOV（Android、iPhone 录屏）**不需要安装任何东西**。只有下面两种情况会用到本机的 ffmpeg：

- **Windows 上 HEVC（H.265）录屏放不出来**：界面上会出现「转码为 H.264 显示」按钮。转码后的文件只用来显示画面，测量仍然使用原视频的时间戳。
  - 安装 ffmpeg：`winget install Gyan.FFmpeg`
  - 或者在 Microsoft Store 安装「HEVC 视频扩展」，这样不用转码也能直接播放
- **MKV / WebM 等非 MP4 格式**：通过 ffprobe 读取时间戳（macOS：`brew install ffmpeg`）

## 开发

需要 Node.js 18+ 和 Rust（stable）。

```bash
npm install
```

```bash
npm run app:dev
```

上面这条命令会启动桌面应用。只调界面的话，可以用 `npm run dev` 在浏览器里打开 http://localhost:1420。浏览器模式使用 mock 数据，需要先在 `public/mock/` 下放一个 `xxx.mp4`，以及用 probe 示例生成的 `xxx.mp4.json`：

```bash
cd src-tauri/core && cargo run --example probe -- ../../public/mock/xxx.mp4 --json > ../../public/mock/xxx.mp4.json
```

运行核心测试：

```bash
cd src-tauri && cargo test -p videoclip-core
```

### 打包

**Windows 一键打包**：双击 `platforms\windows\build.cmd`。脚本会检查环境、安装依赖、编译，最后打开 `release` 文件夹，里面有两个文件：

- `VideoClip_<版本>_x64-setup.exe`：安装包，双击安装，不需要管理员权限
- `VideoClip_<版本>_x64.exe`：免安装版，直接双击运行

首次打包前需要先装好以下环境（各装一次即可）：

```powershell
winget install OpenJS.NodeJS.LTS
```

```powershell
winget install Rustlang.Rustup
```

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**其他平台 / 手动打包**：

```bash
npm run app:build
```

推送到 `main` 后，GitHub Actions 会自动打包 macOS（Apple 芯片和 Intel 通用）和 Windows 安装包。把 `src-tauri/tauri.conf.json` 里的版本号改大，就会自动发布 Release。

## 目录

```
src/                      前端（React + TypeScript）
  player.ts               逐帧播放：seek 排队、帧号以实际显示帧为准、时间偏移校准
  decoder.ts              WebCodecs 逐帧解码与帧缓存
  pages/Measure.tsx       逐帧测量页
  pages/Records.tsx       记录汇总页
src-tauri/
  src/lib.rs              Tauri 命令
  core/src/media.rs       解析 MP4/MOV 帧时间表、ffprobe 兜底、转码
  core/src/export.rs      统计和导出 Excel
  core/src/library.rs     数据存储（应用数据目录下的 library.json）
```

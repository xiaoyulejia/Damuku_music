# OBS／哔哩哔哩直播姬最小化后音频变调问题修复方案

## 一、检查结论

该问题目前不能再归因于网页中的音量淡入：现有代码已经删除 `setInterval` 音量淡入，`applyVolume()` 只有目标音量变化时才写入 `audio.volume`；初始化和切歌时也固定了 `playbackRate = 1`、`defaultPlaybackRate = 1` 和 `preservesPitch = true`。

问题只在 OBS 或哔哩哔哩直播姬最小化时出现，而 Chrome／Edge 等普通浏览器最小化正常，说明故障更可能位于网页 `HTMLAudioElement` 之后的宿主音频链路：

```text
普通浏览器：HTMLAudioElement → Chromium 音频服务 → Windows 默认输出

OBS/直播姬：HTMLAudioElement → 内嵌 CEF → 宿主浏览器源音频回调
           → PCM 分包/时间戳 → 重采样 → 宿主混音器 → 监听/直播输出
```

OBS 浏览器源基于 CEF，并可以把页面音频重新路由到 OBS；这一条路径与普通浏览器直接输出到系统设备不同。宿主最小化后，如果 CEF 渲染进程、音频回调、宿主 UI 线程或音频包时间戳被降频，宿主重采样器会为了填补或消化缓冲不断调整输出，听感可能表现为音高轻微升降、速度漂移、颤音或类似滑动变阻器的声音。

还必须排除第二种高概率原因：浏览器源音频既通过宿主“控制音频”进入混音器，又通过桌面音频被再次采集。两路音频延迟在最小化后发生变化时会产生梳状滤波，听起来同样像音量来回摆动、相位扫动或变调。普通浏览器测试通常只走一条桌面输出路径，因此不会复现。

## 二、当前代码仍需修正的点

### 1. `playAudioWithFallback()` 不应每次播放都先静音再立即解除静音

当前每次播放都会执行：

```js
audio.muted = true;
await audio.play();
audio.muted = false;
```

这不是持续变调的主要原因，但会向 CEF／OBS 音频回调产生一次音轨状态切换，并触发 `volumechange`。应只在第一次确实遇到 `NotAllowedError` 时使用静音启动；已获得播放能力后直接有声 `play()`，不要让每次切歌都重新建立静音到有声的状态。

### 2. 禁止业务代码绕过统一播放入口

`danmu-configer.js` 中仍存在直接调用 `musicPlayer.audio.play()` 和 `musicPlayer.audio.pause()` 的代码。这会绕过播放锁、自动播放处理、诊断状态和宿主兼容逻辑。应统一改为 `togglePlayback()`、`unlockPlayback()` 或专用的 `pausePlayback()`，确保只有 `music-player.js` 可以直接操作媒体对象。

### 3. 音频诊断不能依赖 `debug=1` 的控制台日志

宿主最小化时通常无法持续观察 DevTools，且 CEF 控制台日志不足以证明宿主输出是否稳定。应增加低频、环形、可下载的诊断记录，至少保存最近 5 分钟：

- `performance.now()`、`Date.now()`、`document.visibilityState`；
- `audio.currentTime`、`volume`、`muted`、`playbackRate`、`paused`；
- `playing`、`waiting`、`stalled`、`suspend`、`ratechange`、`volumechange`、`error`；
- 相邻 `timeupdate` 的墙钟间隔和媒体时间增量；
- `publisherId`、租约状态、是否发生重新播放、重新加载或 seek；
- 当前歌曲 URL 的协议、媒体格式和服务端声明的时长，不记录 Cookie 或完整敏感 URL。

如果故障期间 `audio.currentTime / wallTime` 仍接近 `1.0`、`playbackRate` 始终为 `1`、没有 `volumechange` 或 seek，而实际监听／录制已经变音，即可确认问题发生在网页之后的 CEF／宿主混音链路。

## 三、先执行的定位矩阵

不能继续仅凭听感修改网页音量代码。应使用同一首本地测试音频、同一音量和至少 3 分钟最小化时间，依次完成以下四组测试：

| 测试 | 浏览器源由宿主管理音频 | 桌面音频采集 | 监听方式 | 用途 |
| --- | --- | --- | --- | --- |
| A | 开 | 关或排除该应用 | 监听与输出 | 验证 CEF → 宿主重路由 |
| B | 开 | 开 | 监听与输出 | 与 A 对比，检查双重采集／相位干涉 |
| C | 关 | 开 | 系统直接输出 | 绕过宿主浏览器源音频回调 |
| D | 开 | 关 | 不监听，只录制后回放 | 区分“仅监听设备异常”和“直播／录制数据本身异常” |

判定规则：

- 只有 B 异常：基本确认浏览器源音频与桌面音频被重复采集。
- A、B 异常而 C 正常：基本确认 CEF 音频重路由或宿主重采样链路异常。
- 只有实时监听异常、录制文件正常：问题位于 OBS 监听设备、Windows 音频增强或监听设备采样率。
- 录制文件也异常，但网页诊断数据稳定：问题位于 CEF 输出包、宿主重采样或混音器。
- 网页诊断中 `currentTime` 本身忽快忽慢或频繁出现 `waiting`：再检查媒体下载、解码和 CEF 后台调度。

测试时必须一次只保留一个点歌页面／浏览器源，并确认控制页是镜像模式，避免两个页面同时发声。

## 四、推荐修复方案

### 方案 A：音频与浏览器画面彻底解耦（首选）

不要再让 OBS／直播姬内嵌 CEF 承担最终音乐播放。将浏览器源限定为歌词、队列和控制界面，真实音频交给独立的常驻播放器进程：

1. Node 服务继续负责队列和获取歌曲地址。
2. 新增独立音频播放器进程，使用稳定的原生媒体引擎播放，例如 mpv、VLC/libVLC 或 FFmpeg 音频输出。
3. 播放器进程接收 `play/pause/seek/volume/next` 指令，并周期上报歌曲 ID、位置、时长和状态。
4. 浏览器页面不再创建真实发声的 `Audio`；只根据服务端播放状态渲染进度和歌词。
5. OBS／直播姬通过“应用程序音频采集”或虚拟音频设备采集独立播放器，只保留一条音频路径。
6. 独立播放器以隐藏窗口或后台进程运行，不依赖 OBS／直播姬窗口是否最小化。

这是最可靠的结构性修复，因为它完全绕过内嵌 CEF 的后台调度和浏览器源 PCM 重路由。歌词仍可使用 OBS 浏览器源，音频稳定性则由原生播放器保证。

### 方案 B：短期继续使用浏览器源播放

如果暂时不能拆出独立播放器，应按以下顺序配置和修正：

1. 只保留一种采集方式：
   - 使用“由 OBS 控制音频／Control audio via OBS”时，桌面音频或应用音频采集必须排除 OBS／直播姬浏览器源的声音；
   - 使用桌面音频采集时，关闭浏览器源的宿主音频重路由，不能两路同时进入最终混音。

2. 统一采样率：
   - OBS／直播姬项目、Windows 默认输出设备、监听设备和虚拟声卡统一设置为 `48 kHz`；
   - 关闭设备的音频增强、空间音效和独占模式；
   - 修改后完全退出并重启 OBS／直播姬，避免旧的重采样上下文继续存在。

3. 浏览器源设置：
   - 关闭“源不可见时关闭／Shutdown source when not visible”；
   - 关闭“场景激活时刷新浏览器源”；
   - 不要通过隐藏、显示或切换场景来重建播放器；
   - 保证只有一个带 `livemode=true` 的播放端获得房间租约。

4. 升级并做版本对比：
   - OBS 应升级到当前稳定版；OBS 31 已更新到 Chromium 127，较旧版本的 CEF 音频问题更多；
   - 记录哔哩哔哩直播姬版本并升级到最新版；直播姬的内嵌浏览器版本和修复节奏可能与 Chrome 不同；
   - 若最新版仍异常，使用相同网页在最新版 OBS 与直播姬分别测试。两者都异常支持“共同 CEF／系统音频链路”判断，只有直播姬异常则应优先向直播姬报告宿主问题。

5. 禁止使用不确定的 Chromium 启动参数作为正式修复：
   - `--disable-background-timer-throttling` 只能作为诊断实验，不能保证 CEF 音频回调不被宿主降频；
   - 不要把 `--disable-renderer-backgrounding`、`--disable-features=CalculateNativeWinOcclusion` 等参数写入用户启动器，除非已用录制文件 A/B 证明有效；
   - 直播姬可能不接受这些参数，升级后也可能失效。

### 方案 C：媒体源稳定性补强

若定位矩阵表明网页媒体时间自身也不稳定，再处理以下项目：

- 不直接长期播放有有效期的远程歌曲 URL；由 Node 端代理或缓存当前歌曲，支持稳定的 `Content-Length`、`Content-Type`、Range 请求和连接复用。
- 播放前预加载少量音频，收到 `canplay`／`canplaythrough` 后再开始，而不是在 CEF 网络缓冲不足时立即发声。
- 记录 `waiting` 和 `stalled` 的发生次数；缓冲不足时保持正常 `playbackRate`，禁止通过加速播放追赶进度。
- 页面恢复可见时只重绘歌词和进度，不根据服务端旧采样位置 seek 当前播放端。

## 五、实现顺序

1. 先完成 A/B/C/D 定位矩阵并保留录制文件和网页诊断日志。
2. 修正双重采集、采样率和监听设备配置。
3. 收口所有 `audio.play/pause/muted/volume/currentTime` 写入到 `music-player.js`。
4. 修改自动播放 fallback，只在真正被策略阻止时静音启动一次。
5. 若浏览器源重路由仍会在宿主最小化时变音，停止继续调整 CSS、定时器或 `playbackRate`，直接实施“独立原生音频播放器 + 浏览器只显示歌词”的方案 A。

## 六、验收标准

- OBS 和哔哩哔哩直播姬分别保持前台 3 分钟、最小化 10 分钟、恢复前台 3 分钟，录制文件中无音高漂移、速度变化、颤音、音量泵动或相位扫动。
- 最小化期间网页诊断中的 `playbackRate` 恒为 `1`，没有非用户触发的 `volumechange`、seek、pause/play 或音源重载。
- 最终混音中同一歌曲只有一条采集路径；关闭该路径后声音应完全消失，不能还从桌面音频残留第二路。
- OBS／直播姬、监听设备和 Windows 输出设备全部使用 `48 kHz`。
- 浏览器源最小化或场景不可见时不被卸载、不刷新、不丢失播放端租约。
- 若采用独立播放器方案，最小化或关闭 OBS 预览不会影响播放器进程的音频连续性；重新打开歌词页只恢复显示，不重启歌曲。

## 七、参考依据

- OBS 官方文档说明浏览器源基于 CEF，并且“源不可见时关闭”会直接卸载页面：[OBS Browser Source](https://obsproject.com/kb/browser-source)。
- OBS 浏览器插件源码显示浏览器源具有独立的音频重路由配置，而不是普通浏览器的直接系统输出路径：[obs-browser source definition](https://github.com/obsproject/obs-browser/blob/master/obs-browser-source.hpp)。
- OBS 官方开发讨论曾记录“Control audio via OBS”路径出现音频爆音、卡顿等 CEF 相关问题，并说明 OBS 31 更新到 Chromium 127：[OBS Browser/CEF plans](https://github.com/obsproject/obs-studio/discussions/3853)。

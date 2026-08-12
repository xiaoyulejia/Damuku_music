# Damuku_music 歌词显示与播放进度条增强方案

更新时间：2026-08-12

本文只描述实现方案，不包含业务代码修改。目标是在不破坏现有 OBS 唯一播放端、控制页镜像和服务端权威状态机制的前提下，实现网易云歌词显示以及完整的歌曲播放进度条。

## 一、现有基础

目前播放器已经具备以下能力：

- `MusicPlayer.audio` 是真正播放歌曲的 `Audio` 对象。
- 已监听 `loadedmetadata`、`timeupdate`、`ended` 和 `error`。
- 页面已有 `.progress` 和 `.progress_bar`，`timeupdate` 会按 `currentTime / duration` 修改填充宽度。
- OBS 页面是唯一播放端；控制页本身不播放声音，只读取服务端同步状态并发送命令。
- 网易云接口已经通过 `NeteaseCloudMusicApi` 集成在 `/order/netease_api` 下。
- 当前依赖中存在 `lyric` 和 `lyric_new` 接口：
  - `/lyric?id=歌曲ID`：普通 LRC 歌词及翻译歌词。
  - `/lyric/new?id=歌曲ID`：新版歌词，可进一步支持逐字歌词。

现有进度条只能展示 OBS 页面本地播放器的粗略进度，还缺少时间文本、拖动跳转、键盘操作、控制页同步和切歌重置。歌词功能目前尚未实现。

## 二、建议的最终效果

### 2.1 控制页面

控制页面可以保留完整播放器结构：

```text
歌曲名 / 歌手 / 点歌人

        上一句歌词
      当前歌词（高亮）
        下一句歌词

00:42  ━━━━━━━━━●━━━━━━━━  03:58
       播放/暂停  下一首  音量
```

控制页建议提供三种歌词显示模式：

1. `关闭`：不请求、不显示歌词。
2. `单行`：只显示当前歌词。
3. `滚动`：显示前后多行并自动居中当前行，适合控制页或完整播放器。

翻译歌词建议作为独立开关；有翻译时显示在原文下方，无翻译时不占空间。

### 2.2 直播画面：拆成两个独立 OBS 模块

直播画面不应把点歌队列和歌词塞进同一个浏览器源。建议提供两个完全独立的 OBS 浏览器源：

```text
模块一：点歌队列 Bar
  /order/overlay/queue.html?roomid=房间号

模块二：歌词 Bar
  /order/overlay/lyrics.html?roomid=房间号
```

主播在 OBS 中分别添加两个“浏览器”来源：

- `Damuku_music - 点歌队列`：只显示当前歌曲和待播列表。
- `Damuku_music - 歌词`：只显示当前歌词，可选择单行、双语两行或三行模式。

两个来源可以分别设置宽高、位置、裁剪、透明度和 CSS。例如队列放在画面右侧，歌词单独放在画面底部。隐藏其中一个来源不会影响另一个来源，也不会停止真正的音频播放。

### 2.3 独立播放核心

为了让两个展示模块真正独立，长期方案应把“播放核心”和“画面组件”分开：

```text
隐藏/专用播放源：/order/player.html?roomid=房间号&source=player
点歌队列源：    /order/overlay/queue.html?roomid=房间号
歌词源：        /order/overlay/lyrics.html?roomid=房间号
控制页：        /order/?roomid=房间号&livemode=false&source=control
```

- `player.html` 是唯一 publisher，负责音频、弹幕、切歌、歌词时间轴和播放位置遥测。
- `queue.html` 和 `lyrics.html` 都是只读 viewer，不创建 `Audio`、不申请 publisher 租约、不连接弹幕、不加载歌单、不发送播放心跳。
- 控制页负责操作，但自身不播放。
- 如果短期内不新增 `player.html`，可以暂时保留现有 OBS 页面作为唯一播放源，并另外增加只读歌词源；但最终仍建议拆出专用播放核心，否则隐藏/删除队列来源会同时停止音频。

OBS 中必须始终保留一个播放核心来源。它可以放在不可见区域或设置为极小尺寸，但不能通过“关闭来源时关闭浏览器源”让它在场景切换时被销毁；否则音乐、弹幕和同步都会停止。

## 三、总体架构

建议拆分为四个职责明确的模块：

```text
音乐平台适配器
  └─ 获取原始歌词
       ↓
LyricService
  ├─ 缓存歌词
  ├─ 解析 LRC / 逐字歌词
  └─ 合并翻译歌词
       ↓
MusicPlayer（独立播放核心）
  ├─ 以 audio.currentTime 驱动歌词高亮
  ├─ 更新本地进度条
  └─ 发布播放位置遥测
       ↓
服务端房间状态
  ├─ 控制页根据 position + measuredAt 推算显示进度
  ├─ queue overlay 只渲染队列
  └─ lyrics overlay 只渲染歌词
```

歌词数据、当前歌词索引和播放进度不应依赖浏览器 `localStorage`。歌词缓存可以写入服务端本地 `cache/lyrics`，歌词显示设置写入 `data/settings`。

## 四、网易云歌词获取

### 4.1 扩展音乐平台接口

在各音乐平台适配器中统一增加：

```js
async getLyrics(songId) {
    // 返回统一歌词对象
}
```

统一返回结构建议如下：

```js
{
    platform: 'wy',
    songId: '123456',
    instrumental: false,
    original: '[00:12.30]第一句歌词...',
    translated: '[00:12.30]First translated line...',
    romanized: '',
    wordByWord: null,
    sourceVersion: 3
}
```

网易云实现放在 `src/public/services/musicServers/wy-music-server.js` 或更推荐的服务端音乐代理层中：

1. 优先请求 `/lyric/new?id=<sid>`。
2. 若新版接口失败或字段缺失，回退到 `/lyric?id=<sid>`。
3. 普通歌词通常读取 `lrc.lyric`。
4. 翻译歌词通常读取 `tlyric.lyric`。
5. 罗马音可读取对应的罗马音字段；字段不存在时返回空字符串。
6. 接口返回纯音乐标识或歌词为空时，返回 `instrumental: true` 或明确的 `noLyrics` 状态，不能把它当网络错误反复重试。

QQ 音乐适配器也保留 `getLyrics()` 方法；未实现时返回 `null` 或 `{ unsupported: true }`，这样播放器不需要针对平台写分支。

### 4.2 推荐改为服务端获取和缓存

考虑到项目正在将设置和状态迁移到本机文件，歌词也建议由 Node 服务端获取：

```text
GET /order/bili-api/music/lyrics?platform=wy&song_id=123456
```

服务端职责：

- 校验平台和歌曲 ID。
- 调用对应音乐 API。
- 标准化返回结构。
- 缓存成功结果。
- 对失败请求做短时间负缓存，避免每个页面重复请求。

缓存位置建议：

```text
cache/lyrics/wy/123456.json
```

缓存文件建议包含 `fetchedAt`、`expiresAt`、`sourceVersion` 和标准化歌词。普通歌词可缓存 7-30 天；“暂无歌词”只缓存数小时，避免新歌后来补歌词却一直显示为空。

不要把网易云 Cookie、完整音频 URL或其他凭据写进歌词缓存。

## 五、LRC 歌词解析

### 5.1 普通逐行歌词

新增 `src/public/services/lyric-service.js`，负责把 LRC 文本解析成：

```js
[
    {
        timeMs: 12300,
        endMs: 15800,
        text: '第一句歌词',
        translation: 'Translated line'
    },
    {
        timeMs: 15800,
        endMs: 20100,
        text: '第二句歌词',
        translation: ''
    }
]
```

解析规则：

1. 支持 `[mm:ss]`、`[mm:ss.xx]`、`[mm:ss.xxx]`。
2. 同一行可能包含多个时间标签，每个标签都生成一条记录。
3. 忽略 `[ar:]`、`[ti:]`、`[al:]`、`[by:]`、`[offset:]` 等元数据行；`offset` 存在时应统一修正时间。
4. 过滤空白内容，但允许纯音乐提示文字。
5. 按 `timeMs` 升序排列；相同时间戳合并或保持稳定顺序。
6. 每行的 `endMs` 默认取下一行的 `timeMs`；最后一行可取音频 duration 或 `Infinity`。
7. 翻译歌词单独解析后按时间戳合并。时间差小于约 100-300ms 时可视为同一句，避免接口时间戳轻微偏差导致无法匹配。
8. 所有歌词使用 `textContent` 渲染，禁止直接放入 `innerHTML`。

### 5.2 当前歌词定位

不能在每次 `timeupdate` 都从第一行遍历。建议保存 `currentLyricIndex`：

- 正常向前播放时，从当前索引继续向后查找。
- 用户拖动进度、切歌或时间倒退时，用二分查找重新定位。
- 判断条件为 `line.timeMs <= currentTimeMs < line.endMs`。
- 切歌后立即将索引重置为 `-1`，避免短暂显示上一首歌词。

### 5.3 逐字歌词作为第二阶段

第一版建议只实现逐行歌词。逐字歌词会增加以下复杂度：

- 新版接口字段结构可能与普通 LRC 不同。
- 需要把每个字/词的开始时间和持续时间标准化。
- UI 需要在当前行内部做宽度遮罩或逐词 class 高亮。
- OBS 渲染频率需要提升到 `requestAnimationFrame`，不能只依赖低频 `timeupdate`。

建议先完成稳定的逐行歌词，再把统一结构扩展为：

```js
words: [
    { text: '第', startMs: 12300, durationMs: 180 },
    { text: '一', startMs: 12480, durationMs: 220 }
]
```

## 六、歌词 UI 实现

### 6.0 页面职责

歌词 DOM 不直接追加到直播队列页面中，而是复用同一个渲染组件：

- 控制页挂载完整 `LyricsView`，允许滚动、点击歌词跳转和调整偏移。
- `/overlay/lyrics.html` 挂载精简 `LyricsOverlayView`，只负责透明背景展示，不包含按钮、队列和播放器卡片。
- 两者共用 LRC 解析、当前行定位和样式变量，但页面入口与交互权限不同。
- 歌词 overlay 不应自己调用网易云接口重复取歌词。推荐由服务端歌词缓存接口提供标准化歌词；同一歌曲多个页面只命中一次上游请求。

### 6.1 HTML 结构

在 `src/public/index.html` 的 `.nowPlaying` 与进度条之间加入：

```html
<section id="lyricsPanel" class="lyricsPanel" aria-live="off" hidden>
    <div id="lyricsViewport" class="lyricsViewport">
        <div id="lyricsLines" class="lyricsLines"></div>
    </div>
    <div id="lyricsEmpty" class="lyricsEmpty" hidden>暂无歌词</div>
</section>
```

每行使用按钮或普通 div。若支持点击歌词跳转，建议使用 `<button type="button">`，同时提供键盘操作。

### 6.2 渲染策略

- 切歌后只创建一次全部歌词 DOM。
- 时间变化时只移除上一行的 `.active` 并给新行添加 `.active`。
- 当前行变化时使用 `scrollIntoView({ block: 'center', behavior: 'smooth' })`，不要每个 `timeupdate` 都滚动。
- 用户手动滚动后暂停自动滚动约 3-5 秒，再恢复跟随。
- OBS 单行模式只渲染当前行和翻译，不创建长列表，可降低浏览器源负担。
- 切歌请求使用 `lyricRequestId` 或 `AbortController`；旧歌曲的歌词晚返回时不得覆盖新歌曲。

### 6.3 设置项

建议新增并保存在服务端 `data/settings`：

```js
lyricsEnabled: true,
lyricsMode: 'single',       // off | single | scroll
lyricsTranslation: true,
lyricsRomanization: false,
lyricsFontSize: 22,
lyricsOffsetMs: 0,
liveShowLyrics: true
```

`lyricsOffsetMs` 用于用户手动修正歌词提前/延后，建议范围 `-5000` 到 `5000` 毫秒。

歌词独立 OBS 来源是否显示由 OBS 来源可见性决定，也可以保留 `lyricsEnabled` 开关。控制页可始终显示完整滚动歌词。歌词关闭时不请求接口，节省资源。

### 6.4 独立歌词 Bar 的 URL 参数

建议支持以下参数，方便同一页面创建不同 OBS 样式：

```text
/order/overlay/lyrics.html
  ?roomid=4646297
  &mode=single
  &translation=1
  &align=center
  &fontSize=34
  &offset=0
```

- `mode=single|double|triple`：当前一行、原文+翻译两行、前一句+当前句+后一句。
- `translation=0|1`：是否显示翻译。
- `align=left|center|right`：文字对齐。
- `fontSize`：限制在安全范围内，例如 12-96。
- `offset`：只用于预览覆盖，正式偏移建议写入服务端设置。
- `theme`：可选择透明亮字、透明暗字或自定义主题。

URL 参数只控制展示，不允许修改房间队列、播放状态或全局设置。

### 6.5 点歌队列 Bar

新增 `/order/overlay/queue.html`，只渲染：

- 当前歌曲（可选）。
- 点歌人（可选）。
- 接下来若干首歌曲。
- 队列数量（可选）。

建议 URL 参数：

```text
/order/overlay/queue.html
  ?roomid=4646297
  &limit=8
  &showCurrent=1
  &showRequester=1
  &theme=dark
```

队列 Bar 和歌词 Bar 必须分别拥有自己的根 class、CSS 文件和尺寸计算，不能依赖现有 `.playerCard + .queueCard` 的组合布局。两个页面背景默认透明，且都不显示设置按钮、播放按钮、弹窗或后端离线遮罩；离线状态应使用轻量占位文字或直接隐藏。

## 七、完整播放进度条

### 7.1 HTML 结构

建议用原生 range 作为可访问的交互层，而不是只监听一个 div：

```html
<div class="playbackProgress">
    <span id="currentTimeText">00:00</span>
    <div class="progressTrack">
        <div id="bufferedBar" class="bufferedBar"></div>
        <div id="playedBar" class="playedBar"></div>
        <input id="progressSlider"
               type="range"
               min="0"
               max="1000"
               step="1"
               value="0"
               aria-label="歌曲播放进度">
    </div>
    <span id="durationText">00:00</span>
</div>
```

使用固定 `0-1000` 比例可以避免 duration 未知时频繁修改 step，也可直接把 slider 的 max 设置为音频总毫秒数。推荐后者，更容易处理键盘跳转。

### 7.2 进度更新

抽出统一方法：

```js
updatePlaybackProgress(currentTime, duration, buffered)
```

它负责：

- 计算并限制 `0 <= currentTime <= duration`。
- 更新 `playedBar` 百分比。
- 更新 `bufferedBar` 百分比。
- 更新 slider value/max。
- 将时间格式化为 `mm:ss`；超过一小时显示 `h:mm:ss`。
- duration 为 `NaN`、`Infinity` 或 0 时显示 `--:--` 并禁用拖动。

当前 `.progress_bar` 使用像素宽度，建议改成百分比或 CSS 自定义变量：

```css
--played-ratio: 0%;
--buffered-ratio: 0%;
```

这样响应式宽度变化时不需要重新计算元素像素。

### 7.3 更新频率

`timeupdate` 的触发频率由浏览器决定，不够平滑。建议：

- `timeupdate` 用于校准真实播放位置、歌词行切换和服务端遥测。
- 播放中使用 `requestAnimationFrame` 更新进度条视觉位置。
- 暂停、结束、页面隐藏或切歌时停止 animation frame。
- 不要每一帧向服务端发送状态；服务端遥测保持约 500-1000ms 一次即可。

### 7.4 拖动跳转

只有 OBS 唯一播放端可以直接执行：

```js
audio.currentTime = targetSeconds;
```

控制页拖动时必须发送 `seek` 命令：

```js
musicPlayer.sendCommand('seek', {
    positionMs: 92500,
    expectedSongKey: 'wy:123456'
});
```

后端处理要求：

1. 将 `seek` 加入命令白名单和 schema。
2. 校验 `positionMs` 是有限非负数，并限制在已知 duration 范围内。
3. 校验 `expectedSongKey` 与当前歌曲一致；切歌后到达的旧 seek 应拒绝。
4. 后端写入 `playbackAction: 'seek'` 和唯一 action ID。
5. OBS 收到命令后设置 `audio.currentTime`，成功后立即发布一次最新位置。
6. 控制页收到权威状态后结束拖动预览，避免本地预测与 OBS 实际位置长期不一致。

交互细节：

- `input` 事件只预览时间，不连续发送网络命令。
- `change`、`pointerup` 或键盘确认时只发送一次 seek。
- 拖动期间暂停服务端进度覆盖 slider，松开后恢复。
- 支持方向键小步跳转、PageUp/PageDown 大步跳转，并设置正确 `aria-valuetext`。
- 歌曲不支持 seek 或 duration 不可靠时禁用 slider，只显示进度。

## 八、OBS 与控制页的进度同步

目前服务端状态没有播放位置字段。建议由 OBS 每秒发布以下遥测：

```js
playback: {
    songKey: 'wy:123456',
    positionMs: 42500,
    durationMs: 238000,
    paused: false,
    seeking: false,
    playbackRate: 1,
    measuredAt: 1786500000000
}
```

服务端只接受当前 publisher 的播放遥测，并保存到房间状态。控制页收到后，不必每帧请求服务端，可以本地推算：

```text
显示位置 = positionMs + (当前时间 - measuredAt) × playbackRate
```

只有 `paused === false` 且 publisher 租约有效时才向前推算，并且结果不得超过 duration。每次收到新遥测再校正，可以获得平滑显示且不会增加请求量。

注意事项：

- `measuredAt` 应使用服务端接收时间或同时记录客户端时间，避免不同 WebView 时钟偏差。
- 切歌时 `songKey` 变化，控制页必须立即将位置归零并清除上一首歌词。
- publisher 租约失效后停止推算，显示最后位置或“播放端离线”。
- 播放器暂停、等待缓冲、seek、error、ended 时都应立即发布状态，不必等下一次定时心跳。
- 进度遥测属于可清理运行状态，不属于永久设置。

### 8.1 两个 Overlay 的同步规则

- 点歌队列 Bar 只关心 `stateRevision`、`queue`、`currentSong` 和 `currentRequester`，状态未变化时不重绘。
- 歌词 Bar 关心 `currentSong` 和 `playback`。歌曲变化时加载对应歌词；位置变化时本地推算当前歌词行。
- 两个 Bar 都以 `roomid` 订阅同一个房间，但不互相通信，也不通过 `BroadcastChannel` 依赖必须处于同一浏览器进程。
- 两者都不能调用 `/live/sync-claim`，否则会和播放核心争夺 publisher 租约。
- 两者都不能发布 queue/currentSong/settings，防止只读页面用空初始状态覆盖权威数据。
- 服务端重启后两个 Bar 根据 `buildId` 各自刷新；刷新任意一个都不影响音频播放核心。

建议为只读展示增加独立接口或 SSE：

```text
GET /live/overlay-state?room_id=...
```

只返回展示所需字段，不返回 Cookie、完整设置或内部命令日志。首版可以每 500-1000ms 轮询；后续可使用 Server-Sent Events 推送 revision 更新。歌词进度仍在页面本地按 playback 遥测平滑推算，不需要高频网络消息。

## 九、歌词与进度的联动

歌词高亮必须以同一个标准播放时间为准：

```text
effectiveLyricTimeMs = audio.currentTime * 1000 + lyricsOffsetMs
```

- OBS 使用真实 `audio.currentTime`。
- 控制页使用服务端 playback 遥测推算值。
- 用户 seek 后立即重新二分查找歌词位置。
- pause 时歌词停止，恢复播放后继续。
- waiting/stalled 时优先使用真实音频位置，不让歌词按墙钟继续前进。
- 切歌、播放失败或歌曲为空时立即清空歌词面板和进度条。

## 十、状态和数据结构扩展

建议给房间状态增加：

```js
{
    currentSong: {
        platform: 'wy',
        sid: '123456',
        sname: '歌曲名',
        sartist: '歌手',
        duration: 238
    },
    playback: {
        songKey: 'wy:123456',
        positionMs: 42500,
        durationMs: 238000,
        paused: false,
        seeking: false,
        playbackRate: 1,
        measuredAt: 1786500000000
    },
    lyrics: {
        available: true,
        instrumental: false,
        sourceVersion: 3
    }
}
```

不要把完整歌词文本塞进每秒发布的房间状态，否则会反复写入大 JSON 并增加同步流量。完整歌词通过按歌曲 ID 缓存的独立接口获取；状态只发布是否可用和版本信息。

## 十一、建议实施顺序

### 第一阶段：完整进度显示

1. 重构当前 `.progress` 为百分比进度。
2. 增加当前时间和总时长文本。
3. 正确处理切歌、metadata、暂停、结束和错误时的重置。
4. 使用 animation frame 提升视觉流畅度。

### 第二阶段：控制页进度同步与拖动

1. 扩展服务端 playback 遥测字段。
2. 控制页本地推算进度。
3. 新增受校验的 `seek` 命令。
4. 完成拖动预览、提交和权威状态确认。

### 第三阶段：普通逐行歌词

1. 增加统一 `getLyrics()` 接口。
2. 完成网易云普通歌词和翻译歌词获取。
3. 实现 LRC 解析、二分定位和歌词请求竞态保护。
4. 完成单行与滚动两种 UI。

### 第三点五阶段：拆分 OBS 展示模块

1. 新增独立 `player.html`，迁移唯一音频播放和 publisher 职责。
2. 新增只读 `/overlay/queue.html`，复用队列渲染组件。
3. 新增只读 `/overlay/lyrics.html`，复用歌词解析与高亮组件。
4. 启动器分别生成“播放核心”“点歌队列”“歌词”“控制页”四个链接，并提供一键复制。
5. 为两个 overlay 分别提供透明背景、独立 CSS 和 URL 展示参数。
6. 验证隐藏、刷新或删除任意展示 overlay 都不会停止播放或弹幕接收。

### 第四阶段：本地缓存和设置

1. 歌词缓存迁移到 `cache/lyrics`。
2. 歌词显示设置写入服务端 `data/settings`。
3. 关闭服务脚本的“清理运行缓存”可清除歌词缓存，但不得清除网易云凭据。

### 第五阶段：逐字歌词

在逐行歌词稳定后，再解析 `/lyric/new` 的逐字数据并增加逐词高亮动画。

## 十二、异常与边界情况

- 无歌词/纯音乐：显示“纯音乐，请欣赏”，不重复请求。
- 未登录或歌词接口失败：显示“歌词获取失败”，允许手动重试，不影响歌曲播放。
- 歌词时间轴为空：降级显示静态文本。
- 多个相同时间戳：稳定排序并合并翻译。
- 音频 duration 未知或无限：禁用拖动，时间显示 `--:--`。
- 音频 URL 不支持 Range/seek：拖动失败后恢复 OBS 返回的实际位置并提示。
- 快速连续切歌：旧歌词响应必须被 request ID 或 AbortController 丢弃。
- OBS 离线：控制页停止进度推算并禁用 seek。
- 当前歌曲播放失败自动下一首：同步清空旧歌词和旧进度，不能继续显示失败歌曲内容。
- 页面缓存更新：歌词和进度模块跟随现有 `buildId` 机制更新，不能再手工维护独立固定版本号。

## 十三、最小测试清单

### 歌词

- 普通中文 LRC 能正确高亮和滚动。
- 带翻译歌词能够按时间合并。
- `[mm:ss]`、两位和三位毫秒格式均可解析。
- 同一行多个时间标签均生成歌词项。
- `offset` 正负偏移正确生效。
- 纯音乐、无歌词、接口错误和空响应均有正确降级。
- A 歌歌词晚于 B 歌返回时不能覆盖 B。
- seek 前后歌词能立即跳到正确行。

### 进度条

- 加载歌曲后显示正确总时长。
- 播放、暂停、恢复、结束和切歌时进度正确。
- 拖动只发送一次 seek，OBS 实际跳到目标时间。
- 快速切歌后旧 seek 被 `expectedSongKey` 拒绝。
- 控制页和 OBS 的显示误差长期保持在约 1 秒以内。
- duration 无效或音频不可 seek 时控件自动禁用。
- 连续缓冲时歌词不会脱离真实音频进度。

### OBS 双模块

- OBS 同时添加播放核心、队列 Bar 和歌词 Bar 后，只有播放核心申请 publisher 租约。
- 移动、缩放、隐藏或刷新歌词 Bar 不影响队列 Bar 和音乐播放。
- 移动、缩放、隐藏或刷新队列 Bar 不影响歌词 Bar 和音乐播放。
- 队列变化只更新队列 Bar；同一歌曲内的时间变化只更新歌词 Bar，不造成队列 DOM 高频重绘。
- 场景切换后播放核心持续存在时音乐不中断；若播放核心被 OBS 销毁，应明确显示播放端离线。
- 两个 Bar 使用同一 `roomid` 时歌曲和队列一致，使用不同 `roomid` 时互不串房。

### 持久化和清理

- 重启服务后歌词显示设置仍保留。
- 清理 `cache/lyrics` 后可以重新获取歌词。
- 清理运行缓存不会删除 `data/credentials/netease-cookie.dat`，网易云登录保持有效。

## 十四、推荐首版范围

为了尽快得到稳定结果，首版建议只实现：

- 网易云普通逐行歌词。
- 翻译歌词开关。
- 单行和三行滚动显示。
- 当前时间、总时长、平滑进度条。
- 控制页发送一次性 seek 命令。
- 歌词请求竞态保护和本地缓存。
- 独立的队列 Bar 与歌词 Bar OBS 页面。
- 独立且唯一的隐藏播放核心页面。

首版暂不实现逐字卡拉 OK、歌词编辑和多来源在线搜索。这些功能复杂度较高，等基础歌词、切歌和状态同步稳定后再增加更合适。

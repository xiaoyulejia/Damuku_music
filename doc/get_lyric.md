# Damuku_music 歌词显示与播放进度条具体实现方案

更新时间：2026-08-12

本文只描述实现方案，不修改业务代码。方案以当前项目代码为准，保留现有运行模式：

- OBS 页面 `/?roomid=房间号` 是唯一播放端（publisher），持有真正的 `MusicPlayer.audio`。
- 浏览器控制页 `/?roomid=房间号&livemode=false` 是镜像端，不创建第二个音频播放器。
- 房间状态通过 `/live/sync-state` 同步，控制命令通过 `/live/sync-command` 发送。
- `realtime=1` 只决定弹幕来源，不参与歌词或播放进度同步。
- 本轮不拆分新的隐藏播放器、队列 Overlay 或歌词 Overlay，先在现有页面结构中完成歌词和进度条。

## 一、当前代码基础

### 1.1 已有播放器能力

当前 [music-player.js](./src/public/components/music-player.js) 已经：

- 使用 `MusicPlayer.audio` 播放音乐。
- 监听 `play`、`pause`、`loadedmetadata`、`timeupdate`、`ended`、`error` 等事件。
- 在 `timeupdate` 中读取 `audio.currentTime` 和 `audio.duration`。
- 每秒通过 `publishState()` 把 OBS 播放端状态写入服务端。
- 控制页每秒通过 `pullSharedState()` 获取权威状态。
- 使用 `sendCommand()` 把控制命令发给 OBS。

### 1.2 当前进度条局限

[index.html](./src/public/index.html) 已有：

```html
<div class="progress">
    <div class="progress_bar"><i class="dot"></i></div>
</div>
```

当前 `timeupdate` 用父元素像素宽度计算 `.progress_bar.style.width`。它只能在真正播放音频的 OBS 页面工作，存在以下问题：

- 没有当前时间与总时长文字。
- 控制页没有真实播放位置，只能看到静态状态。
- 不能拖动跳转。
- 页面宽度变化后像素值可能不准确。
- 切歌、播放失败、媒体时长无效时缺少统一重置。
- 歌词无法复用同一播放时间轴。

### 1.3 当前歌词状态

歌词尚未实现。网易云 API 已挂载在 `/order/netease_api`，可以使用：

```text
GET /order/netease_api/lyric/new?id=<网易云歌曲ID>
GET /order/netease_api/lyric?id=<网易云歌曲ID>
```

第一版只实现网易云 `platform === 'wy'` 的逐行歌词。QQ 音乐歌曲显示“暂不支持该平台歌词”，不能影响歌曲播放和进度条。

## 二、目标行为

### 2.1 OBS 播放端

OBS 页面负责：

- 用真实 `audio.currentTime` 更新本地进度和歌词。
- 每秒发布一次播放遥测。
- 接收并执行控制页发来的 `seek` 命令。
- 切歌时加载新歌词并清空旧歌词。
- 暂停、缓冲、恢复、结束时保持歌词与音频一致。

### 2.2 浏览器控制页

`livemode=false` 页面负责：

- 从服务端房间状态取得最近一次播放遥测。
- 在两次轮询之间按照墙钟时间平滑推算显示位置。
- 显示和 OBS 相同的当前歌词。
- 用户拖动进度条时只发送一次 `seek` 命令，不直接操作本地 `Audio`。
- 收到下一次 OBS 遥测后校正位置。

### 2.3 与实时弹幕的关系

歌词和进度功能不得检查或依赖 `realtime` 参数：

- 默认历史弹幕点歌可以显示歌词和进度。
- `realtime=1` 实时弹幕点歌也可以显示歌词和进度。
- `livemode=false&realtime=1&debug=1` 仍是只读弹幕调试页，但其歌词和进度与普通控制页一致。

## 三、需要修改的文件

建议按以下范围实现：

```text
src/public/index.html
src/public/styles/main-page.css
src/public/components/music-player.js
src/public/services/musicServers/wy-music-server.js
src/public/services/lyric-service.js          新增
src/services/local-store.js
src/routers/bili-router.js
test/playback-state.test.js                    新增
test/lyric-service.test.js                     新增
```

不需要修改实时弹幕代理 `src/services/bili-live-ws.js`。

## 四、统一播放遥测结构

### 4.1 增加稳定歌曲标识

新增统一方法：

```js
function songKey(song) {
    if (!song?.sid) return '';
    return `${song.platform || 'wy'}:${song.sid}`;
}
```

不要只用 `sid`，因为不同平台的 ID 可能重复。所有 seek 校验、歌词竞态保护和切歌重置都使用 `songKey`。

### 4.2 房间状态增加 `playback`

在 `MusicPlayer.publishState()` 中加入：

```js
playback: {
    songKey: songKey(this.currentSong),
    positionMs: Math.max(0, Math.round((Number(this.audio.currentTime) || 0) * 1000)),
    durationMs: Number.isFinite(this.audio.duration)
        ? Math.max(0, Math.round(this.audio.duration * 1000))
        : Math.max(0, Math.round((Number(this.currentSong?.duration) || 0) * 1000)),
    paused: this.audio.paused,
    seeking: this.audio.seeking,
    readyState: this.audio.readyState,
    sampledAt: Date.now()
}
```

字段含义：

| 字段 | 含义 |
|---|---|
| `songKey` | 遥测属于哪一首歌 |
| `positionMs` | OBS 采样时真实播放位置 |
| `durationMs` | 音频真实时长，未知时回退歌曲元数据 |
| `paused` | 是否暂停 |
| `seeking` | OBS 是否正在跳转 |
| `readyState` | HTMLMediaElement 就绪状态，供调试和停滞判断 |
| `sampledAt` | OBS 获取 `currentTime` 的时间，不可用服务端写入时间代替 |

`sampledAt` 必须来自播放端。服务端 `updatedAt` 是落盘时间，包含网络延迟，不能作为进度起点。

### 4.3 服务端标准化

在 [bili-router.js](./src/routers/bili-router.js) 的 `defaultRoomState()` 中加入默认值：

```js
playback: {
    songKey: '',
    positionMs: 0,
    durationMs: 0,
    paused: true,
    seeking: false,
    readyState: 0,
    sampledAt: 0
}
```

在 `normalizeRoomState()` 中用独立函数校验：

```js
function normalizePlayback(playback, currentSong) {
    const durationMs = finiteClamp(playback?.durationMs, 0, 24 * 60 * 60 * 1000);
    const positionMs = finiteClamp(playback?.positionMs, 0, durationMs || 24 * 60 * 60 * 1000);
    const expectedKey = songKey(currentSong);
    return {
        songKey: playback?.songKey === expectedKey ? expectedKey : '',
        positionMs: playback?.songKey === expectedKey ? positionMs : 0,
        durationMs: playback?.songKey === expectedKey ? durationMs : 0,
        paused: Boolean(playback?.paused),
        seeking: Boolean(playback?.seeking),
        readyState: finiteClamp(playback?.readyState, 0, 4),
        sampledAt: finiteClamp(playback?.sampledAt, 0, Date.now() + 60_000)
    };
}
```

要求：

- 所有数字必须 `Number.isFinite()`。
- `positionMs` 不得小于 0，已知时长时不得超过 `durationMs`。
- `songKey` 与 `currentSong` 不一致时整段位置归零，避免切歌瞬间显示上一首进度。
- 不接受客户端传入任意额外字段。

### 4.4 发布时机

保留当前每秒一次的 `stateTimer`，不要增加高频 HTTP 请求。另外在下列事件后立即调用一次 `publishState()`：

- `play`
- `pause`
- `loadedmetadata`
- `seeked`
- `ended`
- 切歌清空旧音频时
- 新歌曲成功设置 `audio.src` 时

`timeupdate` 不要每次都请求服务端；它只更新 OBS 本地 UI。每秒定时发布已经足够让控制页校准。

## 五、完整进度条实现

### 5.1 HTML

将现有进度 DOM 替换为：

```html
<div id="playbackProgress" class="playbackProgress">
    <span id="currentTimeText" class="progressTime">00:00</span>
    <div class="progressTrack">
        <div id="progressBuffered" class="progressBuffered"></div>
        <div id="progressPlayed" class="progressPlayed"></div>
        <input id="progressSlider"
               class="progressSlider"
               type="range"
               min="0"
               max="0"
               step="1000"
               value="0"
               disabled
               aria-label="歌曲播放进度">
    </div>
    <span id="durationText" class="progressTime">--:--</span>
</div>
```

使用毫秒作为 slider 值，与服务端 `positionMs/durationMs` 保持一致，避免秒和毫秒在多个模块间反复换算。

### 5.2 统一格式化函数

在 `music-player.js` 增加：

```js
formatPlaybackTime(ms)
```

规则：

- 非有限值返回 `--:--`。
- 小于一小时显示 `mm:ss`。
- 一小时及以上显示 `h:mm:ss`。
- 负数按 0 处理。

### 5.3 单一渲染入口

增加：

```js
renderPlaybackProgress(positionMs, durationMs, { interactive = true } = {})
```

该方法统一完成：

- 更新当前时间和总时长。
- 更新 `progressSlider.max/value`。
- 用 CSS 百分比更新播放填充。
- duration 无效时禁用 slider。
- 没有歌曲时显示 `00:00 / --:--`。

CSS 不再写像素宽度，使用变量：

```js
const ratio = durationMs > 0 ? positionMs / durationMs : 0;
progressRoot.style.setProperty('--played-ratio', String(Math.max(0, Math.min(1, ratio))));
```

```css
.progressPlayed {
    transform: scaleX(var(--played-ratio, 0));
    transform-origin: left center;
}
```

这样页面缩放、OBS 调整来源大小后无需重新计算像素。

### 5.4 OBS 本地更新

OBS 播放端以真实音频为准：

- `timeupdate` 调用 `renderPlaybackProgress(audio.currentTime * 1000, audio.duration * 1000)`。
- 播放中用 `requestAnimationFrame` 提高视觉流畅度，但每帧只改时间文字和 CSS 变量。
- `pause`、`ended`、页面隐藏或切歌时停止动画循环。
- `play` 时启动动画循环。
- `loadedmetadata` 时设置 duration 和 slider 可用状态。

必须保证全局只有一个 RAF ID，例如 `progressAnimationFrame`，重复 `play` 不能创建多个循环。

### 5.5 控制页平滑推算

控制页在 `applySharedState(state)` 中保存最近遥测：

```js
this.remotePlayback = state.playback;
this.remotePlaybackReceivedAt = Date.now();
```

显示位置计算：

```js
let positionMs = playback.positionMs;
if (!playback.paused && !playback.seeking && playback.readyState >= 3) {
    positionMs += Math.max(0, Date.now() - playback.sampledAt);
}
positionMs = Math.min(positionMs, playback.durationMs || positionMs);
```

注意：

- `readyState < 3` 时不按墙钟前进，避免网络缓冲时 UI 和歌词继续跑。
- `sampledAt` 与本机时间差异常（例如绝对值超过 30 秒）时，改用 `remotePlaybackReceivedAt` 推算。
- 每次收到服务端新状态都覆盖旧基准，长期误差不会累积。
- `songKey` 变化时立即归零并重载歌词。

控制页也使用一个 RAF 循环渲染，不提高现有每秒状态轮询频率。

### 5.6 拖动与 seek

推荐交互：

- `input`：只更新预览时间和进度条，不发命令。
- `change`、鼠标松开或键盘提交：只发送一次 `seek`。
- 拖动期间设置 `this.progressDragging = true`，暂时忽略远程位置对 slider 的覆盖。
- 命令提交后最多保留预览 2 秒；收到新 OBS 遥测后解除等待并以真实位置校正。

发送内容：

```js
this.sendCommand('seek', {
    positionMs: Number(slider.value),
    expectedSongKey: songKey(this.currentSong)
});
```

OBS 页面如果允许直接拖动，可以复用同一入口，但最终仍建议调用统一的 `executeSeek()`，不要在 DOM 事件里散落 `audio.currentTime = ...`。

## 六、服务端增加 `seek` 命令

### 6.1 后端校验

在 `applyRoomCommand()` 增加 `case 'seek'`：

1. 当前必须存在 `state.currentSong`。
2. `expectedSongKey` 必须与当前歌曲一致，否则返回 HTTP 409 和 `song-changed`。
3. `positionMs` 必须是有限非负数。
4. 若 `state.playback.durationMs > 0`，限制在总时长范围内。
5. seek 不改变队列，不增加 `queueRevision`。
6. 后端只接受并记录命令，不伪造“已经播放到该位置”的遥测。

后端可暂时把 `state.playback.seeking` 标为 `true`，但 `positionMs` 最终必须等待 OBS 执行后发布的真实状态覆盖。

### 6.2 命令日志必须保留 seek 参数

当前命令日志只为部分命令保留 `value`。新增 `seek` 后必须在日志摘要中保留：

```js
value: {
    positionMs,
    expectedSongKey
}
```

否则 OBS 的 `/live/sync-commands` 轮询拿不到跳转目标。

不要把 `seek` 合并成普通状态变化；它必须作为一次性命令被 publisher 消费。

### 6.3 OBS 执行 seek

在 `MusicPlayer.handleCommand()` 增加：

```js
if (message.command === 'seek') {
    this.executeSeek(message.value);
}
```

`executeSeek()` 再次检查：

- 当前页面不是 `isMirrorMode`。
- 当前 `songKey` 与 `expectedSongKey` 一致。
- `audio.duration` 有效且媒体允许 seek。
- 目标位置被限制到 `[0, audio.duration]`。

执行：

```js
this.audio.currentTime = targetMs / 1000;
```

在 `seeked` 事件中立即：

- 更新进度 UI。
- 重新定位歌词。
- `publishState()`。

如果歌曲在命令传输期间已经切换，必须拒绝该命令，不能把新歌曲跳到旧歌曲的位置。

## 七、歌词数据获取

### 7.1 新增 `lyric-service.js`

新增 `src/public/services/lyric-service.js`，只负责：

- 请求歌词。
- 解析 LRC。
- 合并翻译。
- 缓存解析结果。
- 按时间定位当前行。

不要让 `music-player.js` 自己解析 LRC，否则播放器类会继续膨胀。

建议接口：

```js
class LyricService {
    async load(song, { signal } = {}) {}
    parseLrc(text) {}
    mergeTranslation(original, translation, toleranceMs = 250) {}
    findLineIndex(lines, timeMs) {}
    clearMemoryCache() {}
}
```

### 7.2 网易云请求顺序

在 `wy-music-server.js` 增加 `getLyrics(songId, { signal })`：

1. 请求 `/lyric/new?id=<songId>`。
2. 请求失败、响应 code 非 200 或没有可用歌词时，回退 `/lyric?id=<songId>`。
3. 普通歌词读取 `lrc.lyric`。
4. 翻译歌词读取 `tlyric.lyric`。
5. 可选罗马音读取 `romalrc.lyric`，第一版不展示也可以保留在标准对象里。
6. `nolyric`、`uncollected` 或空内容应转换为明确状态，不能无限重试。

标准返回：

```js
{
    platform: 'wy',
    songId: String(songId),
    original: '...',
    translation: '...',
    romanization: '',
    instrumental: false,
    noLyrics: false
}
```

### 7.3 请求竞态保护

`MusicPlayer` 或歌词视图控制器保存：

```js
this.lyricRequestId = 0;
this.lyricAbortController = null;
```

切歌时：

1. 自增 `lyricRequestId`。
2. abort 上一首歌请求。
3. 立即清空歌词 DOM，显示“正在获取歌词”。
4. 请求结束时检查 request ID 和 `songKey`。
5. 旧响应不允许覆盖新歌曲。

### 7.4 缓存

第一版在 `lyric-service.js` 使用内存 `Map`：

```text
key = platform:sid
value = { fetchedAt, status, lines }
```

建议 TTL：

- 有效歌词：24 小时。
- 纯音乐/暂无歌词：1 小时。
- 网络错误：不缓存，或最多缓存 30 秒防止请求风暴。

不要把完整歌词放入 `/live/sync-state`。OBS 和控制页根据同一个 `currentSong` 独立从本地 API 获取歌词，歌词文本不会被每秒写入房间状态文件。

如果后续确认多个页面重复请求造成压力，再把相同结构迁移到 Node `cache/lyrics`；首版无需为了磁盘缓存改造后端。

## 八、LRC 解析规则

`parseLrc()` 输出：

```js
[
    {
        timeMs: 12300,
        endMs: 18120,
        text: '第一句歌词',
        translation: ''
    }
]
```

必须支持：

- `[mm:ss]`
- `[mm:ss.xx]`
- `[mm:ss.xxx]`
- 一行多个时间标签
- `[offset:+500]` 和 `[offset:-500]`
- 跳过 `[ar:]`、`[ti:]`、`[al:]`、`[by:]` 等元数据
- 空歌词行
- CRLF 和 LF

处理顺序：

1. 读取全局 offset。
2. 提取每一行的所有时间标签。
3. 为每个时间标签生成独立歌词项。
4. `timeMs = max(0, 标签时间 + offset)`。
5. 按 `timeMs` 稳定排序。
6. 相同时间的重复行按原始顺序保留或合并，规则必须固定。
7. `endMs` 取下一条歌词的 `timeMs`；最后一行取 `Infinity`。
8. 翻译歌词单独解析后，在 ±250ms 内匹配原文。

所有歌词都使用 `textContent` 渲染，禁止用歌词内容拼接 `innerHTML`。

## 九、当前歌词定位

使用二分查找：

```js
findLineIndex(lines, effectiveTimeMs)
```

判断条件：

```text
line.timeMs <= effectiveTimeMs < line.endMs
```

有效歌词时间：

```js
effectiveTimeMs = playbackPositionMs + lyricsOffsetMs;
```

要求：

- `lyricsOffsetMs` 可以为负数。
- seek 后立即重新二分定位，不能等待下一个 `timeupdate`。
- pause 时歌词停止。
- waiting/stalled 时控制页不能继续按墙钟推进歌词。
- 切歌或歌曲为空时索引立即重置为 `-1`。
- 当前索引没有变化时不重复操作 DOM。

## 十、歌词 UI

### 10.1 HTML

在 `.nowPlaying` 与进度条之间加入：

```html
<section id="lyricsPanel" class="lyricsPanel" aria-live="off" hidden>
    <div id="lyricsPrevious" class="lyricsLine lyricsPrevious"></div>
    <div id="lyricsCurrent" class="lyricsLine lyricsCurrent"></div>
    <div id="lyricsTranslation" class="lyricsTranslation" hidden></div>
    <div id="lyricsNext" class="lyricsLine lyricsNext"></div>
    <div id="lyricsStatus" class="lyricsStatus" hidden></div>
</section>
```

第一版使用固定三行，不创建全部歌词 DOM，不实现可滚动长列表。这样更适合 OBS 页面，也不会因歌词很多而增加节点数量。

### 10.2 渲染状态

歌词面板支持：

```text
hidden       设置关闭或没有当前歌曲
loading      正在获取歌词
ready        显示上一句、当前句、下一句
instrumental 纯音乐，请欣赏
unsupported 暂不支持该平台歌词
empty        暂无歌词
error        歌词获取失败
```

错误只影响歌词区域，不弹出阻塞性提示，也不触发切歌。

### 10.3 渲染入口

建议增加：

```js
renderLyricsAt(positionMs)
setLyricsState(status, payload)
resetLyrics()
loadLyricsForSong(song)
```

`renderLyricsAt()` 只在当前索引变化时更新：

- 上一句文字。
- 当前句文字和高亮 class。
- 当前句翻译。
- 下一句文字。

不要在每个动画帧重新创建节点。

### 10.4 CSS

在 `main-page.css` 增加独立 `.lyricsPanel` 样式，并兼容：

- 默认深色主题。
- `body.overlayLight` 白色主题。
- `body.liveMode` OBS 布局。
- 长歌词单行省略或最多两行换行。
- 当前歌词清晰高亮，前后歌词降低透明度。
- `prefers-reduced-motion` 下关闭位移动画。

不要让歌词面板改变点歌队列表格的定位逻辑。

## 十一、歌词显示设置

在 [local-store.js](./src/services/local-store.js) 的全局 `display` 设置增加：

```js
lyricsEnabled: true,
lyricsTranslation: true,
lyricsOffsetMs: 0,
lyricsFontSize: 22,
progressSeekEnabled: true
```

校验范围：

| 设置 | 范围 |
|---|---|
| `lyricsEnabled` | boolean |
| `lyricsTranslation` | boolean |
| `lyricsOffsetMs` | -5000 到 5000 |
| `lyricsFontSize` | 12 到 64 |
| `progressSeekEnabled` | boolean |

在 `index.html` 的显示设置页加入相应控件，并更新 `main.js`：

- `readLegacySettings()` 提供默认值。
- `applyAppearance()` 应用设置并写入 CSS 变量。
- `getDisplaySettings()` 收集设置。
- 监听控件变化，继续通过现有 `/live/settings` 保存。
- `window.__displaySettings` 更新后通知歌词视图刷新。

设置仍是全局显示设置，不放进房间播放状态，也不使用歌词内容污染设置文件。

## 十二、切歌与异常时的重置顺序

在 `play(song)` 一开始执行：

1. 自增现有 `playbackRequestId`。
2. 计算新 `songKey`。
3. 将进度归零。
4. 取消上一首歌词请求。
5. 清空上一首歌词。
6. 发布新歌曲状态，此时 `playback.positionMs = 0`。
7. 异步请求音频 URL 和歌词；两者互不阻塞。

以下情况也必须重置：

- `playCanonicalState()` 收到空歌曲。
- 音频 URL 获取失败。
- `audio.error` 后自动下一首。
- `ended` 后等待服务端切换队列期间。
- 页面从 publisher 降级为 mirror。
- `currentSong.songKey` 与 `playback.songKey` 不一致。

歌词获取失败不能调用 `playNext()`；音频播放失败也不能让旧歌词继续显示。

## 十三、具体实施顺序

### 第一阶段：播放遥测和只读进度

1. 增加 `songKey()`。
2. 扩展 `publishState()` 的 `playback`。
3. 扩展服务端默认状态和 `normalizeRoomState()`。
4. 替换进度条 HTML/CSS。
5. 实现 OBS 真实位置渲染。
6. 实现控制页平滑推算。

完成标准：OBS 和控制页显示误差稳定在约 1 秒内，切歌不会残留上一首进度。

### 第二阶段：拖动跳转

1. 增加 slider 交互和拖动锁。
2. 服务端增加 `seek` 校验。
3. 命令日志保留 seek 参数。
4. OBS 增加 `executeSeek()`。
5. `seeked` 后立即发布真实状态。

完成标准：控制页拖动只产生一个命令，OBS 跳转成功，快速切歌时旧 seek 被拒绝。

### 第三阶段：普通歌词

1. 新增 `lyric-service.js`。
2. `wy-music-server.js` 增加歌词请求。
3. 实现 LRC 解析、翻译合并和二分定位。
4. 增加请求取消和 request ID 防竞态。
5. 增加三行歌词 DOM 和样式。
6. 使用与进度条相同的位置驱动歌词。

完成标准：OBS 和控制页在同一时间显示同一句歌词，暂停、seek、切歌后同步正确。

### 第四阶段：设置和优化

1. 增加歌词显示设置并持久化。
2. 增加内存 TTL 缓存。
3. 优化 RAF 生命周期。
4. 增加无歌词、纯音乐、QQ 歌曲等降级状态。
5. 根据实际请求量决定是否增加 Node 磁盘歌词缓存。

## 十四、测试方案

### 14.1 服务端状态测试

新增 `test/playback-state.test.js`，覆盖：

- 非有限 `positionMs/durationMs` 被归零。
- position 不得超过 duration。
- playback 的 `songKey` 与 currentSong 不一致时归零。
- `seek` 缺少歌曲时被拒绝。
- `expectedSongKey` 过期时返回 409。
- seek 不修改 `queueRevision`。
- 命令日志能把 `positionMs` 和 `expectedSongKey` 交给 OBS。

### 14.2 LRC 单元测试

新增 `test/lyric-service.test.js`，覆盖：

- `[mm:ss]`、两位和三位小数。
- 一行多个时间标签。
- 正负 offset。
- 元数据行和空行。
- CRLF/LF。
- 翻译在 ±250ms 内合并。
- 二分查找边界。
- 歌词包含 HTML 字符时仍作为纯文本处理。

若 `lyric-service.js` 直接作为浏览器 ES Module，不方便被 Node 测试，可把纯解析逻辑放到无 DOM 依赖的模块，再由浏览器服务导入。

### 14.3 页面人工验收

使用同一房间打开：

```text
OBS：http://127.0.0.1:8000/order/?roomid=4646297
控制页：http://127.0.0.1:8000/order/?roomid=4646297&livemode=false
```

需要测试实时弹幕时，只在 OBS 地址追加 `realtime=1`；这不应改变歌词和进度结果。

逐项验证：

1. 新歌开始后两边显示相同总时长。
2. 播放 5 分钟后两边误差仍不持续累积。
3. 暂停后两边进度和歌词都停止。
4. 恢复后继续前进。
5. 控制页拖动一次，OBS 跳转一次。
6. seek 后歌词立即跳到正确行。
7. 快速连续切歌不会出现上一首歌词。
8. 网络缓冲时歌词不会自行向前跑。
9. 纯音乐、无歌词、QQ 歌曲不会影响播放。
10. OBS 页面关闭后，控制页保持最后位置并显示播放端离线，不继续虚假推进。

## 十五、首版明确不做

为控制改动风险，首版不实现：

- 逐字卡拉 OK 高亮。
- 歌词编辑和在线搜索多个歌词来源。
- 单独的歌词 OBS 页面。
- 隐藏播放核心或多个 Overlay 拆分。
- 高频 WebSocket/SSE 播放进度推送。
- 将完整歌词写入房间状态。
- QQ 音乐歌词抓取。

先完成“现有 OBS 页面真实播放、现有控制页同步显示、可安全 seek、网易云逐行歌词”这一闭环，再考虑拆分独立歌词来源。

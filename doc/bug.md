# Damuku_music 当前待修复问题

复核日期：2026-08-12

本文件已按最新代码重新核对。已经修复的旧问题已直接删除，只保留当前仍能从代码或运行测试中确认的问题。

本次检查包括：全部 JavaScript 语法检查、`node --test`、隔离房间的设置读写、歌单 A/B 切换、未知命令、跨平台歌曲 ID、大歌单请求和现有运行缓存体积检查。

## BUG-01：设置 API 的显示配置写入位置与读取位置不一致

- 位置：`src/routers/bili-router.js:358-399`、`src/services/local-store.js:112-153`
- 现象：`PUT /live/settings` 使用房间 ID 调用 `updateSettings(roomId, { display })`，把显示设置写进房间文件；`GET /live/settings` 却固定返回 `localStore.getSettings(null).display`，也就是全局文件。
- 实测：通过 PUT 将房间主题保存为 `light` 后接口返回 200，但立即 GET 仍得到 `dark`。
- 影响：如果页面改用 PUT 设置接口，保存看似成功，刷新后又恢复旧显示设置；revision 也混用了房间版本和全局版本，冲突判断不可靠。

解决方向：

1. 明确显示设置是全局还是按房间保存。当前 UI 语义更接近全局，应统一写入 `updateSettings(null, { display })`。
2. 如果需要房间覆盖，GET 应按“全局默认 + 房间覆盖”合并，并分别维护 `globalRevision`、`roomRevision`。
3. PUT 成功响应必须直接使用随后 GET 会返回的同一份数据。
4. 增加“PUT 后 GET 完全相等”和 revision 冲突测试。

## BUG-02：命令缓存重复保存完整房间状态，文件快速膨胀并阻塞事件循环

- 位置：`src/routers/bili-router.js:518-556`、`src/routers/bili-router.js:44-56`
- 现象：每条命令都在 `nextCommand.state` 中嵌入完整状态，其中包含整个 `idleSongList`；随后服务端同步读取、解析并重写最多 100 条命令的整个 JSON 文件。
- 实测：当前 `commands-4646297.json` 只有 44 条命令，已经约 2.52 MB，平均每条约 57 KB；最后一条命令内重复包含 62 首空闲歌曲。
- 影响：歌单越大，切歌和音量等每一个小命令都要同步读写数 MB；Node 事件循环会卡顿，磁盘写入放大，OBS 拉取命令也会传输大量重复数据。

解决方向：

1. 命令日志只保存 `sequence/id/command/value/createdAt/stateRevision/result`，不要嵌入完整 state。
2. OBS 收到命令后按 `stateRevision` 单独请求 `/live/sync-state`，或让命令响应只携带执行该动作所需的最小快照。
3. 命令日志改为内存环形队列或逐行追加日志，避免每次读写整个数组。
4. 设置单文件大小、命令数量和保留时间上限；启动时清理过期命令。
5. 文件读写移出请求热路径，至少避免大文件上的同步 `readFileSync/writeFileSync`。

## BUG-03：大歌单超过 Express 默认 100 KB 后无法加载

- 位置：`app.js:11-13`、`src/public/components/login-configer.js:303-320`
- 现象：前端把完整歌单放进 `loadSongList` JSON 命令，服务端使用默认 `express.json()`，请求体上限约为 100 KB。
- 实测：构造 1500 首、约 169 KB 的歌单请求时服务端返回 HTTP 413，并输出 `PayloadTooLargeError` HTML 页面。
- 影响：较大的网易云歌单无法切换；前端收到的不是约定 JSON，最后只能显示笼统的后端失败。

解决方向：

1. 更合理的方案是只提交 `platform + listId + requestId`，由服务端使用持久网易云登录态拉取、标准化和缓存歌单。
2. 如果短期仍传完整列表，将 JSON limit 调整为明确的安全值（例如 1-2 MB），同时限制最大歌曲数、字符串长度和嵌套结构。
3. 增加统一 JSON 错误处理中间件，让 413 返回 `{ code, message }`，不要返回 HTML。
4. 增加 100、1000、5000 首歌单的边界测试，并评估状态文件和命令日志体积。

## BUG-04：服务端本地设置已建立，但浏览器仍是重要数据源，迁移尚未闭合

- 位置：`src/public/components/order-configer.js:3-57,100-128`、`src/public/components/login-configer.js:5-25,141-154`、`src/public/main.js:24-47,97-133`、`src/public/components/music-player.js:83,435-463,562-568`
- 现象：后端已经新增 `data/settings`，但点歌配置、历史、黑名单、歌单 ID、显示设置和音量仍大量从 `localStorage` 初始化并回写。页面还存在服务端设置和浏览器旧值两套来源。
- 影响：首次加载、后端暂时不可用、多浏览器同时操作或事件到达顺序变化时，旧浏览器值仍可能短暂显示或重新发布；“服务端本地文件为唯一来源”的目标尚未真正实现。

解决方向：

1. 页面初始化先等待 `/live/settings`，成功后再构造或启用设置组件和播放服务。
2. 普通设置不再从 `localStorage` 初始化；只保留一次性、带标志位的旧数据迁移。
3. 修改设置统一调用带 revision 的设置 API，服务端成功后才更新 UI。
4. `publishState()` 不再从 `localStorage.songListId` 取权威值。
5. 音量需要明确归类：若是永久设置写入 `data/settings`；若是房间运行状态则只保存在房间状态，不再使用浏览器副本覆盖。
6. 完成迁移后删除无用途的 `readConfig()` 和设置类中的相关 `localStorage.setItem()`。
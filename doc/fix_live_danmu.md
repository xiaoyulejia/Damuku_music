# B 站实时弹幕只能收到部分消息的修复方案

> 说明：本文是早期修复草案，保留用于追溯。最新结论与已实施代码以 [`live_danmu_realtime_mode.md`](./live_danmu_realtime_mode.md) 为准。2026-08-13 已从当前官方播放器确认完整认证字段、HTTP `message_ack` 和 operation 24 Socket ACK，并在房间 440 端到端收到实时 `DANMU_MSG`；下文“ACK 待验证”等表述已经过时。

## 1. 结论

当前问题不是 `realtime=1` 没有生效。从控制台已经看到：

```text
[BilibiliDanmu][proxy] DANMU_MSG
[BilibiliDanmu][WebSocket实时弹幕]
```

这说明浏览器到本项目代理、代理到 B 站弹幕服务器、Brotli 解压和 `DANMU_MSG` 解析这条基本链路已经连通。

但当前实现还不能保证尽可能完整地接收弹幕，主要有四类缺口：

1. **消息序号 ACK 仍待抓包验证。** 早期分析曾观察到官方播放器的 `onReceivedMessage(messages, sequence)` 与 `/xlive/open-interface/v1/dm/message_ack`，但仓库内的 `lib_piliplus` 没有实现 ACK，包头 sequence 也不是可靠消息 ACK 语义的充分证据。当前应先记录并验证，不能把缺少 ACK 判定为已确认根因。
2. **匿名 HTTP 会话和 WebSocket 会话没有统一。** `lib_piliplus` 即使未登录，也会生成并复用带 `buvid3` 的匿名 CookieJar；直播 token、历史和直播间信息通过 heartbeat 账号会话请求。当前 Node 端获取导航信息、弹幕 token、历史弹幕时没有持久 Cookie 会话，WebSocket 又固定使用 `uid=0`。日志里 `uid: 0` 和打码用户名首先是游客隐私字段降级，不等于这条弹幕本身丢失，但会话不一致仍应修复并实测。
3. **解析器返回的半包余量被调用者直接丢弃。** `parseMessages()` 已经返回未解析 remainder，但 `upstream.on('message')` 和 Brotli 内层解析都没有保存它。通常一次 `ws` message 是完整应用消息，但代码既然允许半包，就必须真正做跨消息缓存，否则遇到边界异常时会无日志地丢掉尾部数据。
4. **每个浏览器页面都会新建一条 B 站上游连接。** 两个调试页面不是在观察同一条数据流，而是在各自连接 B 站节点。负载节点、连接时刻、重连间隙不同，都可能造成两页看到的消息不同。正确架构应是“一个房间一个后端上游连接，多个页面只订阅同一个房间流”。

因此修复顺序应当是：先加可观测性确认消息在哪一层消失，再实现一致匿名会话和单房间连接中心，最后补半包缓存、断线补偿和去重。ACK 只在抓包或可重复实验确认后实施。不能只继续增加浏览器端 `console.log`，因为现在的日志只记录已经成功解析出来的 `DANMU_MSG`，无法证明 B 站有没有发、代理有没有丢、解析有没有跳过。

> “全抓下来”的工程目标应定义为：在连接健康时不丢失 B 站下发给当前会话的 `DANMU_MSG`，在短暂断线后尽可能用历史接口补齐并去重。B 站公开协议、游客隐私策略和最近历史条数都不受本项目控制，因此无法承诺取得平台未向当前会话下发的消息，或在长时间断线后 100% 补齐。

---

## 2. 两个测试页面现在实际在做什么

测试地址：

```text
/order/?roomid=4646297&livemode=false&source=control&realtime=1&debug=1
/order/?roomid=4646297&realtime=1&debug=1&livemode=false
```

两者在弹幕接收方面基本相同：

- `realtime=1`：选择 WebSocket 实时模式，不走默认的 3 秒历史轮询点歌模式。
- `debug=1`：打印代理状态和已经解析出的实时弹幕。
- `livemode=false`：页面被识别为镜像/控制页。
- `source=control`：用于页面角色/同步来源，不会让 B 站弹幕连接变成另一种协议。

根据 `src/public/main.js` 和 `src/public/components/danmu-configer.js`，镜像页只有在 `realtime=1&debug=1` 时建立只读诊断连接，并以 `processCommands: false` 启动。因此这两个页面会打印弹幕，但不会把弹幕交给点歌命令处理，避免控制页和播放页重复点歌。

更重要的是，当前 `src/services/bili-live-ws.js` 的 `createLiveProxy()` 会为每一个浏览器 WebSocket 创建一个新的 B 站上游 WebSocket。因此同时打开两个地址会产生两条独立上游连接，它们不是同一接收结果的两个显示窗口，不适合逐条比对完整性。

验收时应另外打开真正负责点歌的播放页，并确保只有它启用命令处理；控制页只观察共享后的后端房间流。

---

## 3. 与 `lib_piliplus` 和当前官方播放器的差异

### 3.1 已经一致的部分

当前实现和 `lib_piliplus/tcp/live.dart` 已经基本一致的部分包括：

- 先取得真实房间号、token 和 `host_list`；
- 连接 `wss://<host>:<wss_port>/sub`；
- 发送 operation 7 认证包；
- 认证正文使用 `roomid`、`uid`、`protover: 3`、`platform: web`、`type: 2` 和 `key`；
- 收到 operation 8 后开始每 30 秒心跳；
- 支持协议版本 2 的 Zlib 和版本 3 的 Brotli；
- 对解压后的内层数据包继续切包；
- 解析 `DANMU_MSG` 的新旧用户字段。

所以不建议把协议强行降到 `protover=2` 作为主要修复。当前 B 站官方播放器仍在使用 `protover: 3`，Brotli 本身不是已经观察到的根因。

### 3.2 `lib_piliplus` 的匿名会话更完整

`lib_piliplus/utils/accounts/account.dart` 中的匿名账号会创建 CookieJar，并调用 `setBuvid3()` 生成游客设备标识。之后 `getDanmuInfo` 等 HTTP 请求沿用这个账号会话；登录时则沿用登录 Cookie 和实际 UID。

当前项目的 `getWbiMixinKey()`、`resolveRoomId()`、`/live/danmu-info` 和 `/live/danmu-history` 是彼此独立的 Axios 请求，没有统一 CookieJar，也没有把同一会话标识绑定到 WebSocket 房间连接。需要把它们合并为一个后端 B 站会话对象。

### 3.3 待验证的官方播放器 ACK

早期分析记录到的官方直播播放器流程是：

1. 调用 `getDanmuInfo?id=<roomId>&type=0`；
2. 以 `protover: 3` 连接 `host_list`；
3. `onReceivedMessage` 除了分发消息，还会取得第二个 `sequence` 参数；
4. 当 `sequence > 1` 时，调用：

```text
POST /xlive/open-interface/v1/dm/message_ack
terminal=0
sequence=<收到的消息序号>
```

这条观察必须用当前客户端重新抓包确认。本项目目前只把 16 字节协议包头的 sequence 打进调试信息，没有建立 ACK 流程。实施时不能武断地对每个心跳序号回执；必须先确认官方回调 sequence 的来源、单调性及其与停止下发的因果关系，再决定是否实现 ACK。

---

## 4. 第一阶段：先证明消息丢在哪一层

此阶段仍然只在 `realtime=1` 下启用，`debug=1` 才输出明细；默认历史点歌模式不改变。

### 4.1 为每个房间连接增加统计器

在 `src/services/bili-live-ws.js` 为每个上游连接维护：

```js
{
  connectionId,
  roomId,
  upstreamHost,
  connectedAt,
  reconnectCount,
  wsMessageCount,
  outerPacketCount,
  compressedPacketCount,
  innerPacketCount,
  commandCountByType,
  danmuCount,
  parseErrorCount,
  remainderBytes,
  lastProtocolSequence,
  sequenceGapCount,
  ackAttemptCount,
  ackSuccessCount,
  ackFailureCount,
  lastDanmuAt
}
```

每 10 秒输出一行汇总，避免每个二进制包都刷屏：

```text
[BilibiliDanmu][metrics] room=4646297 conn=... ws=... outer=... inner=...
danmu=... parseError=... remainder=... seq=... ack=成功/尝试
```

所有解析异常都必须带上 `connectionId`、协议版本、operation、sequence、包长和前 32～64 字节的十六进制摘要。不得输出 token、Cookie 或完整用户敏感信息。

### 4.2 记录所有命令类型，不只记录 `DANMU_MSG`

解压并 JSON.parse 成功后先统计 `message.cmd`，再筛选 `DANMU_MSG`。这样可以区分：

- B 站根本没有下发该弹幕；
- 数据到了但 JSON 解析失败；
- 数据到了但 cmd 变体没有被识别；
- `DANMU_MSG` 已解析，但浏览器或点歌层丢失。

`cmd` 应继续用冒号前的基础命令名比较，例如 `DANMU_MSG:4:0:2:2:2:0` 仍识别为 `DANMU_MSG`。

### 4.3 给每条弹幕生成诊断指纹

优先使用原始消息里稳定的弹幕 ID/`id_str`；没有 ID 时使用：

```text
roomId + uid + 时间戳 + 文本 + rnd
```

生成哈希后在以下节点分别计数：

```text
upstream-decoded -> normalized -> proxy-sent -> browser-received -> command-dispatched
```

这样能准确知道漏点位于代理解析、代理发送、浏览器接收还是命令处理，而不是人工盯两页控制台猜测。

### 4.4 debug 历史对账改为持续审计

当前 `loadHistoryForDebug()` 只在连接时请求一次，无法检测后续漏收。改为仅在 `realtime=1&debug=1` 下每 3 秒获取最近历史，但只用于审计，不触发点歌：

- WebSocket 指纹集合：最近 2～5 分钟；
- 历史指纹集合：每轮最新 10 条；
- 输出 `history 中存在但 websocket 未见`；
- 同时输出 `websocket 中存在但 history 未覆盖`，因为历史接口不是全量日志。

先连续测试 15～30 分钟并保留统计结果，再判断是 ACK、断线、解析还是测试页面多连接导致的差异。

---

## 5. 第二阶段：补齐一致会话，按证据决定 ACK

### 5.1 新建后端会话服务

建议新增：

```text
src/services/bili-session.js
```

职责：

- 为未登录模式生成并在进程生命周期内持久化 `buvid3`；
- 接收并保存 B 站 HTTP 响应的 `Set-Cookie`；
- `nav`、房间号解析、`getDanmuInfo` 和历史接口复用同一会话；若以后确认 ACK，再加入同一会话；
- 登录模式若以后支持 Cookie，则 UID、Cookie、CSRF 必须属于同一个账号；
- 日志只显示 `hasBuvid3/hasLoginCookie/uid`，不得打印 Cookie 内容。

可以使用 `tough-cookie` 与 `axios-cookiejar-support`，也可以实现一个范围有限的 Cookie 容器。前者更不容易漏掉 Domain、Path、Expires 等规则，但会新增依赖，实施后要锁定版本并补测试。

### 5.2 token 不再从浏览器透传

当前浏览器先请求 `/live/danmu-info`，再把 token 和上游 host 放进本地 WebSocket URL。这样 token 会出现在浏览器网络面板和服务日志中，也割裂了后端会话。

改为浏览器只发送：

```text
/live/ws?room_id=4646297&debug=1
```

由房间连接中心使用自己的 `BiliSession` 获取真实房间号、token 和 host。这样 token、Cookie 和重连都属于同一后端会话；若以后确认 ACK，也必须复用该会话。

### 5.3 仅在验证后实现 ACK 队列

只有重新抓包或可重复实验确认 ACK 必需后，才建议在房间连接对象里加入：

```js
lastAckedSequence
pendingAckSequence
ackTimer
ackInFlight
```

规则：

1. 只有已确认是官方可靠消息序号且 `sequence > 1` 才进入队列；
2. 同一 sequence 只回执一次；
3. 以短延迟合并连续消息，只提交当前最大连续 sequence，避免每条消息都发一次 HTTP；
4. POST `/xlive/open-interface/v1/dm/message_ack`，使用取得 token 的同一 Cookie 会话；
5. ACK 失败采用有限指数退避，不阻塞 WebSocket 解析；
6. 记录 HTTP 状态、B 站业务 code 和耗时，不记录会话秘密；
7. 连接重建后清理旧连接的待回执状态，不能把旧 sequence 套到新连接。

如果最终实现，ACK 功能先放在仅 `realtime=1` 生效的内部开关下。连续对账确认漏收率下降且没有异常限流后，再考虑作为实时模式默认行为。

---

## 6. 第三阶段：改成一个房间一条上游连接

建议把 `createLiveProxy()` 拆为房间中心：

```text
LiveDanmuHub
└── Map<realRoomId, RoomConnection>
    ├── BiliSession
    ├── upstream WebSocket（唯一）
    ├── subscribers Set（OBS、控制页、调试页）
    ├── stateful decoder
    ├── ACK 状态
    ├── reconnect 状态
    └── recent-event 去重缓存
```

浏览器连接 `/live/ws?room_id=...` 时：

- 已有健康 `RoomConnection`：只加入 subscribers；
- 没有连接：创建并鉴权上游；
- 浏览器关闭：只移除该 subscriber；
- 最后一个 subscriber 离开后，延迟 30～60 秒再关闭上游，防止刷新页面导致频繁重连；
- 调试页收到相同房间流，但由浏览器端的 `processCommands: false` 保证不点歌；
- 只有实际播放页负责命令处理。

这样两个控制页和 OBS 页看到的是同一条后端数据流，能够排除不同 B 站节点、不同连接时间和重连间隙造成的差异，也减少 B 站连接数。

进程内 Map 只适合单 Node 进程。如果 PM2 使用 cluster 或多实例，必须用固定房间路由，或把房间流放到 Redis Pub/Sub；否则不同进程仍会各建一条上游连接。

---

## 7. 第四阶段：状态化解码，禁止静默丢包

### 7.1 外层缓存

当前调用：

```js
parseMessages(Buffer.from(data), callback)
```

应改为连接级缓冲：

```js
outerBuffer = Buffer.concat([outerBuffer, Buffer.from(data)])
outerBuffer = parseMessages(outerBuffer, callback)
```

同时设置上限，例如 16 MiB。超过上限说明包头损坏或上游异常，应记录错误并重连，不能无限占用内存。

### 7.2 内层缓存

Brotli/Zlib 解压后优先按 B 站二进制包头严格切包。每个连接维护相应 remainder；只有确认内容确实是直接 JSON 时才使用 JSON 流解析器。

当前 `extractJsonObjects()` 是启发式花括号扫描，适合作为兼容兜底，不适合作为主路径。兜底也要保留跨调用的文本余量，防止 JSON 正好被切在两个片段之间。

### 7.3 解码错误策略

- 单个 JSON 解析失败：跳过该对象，记录摘要，继续后续对象；
- 包头非法：记录原始长度和头部摘要，清空当前损坏缓存并重连；
- 解压失败：记录协议版本和压缩包长度，切换 `host_list` 下一个节点；
- 同一连接连续错误达到阈值：主动重建会话/token，不能维持一个已损坏连接；
- 所有 catch 都不得为空。旧项目里吞异常的写法不能照搬。

---

## 8. 第五阶段：重连、补偿和全链路去重

实时 WebSocket 无法自动补回断线期间的消息。重连流程应改为：

1. 记录断线时间和最近一个稳定弹幕指纹；
2. 立即轮换到 `host_list` 下一个节点；
3. 必要时重新获取 token，而不是重复使用可能已经失效的 token；
4. 鉴权成功后立刻请求最近历史；
5. 将历史中未在实时去重缓存出现的消息按时间顺序补发；
6. 补偿消息标记 `source: history-recovery`，实时消息标记 `source: websocket`；
7. 两种来源经过同一个去重器后才能进入点歌命令。

去重键优先级：

1. B 站原始弹幕 ID/`id_str`；
2. 原始事件中的 `rnd`、时间戳等组合；
3. 最后才使用 `uid + 文本 + 秒级时间`，并采用很短 TTL，避免用户重复发送同一句时被永久误杀。

缓存建议采用有界 LRU/TTL，例如保留 5 分钟或 5000 条，防止长时间运行内存增长。

历史接口通常只覆盖最近少量消息，因此它只能修复短断线，不能补偿长断线或高弹幕量下已经被窗口挤掉的消息。

---

## 9. 文件级实施清单

### `src/services/bili-live-ws.js`

- 将每浏览器一条 upstream 改为 `LiveDanmuHub`/`RoomConnection`；
- 保存 `parseMessages()` 的 remainder；
- 记录所有 cmd、sequence、解析错误和连接指标；
- 从消息处理结果中提取可靠 sequence 并进入 ACK 队列；
- 统一重连、host 轮换、token 刷新和历史补偿；
- 标准化事件时保留原始 ID、时间、rnd、source 和 connectionId；
- `debug` 只影响日志，不改变接收协议和点歌语义。

### `src/services/bili-session.js`（新增）

- 管理匿名 `buvid3`/登录 Cookie；
- 提供 `resolveRoomId()`、`getDanmuInfo()`、`getHistory()`、`ackMessage()`；
- 确保四类请求共享同一 Cookie 会话；
- 做超时、限流、有限重试和敏感日志脱敏。

### `src/routers/bili-router.js`

- 将已有房间号、token、历史请求迁移到 `BiliSession`；
- `/live/ws` 不再信任浏览器传入的 token 和任意上游 host；
- 如保留 `/live/danmu-info` 调试接口，只返回必要的非敏感诊断信息；
- 增加仅 debug 可见的房间连接指标接口，例如 `/live/metrics?room_id=...`。

### `src/public/services/danmuServers/bilibili-server.js`

- 浏览器只传 roomId/debug，不传 token/host；
- 接收共享房间流；
- debug 输出事件 ID、source、connectionId 和代理序号；
- 持续历史对账只诊断，不触发点歌；
- 明确展示当前页面是 `command-consumer` 还是 `read-only-observer`。

### `src/public/main.js` 与 `src/public/components/danmu-configer.js`

- 保留现有隔离原则：普通页面不带 `realtime=1` 时行为完全不变；
- `livemode=false&realtime=1&debug=1` 仍只能观察，不能执行点歌；
- 只有播放页以 `processCommands: true` 消费共享流。

---

## 10. 测试方案

### 10.1 单元测试

扩展 `test/bili-live-ws.test.js`：

- 一个 WebSocket message 中包含多个完整包；
- 一个包拆成 2～3 个输入片段，最终不得丢包；
- 完整包后跟半包，下次输入后正确拼接；
- Brotli 和 Zlib 解压后包含多个内层包；
- JSON 直接流跨片段；
- `DANMU_MSG` 各种 cmd 后缀；
- 新旧用户结构和游客 `uid=0`；
- 非弹幕 cmd 只计数、不转发；
- 非法包长、超大 remainder、解压失败不会导致进程崩溃；
- ACK 同序号只提交一次、连续序号合并、失败重试有上限；
- 实时与历史补偿重复消息只进入命令一次。

### 10.2 集成测试

用本地伪 B 站 WebSocket 服务模拟：

- 认证成功、心跳回复；
- sequence 递增并要求 ACK；
- 不 ACK 时暂停后续可靠消息，用于验证修复确实生效；
- 主机断开后切换下一个 host；
- 断线期间产生消息，重连后由历史接口补齐；
- 两个浏览器订阅同房间时，伪上游连接数必须为 1；
- 关闭一个浏览器不应关闭另一个浏览器正在使用的房间连接。

### 10.3 真实房间灰度测试

仅用：

```text
realtime=1&debug=1
```

进行灰度，不调整默认模式。建议让两位测试用户发送带编号弹幕：

```text
测试001
测试002
...
测试100
```

同时保存：

- B 站官方页面实际显示条数；
- 本项目 upstream 解码条数；
- WebSocket 浏览器接收条数；
- 命令层接收条数；
- 历史审计发现的缺失条数；
- ACK 尝试/成功/失败数；
- 连接和重连次数。

不要同时用两个独立上游连接的页面逐条比较；完成共享房间中心后，多个页面才应看到相同事件流。

---

## 11. 验收标准

满足以下条件后才认为实时弹幕链路修复完成：

1. 不带 `realtime=1` 时，当前默认历史轮询和点歌功能完全不变；
2. `realtime=1` 时，同一房间无论打开几个本地页面，Node 到 B 站都只有一条活动上游连接；
3. 100 条编号弹幕测试中，连接健康期间本项目解码层不出现无解释缺号；
4. `parseErrorCount=0`、`remainderBytes` 不持续增长、无静默 catch；
5. 如果已经确认并启用 ACK，成功率达到 99% 以上，失败有重试且不阻塞弹幕处理；未确认时该项不作为验收前提；
6. 模拟短断线后，历史补偿能恢复仍位于最近历史窗口内的消息；
7. 实时消息和补偿消息不会造成重复点歌；
8. 控制/镜像页只打印，不触发命令；真正播放页每条有效点歌弹幕只处理一次；
9. 日志中不出现 token、Cookie、CSRF 等敏感信息；
10. 连续运行 2 小时，无连接泄漏、定时器泄漏、无界缓存增长或重复上游连接。

---

## 12. 推荐实施顺序

建议拆成五次小改动，每次都保持可回退：

1. **只加指标、事件指纹和持续历史对账**，先取得漏消息证据；
2. **建立统一匿名会话**，比较修改前后的缺失率；
3. **引入 `LiveDanmuHub`，改为单房间单上游连接**；
4. **状态化半包解析、host 轮换、token 刷新和历史补偿去重**；
5. **完成自动化测试和 2 小时真实房间灰度**；只有证据确认后再单独实现 ACK。

每一步都只在 `realtime=1` 分支启用。任一步出现异常时，去掉 `realtime=1` 即回到目前正常运行的默认模式，不影响现有点歌台。

# B 站实时弹幕模式：老项目对照、漏收分析与完善方案

本文以仓库内的旧项目 `lib_piliplus` 为事实基准，对照当前 Node + 浏览器实现，回答以下问题：

1. 接收公开直播间的实时弹幕是否必须登录；
2. 旧项目如何取得 token、选择服务器、鉴权、心跳、解压和解析消息；
3. 当前“只能抓到部分弹幕”可能丢在哪一层；
4. 实时弹幕模式应该怎样改造和验收。

本文只讨论普通 B 站直播弹幕协议，不讨论直播开放平台的互动玩法 `gameStart`。

## 实施状态（2026-08-13）

本文的核心修复已经写入代码：

- 新增 `src/services/bili-session.js`，从 B 站 `/x/frontend/finger/spi` 获取并持久化服务器签发的 `buvid3`/`buvid4`，保存 `Set-Cookie`，并让真实房间号、WBI、token、历史与 ACK 复用同一会话；
- `src/services/bili-live-ws.js` 已改为 `LiveDanmuHub -> RoomConnection`，同一真实房间只建立一条 B 站上游连接；
- 浏览器只连接 `/live/ws?room_id=...`，不再取得或透传 token、UID 和任意 host；
- 外层解析已使用连接级 remainder，支持跨 WebSocket message 的半包拼接；
- 保留 `protover: 3`，支持 Zlib/Brotli、多内层包和带后缀的 `DANMU_MSG`；
- 上游会按完整 `host_list` 轮换，以带抖动的指数退避持续重连，并定期刷新 token/host；
- 已加入短断线历史补偿、消息 ID 优先的有界去重、连接指标和 `/live/metrics`；
- 非 debug 模式不再向浏览器发送逐包状态或完整 `raw` 消息；
- operation 7 认证正文已与 2026-08-13 当前官方直播播放器对齐，包含 `buvid`、`support_ack: true`、`queue_uuid` 和 `scene: "room"`；
- 已按官方播放器实现 operation 24 的逐消息 Socket ACK，以及仅对 operation 5 且 `sequence > 1` 的同会话 HTTP `message_ack`。

自动化测试覆盖匿名会话、官方设备签发、完整认证包、两种 ACK、Cookie 规则、半包、Zlib/Brotli、多内层包、共享上游和实时/历史去重。真实联调已在短号房间 `440`（真实房间 `498388`）确认：游客 `uid=0` 取得 4 个 host，operation 8 认证成功；历史接口出现新消息后，同一文本由 WebSocket 实时收到，`commandCountByType.DANMU_MSG` 与 `danmuDecodedCount` 同步增长。

### 2026-08-13 房间 440 故障复盘

故障时的指标非常明确：连接为 `LIVE`、心跳正常、Brotli 解压和内层切包没有错误，但只有 `INTERACT_WORD_V2`、`ONLINE_RANK_COUNT` 等广播事件，`DANMU_MSG=0`。这排除了本地浏览器、房间短号、WebSocket 连通性和解压器。

最终根因是匿名连接虽然收到 operation 8 `code=0`，却没有按当前官方网页建立完整的房间消息会话：

1. 项目使用本地随机生成的 `buvid3`，没有取得 B 站指纹接口签发的 `buvid3`/`buvid4`；
2. 认证包缺少 `buvid`、`support_ack`、`queue_uuid`、`scene`；
3. 初次补字段时把 `scene` 设为空，但官方直播间播放器的实际调用点传的是 `scene: "room"`；
4. 没有实现官方播放器当前存在的 Socket/HTTP ACK 路径；这是需要补齐的兼容性缺口，但本轮成功消息的外层 sequence 为 `0`，未触发 HTTP ACK，所以 ACK 不是房间 440 首条弹幕恢复的直接证据。

operation 8 只表示认证正文被接受，不保证服务端已经把连接加入完整的房间聊天队列。因此验收必须以实际 `DANMU_MSG` 为准，不能以“认证成功”结束。

## 一、结论

### 1. 接收公开弹幕不要求登录

旧项目同时支持游客和登录账号：

- 游客使用 `AnonymousAccount`，WebSocket 鉴权中的 `uid` 为 `0`；
- 登录账号使用所选“观看/心跳账号”的真实 UID；
- 两种模式都必须先调用 `getDanmuInfo` 取得弹幕 token 和 `host_list`；
- 两种模式使用相同的 WebSocket 包格式、Brotli 解压和 `DANMU_MSG` 解析流程。

因此，只接收公开直播间弹幕时，登录不是前置条件。登录主要影响发送弹幕、识别自己的消息、账号权限和个性化信息。

不过，“不登录”不等于“完全无会话”。旧项目的游客账号仍然会：

- 创建长期复用的 CookieJar；
- 自动生成 `buvid3`；
- 尝试激活该设备标识；
- 通过账号拦截器为 HTTP 请求选择并复用 CookieJar；游客模式下各账号槽位默认指向同一个匿名账号；
- 保存 B 站响应中的 `Set-Cookie`。

当前 Node 实现已经补齐这一层，而且不再把随机字符串直接当成最终设备身份：首次匿名启动从 B 站官方指纹接口取得 `b_3`/`b_4`，保存为 `buvid3`/`buvid4`，再用同一 CookieJar 请求 WBI、真实房间号、token、历史和 ACK。

### 2. token 必须有，直播开放平台许可不需要

旧项目调用普通直播接口：

```text
GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo
```

它从响应中取得 `token` 和 `host_list`，然后直连：

```text
wss://<host>:<wss_port>/sub
```

该流程不调用开放平台 `gameStart`，也不依赖互动玩法项目许可。即使游客 `uid=0`，认证正文中的 `key` 仍必须是有效 token。

### 3. 旧项目不是“绝不漏消息”的完整实现

旧项目可以作为协议格式参考，但不能把它当成可靠性设计的完整答案，因为它：

- 只在初次连接时依次尝试 `host_list`，连接断开后不会自动重连；
- 没有断线历史补偿；
- 没有跨连接去重；
- 没有接收数量、解析错误、断线时段等指标；
- 多处 `catch (_) {}` 会静默吞掉解压或 JSON 错误；
- 没有实现当前官方网页已有的消息 ACK；
- 对 `cmd` 使用精确匹配，带后缀的 `DANMU_MSG:...` 可能无法进入分支。

所以完善当前模式时，应保留旧项目已经验证过的协议主链路，同时补上它缺少的连接可靠性和可观测性。

## 二、旧项目的完整接收链路

### 1. 启动与预加载

`lib_piliplus/pages/live_room/controller.dart` 的 `startLiveMsg()` 执行顺序为：

1. 当前消息列表为空时调用 `prefetch()`；
2. `prefetch()` 请求 `gethistory`，只用于填充打开直播间时的最近消息；
3. 如果已有 `dmInfo`，直接建立实时连接；
4. 否则调用 `liveRoomGetDanmakuToken()` 获取 token 和服务器列表；
5. 成功后执行 `initDm()`。

预加载与实时连接是两条不同链路。`gethistory` 只是有限窗口快照，不是实时接口，也不能证明 WebSocket 是否完整。

### 2. HTTP 会话与登录态

`lib_piliplus/utils/accounts/api_type.dart` 把以下接口归到 `AccountType.heartbeat`：

- 直播间信息；
- `getDanmuInfo`；
- `gethistory`；
- 观看心跳等相关接口。

`AccountManager` 在请求前从该接口所属账号的 CookieJar 加载 Cookie，在响应后保存 `Set-Cookie`。直播 token、历史和直播间信息明确使用 heartbeat 账号。WBI key 的 `nav` 请求走默认/main 账号，但 WBI key 本身是公共签名材料；在游客模式下，main 与 heartbeat 默认又是同一个 `AnonymousAccount` 单例。

游客账号的关键属性为：

```text
isLogin = false
mid = 0
csrf = ""
cookieJar = DefaultCookieJar() + buvid3
```

登录账号的关键属性为：

```text
isLogin = true
mid = Cookie 中的 DedeUserID
csrf = Cookie 中的 bili_jct
cookieJar = 登录账号自己的 CookieJar
```

所以旧项目的准确行为是：登录可选，但 token/历史请求所用 heartbeat 会话、WebSocket 鉴权 UID 和所选观看账号保持一致。不能简单概括为“旧项目所有 HTTP 请求永远使用同一个登录账号”。

### 3. 获取 token 和服务器列表

`liveRoomGetDanmakuToken()` 对参数进行 WBI 签名后请求：

```text
GET /xlive/web-room/v1/index/getDanmuInfo

id=<roomId>
web_location=444.8
wts=<timestamp>
w_rid=<signature>
```

成功响应中的核心字段为：

```json
{
  "token": "...",
  "host_list": [
    {
      "host": "...",
      "wss_port": 443
    }
  ]
}
```

当前项目在这一步之前还调用 `getH5InfoByRoom` 解析真实房间号，这是合理的保护措施。房间中心、token、历史审计和去重都应该以真实房间号为键。

### 4. 连接服务器

旧项目把 `host_list` 转成：

```text
wss://<host>:<wss_port>/sub
```

然后按列表顺序尝试连接，某个地址连接成功后立即使用。注意：这只是“初次连接失败时换下一个地址”，不是运行中的自动重连。

### 5. 认证包

连接成功后，旧项目发送 operation `7` 的认证包。外层为 16 字节大端序包头：

| 偏移 | 长度 | 内容 |
| --- | ---: | --- |
| 0 | 4 | 包总长度 |
| 4 | 2 | 包头长度，通常为 16 |
| 6 | 2 | 外层协议版本，认证包为 1 |
| 8 | 4 | operation，认证为 7 |
| 12 | 4 | 包序号，旧项目认证包为 1 |

认证正文为 UTF-8 JSON：

```json
{
  "roomid": 真实房间号,
  "uid": 0,
  "protover": 3,
  "platform": "web",
  "type": 2,
  "key": "getDanmuInfo 返回的 token"
}
```

登录时只把 `uid` 换成该账号真实 UID；包结构不变。

这只是旧项目的正文。2026-08-13 当前官方网页还会发送：

```json
{
  "buvid": "当前 CookieJar 中由 B 站签发的 buvid3",
  "support_ack": true,
  "queue_uuid": "8 位连接队列标识",
  "scene": "room"
}
```

其中底层 WebSocket 库的 `scene` 默认可以为空，但直播间播放器实际以 `scene: "room"` 初始化；必须看调用点，不能照抄底层默认值。房间 440 的 A/B 实测表明，只得到 operation 8 而缺少这套完整会话语义时，会出现“广播事件持续到达、普通聊天弹幕不下发”。

### 6. 认证响应与心跳

收到 operation `8` 后，旧项目认为认证成功，并启动每 30 秒一次的 operation `2` 心跳。operation `3` 是心跳响应/人气值，旧项目直接忽略。

当前 Node 代理在认证成功后先立即发一次心跳，再每 30 秒发送一次。这个差异本身不是已确认的漏弹幕原因。

### 7. 解压、内层切包和 JSON

收到 operation `5` 后，根据包头 `protocolVer` 处理：

- `0` 或 `1`：正文直接解析；
- `2`：Zlib 解压；
- `3`：Brotli 解压。

Brotli/Zlib 解压结果通常仍由多个带 16 字节包头的内层包组成。旧项目的 `_processingData()` 会按 `totalSize` 递归处理同一缓冲区中的后续包，不会只取第一个内层消息。

当前 Node 代理已经支持 Zlib、Brotli 和多个内层包，这部分总体方向与旧项目一致。`protover: 3` 也是旧项目实际使用的值，不应把协议降为 `2` 当作首选修复。

### 8. 提取普通弹幕

旧项目只处理 `cmd == "DANMU_MSG"`，正文来自 `info[1]`。新版结构中的用户信息来自：

```text
info[0][15].user.uid
info[0][15].user.base.name
```

旧结构可从 `info[2]` 回退读取 UID 和用户名。当前 Node 实现还能把 `DANMU_MSG:4:...` 等带后缀命令归一化为 `DANMU_MSG`，这一点比旧项目更稳健。

游客连接会得到降级或打码的用户字段。房间 440 的实测消息中，真实 `uid` 为 `0`、昵称被打码，但 `extra.user_hash` 稳定存在。当前实现用该 hash 生成负数伪 UID，避免所有匿名用户共享同一个点歌限额；这不是 B 站真实 UID。用户名/UID 降级不等于整条弹幕没有收到，诊断时必须按消息 ID、文本和时间判断。

## 三、当前实现与旧项目的关键差异

| 项目 | 旧项目 `lib_piliplus` | 当前实现 | 判断 |
| --- | --- | --- | --- |
| 登录 | 游客或登录均可 | 默认游客 `uid=0`，也支持服务端环境变量登录会话 | 登录不是硬要求 |
| 匿名会话 | CookieJar + 本地生成 `buvid3` + Set-Cookie | 官方 SPI 签发 `buvid3`/`buvid4`，持久化并复用 CookieJar | 已补齐并适配当前网页 |
| token | 同一账号会话获取 | Node 同会话获取，浏览器不可见 | 已修复 |
| host | 初次连接按列表逐个尝试 | Node 按完整列表轮换并定期刷新 | 已增强 |
| 上游连接数 | 一个直播页面一条 | 一个真实房间一条，多个本地订阅者共享 | 已修复 |
| 压缩 | Zlib + Brotli | Zlib + Brotli | 已基本一致 |
| 多内层包 | 支持 | 支持 | 已基本一致 |
| `cmd` 后缀 | 不支持 | 支持 | 当前更好 |
| 外层半包余量 | 不保存 | 连接级保存，16 MiB 上限并报告余量 | 已修复 |
| 重连 | 无 | 持续退避、host 轮换和 token 刷新 | 已增强 |
| 断线补偿 | 无 | 最近历史补偿并与实时流统一去重 | 已实现 |
| 错误可见性 | 大量静默 catch | 结构化指标、连接 ID 和 metrics 接口 | 已实现 |
| 完整认证 | 旧字段，无 `scene`/ACK 能力声明 | `buvid`、`support_ack`、`queue_uuid`、`scene: room` | 已按当前官方网页补齐 |
| ACK | 无 | operation 24 Socket ACK + sequence>1 HTTP ACK | 已按当前官方网页实现 |

## 四、“只能收到部分弹幕”的修复前风险与处理结果

下面列出修复前从仓库代码确认的风险。它们已按本轮实现处理，但各自对线上漏收率的贡献仍需要编号弹幕灰度数据衡量。

### P0：没有办法定位消息在哪一层消失——已补指标

修复前没有以下分层计数：

```text
B站上游包
  -> 解压后的内层事件
  -> DANMU_MSG
  -> 标准化弹幕
  -> 发给浏览器
  -> 浏览器收到
  -> 点歌命令执行
```

现在 `RoomConnection` 已记录上游消息、外层包、内层包、cmd 分布、解码弹幕、代理发送、解析错误和 remainder；浏览器继续记录收到与命令分发。`/live/metrics?room_id=...` 可查看后端汇总。

### P0：匿名 HTTP 会话不连续——已修复

修复前的 WBI key、真实房间号、token 和历史请求没有共享 CookieJar，也没有稳定 `buvid3`。现在统一由 `BiliSession` 执行。

修复没有强制用户登录。默认使用稳定游客会话；登录只能通过服务端 `BILIBILI_COOKIE` 环境变量可选启用，不能把 Cookie 放进 URL、浏览器 localStorage 或普通日志。

### P0：每个本地页面都会创建一条独立 B 站上游连接——已修复

修复前的 `createLiveProxy()` 会为每个浏览器 WebSocket 新建一条 B 站 WebSocket。现在 `LiveDanmuHub` 用真实房间号复用一个 `RoomConnection`，多个页面只作为 subscribers。

Node 会把同一份标准化事件广播给所有本地订阅者；调试/控制页仍由 `processCommands: false` 保证只读。

### P0：解析器返回的未完整数据被调用方丢弃——已修复

修复前 `parseMessages()` 已返回 `remainder`，但调用方没有保存。现在 `StatefulDanmuDecoder` 按连接拼接并保存余量。

Node 的 `ws` 会重组同一个 WebSocket message 的底层网络分片，但不会把两个独立 WebSocket message 自动拼成一个 B 站协议包。连接级缓冲已有 16 MiB 上限，并通过 `remainderBytes` 监控。

### P1：断线与解码失败没有可靠恢复——已增强

修复前浏览器最多重连 3 次，上游断线期间没有补偿。现在上游由 Node 持续恢复，本地浏览器不会因为 B 站节点切换而被关闭。

节点轮换、退避和 token 刷新现在都属于 `RoomConnection`；短断线认证恢复后会进行一次有限历史补偿。

### P1：调试状态消息在非 debug 模式也会发给浏览器——已修复

修复前服务端逐包状态会无条件发送给浏览器，弹幕还携带完整 `raw` 对象。现在生产模式只发送必要连接状态与标准化弹幕，metrics 仅对 debug subscriber 每 10 秒汇总一次。

这样减少了 Node 序列化、本地 WebSocket 和浏览器主线程负载，同时避免把原始消息中的无关信息扩散到浏览器。

### P1：重连后没有历史补偿和统一去重——已修复

`gethistory` 仍只能返回最近少量消息，不能替代实时流。现在重连认证后会按时间排序补发最近历史，并使用消息 ID 优先、有界 TTL 的同一去重器避免重复点歌。

### P0：当前官方消息会话字段与 ACK——已实现

当前官方播放器代码已确认两类回执：

1. `onReceivedMessage(messages, sequence)` 在 `sequence > 1` 时 POST `/xlive/open-interface/v1/dm/message_ack`，正文为 `terminal=0&sequence=<sequence>`；
2. 单条消息含 `msg_id` 且 `p_is_ack` 时，向 WebSocket 发送 operation 24，正文包含 `msg_id`、`cmd` 和 `p_msg_type`。

当前实现只对 operation 5 的外层消息序号安排 HTTP ACK，不会把认证包或心跳包序号误当作消息序号；ACK 异步执行，不阻塞解压和分发。指标分别记录尝试、成功、失败、最后回执序号和 Socket ACK 数量。房间 440 本轮收到的普通弹幕外层 sequence 为 `0`，因此没有触发 HTTP ACK，这是符合条件的，不是错误。

## 五、已实现架构

```text
浏览器/OBS
  -> 本地 /live/ws?room_id=<房间号>
  -> LiveDanmuHub
       -> Map<真实房间号, RoomConnection>
            -> BiliSession（游客默认，登录可选）
            -> 唯一 B 站上游 WebSocket
            -> 状态化二进制解码器
            -> 标准化 + 有界去重
            -> 断线恢复 + host 轮换
            -> subscribers（播放页、控制页、调试页）
```

浏览器只提供房间号和本地角色，不再提供 token、Cookie、UID 或任意上游 host。

### 1. `BiliSession`

新增后端会话服务，职责为：

- 默认创建游客会话：`uid=0`、B 站 SPI 签发并稳定复用的 `buvid3`/`buvid4`、CookieJar；旧缓存只有本地随机 `buvid3` 时会自动迁移；
- 保存 B 站的 `Set-Cookie`；
- 使用同一会话执行 WBI key、真实房间号、`getDanmuInfo`、历史审计和 ACK；
- 登录模式下校验 Cookie 中 UID 与 WebSocket 鉴权 UID 一致；
- 日志只记录 `sessionMode`、`uid`、`hasBuvid3`，绝不输出 Cookie、token 或 CSRF。

登录模式只是可选增强。仅接收公开弹幕时，游客模式必须能够独立工作和通过验收。

### 2. `RoomConnection`

每个真实房间只有一个连接对象，状态至少包括：

```text
IDLE -> CONNECTING -> AUTHENTICATING -> LIVE -> BACKOFF -> CONNECTING
                                             -> CLOSED
```

要求：

- 按 `host_list` 轮换地址，并设置连接/认证超时；
- operation `8` 后进入 `LIVE`；
- 每 30 秒发送心跳；
- 记录最后收到上游消息、心跳响应和普通弹幕的时间；
- 上游关闭、超时或连续解码失败时自动重连；
- 使用带抖动的有限指数退避，只要仍有订阅者就持续恢复；
- 鉴权失败或 token 可能过期时重新取得 token 和 host 列表；
- 最后一个订阅者离开后延迟 30～60 秒关闭，避免刷新页面造成频繁重连。

### 3. 状态化解码器

每条上游连接保存独立的 `outerRemainder`：

```js
outerRemainder = Buffer.concat([outerRemainder, incoming])
outerRemainder = parseMessages(outerRemainder, onPacket)
```

解压后的数据同样严格按 16 字节包头切包。只有明确检测到直接 JSON 时才使用 JSON 流解析器作为兼容分支。

安全限制：

- 单包和 remainder 设置 16 MiB 上限；
- 非法包头、解压失败、JSON 失败都必须计数；
- 日志只保存长度、协议版本、operation、sequence 和短十六进制摘要；
- 不允许空 `catch`；
- 连续错误达到阈值时切换 host 并重建连接。

### 4. 标准化事件与去重

标准化事件至少保留：

```js
{
  roomId,
  uid,
  uname,
  danmu,
  messageId,
  sentAt,
  receivedAt,
  source,       // websocket | history-recovery
  connectionId
}
```

去重键优先使用 B 站原始 `id_str`/消息 ID；没有 ID 时才组合 UID、时间、文本和原始随机字段。去重缓存必须有 TTL 和条数上限，避免误杀用户连续发送的相同点歌指令，也避免长时间运行内存增长。

### 5. 断线补偿

鉴权恢复后请求一次最近历史：

1. 读取最近历史窗口；
2. 与最近实时消息 ID 集合对比；
3. 只补发未见过的消息；
4. 标记 `source: history-recovery`；
5. 实时和补偿消息经过同一个去重器后再进入点歌层。

历史窗口很小，所以只能补偿短断线，不能承诺恢复长时间断线或极高弹幕量期间的全部消息。

## 六、诊断指标

每个 `RoomConnection` 维护：

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
  danmuDecodedCount,
  proxySentCount,
  parseErrorCount,
  decompressErrorCount,
  remainderBytes,
  lastProtocolSequence,
  lastMessageSequence,
  lastAckedSequence,
  httpAckAttemptCount,
  httpAckSuccessCount,
  httpAckFailureCount,
  socketAckCount,
  lastDanmuAt
}
```

每 10 秒最多打印一条汇总。逐包日志只在 debug 下采样，不能无条件推送给浏览器。

每条弹幕生成诊断指纹，并在以下节点记录：

```text
decoded -> normalized -> proxy-sent -> browser-received -> command-dispatched
```

这样才能回答“部分弹幕”具体丢在代理解析、本地传输还是点歌命令层。

## 七、实施顺序（已完成核心阶段）

### 第一阶段：只加证据，不改变点歌语义

- 增加分层计数、连接 ID、cmd 分布和错误计数；
- 保存并报告 `remainderBytes`；
- 生产模式停止发送逐包状态和完整 `raw`；
- debug 模式持续做历史审计，但历史消息不触发点歌；
- 用编号弹幕取得修改前基线。

### 第二阶段：补齐旧项目已有的会话语义

- 实现稳定游客 `BiliSession`；
- WBI、真实房间号、token 和历史共用 CookieJar；
- token 与 host 只保留在 Node；
- 浏览器只传房间号。

### 第三阶段：连接可靠性

- 一房间一条上游连接；
- 状态化半包缓冲；
- 全 host 轮换、持续重连、token 刷新；
- 短断线历史补偿和统一去重。

### 第四阶段：对齐当前官方房间会话——已完成

- 使用服务器签发的匿名设备身份，不再依赖本地伪造值；
- 认证包声明 `support_ack`、队列标识与 `scene: room`；
- 实现同会话 HTTP ACK 和 operation 24 Socket ACK；
- 游客模式已在房间 440 实际收到与历史新增一致的 `DANMU_MSG`，无需把登录设为前置条件。

## 八、测试与验收

### 1. 单元测试

- 一个输入含多个完整外层包；
- 一个协议包拆成 2～3 次输入，最终只解析一次且不丢；
- 完整包后跟半包，下次输入后正确拼接；
- Brotli/Zlib 解压后含多个内层包；
- `DANMU_MSG` 与各种带后缀变体；
- 新旧用户字段、游客降级用户字段；
- 非弹幕 cmd 只统计、不转发；
- 非法长度、超大 remainder 和解压错误不会使进程崩溃；
- 实时与历史补偿的重复消息只进入点歌一次；
- 两个本地订阅者只创建一个 B 站上游连接。

### 2. 真实房间测试

使用两个测试账号交替发送：

```text
测试001
测试002
...
测试100
```

同时保存：

- B 站官方页面显示的编号；
- Node 解码到的 `DANMU_MSG` 编号；
- Node 发给本地浏览器的编号；
- 浏览器收到的编号；
- 命令层处理的编号；
- 连接、重连、解析错误和 remainder 指标。

官方页面和 `gethistory` 都只能作为外部对照，不是协议层全量日志。只有编号消息在每一层的指纹记录，才能准确定位本项目内部丢失。

### 3. 完成标准

满足以下条件后，才认为实时弹幕模式完善完成：

1. 游客模式无需登录即可稳定认证并接收公开弹幕；
2. 同一房间无论打开几个本地页面，Node 到 B 站只有一条上游连接；
3. 100 条编号测试中，健康连接期间解码层无无法解释的缺号；
4. `parseErrorCount=0`，`remainderBytes` 不持续增长；
5. 模拟半包不会丢消息；
6. 模拟短断线后，仍在历史窗口中的消息可以补偿；
7. 实时与补偿消息不会重复点歌；
8. 控制/调试页只观察，真正播放页每条有效命令只执行一次；
9. 日志和本地 WebSocket URL 中没有 token、Cookie、CSRF；
10. 连续运行 2 小时无连接、定时器、订阅者或缓存泄漏。

## 九、源码证据索引

旧项目：

- `lib_piliplus/tcp/live.dart`：认证包、服务器选择、心跳、Zlib/Brotli 和内层切包；
- `lib_piliplus/pages/live_room/controller.dart`：预加载、token 获取、`initDm()` 和 `DANMU_MSG` 消费；
- `lib_piliplus/http/live.dart`：`gethistory` 与 `getDanmuInfo` 请求；
- `lib_piliplus/utils/accounts/account.dart`：游客 `uid=0`、CookieJar 和 `buvid3`；
- `lib_piliplus/utils/accounts/account_manager/account_mgr.dart`：按账号附加 Cookie、保存 `Set-Cookie`；
- `lib_piliplus/utils/accounts/api_type.dart`：直播 token/历史请求使用 heartbeat 账号。

当前项目：

- `src/services/bili-session.js`：匿名/登录会话、CookieJar、WBI、真实房间号、token 和历史请求；
- `src/services/bili-live-ws.js`：共享房间中心、Node 到 B 站的 WebSocket、状态化解码、重连、补偿、去重和指标；
- `src/routers/bili-router.js`：非敏感弹幕信息、历史和 metrics 路由；
- `src/public/services/danmuServers/bilibili-server.js`：实时/历史模式选择和本地共享流订阅；
- `src/public/main.js`、`src/public/components/danmu-configer.js`：播放页命令消费与调试页只读隔离。

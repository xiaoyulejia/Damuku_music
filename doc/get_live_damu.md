# B 站直播间实时弹幕获取与本项目接入方案

> 历史设计说明：本文保留协议研究过程。实时模式已经按服务端会话和单房间共享连接方案实现，当前代码与验收方式以 [`live_danmu_realtime_mode.md`](./live_danmu_realtime_mode.md) 为准。

## 1. 结论

`lib_piliplus` 获取实时直播弹幕的方式是：

1. 用 HTTP 接口取得直播间的真实房间号、弹幕鉴权 token 和可用弹幕服务器列表。
2. 连接 `wss://<host>:<wss_port>/sub`。
3. 发送 B 站 16 字节包头格式的认证包，认证正文包含房间号、用户 UID、协议版本和 token。
4. 认证成功后，每 30 秒发送一次心跳包。
5. 持续接收 WebSocket 二进制数据，按包头切包，对 Zlib/Brotli 数据解压，再解析 JSON 事件。
6. 从 `DANMU_MSG` 事件中提取用户 ID、用户名和弹幕正文。

这套“普通直播协议”不依赖 B 站直播开放平台的 `gameStart`，因此游客也能收公开直播间弹幕。登录状态不是“能否接收”的前提：游客认证时 `uid=0`，登录时使用账号 UID；HTTP 请求会分别携带匿名或登录账号的 Cookie，但后续 WebSocket 包格式相同。

当前项目已经实现了这条链路的大部分代码，但为避免影响目前稳定运行的默认模式，页面仍默认每 3 秒轮询 `gethistory`，只有 URL 显式带 `realtime=1` 时才启用 WebSocket。实时模式应先在这个开关下完成测试和验收，确认稳定后再另行决定是否调整默认值。

本轮已经在该隔离开关下完成以下实现：二进制包长校验、多包及半包边界处理、Zlib/Brotli 内层包解析、`DANMU_MSG` 新旧字段兼容、认证成功后立即心跳、重复关闭保护和浏览器端单一重连定时器。默认历史轮询流程没有改动。

使用 `realtime=1&debug=1` 时，浏览器开发者工具控制台会用 `[BilibiliDanmu][WebSocket实时弹幕]` 前缀逐条打印 WebSocket 收到的实时弹幕；Node 服务终端同时会出现 `[BilibiliDanmu][proxy] DANMU_MSG`。这两个固定前缀可用于确认当前点歌消息来自实时 WebSocket，而不是默认的历史轮询。

如果页面同时使用 `livemode=false`，它属于镜像/控制页，正常情况下不会负责接收弹幕。为了方便测试，`livemode=false&realtime=1&debug=1` 会建立一条只读诊断 WebSocket：控制台打印实时弹幕，但不把消息交给点歌命令处理，避免与 OBS 播放页重复点歌。

---

## 2. `lib_piliplus` 中的完整调用链

### 2.1 页面何时启动弹幕连接

直播间控制器在播放器开始播放时调用 `startLiveMsg()`：

- `lib_piliplus/pages/live_room/view.dart:129-139`
- `lib_piliplus/pages/live_room/view.dart:161-165`
- `lib_piliplus/pages/live_room/controller.dart:418-437`

`startLiveMsg()` 做三件事：

1. 消息列表为空时调用 `prefetch()`，通过历史弹幕接口填充初始列表。
2. 如果已经有连接，则不重复创建。
3. 调用 `liveRoomGetDanmakuToken()` 获取 token 和服务器列表，然后调用 `initDm()` 建立实时连接。

历史弹幕与实时弹幕用途不同：

- `gethistory` 只是一小段最近记录，不是真正的实时流。
- WebSocket 才是后续持续推送的新事件。

### 2.2 短房间号必须转换为真实房间号

用户访问直播间时传入的可能是短号。PiliPlus 先调用直播间信息接口：

```text
GET https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo
```

成功后用响应里的 `room_id` 覆盖原来的房间号，见：

- `lib_piliplus/http/live.dart:80-111`
- `lib_piliplus/pages/live_room/controller.dart:211-230`

后续申请 token、历史弹幕和 WebSocket 认证都应该使用真实房间号。若直接拿短号认证，有些房间会收不到数据或鉴权失败。

当前项目的 `resolveRoomId()` 已通过 `getH5InfoByRoom` 完成同类转换，见 `src/routers/bili-router.js:850-864`，可以保留。

### 2.3 取得 token 和服务器列表

PiliPlus 使用：

```text
GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo
```

参数为：

```text
id=<真实房间号>
web_location=444.8
wts=<Unix 秒时间戳>
w_rid=<WBI 签名>
```

相关代码：

- 接口定义：`lib_piliplus/http/api.dart:329-331`
- 发起请求：`lib_piliplus/http/live.dart:148-169`
- WBI 签名：`lib_piliplus/utils/wbi_sign.dart`
- 返回模型：`lib_piliplus/models_new/live/live_dm_info/data.dart`
- 服务器模型：`lib_piliplus/models_new/live/live_dm_info/host_list.dart`

核心返回结构是：

```json
{
  "code": 0,
  "data": {
    "token": "弹幕认证 token",
    "host_list": [
      {
        "host": "broadcastlv.chat.bilibili.com",
        "port": 2243,
        "ws_port": 2244,
        "wss_port": 443
      }
    ]
  }
}
```

PiliPlus 将列表转换为：

```text
wss://<host>:<wss_port>/sub
```

并在连接失败时依次尝试下一个节点，见 `lib_piliplus/pages/live_room/controller.dart:492-505` 和 `lib_piliplus/tcp/live.dart:182-194`。

### 2.4 登录和未登录为什么都能接收

PiliPlus 的账号抽象包含两种状态：

- 登录账号：`LoginAccount.mid` 为真实 UID，并由 CookieJar 附带登录 Cookie。
- 游客账号：`AnonymousAccount.mid = 0`，仍会生成并保存匿名 `buvid3`。

相关代码位于：

- `lib_piliplus/utils/accounts/account.dart`
- `lib_piliplus/utils/accounts/account_manager/account_mgr.dart:45-105`
- `lib_piliplus/utils/accounts/account_manager/account_mgr.dart:230-237`

实时连接使用的是 `Accounts.heartbeat.mid`：

```dart
uid: Accounts.heartbeat.mid
```

因此：

| 模式 | HTTP Cookie | WebSocket 认证 `uid` | 能否收公开弹幕 |
|---|---|---:|---|
| 游客 | 匿名 Cookie，含生成的 `buvid3` | `0` | 可以 |
| 登录 | 账号 Cookie | 账号 UID | 可以 |

登录主要影响身份相关功能，例如识别自己发送的弹幕、发送弹幕、关注/历史等；接收公开直播间消息不要求登录。token 仍然必须从 `getDanmuInfo` 获取，不能因为 `uid=0` 就省略。

### 2.5 WebSocket 认证包

所有数据包使用 16 字节、大端序包头，定义在 `lib_piliplus/tcp/live.dart:10-34`：

| 偏移 | 长度 | 含义 |
|---:|---:|---|
| 0 | 4 | 整包长度 `packetLen` |
| 4 | 2 | 包头长度，固定 `16` |
| 6 | 2 | 协议版本 `protover` |
| 8 | 4 | 操作码 `operation` |
| 12 | 4 | 序列号 `sequence` |

建立连接后发送操作码 `7` 的认证包。PiliPlus 的认证正文为：

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

字段说明：

- `roomid`：必须使用真实房间号。
- `uid`：游客为 `0`，登录时可为账号 UID。
- `protover: 3`：要求服务端发送 Brotli 压缩消息。
- `key`：弹幕 token。
- 认证包包头本身使用 `protocolVer=1`、`operation=7`、`seq=1`。

认证成功响应的操作码是 `8`。

### 2.6 心跳

收到操作码 `8` 后，PiliPlus 每 30 秒发送一次操作码 `2` 的空正文心跳包，见 `lib_piliplus/tcp/live.dart:224-250`。

常用操作码：

| 操作码 | 含义 | 本项目动作 |
|---:|---|---|
| 2 | 客户端心跳 | 每 30 秒发送 |
| 3 | 心跳响应/人气值 | 可记录，不作为弹幕处理 |
| 5 | 业务消息 | 解压并解析 JSON |
| 7 | 客户端认证 | 建连后立即发送 |
| 8 | 认证成功 | 启动心跳，标记连接可用 |

建议建立连接后立即发送一次心跳，再启动 30 秒定时器。PiliPlus 是收到认证成功后才启动定时器，第一次定时发送会晚约 30 秒；通常可用，但立即心跳更利于快速确认链路健康。

### 2.7 解压、切包和 JSON 解析

PiliPlus 在 `lib_piliplus/tcp/live.dart:252-291` 按协议版本处理：

- `0`、`1`：正文是未压缩数据。
- `2`：Zlib 解压。
- `3`：Brotli 解压。

解压后的内容通常不是单个 JSON，而是一个或多个完整的 B 站二进制包。因此必须：

1. 读取当前包头的 `packetLen`。
2. 从 `headerLen` 到 `packetLen` 取正文。
3. 处理完后按 `packetLen` 移动游标。
4. 若缓冲区还有数据，继续解析下一包。
5. 解压后的缓冲区也按相同规则递归/循环解析。

不要仅按字符串 `}{` 拆 JSON；JSON 字符串内容本身可能出现类似字符。以二进制包长切包才是可靠边界。

PiliPlus 的 `_processingData()` 会根据 `totalSize` 递归处理同一缓冲区中的剩余包，见 `lib_piliplus/tcp/live.dart:199-222`。

### 2.8 提取普通弹幕

业务消息是 JSON，`cmd` 可能带后缀，因此建议用：

```js
String(message.cmd || '').split(':', 1)[0] === 'DANMU_MSG'
```

PiliPlus 当前匹配 `DANMU_MSG`，随后主要读取：

```text
info[1]                         弹幕正文
info[0][15].user.uid            新版结构中的用户 UID
info[0][15].user.base.name      新版结构中的用户名
info[2][0] / info[2][1]         旧版结构的 UID / 用户名（兼容回退）
info[0][15].extra               颜色、模式、弹幕 ID、回复信息、表情等 JSON
```

解析实现见 `lib_piliplus/pages/live_room/controller.dart:523-585`。

本项目点歌逻辑所需的最小标准化对象为：

```json
{
  "uid": 123456,
  "uname": "用户名",
  "danmu": "点歌 歌名",
  "roomId": 987654,
  "receivedAt": 1786500000000
}
```

建议额外保留 `raw` 仅供调试，并且不要默认写入长期日志。

---

## 3. 当前项目现状与问题

### 3.1 已经具备的部分

当前项目不是从零开始，以下实现已经存在：

- `src/routers/bili-router.js:850-902`
  - 短房间号转真实房间号。
  - WBI 签名请求 `getDanmuInfo`。
  - 历史弹幕代理接口。
- `src/services/bili-live-ws.js`
  - Node 连接 B 站上游 WSS。
  - 发送认证包和心跳包。
  - Zlib/Brotli 解压。
  - 解析内层多包。
  - 将普通弹幕转换成 JSON 发给浏览器。
- `app.js:140-155`
  - 在现有 HTTP Server 上挂载 WebSocket upgrade。
- `src/public/services/danmuServers/bilibili-server.js`
  - 请求弹幕 token。
  - 连接本项目的 WebSocket 代理。
  - 把 `{uid, uname, danmu}` 交给原点歌回调。

整体方向与 PiliPlus 一致，服务端代理也解决了浏览器跨域、Brotli 支持差异和上游协议暴露问题。

### 3.2 当前最主要的问题

#### 问题 A：默认不是实时弹幕

`bilibili-server.js` 当前逻辑为：

```js
const realtime = URL 中是否有 realtime=1;
this.historyOnly = !realtime || URL 中是否有 history=1;
```

所以普通地址默认启动 `startHistoryConsole()`，每 3 秒请求一次 `gethistory`。这会带来：

- 最高约 3 秒延迟。
- 历史接口只返回有限条记录，高峰时可能漏弹幕。
- 需要自己去重，且消息顺序/重复判断不可靠。
- 增加 HTTP 请求频率，不能替代推送流。

当前实施阶段不改变这个默认行为：继续仅在 `realtime=1` 时进入 WebSocket，用它隔离测试实时链路。等测试结论明确后，再单独评估是否切换默认值。

#### 问题 B：token 放在浏览器 WebSocket URL 查询参数

当前浏览器连接类似：

```text
/live/ws?room_id=...&uid=0&token=...&host=...
```

查询参数可能进入反向代理 access log、浏览器调试记录或错误日志。弹幕 token 虽然是短期凭据，仍不应无必要暴露。

推荐让 Node 服务端自己调用 `getDanmuInfo` 并连接 B 站，浏览器只传 `room_id`：

```text
/live/ws?room_id=123456
```

服务端内部解析真实房间号、申请 token 和选择 host。更进一步，可让服务端常驻每房间一条连接，浏览器只订阅标准化事件。

#### 问题 C：连接生命周期和重连状态较弱

当前浏览器 `onerror` 和 `onclose` 都会调用重连，单次故障可能安排两个重连任务；`connect()` 又调用 `close()`，重连计数与关闭状态容易互相影响。

推荐统一状态机：

```text
idle -> connecting -> authenticating -> connected -> backoff -> connecting
                                      -> closing -> closed
```

同一时刻只允许一个连接 Promise 和一个重连 Timer。

#### 问题 D：服务端没有按房间复用上游连接

目前每打开一个浏览器页面就创建一条 B 站上游 WSS。OBS 页、控制页和调试页同时打开时会重复连接、重复收包。

建议以真实房间号作为 key 建立 `RoomDanmuHub`：

- 每个房间最多一条上游连接。
- 多个浏览器客户端订阅同一事件流。
- 最后一个客户端离开后延迟 30～60 秒关闭上游，避免刷新页面导致频繁重连。
- OBS/主播放页可以作为主要订阅者，控制页只需按业务需求订阅。

#### 问题 E：WBI key 每次请求都重新获取

当前 `getWbiMixinKey()` 每次都请求 `/x/web-interface/nav`。PiliPlus 会缓存 mixin key。建议在 Node 内存中按自然日或较短 TTL（例如 6 小时）缓存，并在签名失败时清缓存重试一次。

#### 问题 F：解析容错与观测需要明确

建议补充：

- 校验 `packetLen >= headerLen >= 16` 和最大包长。
- 不完整帧应缓存到下一次数据到达，而不是静默丢弃。虽然 `ws` 通常交付完整 message，但解析器应能独立处理分片缓冲。
- 解压失败、认证失败、服务端关闭码、所选 host、重连次数采用结构化日志。
- token、Cookie 和完整认证正文禁止写日志。
- 解析 `cmd` 时兼容 `DANMU_MSG:*`。

---

## 4. 推荐架构

```text
浏览器/OBS 页面
    |
    | ws(s)://本项目/.../live/ws?room_id=<用户输入房间号>
    v
Node RoomDanmuHub（每个真实房间一条上游连接）
    |
    | 1. 解析真实房间号
    | 2. 取得并短期缓存 token + host_list
    | 3. WSS 认证、心跳、解压、切包、重连
    v
B 站普通直播弹幕服务器

Node -> 浏览器只发送标准 JSON：
{ type: "danmu", data: { uid, uname, danmu, roomId, receivedAt } }
```

把协议实现放在 Node 端的原因：

- 本项目已经有 Node 服务和 `ws`、`zlib` 依赖。
- Node 原生支持 Brotli，浏览器不需要额外解压库。
- token 不必交给浏览器。
- 多页面可以共享一条上游连接。
- 后续可在服务端统一做去重、限流、日志和测试。

---

## 5. 具体改造方案

### 5.1 新建独立协议模块

建议新增：

```text
src/services/bili-live/
  packet.js          负责编码包头、遍历二进制包
  api.js             真实房间号、WBI key、getDanmuInfo
  parser.js          解压和业务事件标准化
  connection.js      单条 B 站上游连接、认证、心跳、重连
  hub.js             按 roomId 复用连接并管理浏览器订阅者
```

现有 `src/services/bili-live-ws.js` 可先拆分再替换，不必一次重写全部业务。

### 5.2 服务端连接流程

`connection.js` 的建议流程：

```js
async function connect(inputRoomId) {
  const roomId = await resolveRoomId(inputRoomId);
  const { token, host_list: hosts } = await getDanmuInfo(roomId);

  for (const host of rotateHosts(hosts)) {
    try {
      const socket = await openWithTimeout(
        `wss://${host.host}:${host.wss_port}/sub`,
        10_000
      );
      sendAuth(socket, {
        roomid: roomId,
        uid: 0,
        protover: 3,
        platform: 'web',
        type: 2,
        key: token
      });
      await waitForAuthReply(socket, 10_000);
      sendHeartbeat(socket);
      startHeartbeat(socket, 30_000);
      return socket;
    } catch (error) {
      // 记录 host 和错误类型，但不记录 token
    }
  }
  throw new Error('所有弹幕服务器均连接失败');
}
```

重连建议：

- 第 1、2、3、4、5 次分别等待约 1、2、4、8、15 秒，并加入 0～30% 随机抖动。
- 上限保持 30 秒，不要 3 次后永久停止。
- 正常收到业务消息一段时间后清零失败计数。
- token 可能过期，重连时重新请求 `getDanmuInfo`，不要无限复用旧 token。
- 当前 host 失败后先尝试 `host_list` 的其他节点。

### 5.3 二进制解析器

解析器只依赖 `Buffer` 和 Node `zlib`：

```js
function parsePacketStream(buffer, onPacket) {
  let offset = 0;
  while (offset + 16 <= buffer.length) {
    const packetLen = buffer.readUInt32BE(offset);
    const headerLen = buffer.readUInt16BE(offset + 4);
    if (headerLen < 16 || packetLen < headerLen) throw new Error('非法弹幕包头');
    if (offset + packetLen > buffer.length) break;

    onPacket({
      version: buffer.readUInt16BE(offset + 6),
      operation: buffer.readUInt32BE(offset + 8),
      sequence: buffer.readUInt32BE(offset + 12),
      body: buffer.subarray(offset + headerLen, offset + packetLen)
    });
    offset += packetLen;
  }
  return buffer.subarray(offset); // 留给下一次拼接
}
```

对于操作码 `5`：

```text
version 0/1 -> body 直接按 UTF-8 JSON 解析
version 2   -> inflateSync(body)，然后重新走 parsePacketStream
version 3   -> brotliDecompressSync(body)，然后重新走 parsePacketStream
```

解压后的数据必须先尝试按二进制内层包解析，不建议把“是否以 `{` 开头”作为主要协议分支。可以保留纯 JSON 回退，仅作为兼容策略并配套测试。

### 5.4 事件标准化

```js
function normalizeDanmu(message, roomId) {
  const command = String(message?.cmd || '').split(':')[0];
  if (command !== 'DANMU_MSG') return null;

  const info = message.info || [];
  const structuredUser = info[0]?.[15]?.user;
  return {
    uid: Number(structuredUser?.uid ?? info[2]?.[0] ?? 0),
    uname: String(structuredUser?.base?.name ?? info[2]?.[1] ?? '用户'),
    danmu: String(info[1] ?? ''),
    roomId,
    receivedAt: Date.now()
  };
}
```

若后续要支持醒目留言、礼物或进入房间事件，可在同一解析层增加：

- `SUPER_CHAT_MESSAGE`
- `SEND_GIFT`
- `INTERACT_WORD`
- `GUARD_BUY`
- `ROOM_CHANGE`

但点歌第一阶段只处理 `DANMU_MSG`，避免把礼物文案误判为点歌命令。

### 5.5 浏览器协议

浏览器不再获取 token，也不处理 B 站二进制协议：

```js
const ws = new WebSocket(`${proxyBase}/live/ws?room_id=${roomId}`);

ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.type === 'danmu') this.danmuMessage?.(message.data);
};
```

服务端消息类型建议固定为：

```json
{ "type": "status", "status": "connecting", "roomId": 123 }
{ "type": "status", "status": "authenticated", "roomId": 123 }
{ "type": "danmu", "data": { "uid": 1, "uname": "A", "danmu": "点歌 X", "roomId": 123, "receivedAt": 1 } }
{ "type": "error", "code": "UPSTREAM_AUTH_FAILED", "message": "弹幕服务器认证失败" }
```

生产页面只提示最终失败，不必把每次 host 切换都弹窗；详细过程放到控制台或服务端日志。

### 5.6 测试开关与默认行为

当前修改必须遵守以下兼容约束：

- 不带 `realtime=1` 时，继续使用当前历史轮询，现有项目行为不变。
- 只有带 `realtime=1` 时，才请求 token 并建立实时 WebSocket。
- `history=1` 可强制回到历史轮询，便于对照诊断。
- 删除“必须传 token”的提示；正常只要求 `roomid`。
- 保留 `debug=1`，但确保日志不打印 token 和带 token 的完整 URL。
- 若采用服务端自取 token，删除浏览器侧 `/live/danmu-info` 调用。

建议 URL 行为：

| 参数 | 默认值 | 用途 |
|---|---|---|
| `roomid` | 必填 | 用户输入的直播间号，可为短号 |
| `debug` | `0` | 输出协议诊断信息 |
| `realtime` | `0` | 设置为 `1` 才启用正在测试的实时 WebSocket |
| `history` | `0` | 设置为 `1` 时强制使用历史轮询 |

本轮实现保留 `realtime=1`，不能改成默认实时模式。

---

## 6. 测试方案

### 6.1 单元测试

新增 `test/bili-live-packet.test.js`：

- 认证包总长度、16 字节包头和大端序正确。
- 同一 Buffer 含两个未压缩包时能依次产出两条消息。
- Buffer 只含半包时先保留，拼接剩余部分后成功解析。
- `version=2` 的 Zlib 外层包能解析内层包。
- `version=3` 的 Brotli 外层包能解析内层包。
- 非法 `packetLen/headerLen` 被拒绝，不造成死循环或大内存分配。

新增 `test/bili-live-parser.test.js`：

- 新版 `info[0][15].user` 正确提取 UID 和用户名。
- 旧版 `info[2]` 正确回退。
- `DANMU_MSG:4:0:2:2:2:0` 能识别为普通弹幕。
- 非弹幕事件不触发点歌回调。
- 弹幕正文含花括号、引号和 emoji 时不被错误拆包。

### 6.2 集成测试

对可控的本地假 WebSocket 上游测试：

1. 校验客户端先发操作码 `7`。
2. 返回操作码 `8`，校验客户端发送操作码 `2` 心跳。
3. 推送 Brotli 压缩的 `DANMU_MSG`，校验浏览器收到标准 JSON。
4. 主机 1 连接失败，校验自动切换主机 2。
5. 上游断开，校验只创建一个重连任务。
6. 两个浏览器订阅同一房间，校验只有一条上游连接。

### 6.3 人工验收

1. 未登录情况下打开 `?roomid=<正在直播的房间>`。
2. 用另一个账号发送唯一测试弹幕。
3. 页面应在约 0～2 秒内显示/识别，而不是等待 3 秒轮询。
4. 连续快速发送多条，确认不漏、不重复、顺序正确。
5. 分别测试短房间号和真实房间号。
6. 断网 10 秒再恢复，确认自动重连并继续接收。
7. 同时打开 OBS 页和控制页，确认同一条弹幕不会触发两次点歌。
8. 登录模式再测一次，确认接收逻辑与游客一致，并能正确识别用户 UID。

联调时可保留 `/live/danmu-history` 作为对照，但它不能作为实时链路是否成功的证据。

---

## 7. 实施顺序

### 第一阶段：让现有功能真正实时

1. 保持默认历史轮询不变，仅完善 `realtime=1` 分支。
2. 修复重复重连 Timer。
3. 兼容 `DANMU_MSG:*`。
4. 加入协议解析单元测试。

这一步改动最小，可以快速验证现有 `bili-live-ws.js` 是否稳定收弹幕。

### 第二阶段：收紧安全边界

1. `/live/ws` 只接收 `room_id`。
2. Node 内部完成真实房间号、WBI 签名、token 和 host 获取。
3. 禁止 token、Cookie 和认证正文进入日志。
4. WBI key 增加 TTL 缓存及失败刷新。

### 第三阶段：提升多页面稳定性

1. 实现 `RoomDanmuHub`，每房间复用一条上游连接。
2. 加入带抖动的指数退避、host 轮换和 token 刷新。
3. 最后订阅者离开后延迟关闭连接。
4. 增加健康状态：连接状态、最近心跳、最近消息时间和重连次数。

---

## 8. 不建议采用的方式

- 不要把 `gethistory` 当实时弹幕接口。它是最近记录快照，轮询会延迟、漏消息并产生额外请求。
- 不需要为“只接收公开弹幕”接入直播开放平台 `gameStart`。普通直播协议已经满足需求。
- 不要固定写死一个弹幕 host。优先使用 `getDanmuInfo.host_list` 并在失败时切换。
- 不要把用户登录 Cookie 发送到浏览器或写入项目配置；游客 `uid=0` 已足够收弹幕。
- 不要仅按字符串 `}{` 拆分消息。必须先按 16 字节包头的包长切包。
- 不要把 token 放进长期配置、前端日志或反向代理日志。

---

## 9. 最终建议

本项目应以现有 `src/services/bili-live-ws.js` 为实时模式的实现起点，同时保留历史弹幕轮询作为默认稳定路径。最小可行版本是在 `realtime=1` 下补足重连和解析测试；通过实测后，正式版本再考虑把 token 获取完全移到 Node 服务端并按房间复用连接。

最终数据链路应为：

```text
roomid
  -> 解析真实 room_id
  -> WBI 签名请求 getDanmuInfo
  -> 获取 token + host_list
  -> WSS 认证（游客 uid=0 / 登录 uid=账号 UID）
  -> 30 秒心跳
  -> Zlib/Brotli 解压
  -> 按二进制包长解析
  -> 提取 DANMU_MSG
  -> 标准化为 {uid, uname, danmu}
  -> 交给现有 identifyDanmuCommand 点歌逻辑
```

这与 `lib_piliplus` 的工作原理一致，同时更适合当前 Node + 浏览器 + OBS 的项目结构。

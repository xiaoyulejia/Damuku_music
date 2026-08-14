# Damuku_music

一个面向 B 站直播间的弹幕点歌台，支持网易云音乐和 QQ 音乐，可作为 OBS 浏览器源、直播姬浏览器源或普通网页使用。

项目包含：

- B 站弹幕点歌、切歌、暂停和播放；
- 网易云音乐、QQ 音乐歌曲搜索与播放；
- OBS 唯一播放端和控制页状态同步；
- 空闲歌单、点歌队列、黑名单和点歌限制；
- 透明歌词页、歌词翻译、进度条和控制页跳转；
- B 站历史弹幕轮询模式和实时 WebSocket 模式；
- 浏览器设置页、Node 服务端持久化设置和调试接口。

## 快速开始

### 环境要求

- Windows、Linux 或 macOS；
- Node.js 18 及以上，推荐 Node.js 24 LTS；
- npm；
- 长期运行时可选 PM2，项目依赖中已包含。

### Windows 一键启动

双击项目根目录的 `启动点歌台.bat`。脚本会：

1. 检查 Node.js、npm 和 Node.js 主版本；
2. 首次运行时安装依赖；
3. 启动本地服务；
4. 自动打开点歌台启动器。

启动器地址：

```text
http://localhost:8000/order/launcher.html
```

在启动器输入 B 站直播间号，点击“生成链接”，然后按下面方式使用：

| 链接 | 用途 |
| --- | --- |
| `?roomid=房间号&source=obs` | OBS 或直播姬浏览器源，唯一实际播放端 |
| `?roomid=房间号&livemode=false&source=control` | 普通浏览器控制页，负责切歌、队列、歌单和声音控制 |
| `?roomid=房间号&source=obs&lyric=true` | 透明歌词页，可作为独立歌词浏览器源 |
| `/order/settings.html?roomid=房间号` | 设置页 |

例如：

```text
OBS:     http://127.0.0.1:8000/order/?roomid=4646297&source=obs
控制页:  http://127.0.0.1:8000/order/?roomid=4646297&livemode=false&source=control
歌词页:  http://127.0.0.1:8000/order/?roomid=4646297&source=obs&lyric=true
设置页:  http://127.0.0.1:8000/order/settings.html?roomid=4646297
```

OBS 页面负责真正播放音频；控制页不会创建第二个播放器。一个房间只允许一个播放端租约，重复打开 OBS 链接时，后打开的页面会自动降级为监控页。

直播姬中优先使用启动器生成的 `127.0.0.1` 地址，不要手动改回 `localhost`。部分直播姬版本对 `localhost` 回环解析和缓存处理不稳定。

### 直播姬多场景设置

优先在所有场景中选择“添加现有来源”，引用同一个 `source=obs` 浏览器源；浏览器源属性中关闭“源不可见时关闭”和“场景激活时刷新浏览器源”。不要在每个场景重新创建相同 URL。

如果直播姬无法跨场景引用同一个来源，给每个独立 WebView 使用不同的实例参数，例如：

```text
场景 A: http://127.0.0.1:8000/order/?roomid=4646297&source=obs&handoff=scene&instance=scene-a
场景 B: http://127.0.0.1:8000/order/?roomid=4646297&source=obs&handoff=scene&instance=scene-b
```

此模式下先在设置页勾选“启用播放源切换”，保存后刷新两个直播姬页面和控制页。控制页会显示“播放源切换”面板，只有在这里选择目标 `instance` 并点击“切换播放源”才会发生接管。直播姬与服务不在同一台电脑时，不能使用 `127.0.0.1`，应监听 `0.0.0.0` 并使用启动日志中的局域网地址。

### 命令行启动

```bash
npm install       # 安装依赖
npm run dev       # 直接运行 app.js
npm run launch    # 启动服务并自动打开启动器
npm start         # 使用 PM2 后台运行
npm run stop      # 停止 PM2 服务
npm run restart   # 重启 PM2 服务
npm run log       # 查看 PM2 日志
npm test          # 运行 Node 测试
```

`npm run launch` 如果发现端口已有服务，会直接复用已有服务并打开启动器。关闭 `npm run launch` 的窗口会停止本次直接启动的服务；使用 `npm start` 时请用 `npm run stop` 停止。

## URL 参数速查

主页面地址格式：

```text
http://主机:端口/order/?roomid=房间号&参数=值
```

参数之间使用 `&`，不要使用第二个 `?`。程序目前兼容误写的 `?roomid=123?debug=1`，但推荐始终使用标准写法。

| 参数 | 可用值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `roomid` | 正整数 | 无 | B 站直播间短号或房间号，必填 |
| `room_id` | 正整数 | 无 | `roomid` 的兼容别名，API 调试时也可使用 |
| `source` | `obs`、`control`、`monitor`、`preview` | 空 | `obs` 用于播放源；后三者表示控制/监控页 |
| `livemode` | `true/1/yes/on` 或 `false/0/no/off` | `true` | `false` 时进入控制/镜像模式，不播放第二份音频 |
| `lyric` | `true/1/yes/on` | 关闭 | 进入透明歌词模式，自动成为镜像页，不负责播放 |
| `realtime` | `true/1/yes/on` | 关闭 | 启用服务端共享实时 WebSocket 弹幕 |
| `history` | `true/1/yes/on` | 关闭 | 强制使用历史弹幕轮询；和 `realtime=1` 同时出现时以历史模式为准 |
| `debug` | `true/1/yes/on` | 关闭 | 在浏览器 Console 输出诊断信息 |
| `uid` | B 站用户 UID | `0` | 指定管理员 UID，用于“切歌”“暂停”“播放”权限判断 |
| `settings` | `1` | 关闭 | 内部设置页标志，通常直接打开 `settings.html`，不要手写 |

常用组合：

```text
# 默认稳定模式，历史弹幕轮询
http://127.0.0.1:8000/order/?roomid=4646297&source=obs

# 实时 WebSocket 弹幕和调试
http://127.0.0.1:8000/order/?roomid=4646297&source=obs&realtime=1&debug=1

# 控制页
http://127.0.0.1:8000/order/?roomid=4646297&livemode=false&source=control

# 控制页只读观察实时弹幕，不重复触发点歌
http://127.0.0.1:8000/order/?roomid=4646297&livemode=false&source=control&realtime=1&debug=1

# 透明歌词页
http://127.0.0.1:8000/order/?roomid=4646297&source=obs&lyric=true
```

`uid` 不是 B 站登录凭证，也不是房间号。不要把 Cookie、Token、弹幕服务器地址等敏感信息放进 URL；这些内容由 Node 服务端处理。

## 音乐平台和配置

打开：

```text
http://127.0.0.1:8000/order/settings.html?roomid=4646297
```

设置页包含：

- 网易云音乐二维码登录；
- QQ 音乐 Cookie 配置；
- 空闲歌单 ID 和歌单历史；
- 每个用户和全局点歌数量限制；
- 点歌歌曲最大时长、超时自动切歌时长；
- 用户历史、歌曲历史、用户黑名单、歌曲黑名单；
- 主题、透明度、模糊、歌词和直播模式显示内容；
- 自定义 CSS、控制页拖动进度开关。

默认 API 配置在 `config/default/webapi.js`：

```js
BASE_PATH: "/order"
bili_api: "/bili-api"
netease_api: "/netease_api"
qqmusic_api: "http://localhost:3300"
```

网易云 API 和 B 站 API 默认由当前 Node 服务集成启动。QQ 音乐默认指向外部 `QQMusicApi` 服务 `http://localhost:3300`，如果没有启动对应服务，QQ 搜索和播放不可用；当前项目本身不提供 QQ API 服务。

## 配置文件和端口

第一次启动会自动从 `config/default/` 创建：

- `config/config.yaml`：服务地址、端口和旧版开放平台配置；
- `config/webapi.js`：静态资源基础路径和 API 地址。

默认配置：

```yaml
web_server_host: "127.0.0.1"
web_server_port: 8000
```

让局域网其他设备访问：

```yaml
web_server_host: "0.0.0.0"
```

然后使用启动日志打印的电脑 IPv4 地址，例如：

```text
http://192.168.1.100:8000/order/launcher.html
```

也可以用环境变量覆盖端口，`DAMUKU_PORT` 优先级高于 YAML：

```powershell
$env:DAMUKU_PORT = 8001
npm run launch
```

端口必须是 `1` 到 `65535` 的整数。

## B 站弹幕模式

默认模式是历史弹幕轮询，每 3 秒获取最近弹幕并去重，适合稳定使用：

```text
?roomid=4646297&source=obs
```

实时模式由 Node 服务端维护匿名 B 站会话、Token、真实房间号和共享上游连接，浏览器只订阅本地服务：

```text
?roomid=4646297&source=obs&realtime=1
```

实时模式支持断线重连、Brotli/Zlib 解压、半包拼接、短断线历史补偿和房间级连接复用。接收公开弹幕不需要 B 站登录。

## 观众指令

```text
点歌歌曲名
点歌wy歌曲名
点歌qq歌曲名
切歌
暂停
播放
```

`wy` 表示网易云音乐，`qq` 表示 QQ 音乐；不写平台时使用当前默认音乐平台，默认是网易云音乐。

权限规则：

- “切歌”：管理员、当前歌曲点歌人可以切换；空闲歌单歌曲也允许切换；
- “暂停”“播放”：仅 `uid` 指定的管理员 UID 可以执行；
- 点歌数量、歌曲时长、黑名单由设置页控制。

## 调试和排障

页面调试：在页面 URL 追加 `debug=1`，打开浏览器开发者工具的 Console：

```text
http://127.0.0.1:8000/order/?roomid=4646297&source=obs&realtime=1&debug=1
```

可查看连接状态、历史弹幕、实时弹幕、歌曲搜索、歌单、音频加载、播放事件和控制同步过程。调试日志会隐藏 Cookie、Token 和完整音频 URL 参数。

后端健康检查：

```text
http://127.0.0.1:8000/order/bili-api/live/health?room_id=4646297
```

实时连接指标：

```text
http://127.0.0.1:8000/order/bili-api/live/metrics?room_id=4646297
```

指标重点看 `DANMU_MSG`、`danmuDecodedCount`、`proxySentCount`、`subscriberDeliveryCount`、`parseErrorCount` 和 `remainderBytes`。该接口只在房间存在实时连接时返回数据。

查看弹幕鉴权和历史数据：

```text
http://127.0.0.1:8000/order/bili-api/live/danmu-info?room_id=4646297
http://127.0.0.1:8000/order/bili-api/live/danmu-history?room_id=4646297
```

同步调试接口还支持：

```text
GET /order/bili-api/live/sync-state?room_id=4646297
GET /order/bili-api/live/sync-commands?room_id=4646297&after=0&since=0
```

其中 `after` 是命令序号，只返回序号更大的命令；`since` 是毫秒时间戳，只返回创建时间不早于该值的命令。它们主要供排查控制页和 OBS 的命令同步，不需要普通用户手动调用。

日志位置：

- 直接运行：当前终端窗口；
- PM2：`logs/out.log`、`logs/error.log`，或执行 `npm run log`；
- 房间状态和命令同步：`cache/order-sync/`；
- 持久化设置：`data/settings/`；
- 网易云 Cookie：`data/credentials/netease-cookie.dat`。

修改服务端代码后必须重启 Node/PM2；只刷新浏览器不会更新已经运行的后端。修改前端代码后可使用 Ctrl+F5，遇到版本提示时点击“清空缓存并刷新”。

## 安全提示

不要提交以下内容：

- 网易云 Cookie、QQ Cookie；
- `data/credentials/`、`logs/`、`cache/` 中的运行数据；
- `config/config.yaml`、`config/webapi.js` 中的本地配置和外部服务地址。

这些路径已加入 `.gitignore`。如果密钥已经被 Git 跟踪，仅修改 `.gitignore` 不能清除历史记录。

## 项目结构

```text
app.js                    # Express 服务入口
src/public/               # 播放页、控制页、设置页、启动器
src/routers/              # B 站及房间同步 API
src/services/             # 本地存储、B 站会话和实时弹幕服务
config/default/           # 默认配置模板
scripts/launch.js         # 启动服务并打开启动器
启动点歌台.bat             # Windows 一键启动
ecosystem.config.js       # PM2 配置
test/                     # 自动化测试
doc/                      # 开发和协议说明
```

详细操作、参数和故障排查请阅读：[使用说明.md](./使用说明.md)。

## 许可证

本项目沿用仓库中的 `LICENSE`。

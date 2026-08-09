# Damuku_music

为B站直播间提供观众弹幕点歌功能，支持网易云音乐、QQ音乐。

## 项目介绍

本插件是一个基于 H5 的直播间点歌组件，可嵌入直播姬、OBS 等直播软件的浏览器源中使用。观众通过发送弹幕指令即可点歌，插件自动获取歌曲资源并播放。

主要功能：
- 支持观众弹幕点歌、切歌、暂停、播放控制、空闲歌单自动播放
- 可设置用户点歌数、全局点歌数、歌曲时长限制、用户/歌曲黑名单管理
- B站普通直播弹幕协议对接（通过直播间 token），支持网易云音乐（集成）、QQ音乐（自行部署）
- API服务支持集成挂载或独立部署

## 部署
### 安装步骤

```bash
# 克隆项目（gitcode/github）
git clone https://gitcode.com/xiao-an/bilibili-ordersong-plugin.git Damuku_music

# git clone https://github.com/xiaoan-1/bilibili-ordersong-plugin.git Damuku_music

cd Damuku_music

# 安装依赖
pnpm i
```

### 服务管理
```bash
# 启动服务
npm run start

# 停止服务
npm run stop

# 重启服务
npm run restart

# 查看日志
npm run log
```

首次启动时，会自动从 `config/default/` 目录拷贝默认配置到 `config/` 目录。

## 配置

### 服务端配置 `config/config.yaml`
| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `access_key_id` | B站开放平台项目密钥 | 空 |
| `access_key_secred` | B站开放平台签名密钥 | 空 |
| `web_server_port` | Web服务端口号 | 8000 |

>**密钥获取 → [B站直播创作者服务中心](https://open-live.bilibili.com/open-manage)**

### API地址配置 `config/webapi.js`

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `bili_api` | B站开放平台API地址 | `/bili-api`（集成模式） |
| `netease_api` | 网易云音乐API地址 | `/netease_api`（集成模式） |
| `qqmusic_api` | QQ音乐API地址 | `http://localhost:3300`（独立服务） |

**地址规则：**
- 以 `/` 开头的相对路径：表示该API集成在主服务中，启动时自动挂载
- 完整URL地址（如 `http://localhost:3300`）：表示该API独立运行，需单独启动

## 使用

在直播姬或 OBS 中选择添加浏览器源，输入网址链接即可：

```
http://localhost:8000/order?roomid={直播间号}
```

默认启用直播模式，只展示观众需要看的点歌队列。自己在浏览器中查看完整播放器时，使用：

```
http://localhost:8000/order?roomid={直播间号}&livemode=false
```

也可以使用 `livemode=true` 显式开启直播模式；设置页中的“直播模式显示内容”可以调整观众能看到的内容。
`livemode=false` 页面是 OBS 播放页的预览镜像，不会再次连接弹幕或加载另一份歌单，因此两边显示的当前歌曲和队列保持一致。

服务端会根据直播间号自动获取弹幕 token。若已经从 B站接口取得 token，也可以直接传入 `&token={弹幕token}`。

调试弹幕连接时追加 `debug=1`，浏览器开发者工具 Console 会输出 API 地址、鉴权摘要、WebSocket 数据包、原始 `DANMU_MSG` 和解析后的弹幕对象：

```
http://localhost:8000/order?roomid={直播间号}&debug=1
```

**公益链接（若无法使用请自行搭建）：**

> **https://xiaoan.website/order?roomid={直播间号}**

直播间号可以从直播间网址或直播中心查看；不再需要 B站开放平台身份码。


### 观众指令

1. **点歌**：发送 `点歌 (平台) 歌曲关键词`
   - 不带平台默认为网易云音乐，目前支持 `wy`（网易）和 `qq`（QQ音乐）
   - 开头两个字为"点歌"即可，无严格格式要求
   - 示例：`点歌起风了`、`点歌qq起风了`
2. **切歌**：发送 `切歌`
3. **暂停/播放**：发送 `暂停` 或 `播放`
   - 观众只能操作自己所点的歌曲
   - 管理员可以操作任何人的歌曲

## 设置简介

主界面点击“设置”按钮，或直接打开全局设置页：

```
http://localhost:8000/order/settings.html
```

设置页不需要携带 `roomid`，配置会保存在当前浏览器中，并对所有直播间生效。
设置页包含以下设置项：

### 登录设置
1. **音乐平台**：选择网易云音乐或QQ音乐
2. **网易云二维码登录**：点击刷新二维码，扫码登录
3. **QQ音乐Cookie登录**：在QQ音乐网页端登录后获取Cookie，粘贴设置
4. **空闲歌单ID**：网易云歌单ID，无人点歌时自动播放该歌单

### 点歌设置
1. **用户点歌数**：每个用户同时已点的最大歌曲数
2. **最大点歌数**：全局同时已点的最大歌曲数
3. **最大歌曲时长**：限制歌曲最大时长（秒），超过无法点歌
4. **超时限播时长**：超过最大时长也可以点，但播放到指定时间自动切歌
5. **历史记录与黑名单**：历史点歌用户、历史点歌歌曲、用户黑名单、歌曲黑名单

### 弹幕设置
1. **直播平台**：选择B站、抖音（暂不支持）、斗鱼（暂不支持）等平台，切换/重连弹幕服务

### 显示设置
1. **内置主题**：支持当前深色主题和白色主题
2. **播放界面透明度**：调整 OBS 浏览器源中播放卡片的背景透明程度
3. **背景模糊**：调整播放卡片的背景模糊效果
4. **自定义 CSS**：可修改 `.playerCard`、`.queueCard`、`.playerActions`、`.alertBox .text` 等元素，点击“应用 CSS”后全局保存

示例：

```css
.playerCard, .queueCard {
    border-radius: 8px;
}

.playerActions button {
    font-size: 16px;
}
```

## 致谢

- ~~[NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) — 网易云音乐 Node.js API~~

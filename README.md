# Damuku_music

一个面向 B 站直播间的弹幕点歌台，支持网易云音乐和 QQ 音乐。项目包含 OBS 播放页面、独立控制页面、弹幕点歌、队列管理、空闲歌单和浏览器本地设置。

## 最快开始（Windows）

1. 安装 [Node.js 24 LTS（推荐，至少 Node.js 18）](https://nodejs.org/en/download/)。
2. 双击项目根目录的 `启动点歌台.bat`。
3. 脚本首次运行会优先使用国内 npm 镜像安装依赖；镜像失败会自动切换 npm 官方源重试，随后启动服务并打开“点歌台启动器”。
4. 输入 B 站直播间号，点击“生成链接”，即可复制两个页面地址。

如果浏览器没有自动打开，也可以手动访问：

```text
http://localhost:8000/order/launcher.html
```

启动器生成的两个链接如下：

| 页面 | 用途 |
| --- | --- |
| `/order/?roomid=房间号` | OBS 浏览器源播放页，默认直播模式 |
| `/order/?roomid=房间号&livemode=false` | 控制/预览页，用于切歌、歌单、声音和队列控制 |

OBS 中添加“浏览器”来源时使用第一个链接；日常管理使用第二个链接。两个页面必须填写同一个房间号。设置页可以从启动器打开，也可以访问 `/order/settings.html?roomid=房间号`。

## 命令行启动

```bash
# 安装依赖
npm install

# 开发或本地直接运行，启动后手动访问启动器
npm run dev

# 一键启动并自动打开启动器
npm run launch

# PM2 后台运行（适合长期运行）
npm start

# PM2 管理
npm run stop
npm run restart
npm run log
```

`启动点歌台.bat` 会检查 Node.js、npm 和 Node.js 主版本。缺少 Node.js、npm 或版本低于 18 时，会提示安装 Node.js 24 LTS 并打开官方下载页。首次安装依赖只对当前命令使用 `https://registry.npmmirror.com`，失败后自动回退到 `https://registry.npmjs.org`，不会修改电脑的全局 npm 源。

`npm run launch` 会先检查 `8000` 端口是否已有服务；没有服务时直接启动 `app.js`，等待服务可访问后自动打开启动器。关闭该命令窗口会停止本次直接启动的服务。`npm start` 使用 `ecosystem.config.js` 交给 PM2 管理，适合服务器或长期运行场景。

如需更换端口，可在启动前设置 `DAMUKU_PORT`；服务端实际端口仍以 `config/config.yaml` 为准，因此两者需要保持一致：

```powershell
$env:DAMUKU_PORT = 8001
npm run launch
```

## 配置

首次启动会从 `config/default/` 自动创建以下本地配置文件：

- `config/config.yaml`：服务监听地址、端口和 B 站开放平台配置。
- `config/webapi.js`：前端 API 基础路径，以及网易云、QQ 音乐 API 地址。

默认配置：

```yaml
web_server_host: "127.0.0.1"
web_server_port: 8000
```

如果要让同一局域网内的其他设备访问，把 `web_server_host` 改为 `0.0.0.0`，并使用启动日志中显示的局域网地址，例如：

```text
http://192.168.1.100:8000/order/launcher.html
```

### 网易云音乐登录

网易云登录和 token 由浏览器端处理，保存在当前浏览器的 `localStorage` 中，不会写入项目仓库。不要把浏览器导出的 Cookie、token 或其他密钥粘贴到代码、README、日志或 Git 提交中。项目中的 `config/config.yaml`、`config/webapi.js`、`src/public/webapi.js` 和 `logs/` 已加入 `.gitignore`；修改忽略规则后，可用下面的命令确认 Git 状态：

```bash
git status --short
git check-ignore -v config/config.yaml config/webapi.js src/public/webapi.js logs
```

如果密钥已经被 Git 跟踪，仅修改 `.gitignore` 不会移除它，需要先从暂存索引取消跟踪，再检查历史提交是否已经泄露。

## 页面说明

- 播放页：给 OBS 浏览器源使用，负责真正播放音频。
- 控制页：`livemode=false`，用于控制播放、队列、空闲歌单和声音；不会另起一套弹幕点歌状态。
- 设置页：`settings.html`，只负责配置，不会自动播放歌曲。
- 启动器：`launcher.html`，输入房间号后生成播放页和控制页链接。

播放页和控制页通过浏览器通信，并在无法使用同源通信时通过本地服务同步状态。建议先打开播放页，再打开控制页；OBS 使用播放页链接。

调试时在播放页或控制页地址追加 `debug=1`，打开开发者工具 Console，可查看网易云搜索、歌单、歌曲播放地址、音频加载/播放事件，以及控制指令同步过程。日志不会输出 Cookie 或完整音频地址参数：

```text
http://localhost:8000/order/?roomid=房间号&debug=1
```

如果浏览器阻止自动播放，OBS 播放页会出现一次性的“启用声音”提示；在 OBS 页面直接点击后，控制页即可继续控制播放。

## 观众指令

- 点歌：`点歌歌曲关键词`，也支持 `点歌wy歌曲关键词`、`点歌qq歌曲关键词`
- 切歌：`切歌`
- 暂停/播放：`暂停`、`播放`

管理员和普通观众的操作权限由页面与点歌配置共同决定。

## 依赖与部署建议

本项目是 Node.js 本地服务，不需要构建前端产物。部署到新电脑或服务器时，只需复制项目代码、安装 Node.js，然后执行：

```bash
npm install
npm start
```

生产环境建议使用 PM2；Windows 本地使用 `启动点歌台.bat` 最方便。`logs/`、本地配置和运行时生成的 `src/public/webapi.js` 不应上传到 Git 仓库。

## 项目结构

```text
app.js                    # Express 服务入口
src/public/               # 播放页、控制页、设置页和启动器
src/routers/              # B 站 API 路由
config/default/           # 默认配置模板
scripts/launch.js         # 启动服务并打开启动器
启动点歌台.bat             # Windows 一键启动
ecosystem.config.js       # PM2 配置
```

## 许可证

本项目沿用仓库中的 `LICENSE`。

import musicPlayer from "./music-player.js?v=20260812-4";
import publicMethod from "../utils/common.js?v=20260810-41";
import musicServer from "../services/musicServers/music-server.js?v=20260810-42";
import danmuServer from "../services/danmuServers/danmu-server.js?v=20260812-1";

/* 在此处启动弹幕服务 */
class DanmuConfiger {

    // 管理员ID
    adminId = 0;

    // 平台切换下拉框
    elem_danmuPlatformSelect = document.getElementById("danmuPlatformSelect");

    // 重连/切换按钮
    elem_danmuPlatformButton = document.getElementById("danmuPlatformButton");

    constructor() {
        // 监听弹幕平台切换
        this.elem_danmuPlatformButton.onclick = async (e) => {
            const platform = this.elem_danmuPlatformSelect.value;
            const isChanged = danmuServer.changePlatform(platform);
            if (isChanged) {
                await this.startDanmu();
            } else {
                publicMethod.pageAlert("弹幕平台切换/重连失败！");
            }
        }

        console.log("弹幕配置初始化完毕");

    }

    // 启动弹幕链接
    async startDanmu({ processCommands = true } = {}) {
        // 镜像页在 realtime=1&debug=1 下可以只观察实时弹幕，但不能重复触发点歌。
        danmuServer.serverObj.danmuMessage = processCommands
            ? this.identifyDanmuCommand.bind(this)
            : null;
        // 连接弹幕服务器
        const connected = await danmuServer.serverObj.connect();
        if (!connected) return;
        if (!processCommands) {
            console.log('[BilibiliDanmu][WebSocket] 调试观察模式：实时弹幕只打印，不触发点歌');
        }
        // 获取管理员ID
        this.adminId = Number(new URLSearchParams(window.location.search).get('uid') || danmuServer.serverObj.uid || 0);
    }


    /*  识别弹幕命令, 触发点歌流程
        @param: userDanmu 包括用户id、用户名、用户弹幕
    */
    async identifyDanmuCommand(userDanmu) {
        let danmuMsg = userDanmu.danmu.trim();

        // 点歌命令触发
        if (danmuMsg.slice(0, 2) == "点歌") {
            let keyword = danmuMsg.slice(2).trim();
            let platform = keyword.slice(0, 2);
            if (musicServer.platformList.includes(platform)) {
                // 如果存在平台信息，关键字剔除平台信息
                keyword = danmuMsg.slice(4).trim();
            }

            // 根据平台通过API查询歌曲信息
            let song = await musicServer.getServer(platform).getSongInfo(keyword);
            if (!song) {
                publicMethod.pageAlert("没找到<(▰˘◡˘▰)>");
                return;
            }
            // 封装点歌信息
            const order = {
                uid: userDanmu.uid,
                uname: userDanmu.uname,
                song: song
            }

            // 添加点歌信息到点歌列表  
            await musicPlayer.addOrder(order);

            // 点歌只提交给后端，当前歌曲、队列位置和是否立即播放由后端统一决定。

        } else if (danmuMsg == "切歌") {

            const current = musicPlayer.orderList[0];
            if (!current) {
                publicMethod.pageAlert("当前没有可切换的歌曲");
                return;
            }
            // 是否为空闲歌单歌曲
            const isOwner = current.uid == 0;
            // 是否为管理员
            const isAdmin = userDanmu.uid == this.adminId;
            // 是否为用户自己的歌曲
            const isFree = current.uid == userDanmu.uid;

            if (isOwner || isAdmin || isFree) {
                // 如果当前播放的是空闲歌单、用户歌曲，或者发送命令的是管理员，则播放下一首歌曲
                musicPlayer.requestNext();
            } else {
                publicMethod.pageAlert("不能切别人点的歌哦(^o^)");
            }
        } else if (danmuMsg == "暂停") {
            if (userDanmu.uid == this.adminId) {
                musicPlayer.audio.pause();
            } else {
                publicMethod.pageAlert("您没有改权限进行该操作~");
            }
        } else if (danmuMsg == "播放") {
            if (userDanmu.uid == this.adminId) {
                musicPlayer.audio.play();
            } else {
                publicMethod.pageAlert("您没有改权限进行该操作~");
            }
        }
    }
}

export default new DanmuConfiger();

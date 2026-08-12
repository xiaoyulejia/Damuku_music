import wyMusicServer from "./wy-music-server.js?v=20260812-22";
import qqMusicServer from "./qq-music-server.js?v=20260812-22";

class MusicServer {

    platform = "wy";

    platformList = ["qq", "wy"];

    changePlatform(platform) {
        this.platform = platform;
    }

    /**
     * 获取指定音乐平台服务对象
     * @param {string} platform
     * @returns {wyMusicServer | qqMusicServer} 音乐平台服务对象
     */
    getServer(platform) {
        if (platform == "wy") {
            return wyMusicServer;
        } else if (platform == "qq") {
            return qqMusicServer;
        } else if (this.platform == "wy") {
            return wyMusicServer;
        } else if (this.platform == "qq") {
            return qqMusicServer;
        }
    }

}

export default new MusicServer();

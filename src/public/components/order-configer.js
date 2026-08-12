import publicMethod from "../utils/common.js?v=20260810-41";

function isMirrorPage() {
    const query = window.location.search.replace(/^\?/, '').replace(/\?/g, '&');
    const params = new URLSearchParams(query);
    const role = (params.get('source') || '').toLowerCase();
    if (params.get('settings') === '1') return true;
    if (['monitor', 'control', 'preview'].includes(role)) return true;
    return ['0', 'false', 'no', 'off'].includes((params.get('livemode') || 'true').toLowerCase());
}

/**
 * 点歌配置项
 * 包括用户点歌数限制、黑名单等
 */
class OrderConfiger {

    // 用户点歌数量限制
    userMaxOrder = 3;
    elem_userMaxOrder = document.getElementById('userMaxOrder');

    // 全局最大点歌数限制
    globalMaxOrder = 15;
    elem_globalMaxOrder = document.getElementById('globalMaxOrder');

    // 限制点歌歌曲的时长(单位秒), 超过则无法点上
    orderMaxDuration = 0;
    elem_orderMaxDuration = document.getElementById('orderMaxDuration');

    // 限制歌曲播放的时长(单位秒)，超过则自动播放下一首歌曲
    overLimitSkip = 0;
    elem_overLimitSkip = document.getElementById('overLimitSkip');

    // 历史点歌用户
    userHistory = [];
    elem_userHistory = document.getElementById("userHistory");

    // 历史点歌歌曲
    songHistory = [];
    elem_songHistory = document.getElementById("songHistory");

    // 用户黑名单
    userBlackList = [];
    elem_userBlackList = document.getElementById("userBlackList");

    // 歌曲黑名单
    songBlackList = [];
    elem_songBlackList = document.getElementById("songBlackList");

    // 构造函数
    constructor() {
        // 为页面元素设置配置项数据
        this.elem_userMaxOrder.value = this.userMaxOrder;
        this.elem_globalMaxOrder.value = this.globalMaxOrder;
        this.elem_orderMaxDuration.value = this.orderMaxDuration;
        this.elem_overLimitSkip.value = this.overLimitSkip;

        this.renderHistoryLists();

        this.addListener();
        // 控制页只能等待 OBS 的服务端状态，不能用本地旧配置初始化并覆盖播放端。
        window.addEventListener('bilibili-ordersong-shared-settings', event => {
            this.applySharedState(event.detail?.order);
        });
        console.log("点歌配置初始化完成");
        publicMethod.pageAlert("已初始化配置项!");
    }

    getSharedState() {
        return {
            userMaxOrder: Number(this.userMaxOrder),
            globalMaxOrder: Number(this.globalMaxOrder),
            orderMaxDuration: Number(this.orderMaxDuration),
            overLimitSkip: Number(this.overLimitSkip),
            userHistory: this.userHistory,
            songHistory: this.songHistory,
            userBlackList: this.userBlackList,
            songBlackList: this.songBlackList
        };
    }

    publishSharedState() {
        const state = this.getSharedState();
        window.__orderSettingsState = state;
        window.dispatchEvent(new CustomEvent('bilibili-ordersong-settings-changed', {
            detail: { order: state }
        }));
    }

    applySharedState(state) {
        if (!state) return;
        const bounded = (value, fallback, min, max) => {
            const number = Number(value);
            return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
        };
        if (state.userMaxOrder != null) this.userMaxOrder = bounded(state.userMaxOrder, this.userMaxOrder, 1, 1000);
        if (state.globalMaxOrder != null) this.globalMaxOrder = bounded(state.globalMaxOrder, this.globalMaxOrder, 1, 10000);
        if (state.orderMaxDuration != null) this.orderMaxDuration = bounded(state.orderMaxDuration, this.orderMaxDuration, 0, 86400);
        if (state.overLimitSkip != null) this.overLimitSkip = bounded(state.overLimitSkip, this.overLimitSkip, 0, 86400);
        if (Array.isArray(state.userHistory)) this.userHistory = state.userHistory;
        if (Array.isArray(state.songHistory)) this.songHistory = state.songHistory;
        if (Array.isArray(state.userBlackList)) this.userBlackList = state.userBlackList;
        if (Array.isArray(state.songBlackList)) this.songBlackList = state.songBlackList;

        this.elem_userMaxOrder.value = this.userMaxOrder;
        this.elem_globalMaxOrder.value = this.globalMaxOrder;
        this.elem_orderMaxDuration.value = this.orderMaxDuration;
        this.elem_overLimitSkip.value = this.overLimitSkip;
        this.renderHistoryLists();
        window.__orderSettingsState = this.getSharedState();
    }

    renderHistoryLists() {
        const fill = (element, items, valueKey, textKey) => {
            if (!element) return;
            element.innerHTML = '';
            items.forEach(item => {
                const option = document.createElement('option');
                option.value = String(item[valueKey]);
                option.textContent = item[textKey] || item.sname || item.uname || item[valueKey];
                element.appendChild(option);
            });
        };

        fill(this.elem_userHistory, this.userHistory, 'uid', 'uname');
        fill(this.elem_songHistory, this.songHistory, 'sid', 'sname');
        fill(this.elem_userBlackList, this.userBlackList, 'uid', 'uname');
        fill(this.elem_songBlackList, this.songBlackList, 'sid', 'sname');
    }

    // 添加控件的监听事件
    addListener() {
        // 输入框失去焦点保存配置
        this.elem_userMaxOrder.addEventListener("blur", (e) => this.setUserMaxOrder(e.target.value));
        this.elem_globalMaxOrder.addEventListener("blur", (e) => this.setGlobalMaxOrder(e.target.value));
        this.elem_orderMaxDuration.addEventListener("blur", (e) => this.setOrderMaxDuration(e.target.value))
        this.elem_overLimitSkip.addEventListener("blur", (e) => this.setOverLimitSkip(e.target.value));

        // 添加用户到黑名单
        document.getElementById('addUserBlack').onclick = () => {
            let select = this.elem_userHistory.selectedIndex;
            if (this.elem_userHistory.children.length == 0 || select < 0) {
                publicMethod.pageAlert("未选择用户!");
                return;
            }
            // 在历史用户里查询完整的数据，添加到黑名单中
            for (let i = 0; i < this.userHistory.length; i++) {
                if (this.userHistory[i].uid == this.elem_userHistory[select].value) {
                    this.addUserBlackList(this.userHistory[i]);
                    break;
                }
            }
        };
        document.getElementById('deleteUserHistory').onclick = () => this.deleteUserHistory();
        document.getElementById('clearUserHistory').onclick = () => this.clearUserHistory();
        // 移除黑名单的用户
        document.getElementById('delUserBlack').onclick = () => {
            let select = this.elem_userBlackList.selectedIndex;
            if (this.elem_userBlackList.children.length == 0 || select < 0) {
                publicMethod.pageAlert("未选择用户！");
                return;
            }
            this.removeUserBlackList(this.elem_userBlackList[select].value);
        };

        // 添加歌曲到黑名单
        document.getElementById('addSongBlack').onclick = () => {
            let select = this.elem_songHistory.selectedIndex;
            if (this.elem_songHistory.children.length == 0 || select < 0) {
                publicMethod.pageAlert("未选择歌曲");
                return;
            }
            // 在历史歌曲中查询完整的歌曲数据，添加到歌曲黑名单中
            for (let i = 0; i < this.songHistory.length; i++) {
                if (this.songHistory[i].sid == this.elem_songHistory[select].value) {
                    this.addSongBlackList(this.songHistory[i]);
                    break;
                }
            }
        };
        document.getElementById('deleteSongHistory').onclick = () => this.deleteSongHistory();
        document.getElementById('clearSongHistory').onclick = () => this.clearSongHistory();

        // 移除黑名单的歌曲
        document.getElementById('delSongBlack').onclick = () => {
            let select = this.elem_songBlackList.selectedIndex;
            if (this.elem_songBlackList.children.length == 0 || select < 0) {
                publicMethod.pageAlert("未选择歌曲！");
                return;
            }
            this.removeSongBlackList(this.elem_songBlackList[select].value);
        };
    }

    // 设置用户点歌数
    setUserMaxOrder(userOrder) {
        if (userOrder == "" || userOrder <= 0) {
            this.elem_userMaxOrder.value = this.userMaxOrder;
            return;
        }
        this.userMaxOrder = userOrder;
        this.publishSharedState();
    }

    // 设置全局最大点歌数
    setGlobalMaxOrder(globalMaxOrder) {
        if (globalMaxOrder == "" || globalMaxOrder <= 0) {
            this.elem_globalMaxOrder.value = this.globalMaxOrder;
            return;
        }
        this.globalMaxOrder = globalMaxOrder;
        this.publishSharedState();
    }

    // 设置最大点歌歌曲时长
    setOrderMaxDuration(orderMaxDuration) {
        if (orderMaxDuration == "" || orderMaxDuration < 0) {
            this.elem_orderMaxDuration.value = this.orderMaxDuration;
            return;
        }
        this.orderMaxDuration = orderMaxDuration;
        this.publishSharedState();
    }

    // 设置歌曲限制时长
    setOverLimitSkip(overLimitSkip) {
        if (overLimitSkip == "" || overLimitSkip < 0) {
            this.elem_overLimitSkip.value = this.overLimitSkip;
            return;
        }
        this.overLimitSkip = overLimitSkip;
        this.publishSharedState();
    }

    // 添加历史用户信息
    addUserHistory(user) {
        // 查重
        for (let i = 0; i < this.userHistory.length; i++) {
            if (this.userHistory[i].uid == user.uid) {
                return;
            }
        }
        // 限长，按队列结构出队（防止无限占用内存）
        if (this.userHistory.length >= 50) {
            this.userHistory.shift();
        }
        // 添加用户信息
        this.userHistory.push(user);
        // 保存到本地
        this.renderHistoryLists();
        this.publishSharedState();
    }

    // 添加历史歌曲信息
    addSongHistory(song) {
        for (let i = 0; i < this.songHistory.length; i++) {
            if (this.songHistory[i].sid == song.sid) {
                return;
            }
        }
        // 限长，按队列结构出队（防止无限占用内存）
        if (this.songHistory.length >= 50) {
            this.songHistory.shift();
        }
        // 添加歌曲信息
        this.songHistory.push(song);
        // 保存到本地
        this.renderHistoryLists();
        this.publishSharedState();
    }

    clearUserHistory() {
        this.userHistory = [];
        this.renderHistoryLists();
        this.publishSharedState();
        publicMethod.pageAlert("历史点歌用户已清空");
    }

    deleteUserHistory() {
        const selectIndex = this.elem_userHistory.selectedIndex;
        if (selectIndex < 0) {
            publicMethod.pageAlert("未选择用户！");
            return;
        }
        const selectedUser = this.userHistory[selectIndex];
        if (!selectedUser) return;
        this.userHistory.splice(selectIndex, 1);
        this.renderHistoryLists();
        this.publishSharedState();
        publicMethod.pageAlert(`已删除历史用户：${selectedUser.uname}`);
    }

    clearSongHistory() {
        this.songHistory = [];
        this.renderHistoryLists();
        this.publishSharedState();
        publicMethod.pageAlert("历史点歌歌曲已清空");
    }

    deleteSongHistory() {
        const selectIndex = this.elem_songHistory.selectedIndex;
        if (selectIndex < 0) {
            publicMethod.pageAlert("未选择歌曲！");
            return;
        }
        const selectedSong = this.songHistory[selectIndex];
        if (!selectedSong) return;
        this.songHistory.splice(selectIndex, 1);
        this.renderHistoryLists();
        this.publishSharedState();
        publicMethod.pageAlert(`已删除历史歌曲：${selectedSong.sname}`);
    }

    // 添加用户黑名单信息
    addUserBlackList(user) {
        // 查重 
        for (let i = 0; i < this.userBlackList.length; i++) {
            if (this.userBlackList[i].uid == user.uid) {
                publicMethod.pageAlert("用户已加入黑名单, 请勿重复添加!");
                return;
            }
        }
        // 限长，按队列结构出队（防止无限占用内存）
        if (this.userBlackList.length >= 50) {
            this.userBlackList.shift();
        }
        // 用户黑名单添加用户
        this.userBlackList.push(user);
        // 保存到本地
        this.renderHistoryLists();
        this.publishSharedState();
    }

    // 移除用户黑名单配置项中对应的用户信息
    removeUserBlackList(uid) {
        // 查找
        for (let i = 0; i < this.userBlackList.length; i++) {
            if (this.userBlackList[i].uid == uid) {
                this.userBlackList.splice(i, 1);
                break;
            }
        }
        // 移除页面中用户黑名单的选中用户
        this.elem_userBlackList.querySelector(`option[value='${uid}']`)?.remove();
        // 更新本地存储配置项
        this.publishSharedState();
    }

    // 添加歌曲黑名单信息
    addSongBlackList(song) {
        // 查重
        for (let i = 0; i < this.songBlackList.length; i++) {
            if (this.songBlackList[i].sid == song.sid) {
                publicMethod.pageAlert("歌曲已加入黑名单, 请勿重复添加!");
                return;
            }
        }
        // 限长，按队列结构出队（防止无限占用内存）
        if (this.songBlackList.length >= 50) {
            this.songBlackList.shift();
        }
        // 歌曲黑名单添加歌曲
        this.songBlackList.push(song);
        // 保存到本地
        this.renderHistoryLists();
        this.publishSharedState();
    }

    // 歌曲黑名单移除歌曲
    removeSongBlackList(sid) {
        // 查找
        for (let i = 0; i < this.songBlackList.length; i++) {
            if (this.songBlackList[i].sid == sid) {
                this.songBlackList.splice(i, 1);
                break;
            }
        }
        // 移除页面中歌曲黑名单的选中歌曲
        this.elem_songBlackList.querySelector(`option[value='${sid}']`)?.remove();
        // 更新本地存储配置项
        this.publishSharedState();
    }

}

export default new OrderConfiger();

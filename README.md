<p align="center"><img src="https://raw.githubusercontent.com/zxxlxj/rex-m/main/assets/mania.png?v=2.1.1" width="128" alt="MANIA 爆米花小怪兽" /></p>

# MANIA

作者：[@zxxlxj](https://github.com/zxxlxj)

连接你自行部署的媒体服务，获取资源并播放。

REX 版当前版本 **2.2.0**。影视分类需要服务器支持资源库协议 3。

## 导入模块

通过 **[GitHub 一键导入](https://rexnow.tv/widget?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzxxlxj%2Frex-m%2Fmain%2Fdocs%2Fplugin-platform%2Fexamples%2Fmania%2Fmania.rex.js)**，或复制集合地址：

```text
https://raw.githubusercontent.com/zxxlxj/rex-m/main/mania.rex
```

## 开始使用

1. 填写 **自部署服务器地址**和 **API**。
2. 打开“获取播放账号”，点击选择主账号或备用账号。
3. 在 REX 中将“全部电影”“全部剧集”或所需分类添加到资源库，分类入口可以选择更细的子分类。

资源库只展示自部署服务中已缓存的媒体；播放账号和模块说明在各自入口管理。

## 2.2.0 更新

- 新增「RAVE 音乐」，支持浏览和搜索专辑、歌曲。
- 打开专辑可选曲，歌曲支持播放原始音频。

在 REX 资源库添加「RAVE 音乐」，填写 RAVE 媒体服务器地址和有音乐权限的账号。密码也可用该账号的 Subsonic 令牌替代。地址包含媒体端口及反向代理前缀，末尾无需添加 `/rest`。旧账号若提示需要准备令牌认证，先登录一次 RAVE 网页再刷新列表。

## 2.1.1 更新

- 减少点击播放后的等待：有效播放凭证直接交给播放器，不再额外等待直链同步；本机已有有效直链继续复用。
- 缓存写入失败时仍能播放当前资源，避免混用新旧资源信息和凭证。
- 新版服务器在起播时暂停后台分类回填并自动恢复，分批重建和清理分类；账号与鉴权读取使用只读连接，账号变更仍立即生效。

刷新模块即可获得模块端优化；服务端优化需同步部署新版主程序。

## 2.1.0 更新

- 完整提供电影、剧集、动漫、综艺、纪录片、演唱会、特摄、晚会 8 大类和 46 个细分类，父分类包含下级内容并去重。
- 增加“待分类”和“自定义分类”入口。自定义分类填写服务器规则中的完整路径；预设选择项不会自动增加自定义标签。
- 优化资源库分页、列表缓存、配置读取和海报加载。配合新版服务器的本地索引，提高资源列表读取速度；原有收藏和播放链接继续可用。

服务器升级后会在后台自动补齐已有资源的分类资料，资料不足的内容仍可在“待分类”和全部资源中查看。

## 戏精俱乐部

[查看图标包和资源卡片配置包，预览并导入](./xijing-club/)

## Rex Hub · 模块聚合与分发

**当前版本：`0.0.2`**。聚合 Rex 模块、管理和托管徽章包，支持 iPhone 主屏幕 PWA。

> [!WARNING]
> Workers Free 每账号 100,000 次请求/日；KV 免费每天 1,000 次写入和删除。大徽章包建议先用直链；部署前请看下面说明中的配额和费用提醒。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fzxxlxj%2Frex-m%2Ftree%2Fmain%2Frex-hub)

[中文部署与使用说明](./rex-hub/README.md)

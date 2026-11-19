# Rex Hub Docker 版

Rust + Axum + SQLite。与 Worker 版共用 UI、PWA 和图标，使用独立数据，不需要 Cloudflare、Node.js、Redis 或外置数据库。Docker 版不应用 Cloudflare 的每日请求或 KV 配额；仍有限制网络并发、请求超时和单文件大小。

## 启动

在 `rex-hub/`（`Dockerfile` 所在目录）执行：

```sh
umask 077
printf 'SETUP_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
docker compose up -d --build
```

打开 `http://localhost:8080`，复制 `.env` 中的初始化令牌，设置至少 12 字符的密码。没有默认管理员密码。默认只监听宿主机回环地址；远程服务器上可用 SSH 端口转发完成初始化，或直接配置 HTTPS 反代。

### HTTPS 访问、Rex 导入和 PWA

在 `.env` 加入 `PUBLIC_ORIGIN=https://你的域名`，再用反向代理把该域名指向宿主机 `127.0.0.1:8080`（如果反代也是容器，请使用共用 Docker 网络和服务地址）。修改 `.env` 后用 `docker compose up -d` 重建配置。不带路径，优先在首次导入前配置；已发布的清单会记录绝对地址，换域名需要重新发布并更新客户端链接。iPhone 主屏幕 PWA 和 Rex 的远程导入建议使用 HTTPS。纯内网测试可显式设置 `REX_BIND=0.0.0.0`、`PUBLIC_ORIGIN=http://内网IP:8080` 和 `ALLOW_INSECURE_HTTP=1`，不要开放到公网，也不要在不可信网络使用 HTTP 登录。

可选变量：`REX_PORT` 为宿主机端口（如改动，同步设置 `PUBLIC_ORIGIN`），`SETUP_TOKEN_FILE` 为容器内的只读令牌文件路径（直接运行镜像时可使用）。初始化成功后可以移除令牌。不要提交 `.env`。

## 数据和升级

- Docker 卷 `rex-data` 挂载到 `/data`，包含 SQLite、上传模块、镜像文件和徽章。升级或重建容器保留卷；不要运行 `docker compose down -v`，否则会删除数据。
- 建议停容器后完整备份 `/data`。如改用宿主机挂载目录，须允许 UID/GID `10001` 读写；优先使用本地存储，勿把 SQLite 放到不支持可靠文件锁的网络盘。
- 此版本面向单实例，不要让多个容器共享同一个数据卷。Worker 实例和 Docker 实例的数据不自动同步；不要把 D1 导出文件直接覆盖本地库。
- 并发下载仍有界；远程来源要求公开 HTTPS，不访问内网主机。私有模块可本地上传。仅托管你有权分发的文件。

## 自行构建

`docker build -t rex-hub:0.0.2 .` 使用多阶段构建。最终镜像不含 Rust 工具链。也可在装了 Rust 与 SQLite 开发库的 Linux 上运行 `cargo test --locked --manifest-path docker/Cargo.toml`。

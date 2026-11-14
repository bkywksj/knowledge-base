# 局域网同步（手机 ↔ 电脑，不经云端）

> 来源：2026-11-14 用户反馈「在家用电脑记、外出用手机记，回家时同步一下就行」。
> 用户确认：配对方式用扫二维码；电脑须开着知识库；手机连不上时先做电脑端 1–3 步。

## 方案

```
手机 LanBackend ──(HTTPS + 证书指纹固定 + 令牌)──▶ 电脑 lan_server ──▶ 局域网库目录 ◀── 电脑自己的同步（LocalPathBackend）
```

- 同步算法、冲突处理、附件去重全复用：服务端只把 `SyncBackendImpl` 的方法一一暴露出去，
  客户端 `LanBackend` 实现同一套接口，手机端用法与 WebDAV / S3 一致
- 不是通用文件服务：只有同步接口那几个操作；路径 / hash 在服务端二次校验
  （`LocalPathBackend::resolve` 遇到 `C:` 这类段会换掉整个根，网络来的路径必须先过 `validate_rel_path`）
- 安全：自签证书（rcgen），客户端只认配对时拿到的指纹；Bearer 令牌常量时间比较
- 库级租约：写操作必须持有；电脑自己往库目录同步时也在进程内拿同一把，防两边交错写 manifest；
  120 秒不续自动失效，持有方断网 / 被杀不会锁死

## 进度

- [x] 第 1 步：服务端 + 客户端 + 租约 + 端到端测试
  - `services/sync_v1/lan_protocol.rs`：接口约定、路径 / hash 校验、证书指纹、令牌比较
  - `services/sync_v1/backend_lan.rs`：客户端（全平台），指纹固定的证书校验器
  - `services/lan_server.rs`：服务端（仅桌面），tokio-rustls + hyper 跑 axum Router
  - 单测 11 条：读写往返、无租约写被拒、与电脑端同步互斥、错误令牌 / 冒充证书被拒、路径越界、租约超时
- [x] 第 2 步：电脑端开关 + 配对二维码 + 本机中转同步源
  - `services/lan_sync.rs`：配置存 app_config（开关 / 端口 / 令牌 / 证书）；证书和令牌只在缺失时生成
  - 开启时自动建「局域网同步（本机中转）」同步源（本地目录 → `<数据目录>/lan-vault`，自动同步 5 分钟），
    用户删了下次开启会重建
  - `sync_v1_scheduler` 推送 / 拉取这个中转源前先拿库级租约（手机在同步则最多等 30 秒）
  - 启动时按上次开关自动拉起（同 MCP HTTP）
  - Commands：`lan_sync_status / enable / disable / pairing_payload / reset_pairing`
  - 设置 → 数据同步与备份 → 「局域网同步」标签：开关、端口、二维码、本机地址、证书指纹、重新生成配对码
  - 二维码内容 = `{t:"kb-lan", v:1, name, hosts, port, fp, token}`
  - 单测 +4（身份 / 令牌稳定、中转源重建、二维码字段、租约只对中转源生效）；界面用假数据在浏览器挂载验收
  - **未在真机上开过服务**：开启会监听 0.0.0.0，Windows 会弹防火墙询问，留给用户自己试
- [x] 第 3 步：mDNS 自动发现 + 多网卡地址
  - `services/lan_discovery.rs`：服务开着时广播 `_kb-lan._tcp`，TXT 带完整证书指纹，实例名 = 设备名 + 指纹前 8 位；
    地址交给 mdns-sd 按网卡自动填；`discover(指纹, 超时)` 供第 4 步手机端用
  - 广播失败不影响同步服务（只是换 IP 后要重新扫码），只记日志；关服务时先停广播
  - 二维码里的地址改为本机全部私网 IPv4（if-addrs），默认路由那块网卡排第一，去掉回环 / 169.254
  - 单测 +3；真实组播收发测试默认 `#[ignore]`（会监听 UDP 5353，Windows 可能弹防火墙），
    手动跑：`cargo test --manifest-path src-tauri/Cargo.toml --lib lan_discovery -- --ignored`
- [ ] 第 4 步：手机端「局域网」同步方式 + 扫码（需真机）；同步流程开始 / 结束时 begin / end 租约；
      手机同步完通知电脑立即合并；连不上二维码里的地址时调 `lan_discovery::discover` 按指纹找
      （mdns-sd 要挪到全平台依赖；Android 收组播需先申请 WifiManager.MulticastLock）
- [ ] 第 5 步：真机联调、防火墙提示、电脑睡眠 / 换网的提示文案

# 部署包使用说明（给 Tony 的一次性操作，约 10 分钟）

Muse 拿不到你的服务器 SSH（它的出站只有 80/443），而且你之前也明确不给服务器权限——
所以这套方案是**零权限部署**：Muse 只管写代码并 push 到 GitHub，你的服务器定时 pull，Nginx 直接 serve。
你只需要做下面的一次性 setup，之后更新全自动。

## 0. 前提
- Debian + Nginx（sites-available / sites-enabled 结构；路径不一样就按你的改）
- Node 18+（`node -v` 没有就装：`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`）
- 4 个 GitHub 仓库（Muse 建好后把 pull.sh 里的 URL 换成实际的；提议名：aioo-tools / aiee-reviews / aiia-content / aiea-en）

## 1. Nginx vhost（4 个）
```bash
sudo cp nginx/*.conf /etc/nginx/sites-available/
cd /etc/nginx/sites-enabled
sudo ln -s ../sites-available/aioo.duckdns.org.conf .
sudo ln -s ../sites-available/aiee.duckdns.org.conf .
sudo ln -s ../sites-available/aiia.duckdns.org.conf .
sudo ln -s ../sites-available/aiea.cc.cd.conf .
sudo nginx -t && sudo systemctl reload nginx
```
HTTPS（每个域名来一遍，或已有证书跳过）：
```bash
sudo certbot --nginx -d aioo.duckdns.org -d aiee.duckdns.org -d aiia.duckdns.org
# aiea.cc.cd 走 Cloudflare：源站证书用 certbot 或 Cloudflare Origin CA，CF 侧 SSL 模式选 Full (strict)
```

## 2. 网站目录 + 首次 clone
```bash
for d in aioo.duckdns.org aiee.duckdns.org aiia.duckdns.org aiea.cc.cd; do
  sudo mkdir -p /var/www/$d && sudo chown -R $USER:$USER /var/www/$d
done
# 仓库建好后逐个 clone（示例）：
# git clone https://github.com/vip712/aioo-tools.git /var/www/aioo.duckdns.org
# ... 每个站点的 public/ 就是网页根目录（vhost 里 root 指向 .../public）
```
注意：vhost 的 `root` 指向 `.../public`，所以仓库里网页文件放 `public/` 目录下。

## 3. API 缓存代理（Node，零依赖）
```bash
sudo mkdir -p /var/www/api-proxy && sudo chown -R $USER:$USER /var/www/api-proxy
cp api-proxy/server.js api-proxy/package.json /var/www/api-proxy/
sudo cp api-proxy/indie-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now indie-api
# 验证：
curl -s http://127.0.0.1:3001/api/health
curl -s http://127.0.0.1:3001/api/btc-fees | head -c 200
```

## 4. 定时拉取
```bash
sudo cp pull.sh /var/www/pull.sh && sudo chmod +x /var/www/pull.sh
# 先手动跑一遍看输出，确认各目录都是 git repo 后再加 cron：
# crontab -e → */5 * * * * /var/www/pull.sh >> ~/site-pull.log 2>&1
```
代理代码更新不频繁；改了 server.js 后 `sudo systemctl restart indie-api` 一下即可。

## 5. Cloudflare（aiea.cc.cd）
- 开发期：在 Cloudflare 建一条 Cache Rule，对 `*.html` 和 `/` **Bypass cache**（否则改完页面用户看到旧版）。
- 稳定后改回短缓存即可。
- 以后想让 Muse 帮你清缓存：Cloudflare 建一个只有 **Cache Purge** 权限的 API token，走安全流程交接。

## 6. 验证清单
- [ ] 四个域名 https 都 200
- [ ] `https://aioo.duckdns.org/api/btc-fees` 返回 JSON（走完 Nginx→代理→上游）
- [ ] pull.sh 手动跑一遍无报错
- [ ] cron 已加

之后流程：Muse 写页面 → push GitHub → 5 分钟内小鸡自动 pull → 线上更新。你这边什么都不用管。

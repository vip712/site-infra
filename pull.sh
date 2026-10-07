#!/bin/bash
# pull.sh — 定时从 GitHub 拉取各站代码（Muse 侧只 push，服务器侧只 pull）
# 部署: sudo cp pull.sh /var/www/pull.sh && sudo chmod +x /var/www/pull.sh
# cron: */5 * * * * /var/www/pull.sh >> ~/site-pull.log 2>&1
#
# 仓库名是提议（Muse 建好仓库后把下面 URL 换成实际的）：
#   vip712/aioo-tools    → aioo.duckdns.org（工具矩阵）
#   vip712/aiee-reviews  → aiee.duckdns.org（返佣测评）
#   vip712/aiia-content  → aiia.duckdns.org（内容站，待定）
#   vip712/aiea-en       → aiea.cc.cd（英文站）
set -u

SITES=(
  "aioo.duckdns.org|https://github.com/vip712/aioo-tools.git|/var/www/aioo.duckdns.org"
  "aiee.duckdns.org|https://github.com/vip712/aiee-reviews.git|/var/www/aiee.duckdns.org"
  "aiia.duckdns.org|https://github.com/vip712/aiia-content.git|/var/www/aiia.duckdns.org"
  "aiea.cc.cd|https://github.com/vip712/aiea-en.git|/var/www/aiea.cc.cd"
)

for entry in "${SITES[@]}"; do
  IFS='|' read -r name repo dir <<< "$entry"
  if [ -d "$dir/.git" ]; then
    if git -C "$dir" pull --ff-only --quiet 2>/dev/null; then
      echo "$(date -Is) $name updated"
    else
      echo "$(date -Is) $name pull FAILED (check manually)"
    fi
  else
    echo "$(date -Is) $name not a git repo yet — clone once: git clone $repo $dir"
  fi
done

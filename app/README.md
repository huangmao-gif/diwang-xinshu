# 朕知道了 · 四帝判官

帝王心术 v0.3 套进 Jev 式判断架子：模型只答 11 道判断题（选一个 / 打分 / 是否），外加令、验、价几行字；类型校验、分流、限流都由代码做。

## 目录

| 文件 | 作用 |
|---|---|
| `prompt/rulebook.md` | 帝王心术 v0.3 原文，没改一个字 |
| `prompt/wrapper.xml` | 外层架子：11 道题的选项和标尺、输出格式 |
| `server.js` | 调 DeepSeek → 校验类型（选项外的值不收，不合格重试一次）→ 按把握分流 → 限流 |
| `public/index.html` | 判决卡页面，打开就有一张样例卡 |
| `test/` | 样例和模拟输出；`npm test` 跑 11 项校验与分流检查 |

## 分流（写在代码里，不靠模型自觉）

| 条件 | 页面显示 |
|---|---|
| 急性危机把握 ≥ 0.3 | 热线卡（12356 / 110 / 120），不判 |
| 需专业资质、手段违法 | 「此局不判」+ 成本理由 |
| 不可逆把握 ≥ 0.5 | 事实清单；推测超过 2 条不出判决（帝王心术 §1.1） |
| 局型或主裁把握 < 0.5 | 只显示一句补问 |
| 其余 | 判决卡：主裁印、动/等、朱批令、四帝话语权、度势时术、死法卡、打脸预测、价、锚 |

## 部署（服务器上，约 10 分钟）

```bash
# 1. 传到服务器后
cd /srv/zhenzhidaole && npm install --omit=dev

# 2. 用命理鉴心现有的 DeepSeek key 和模型名
export DEEPSEEK_API_KEY=sk-xxxx
export DEEPSEEK_MODEL=deepseek-chat      # 和现有项目里写的模型名保持一致
PORT=3100 pm2 start server.js --name zhenzhidaole --update-env && pm2 save
```

Nginx（挂在现有域名的 `/zhen/` 下）：

```nginx
location = /zhen { return 301 /zhen/; }
location /zhen/ {
    proxy_pass http://127.0.0.1:3100/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 60s;
}
```

前面挂了 CDN 的话，`/zhen/api/` 设为不缓存。

## 上线后自查

1. 手机浏览器打开 `https://你的域名/zhen/`，首屏有样例卡。
2. 把链接发到支付宝里打开一次，确认支付宝内置浏览器能显示。
3. 点「例 · 组长抢功」→「呈请御览」，30 秒内出卡。
4. `pm2 logs zhenzhidaole` 看到 `"mode":"verdict"` 即通。

## 可调参数（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PER_IP_DAILY` | 10 | 每个 IP 每天次数 |
| `DAILY_CAP` | 300 | 全站每天次数，超了显示样例卡；保护 key 余额 |
| `MOCK` | 关 | 设为 1 不调模型，用 `test/` 里的模拟输出，本地看页面用 |

# 年会抽奖系统（MVP 骨架）

这仓库目前只实现了“能跑起来并抽出结果”的最小闭环：活动/奖项/名单导入/抽奖（带种子与审计日志）。

## 运行

前置：Node.js 20.x（本仓库在 `v20.10.0` 上验证可用）

```bash
npm install
```

终端 1：启动后端（默认 `http://localhost:3000`）

```bash
npm run dev:server
```

终端 2：启动前端（默认 `http://localhost:5173`，已配置 `/api` 代理到后端）

```bash
npm run dev:web
```

然后打开 `http://localhost:5173`，按页面步骤：
1) 创建活动 → 2) 创建奖项 → 3) 导入名单 → 4) 抽奖 → 5) 导出结果

## 双屏模式（控制台 / 舞台）

- 控制台：`/admin`（主持人操作）
- 舞台页：`/stage/:eventId`（大屏全屏展示，只读，1 秒轮询后端状态）

## 舞台多媒体（路线 C）

- 背景：在控制台上传活动背景（支持 `image/*` 与 `video/mp4`，上限 50MB；后端落盘到 `UPLOAD_DIR`，默认 `./uploads/`，通过 `/uploads/...` 访问）
- 音效：把 `rolling.mp3` / `win.mp3` 放到 `web/public/assets/`；舞台页首次点击会解锁音频并尝试全屏，右上角可调音量

### 舞台音频回归验证（3 轮）

每次改动舞台音频逻辑后，至少执行以下 3 轮：

1. 首轮进入：首次打开 `/stage/:eventId?control=1`，点击“准备就绪”后直接开始一轮抽奖，确认准备阶段（READY）、抽奖阶段（ROLLING）、颁奖阶段（REVEAL）都能触发对应音轨。
2. 切奖项连续抽：在控制条切换不同奖项（例如三等奖→二等奖→一等奖），连续执行“开始→停止→下一轮”，确认多轮切换后音频不丢失。
3. 弱网/慢加载：在浏览器 DevTools 将网络限速为 Slow 3G（或同级别），刷新舞台页后重复第 1 步，确认页面可恢复，音频不会因首次加载慢而永久静音。

故障定位建议：打开浏览器控制台过滤 `stage-audio`，如播放失败会打印 `channel/slot/state/attempt/error.name/error.message`，并自动进行一次 `canplay + 短延时` 重试。

## 名单导入格式

当前支持：`.xlsx/.xls` / `.csv` / `.txt`。

- `txt`：每行一个姓名
- `csv`：可带表头，识别这些列名（中英文都行）
  - `name` / `姓名`
  - `employee_id` / `工号`
  - `department` / `部门`
  - `weight` / `权重`（可选，≤0 会被抽样算法跳过）
- `xlsx/xls`：浏览器端解析并预览（后端只接收 JSON，不接触原始 Excel 二进制文件）

## 数据与审计

- SQLite 数据库默认落在：`./data/lottery.sqlite`（自动创建，可用 `DB_PATH` 覆盖）
- 每次抽奖会写入：
  - `draw_runs`：`seed`、候选池快照哈希 `candidate_hash`、算法版本等
  - `draw_results`：中奖者列表
  - `audit_logs`：导入与抽奖的审计记录

## 环境变量（后端）

- `PORT`：默认 3000
- `DB_PATH`：默认 `./data/lottery.sqlite`
- `UPLOAD_DIR`：默认 `./uploads`（后续媒体上传会用到）
- `CORS_ORIGIN`：默认 `http://localhost:5173`

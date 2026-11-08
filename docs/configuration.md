# 配置与命令参考

本文承接 [README](../README.md) 里放不下的细节：配置目录、`node.json` / `commands.json`、机器类型、carrier、CLI 速查、本机状态文件。
规范性约定以 [中台标准](standard.md) 为准，这里只讲怎么配、怎么用。

## 1. 配置目录

配置目录取 `--config <dir>` > 环境变量 `HUB_NODE_HOME` > `~/.hub-node`。里面有：

| 文件 | 作用 | 能否提交仓库 |
|---|---|---|
| `node.json` | 节点身份、总线参数、唤醒与对账周期、角色 | 否（含 Base token、表 ID、open_id） |
| `commands.json` | 能力表：本机能干什么、怎么干 | 否 |
| `app.env` | 飞书应用凭据，权限 600 | 绝不 |
| `runs/<Task_ID>/` | 每次执行的输入、输出与在途账本（`entry.json`） | 否 |
| `retry_state.json` `approval_state.json` `present_state.json` `stale_state.json` `schedule_state.json` | 节点私有状态与水位，非协议字段 | 否 |
| `present_queue.jsonl` `present_bell` | 发给本机 Agent 的回执队列与门铃文件 | 否 |
| `agent_inbox.jsonl` | `kind=agent` 节点的收件箱 | 否 |

仓库里只有占位符样例：[`config/node.example.json`](../config/node.example.json)、[`config/commands.example.json`](../config/commands.example.json)。

## 2. node.json

节点身份（`node` / `zone`）、总线参数（`baseToken` / `tables`）、凭据来源（`appEnv` 指向本地 env 文件，或 `appId` / `appSecret` 直填）、轮询与对账周期。

- `role`：`node` 或 `hub`，缺省 `node`。`lah daemon`、`doctor`、`service` 省略 `--role` 时读它。
- `events`：是否订阅云文档事件（长连接门铃，秒级唤醒）。`pollSec`（默认 45）是 poll 模式的扫表间隔；`sweepSec`（默认 900，即 15 分钟）是对账兜底。
- `ownerOpenId`：机主 open_id，只有 hub 角色用，用来校验审批卡的操作者。
- `tz`：hub 专用，IANA 时区名，缺省 `Asia/Shanghai`。只决定定时调度的 cron 墙钟，与宿主机时区无关。
- hub 角色强制 ws 长连接。唤醒只是门铃，内容一律回表拉取。

## 3. 机器类型：host 与 agent

`lah setup [--kind host|agent]` 的向导会问你。

- **`kind: host`（电脑宿主，默认）**：自动发现 lark-cli 应用，识别本机已装的 Agent（Claude Code、Codex、agy、Paseo、Orca 等）并生成 `commands.json`；守护进程认领任务后拉起本机命令干活。
- **`kind: agent`（独立 Agent 本尊，如 Muse、常驻 Agent 容器）**：Agent 自己就是干活的人。setup 不扫描 PATH、不注册外部 CLI，只登记 `agent` 能力（`mode: inbox`）。守护进程认领任务后写入本地 `agent_inbox.jsonl` 并刷新心跳，由本尊自己接单、办完回执。

> [!IMPORTANT]
> `kind=agent` + inbox 只适合有常驻进程、能在主循环里定期调用 `lah inbox` 的 Agent。没有常驻进程的云端外部 Agent（如 Grok Bot）不要选它，应走「协议接入型节点（`Receive_Mode=automation`）＋飞书自动化 webhook」，见 [协议节点运行手册](protocol-node-runbook.md)。飞书自动化是向外部 HTTP 端点 POST，不会读取本机收件箱，收件箱也绝不会被平台 webhook 唤醒。

## 4. commands.json：能力表

键是 Skill_ID（能力 ID），值是命令模板。**加能力、改能力、删能力，只改这个文件，不改内核。**

```jsonc
{
  "daily-briefing": {
    "command": "node scripts/briefing.js",
    "mode": "json",
    "name": "每日早报",
    "desc": "天气、热点、本机状态汇总",
    "side_effect": "read"
  },
  "ops-agent": {
    "command": "agy --dangerously-skip-permissions --print {prompt}",
    "mode": "agent",
    "name": "运维 Agent",
    "side_effect": "write",
    "approval_class": "approve",
    "timeout_sec": 900
  }
}
```

| 字段 | 说明 |
|---|---|
| `command` | 命令模板。agent 模式含 `{prompt}` |
| `mode` | `agent`（默认）纯文本输出＋结构化回执；`json` 脚本类，stdin 收信封、stdout 最后一行出结果；`inbox` 交给本尊收件箱 |
| `context` | `direct`（默认，守护进程直接拉起）或 `carrier`（见第 5 节）。取值非法时任务直接 `rejected`，不静默降级 |
| `timeout_sec` | 单次执行上限，默认 600 |
| `cwd` | 工作目录，默认配置目录 |
| `side_effect` | 副作用等级，写进名片，如 `read` / `write` |
| `approval_class` | 本机审批下限，只收紧不放宽。设为 `approve` 的能力执行前必走机主审批 |
| `resume_command` | 可选，含 `{session}` 与 `{prompt}`。仅 direct 问答续跑且本机已有 session 时替换 `command` |
| `cap_id` `name` `desc` | 登记到 AgentCards 的名片信息 |

命令、目录、语境只来自这个文件。任务参数里带 `command` / `cwd` / `context` / `agent` 等执行控制键，会被直接拒收，不会被当作指令。

热更新与降级：

- 守护进程每轮用文件 mtime 与内容哈希判断能力表变没变；变了就串行对账 AgentCards：新增或修改的能力更新名片，被删的能力把名片 `Dispatchable` 置为 `No`。
- 首次同步与 carrier 在线状态变化时也强制校准名片；写表全部成功后才更新本地缓存，写一半失败就保持上一版，下一轮补写。
- `commands.json` 解析失败时，保留上一版有效能力表并**暂停接新单**（任务留在 `submitted`，不会因能力表被清空而被拒成 `rejected`）。修好文件后下一轮自动恢复。`lah doctor` 会检查两份配置是否合法。

能力分三层：确定性脚本；指定本地 Agent 执行指定 Skill；通用能力（Agent＋工具面）。都只是命令模板，守护进程是薄壳，不内嵌任何执行器。

### 回执约定（摘要）

内核只认结构，不猜自然语言。完整语法见标准 §9。

- **agent 模式**：最后一个完整的 ```` ```agent-ask ```` 围栏表示提问（任务转 `input-required`）；围栏外整行的 `ARTIFACT:` / `ARTIFACT_NAME:` / `USAGE:` / `SESSION:` / `LATER:` 分别表示产物、用量、会话、预约复查。围栏内伪造的行不生效。
- **json 模式**：只认 stdout 最后一行 JSON：`summary`、`artifact`、`artifact_name`、`need_input`，可选 `usage`、`session`、`later`。未知顶层键忽略并记日志。
- `usage` 累计到 `Tasks.Metadata.usage`；`session` 只存本机 `runs/<Task_ID>/session.json`，不进总线；`later` 在任务完成时生效，由 hub 到点在同一 `Context_ID` 新建复查任务。

## 5. carrier：需要局域网的能力（macOS）

macOS 上由 launchd 拉起的守护进程访问局域网，会被系统本地网络隐私机制拦截（背景与实测见 [DESIGN.md](../DESIGN.md) §9）。需要局域网的能力，在条目里加 `"context": "carrier"`，再在你日常的终端里跑：

```bash
lah host     # 前台常驻，保持终端开启；Ctrl-C 退出
```

守护进程经本地 unix socket 把这类命令交给 carrier 代跑。carrier 不在线时，这些能力在名片上自动标 `offline`，任务明确拒收，**绝不静默改走直跑**。守护进程只连接 carrier，从不拉起它。

socket 在线只说明本机 carrier 在听，不代表远端局域网目标可达。要实测目标：

```bash
lah doctor --probe <host:port>   # 经在线 carrier 做一次只读 TCP 探测
```

DESIGN.md §9 注记④ 记录了本项目作者机器上的限定：长驻进程做裸 TCP 局域网访问并不稳定，carrier 作为语境抽象与离线纪律保留，在你的环境里是否有效请用 `--probe` 验证。

## 6. CLI 速查

`lah` 是主入口，`hub-node` 是兼容别名。以下 `--config <dir>` 均可省略（见第 1 节）。

| 命令 | 作用 |
|---|---|
| `lah setup [--role node\|hub] [--kind host\|agent] [--wake poll\|event\|sweep] [--skip-skill]` | 一键向导：解析表 ID、写 `app.env` 与 `node.json`、生成 `commands.json`、订阅事件、自检、可选注册自启 |
| `lah daemon [--role node\|hub]` | 常驻守护进程 |
| `lah doctor [--role node\|hub] [--probe <host:port>]` | 只读自检：配置合法性、连通性、能力登记、carrier |
| `lah service [--role node\|hub] [--remove]` | 注册（或卸载）开机自启：macOS LaunchAgent / Linux systemd 用户服务 |
| `lah update [--check] [--skip-skill]` | 自更新程序本体：git pull、依赖重装、软链与 Skill 补齐；不碰配置目录。`--check` 只看远端有没有新版本。tarball 安装请重跑 install.sh |
| `lah host` | carrier 进程，只能由用户在终端里启动 |
| `lah reconcile` | 单次回表认领与对账后退出 |
| `lah inventory` | 只读盘点本节点名片与任务 |
| `lah task create --to <node> --cap <cap_id> [--text …] [--params <json 或 @文件>] [--idempotency-key <键>] [--from <node>]` | 派单。写表前按 AgentCards 名册校验 `--to` 与 `--cap` |
| `lah task reply --task <id> --text …` | 答复 `input-required` 的追问，原任务续跑 |
| `lah task show <id>` | 看状态与产物 |
| `lah task why <id> [--json]` | 只读时间线：任务行、消息、Runs、Artifacts、本机待补交状态 |
| `lah task cancel --task <id> [--text …]` | 撤单。发起方只撤自己的单，hub 可撤任意单；终态报错且不改状态 |
| `lah present [--pop]` | 读取（并清空）本机发起任务的回执队列 |
| `lah inbox [--pop] [--json]` | `kind=agent` 接单 |
| `lah inbox done\|ask\|fail --task <id> --text …` | 完单（可带 `--artifact`）、追问、失败回执 |

回执队列 `present_queue.jsonl` 旁边的 `present_bell` 文件，在有新回执落盘时刷新 mtime，本机 Agent 盯这一个文件即可，不必轮询队列。

## 7. 自建中台（Hub 角色）

1. 按 [base-schema.md](base-schema.md) 在飞书多维表格里建好七张标准表，拿到 Base 链接与机主 `open_id`。
2. 安装后运行 `lah setup --role hub --owner <机主 open_id>`。hub 角色包含 node 的全部能力，并承担全网审批发卡、结果呈递、陈旧任务告警、定时调度与 `later` 复查。
3. `lah doctor --role hub` 验收。单进程、单配置目录，不需要拆两个进程。

## 8. 接入外部 bot（飞书自动化 + webhook）

适用于托管在外部云平台、没有常驻进程、跑不了 Node 守护进程的 Agent（如 Grok bot）：

1. 在 AgentCards 登记该 bot 的能力，`Receive_Mode` 设为 `automation`。
2. 在 Base 里配飞书自动化：Tasks 新增记录或状态变更且 `Target_Node` 是该 bot 时，向它的公网端点 POST。**只带 ID（Task_ID、状态、Msg_ID），不带正文与敏感数据**。
3. bot 收到门铃后用飞书 REST API 回查 Messages / Parts，执行完按协议写回 Messages、Parts、Runs 并更新 Tasks 状态。bot 自己要做低频对账（如 15 分钟）兜底。平台 webhook 与定时对账不能写在同一个飞书自动化里，详见 [协议节点运行手册](protocol-node-runbook.md)。

守护进程绝不开监听端口、不做端口映射与反向隧道，也不主动向外部节点推送（标准 §0 第 3 条、§10.3）。出站通知完全由飞书官方的多维表格自动化驱动。

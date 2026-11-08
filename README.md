# lark-a2a-hub —— 多 Agent 中台（飞书多维表格总线）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Standard](https://img.shields.io/badge/standard-v3.5-blue.svg)](docs/standard.md)
[![Version](https://img.shields.io/badge/version-0.6.2-orange.svg)](CHANGELOG.md)

[English](README.en.md) · [中台标准](docs/standard.md) · [架构](docs/architecture.md) · [更新日志](CHANGELOG.md)

一套已经在生产运行的多 Agent 协作系统：**用飞书多维表格当消息总线与
状态层**，数据模型借 A2A 协议；一个枢纽（hub）负责拆解、派发、审批与
结果呈递；任意终端装上节点适配器即可入列干活，云端 Agent 也能按协议
直接接入。任务只有一个发起面和一个状态面，全程留痕可查。

> 方向说明（标准 v3.5）：枢纽（hub）是逻辑角色，并且是 `node` 的**单进程超集**，
> 由 `lah daemon --role node|hub`（CLI 简称 `lah`，向下兼容 `hub-node` 别名）承载
> （省略 `--role` 时读 `node.json` 的 `role`，缺省 node）。单进程单配置目录即可同时
> 承担 Hub 枢纽职责（全网审批发卡、结果呈递、超时告警）与 Node 执行节点能力（认领执行任务）。
> 仓库只有这一份 Node 实现。唤醒方式为 ws / poll / webhook 三种（webhook 专指飞书自动化出站通知，
> 本项目任何进程不主动推送），本项目任何进程都不开监听端口。hub 角色强制 ws。

本仓库包含系统的全部公开部分：

| 组成 | 位置 | 说明 |
|---|---|---|
| 中台标准 v3.5 | [docs/standard.md](docs/standard.md) | 七表对象模型、A2A 八态状态机、通信/审批/幂等协议（规范性文件） |
| 系统架构 | [docs/architecture.md](docs/architecture.md) | 分层、核心决策与理由、生命周期、故障模型 |
| Base 结构 | [docs/base-schema.md](docs/base-schema.md) · [schema/](schema/) | 七表字段级定义，由运行中的 Base 生成（附生成器） |
| 枢纽对接 | [docs/hub-integration.md](docs/hub-integration.md) · `src/hub/` | 枢纽职责、建单纪律、呈递与审批回路；实现是 `lah daemon --role hub` |
| 节点适配器 | 本仓库 `bin/` `src/` · [DESIGN.md](DESIGN.md) | 把任何终端变成执行节点：认领 → 拉起本机脚本/Agent → 收回执 → 落日志 |
| 能力模板库 | [docs/agent-templates.md](docs/agent-templates.md) | 各家无头 CLI 定版命令、三类权限语义与已知坑 |
| 协议接入 | [docs/protocol-node-runbook.md](docs/protocol-node-runbook.md) | 无守护进程的 Agent 按手册盯表接入（同一套协议） |

```mermaid
flowchart LR
    OP["操作者"] --> HUB["枢纽 hub"]
    HUB -->|"建单（先消息、后任务行）"| BUS["飞书多维表格总线<br/>Tasks · Messages · Parts · Runs<br/>Artifacts · AgentCards · Rules"]
    BUS -->|"事件推送＋对账兜底"| NODES["节点们：家用机 / 工作机 / 云端 Agent"]
    NODES -->|"状态 · 消息 · 产物回写"| BUS
    BUS -->|"终态 / 待答 / 待批"| HUB
```

## 快速上手

### 路径 A：加入现成中台（装一个 node）

向中台管理员获取已建好的 Base 链接，只需 3 步：

1. **安装程序**（前置需 Node.js >= 20）：
   ```bash
   curl -fsSL https://raw.githubusercontent.com/backtomyfuture/lark-a2a-hub/main/install.sh | sh
   ```
   程序安装到 `~/.hub-node/app`，可执行入口链接至 `~/.local/bin/lah`（同时保留 `hub-node` 兼容别名）。

2. **一键向导配置**：
   ```bash
   lah setup [--kind host|agent]
   ```
   提示式向导支持选择机器类型（1=电脑宿主，2=独立 Agent 本尊）：
   - **`kind: host`（电脑宿主，默认）**：自动发现 lark-cli 应用、自动识别本机已安装的 Agent（Claude Code、Codex、agy、Paseo、Orca 等）并生成 `commands.json`，由守护进程拉起子进程干活；
   - **`kind: agent`（独立 Agent，如 Muse、本地 Agent 会话或常驻 Agent 容器）**：本身即为 Agent 实体，适用于有常驻守护进程或能在主循环中定期调用 `lah inbox` 的 Agent。setup 绝不扫描 PATH、不注册任何外部 CLI，只注册 `agent` 能力（`mode: inbox`）。守护进程认领任务后写入本地 `agent_inbox.jsonl` 并刷新心跳保活，由本尊自行接单与处理。
   > [!IMPORTANT]
   > **架构分界提示**：`kind=agent` + inbox 仅适用于有常驻进程/能主动调用 `lah inbox` 的 Agent。没有常驻进程的云端外部 Agent（如 Grok Bot）请勿选择 `kind=agent`，而应走「协议接入型节点（`Receive_Mode=automation`）＋飞书自动化 webhook」（见下方接入外部 bot）；因为飞书自动化 webhook 是向外部 HTTP 端点 POST，**不会读取本机收件箱，收件箱也绝不会被平台 webhook 唤醒**。
   自动解析 Base 六表 ID、写入 600 权限的 `app.env` 与 `node.json`，注册云文档事件订阅实现秒级唤醒，并运行 `doctor` 自检。最后可直接确认注册开机自启。

3. **验收运行**：
   ```bash
   lah doctor      # 检查连通性与能力登记
   lah daemon      # 前台试跑（若 setup 中已注册自启则已常驻）
   ```
   安装向导已自动为终端 Agent 安装 `lah` Skill（位于 `~/.agents/skills/lah`），终端 Agent 可以直接发起跨节点调度！

---

### 多 Agent 调度与任务交互（CLI / Agent 通用）

任何入网节点或终端 Agent 都可以派发任务并按原路接收结果：

- **派单**：
  ```bash
  lah task create --to <Target_Node> --cap <Skill_ID> --text "指令文本" [--params '{"k":"v"}']
  ```
  默认自动以当前节点作为发起方（`From_Node` 与 `Source`）。
- **消费回执（原路落盘，飞书不刷屏）**：
  ```bash
  lah present --pop
  ```
  读取并清空属于本机发起的任务回执队列（`~/.hub-node/present_queue.jsonl`），终端 Agent 即可直接在当前对话中向用户汇报。
- **答复追问**：
  当任务状态为 `input-required` 时，直接原路答复，目标节点在原任务自动续跑：
  ```bash
  lah task reply --task TASK-XXXX --text "答复内容"
  ```
- **查看状态与产物**：
  ```bash
  lah task show TASK-XXXX
  ```
- **审批安全红线**：
  需要机主授权的动作自动转入 `auth-required`，由主节点在飞书向机主发送卡片，机主点击批准/驳回后自动恢复执行或取消，无需终端手动干预。
- **独立 Agent 接单与回执（收件箱工作流）**：
  若节点以 `--kind agent` 运行，Agent 本尊在循环开头接单，处理后原路提交回执：
  ```bash
  lah inbox --pop                                                    # 接单：读取并确认待办
  lah inbox done --task TASK-XXXX --text "执行结论" [--artifact <路径>]  # 完单：关单并原路回传
  lah inbox ask  --task TASK-XXXX --text "追问问题"                   # 追问：转入 input-required 待答
  lah inbox fail --task TASK-XXXX --text "失败原因"                   # 失败：置 failed 并原路通知
  ```

---

### 路径 B：自建中台（Hub 角色：单进程兼任中台与执行节点）

一台机器即可同时承担枢纽（发审批/呈递/告警）与执行节点能力（认领执行任务），单进程单目录常驻：

1. **准备 Base**：
   按照 [docs/base-schema.md](docs/base-schema.md) 在飞书多维表格中建好七张标准表，获取 Base 链接与机主的 `open_id`。安装程序：
   ```bash
   curl -fsSL https://raw.githubusercontent.com/backtomyfuture/lark-a2a-hub/main/install.sh | sh
   ```

2. **配置并启动枢纽（hub）**：
   ```bash
   lah setup --role hub --owner <机主open_id>
   ```
   hub 角色自动包含 node 的全部功能：扫描本机 Agent、生成 `commands.json`、注册事件长连接与云文档事件订阅（秒级门铃），并承担全网审批发卡与结果呈递。在向导末尾确认即可直接注册常驻系统自启。

3. **验收运行**：
   ```bash
   lah doctor --role hub
   ```
   服务单进程承载 Hub 与 Node 双重职责，无需额外启动两个进程或维护两套配置目录。

---

### 接入外部 bot（如 Grok bot）：飞书自动化 + webhook

对于托管在外部云平台、没有常驻进程、无法运行 Node 守护进程且无长连接能力的外部 Agent（如 Grok bot）：
> **选型界限**：没有常驻进程的外部 Agent 必须走本路径（协议节点 + 飞书自动化 webhook），不能走 `kind=agent` 的收件箱（inbox）模式，因为外部 webhook 无法唤醒本地收件箱文件。

1. **定义与名片**：在 AgentCards 表登记该 bot 的能力与节点标识，`Receive_Mode` 设为 `automation`。
2. **飞书多维表格自动化**：在 Base 配置自动化流程——当 Tasks 表有新记录写入或状态变更（且 `Target_Node` 为该 bot）时，触发飞书自动化向该 bot 的公网端点发送 HTTP POST。**只发送 ID（Task_ID、状态、Msg_ID），不带任务正文与敏感数据**。
3. **拉取与回写**：外部 bot 收到 webhook 门铃后，通过飞书 REST API 回查 Messages / Parts 拉取参数；执行完毕后按 A2A 协议写回 Messages、Parts、Runs 并更新 Tasks 状态。外部 bot 须自行设置低频对账（如 15 分钟）兜底扫表（注意：平台 webhook 与定时对账不能写在同一个飞书自动化内，详见 [协议节点运行手册](docs/protocol-node-runbook.md)）。
> **红线原则**：本项目守护进程绝不开监听端口、不做端口映射与反向隧道，也不主动向外部节点发起推送（标准 §0 第 3 条、§10.3）。出站通知完全由飞书官方多维表格自动化驱动。详细规范见 [协议节点运行手册](docs/protocol-node-runbook.md)。

## 节点配置要点

- `node.json`：节点身份（node/zone）、总线参数（baseToken/tables）、凭据来源
  （appEnv 指向本地 env 文件，或 appId/appSecret 直填）、轮询与对账周期。
  hub 另可写 `tz`（IANA 时区名，缺省 `Asia/Shanghai`），只用于定时调度的 cron 墙钟，与宿主机时区无关。
- `commands.json`：能力表。键是 Skill_ID，值是命令模板：
  - `mode: "json"` —— 脚本类：stdin 收任务信封，stdout 最后一行输出结果 JSON；
  - `mode: "agent"` —— Agent 类：模板含 `{prompt}`，输出纯文本＋结构化回执块。
  - 加能力、改能力或删能力只改这个文件。守护进程每轮用文件 mtime 与内容
    哈希判断它变没变；变了就串行对账 AgentCards：新增或修改的能力更新名片，
    从文件里删掉的能力把名片 `Dispatchable` 置为 `No`。进程启动后的第一次同步，
    以及 carrier 在线状态变化时，也会强制校准名片。`registeredCards` 和
    `carrierAvailability` 只在这一轮写表全部成功之后才更新；写到一半失败就保持
    上一版缓存，下一轮再补，不会把“没写上”当成“已经同步”。
  - `commands.json` 临时解析失败时保留上一版有效能力表，并暂停派发新任务
    （任务留在 `submitted`，不会因为能力表被清空而拒成终态 `rejected`）。
    文件修好后，下一轮检测到变更会自行恢复派发。
- 能力分三层：确定性脚本、指定本地 Agent 执行指定 Skill、通用能力
  （Agent＋工具面）——都是命令模板，守护进程是薄壳，不内嵌执行器。
- 凭据只存节点本地，绝不进总线；节点只发起出站连接，不开监听端口。

### carrier：需要局域网的能力（macOS）

macOS 上由 launchd 拉起的守护进程访问局域网会被系统本地网络隐私机制拦截
（见 DESIGN.md §9）。需要局域网的能力，在 `commands.json` 的条目里加
`"context": "carrier"`，再在你日常的终端（比如常开的 Ghostty/tmux 里）跑：

```bash
lah host     # 前台常驻，保持终端开启；Ctrl-C 退出
```

守护进程会经本地 unix socket 把这类命令交给 carrier 在终端语境里代跑；
carrier 不在线时，这些能力在名片上自动标离线、任务明确拒收，绝不静默
改走直跑。在线状态相对上次成功写表发生变化时，会再强制校准一次名片，
并且仍是写表成功之后才记住新的 `carrierAvailability`。`lah doctor`
默认只报告 carrier socket 是否在线。

[DESIGN.md](DESIGN.md) §9 注记④ 的限定：carrier 必须由用户在拥有局域网路由
和本地网络权限的交互终端里启动（守护进程只连接、从不拉起它）。socket
在线只说明本机 carrier 在听，不代表远端局域网目标一定可达。要实测该目标：

```bash
lah doctor --probe <host:port>   # 经在线 carrier 做一次只读 TCP 探测
```

## 版本与变更

见 [CHANGELOG.md](CHANGELOG.md)。参与改进见
[CONTRIBUTING.md](CONTRIBUTING.md)。

License: MIT

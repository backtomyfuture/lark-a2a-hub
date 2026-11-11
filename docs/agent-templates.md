# 能力模板库

`lah setup` 扫到本机 CLI 后，按这里的定版命令把它登记为该节点 `commands.json` 里 `workers` 下的一个 Worker（Worker 名即下面的小节名，如 `claude`、`agy`；每个 Worker 在名册里有一张 Worker 名片（`Skill_ID=agent`，代表它的通用执行），见[配置参考](configuration.md#4-commandsjson能力表)）。命令里的可执行文件会落成绝对路径，下面为了可读只写命令名。

规范性要求在 [标准 §9](standard.md)：编排型 CLI 必须显式带默认执行主体；agent 型无头 CLI 必须显式处理权限。模型 slug 只钉在节点本地，不进总线。

## 权限语义

三类不要混用：

- **软拒绝型**（agy、gemini、claude）。不带批准参数时，工具调用会被静默拒绝，进程仍可能以成功退出。看起来做完了，实际什么都没改。
- **沙箱档位型**（codex、droid）。用沙箱或自治档位限制能不能写。codex 不写档位时默认只读，写类任务必失败。
- **全批准开关型**（amp、opencode）。一个开关放开无头运行所需的权限。没有这个开关就会停在确认上，守护进程没有人点。

## 模型口径

- 编排型的 provider 必须写进模板。Paseo 不带 `--provider` 时没有执行主体，运行必失败。
- 模型 slug 按需钉在节点本地 `commands.json`（`--provider <provider>/<model>`）。不写模型就只用 provider 的默认模型。
- 能用别名就用别名，例如 claude 的 `sonnet`，少钉死一串会过期的版本号。
- 钉了 slug 之后靠 `lah doctor` 对照 `paseo provider models <provider>` 的在册 ID 校验活性。slug 失效应在自检时报出，而不是跑任务时才发现。

## 定版命令

### claude

`claude -p --dangerously-skip-permissions {prompt}`

无头 `-p` 会停在权限确认，没人点就卡住。软拒绝型，三选一即可：`--dangerously-skip-permissions`、`--permission-mode`、`--allowedTools`（也认 `--allowed-tools`）。预置模板用第一个。

### codex

`codex exec --sandbox workspace-write {prompt}`

默认沙箱是只读档，写类任务必失败。沙箱档位型，模板钉 `workspace-write`。`-s` 与 `--sandbox=...` 同样算写了档位。

### agy

`agy --dangerously-skip-permissions --print {prompt}`

软拒绝型。`--print` 会把紧随其后的参数当成 prompt 吞掉，批准参数必须放在 `--print` 前面。本机实测过这个顺序。批准参数只认 `--dangerously-skip-permissions`。

### gemini

`gemini --approval-mode yolo -p {prompt}`

软拒绝型。`--approval-mode` 必须放在 `-p` 前面，原因与 agy 的 `--print` 相同。`-y` / `--yolo` 已废弃，不要用。

### amp

`amp --dangerously-allow-all -x {prompt}`

全批准开关型。不带这个开关，无头 `-x` 会停在确认上。

### droid

`droid exec --auto medium {prompt}`

沙箱档位型里的分级自治。预置取中档 `medium`（`low` / `medium` / `high`），不把默认放到最高。

### opencode

`opencode run --dangerously-skip-permissions {prompt}`

全批准开关型。这个参数名有版本差异，以目标机 `opencode --help` 为准。本机较新版本 `--help` 里可见的是 `--auto`；`--dangerously-skip-permissions` 是旧名，也是隐藏别名。

### paseo

`paseo agent run --provider antigravity {prompt}`

要钉模型时写成 `--provider antigravity/<model>`。编排型，没有默认执行主体。不写 `--provider` 时运行必失败，mba / mini 两台就是这样集体翻车的。交互安装会再问 provider（默认 antigravity）和 model（可留空）；非交互保持上面的默认。

### grok

`grok -p {prompt}`

本版不动。现有无头写法没有纳入这次权限定版。

### hermes

`hermes -z {prompt}`

本版不动。

### cursor-agent

`cursor-agent -p {prompt}`

本版不动。

### aider

`aider --message {prompt} --yes`

本版不动。`--yes` 已经是它自己的无头确认。

### orca

`orca task run {prompt}`

本版不动命令行本身。Orca 按编排型处理：模板必须显式带默认执行主体，具体参数以目标机 `orca --help` 为准。本版没有猜它的旗标，避免把未核实的参数写进预置模板。

## 会话续接（可选）

只用于 `context=direct` 的 json / agent。carrier 与 inbox 不读 `resume_command`。

同一任务从 input-required 收到 answer 再执行时，如果本机 `runs/<Task_ID>/session.json` 里已有执行者上次自报的 session id，并且该能力写了 `resume_command`，节点用它替换 `command`。第一次执行、失败重试、心跳回收后的重跑仍走原来的 `command`。session id 不进总线。

`{session}` 会换成单引号包裹的 id，只替换一次。agent 模式同时保留 `{prompt}`，数据仍在全量 `input.json`。json 模式只需要 `{session}`，任务信封仍走标准输入。`lah doctor` 发现写了 `resume_command` 却没有 `{session}` 会报问题。

下面的旗标按本机帮助文本的位置来写，没有另造开关。换了版本先看 `--help`。

- **claude**。本机 `claude --help` 有 `-r, --resume [value]`（Resume a conversation by session ID）。agent 续接可以写成 `claude -p --dangerously-skip-permissions --resume {session} {prompt}`。普通执行仍用上一节的定版命令。
- **codex**。本机 `codex exec --help` 的可选项（含 `--sandbox`）在子命令之前；`codex exec resume --help` 里会话号是位置参数 `[SESSION_ID]`，后面才是 `[PROMPT]`，没有名为 `--resume` 的旗标。按这个位置，续接写成 `codex exec --sandbox workspace-write resume {session} {prompt}`。这里没有把这条组合实际跑通，只对齐了两份帮助里的参数位置。

json 模式没有对应的定版 CLI。占位写法是在原命令之外加一条只含 `{session}` 的 `resume_command`，具体参数名以该程序自己的 `--help` 为准。

## 已知坑

- **agy 参数顺序**。`--dangerously-skip-permissions` 必须在 `--print` / `-p` 之前。放在后面会被当成 prompt。
- **codex**。`--full-auto` 已废弃，用 `--sandbox`。非 git 目录会拒跑，这是 CLI 自己的限制，模板解决不了。
- **opencode**。写成 `--prompt` 会掉进交互界面，守护进程没有 TTY 可答。用 `run` 加位置参数 `{prompt}`。
- **paseo**。没有默认 provider。新版命令名是 `run`，本机仍是 `agent run`，有版本差；预置模板按本机写法。换了版本先看 `--help`。
- **orca**。编排型，模板须显式带默认执行主体，参数以其 `--help` 为准。不要照 paseo 的 `--provider` 硬套。

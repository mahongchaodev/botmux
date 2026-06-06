# v3 结构化 loop 节点设计

- 日期：2026-06-06
- 状态：draft，待 claude/codex/老滕讨论
- 关联：
  - `docs/design/2026-06-01-next-gen-workflow-design.md`
  - `docs/design/2026-06-03-v3-blocked-resultschema-design.md`

## 0. 摘要

v3 的外层 workflow 仍然保持 DAG。返工场景不能直接建普通回边，例如 `test -> code`，否则会破坏拓扑排序、并发调度、重启恢复、dashboard 展示和成本控制。

返工应建模成一个结构化 `loop` 节点：

```text
prepare -> repairLoop -> report
```

对外层 DAG 来说，`repairLoop` 是普通节点：有输入、有输出、有状态。它内部才执行带边界的子流水线：

```text
第 1 轮：code -> test
第 2 轮：code -> test
第 3 轮：code -> test
...
```

这样既保留 DAG 的确定性，又支持 code -> test -> code 这类常见返工闭环。

## 1. 问题

很多复杂任务不是一次性从头走到尾：

```text
code -> test
```

如果 test 节点成功跑完，并报告 bug 仍未修好，重试 test 节点本身是错误的。test 已经完成了自己的职责；真正不合格的是上游 code 节点产物。

这里要区分两类情况：

| 类型 | 例子 | 正确动作 |
|---|---|---|
| 节点自身失败 | 测试命令超时、缺鉴权、result.json 格式不对 | retry 同一个节点 |
| 验收失败 | 测试跑完且 `passed=false` | 带测试报告回到上游节点返工 |

blocked/resultSchema 第一刀解决前者。结构化 loop 解决后者。

## 2. 设计原则：禁止任意 goto

外层 DAG 必须继续无环：

- 普通 `depends` 边不能往回指。
- DAG validator 继续拒绝环。
- 返工只能出现在显式 `type: "loop"` block 里。
- loop 必须有边界，`maxIterations` 必填。

它更像编程语言里的结构化控制流，而不是图上的任意跳转：

```text
外层 DAG：
  A -> B(loop) -> C

B 内部：
  while 准出条件未满足 && 未超过 maxIterations:
    跑一轮 body DAG
```

## 3. loop 节点形态

建议 authored shape：

```json
{
  "id": "repairLoop",
  "type": "loop",
  "depends": ["prepare"],
  "inputs": [{ "from": "prepare" }],
  "maxIterations": 3,
  "body": {
    "nodes": [
      {
        "id": "code",
        "type": "goal",
        "goal": "根据初始需求和上一轮测试报告修复 bug。",
        "depends": [],
        "inputs": []
      },
      {
        "id": "test",
        "type": "goal",
        "goal": "运行回归测试，写 result.json 和测试报告。",
        "depends": ["code"],
        "inputs": [{ "from": "code" }],
        "resultSchema": {
          "type": "object",
          "properties": {
            "passed": { "type": "boolean" },
            "summary": { "type": "string" },
            "failures": { "type": "array" }
          },
          "required": ["passed"]
        }
      }
    ]
  },
  "exit": {
    "node": "test",
    "when": { "path": "result.passed", "equals": true }
  },
  "continue": {
    "node": "test",
    "when": { "path": "result.passed", "equals": false },
    "feedback": ["test.result", "test.files"]
  },
  "onExhausted": "blocked",
  "sessionPolicy": "fresh"
}
```

说明：

- `body.nodes` 自己也是小 DAG，必须无环。
- `exit.node` 指向一个有结构化结果的 body 节点。
- `continue.feedback` 声明哪些上一轮产物会显式传给下一轮。
- `onExhausted: "blocked"` 表示达到最大轮数后停下来让人介入。
- `sessionPolicy: "fresh"` 是 MVP 默认值，也是第一版唯一支持值。

## 4. 准入 / 准出语义

### 准入

loop 节点的外层依赖完成后，loop 才能开始。

第 1 轮时，runtime 写入 loop input context：

```json
{
  "loopId": "repairLoop",
  "iteration": 1,
  "outerInputs": [],
  "previous": null
}
```

第 N 轮（N > 1）时，runtime 额外写入上一轮选定产物：

```json
{
  "loopId": "repairLoop",
  "iteration": 2,
  "previous": {
    "test": {
      "resultPath": ".../iterations/001/test/attempts/001/work/result.json",
      "files": [
        {
          "name": "test report",
          "path": ".../iterations/001/test/attempts/001/work/report.md",
          "kind": "markdown"
        }
      ]
    }
  }
}
```

下一轮 `code` 节点不能靠聊天记忆猜上一轮发生了什么。goal 里应明确要求它读取上一轮 test report。

### 准出

每轮结束后，runtime 根据指定节点的结构化 result 判断是否准出。

对 code -> test 来说：

- `test.result.passed == true` -> loop succeeded。
- `test.result.passed == false` -> 开下一轮，并把 test feedback 传回 code。
- `maxIterations` 用完 -> loop blocked。
- body 内节点出现基建失败 -> loop failed。
- body 内节点 blocked -> loop blocked。

loop 节点对外只暴露最终结果：

- 成功：最后一轮成功产物。
- blocked：blocked 原因、最后 iteration id、最后一轮 feedback。
- failed：底层 failed node 和 errorClass。

## 5. 跨轮上下文传递

loop 上下文必须显式、文件化。

建议标准引用：

| 引用 | 含义 |
|---|---|
| `previous.<nodeId>.result` | 上一轮某节点结构化结果 |
| `previous.<nodeId>.files` | 上一轮某节点 manifest files |
| `previous.<nodeId>.manifest` | 上一轮某节点完整 manifest |

bugfix 场景里，第 2 轮 code 应拿到：

- 原始 bug 需求。
- 当前 repo / working directory。
- 上一轮 `test.result`。
- 上一轮 test report 文件路径。

这样 loop 可 replay、可审计，agent 不需要猜历史。

## 6. session 策略

MVP 默认每个 iteration 的每个 body 节点都是 fresh session：

```text
第 1 轮：fresh code worker，fresh test worker
第 2 轮：fresh code worker，fresh test worker
```

原因：

1. Claude Code / Codex / Seed / 未来 adapter 的 resume 能力不一致。
2. 长 session 容易累积错误假设；fresh session 读取明确 test report 反而更稳。
3. recovery 更简单：daemon restart 只依赖文件和 journal，不依赖 live session 归属。
4. cancel 和 budget accounting 更简单。
5. v3 架构本来就把文件 IPC 当 source of truth。

未来可以保留 opt-in：

```json
{
  "sessionPolicy": "resumeWithinLoop"
}
```

如果 dogfood 证明“保留 code agent 的连续上下文”明显更好，再为特定 loop 打开。它不应是默认值。

## 7. 状态和 journal

实现上不能覆盖 body node 的状态。每轮 iteration 都是 append-only：

```text
repairLoop/
  iterations/
    001/
      code/attempts/001/
      test/attempts/001/
    002/
      code/attempts/001/
      test/attempts/001/
```

journal 必须保留 iteration 边界。具体事件名实现时可再定，但审计模型至少要有：

- loop started
- iteration started
- body node dispatched/succeeded/blocked/failed
- iteration decision evaluated
- loop succeeded/blocked/failed

dashboard 外层先展示 loop 节点，再允许展开 iteration：

```text
repairLoop  blocked after 3 iterations
  iteration 1: code done, test passed=false
  iteration 2: code done, test passed=false
  iteration 3: code done, test passed=false
```

## 8. 和 blocked/resultSchema 的关系

`resultSchema` 是 loop 准出的基础。

没有结构化 result 时，loop 只能解析“看起来没问题”这类自然语言，稳定性不够。引入 resultSchema 后，loop 可以确定性判断字段：

```json
{
  "passed": false,
  "summary": "Regression still fails",
  "failures": [
    "Expected status 200, got 500"
  ]
}
```

关键区别：

- `result.json` 不符合 schema -> test 节点 blocked。
- `result.json` 合法且 `passed=false` -> test 节点 succeeded，但 loop 继续下一轮。

## 9. architect 生成规则

architect 遇到“修到通过 / 质量达标才继续”的目标，应生成 loop 节点，而不是普通一次性 DAG。

适合 loop：

- code -> test repair
- implement -> review repair
- research -> verify quality
- generate report -> critique -> revise

不适合 loop：

- 目标就是产出一次性缺陷报告。
- 单纯数据抽取。
- 通知 / 发布流程。

判断准则：

如果验证失败意味着“回去修上游产物”，用 loop。若验证结果本身就是最终产物，用普通 DAG。

## 10. Deferred

- 任意图成环：拒绝。
- nested loop：等真实需求出现再做。
- parallel iterations：MVP 拒绝，会复杂化 budget 和 feedback。
- `resumeWithinLoop`：后续 opt-in。
- 完整表达式语言：先支持 path equals / not equals / numeric comparison；不要嵌 JS。

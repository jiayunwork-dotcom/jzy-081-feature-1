# 离散生命表寿险精算服务（APV + 年缴保费与准备金）

把离散生命表下的精算口径固化为常驻 HTTP 服务，Node.js 20 + Fastify 实现，
供产品系统反复直接调用。两层能力共用同一套生存递推与贴现换算：

- **趸缴现值**：终身寿险、期初生存年金、定期/两全净保费（原有口径，行为不变）
- **年缴保单核算**：均衡年缴净保费反解、逐年净准备金序列（往后看 + 回算双口径）、
  准备金递推关系校验

## 口径约定（离散精算惯例，钉死）

- 贴现因子 `v = 1 / (1 + i)`；贴现率 `d = i / (1 + i)`（**不是利率 `i` 本身**）
- 活过前 k 年的概率连乘递推：`_0 p_x = 1`，`_{k+1} p_x = _k p_x · (1 − q_{x+k})`
- 第 k 年死亡概率：`_k p_x · q_{x+k}`
- 终身寿险（年末赔付）：`A_x = Σ v^(k+1) · _k p_x · q_{x+k}`
- 期初生存年金：`ä_x = Σ v^k · _k p_x`；限期 n 年：`ä_{x:n} = Σ_{k=0}^{n-1} v^k · _k p_x`
- 定期死亡（保障年限 n）：`A¹_{x:n} = Σ_{k=0}^{n-1} v^(k+1) · _k p_x · q_{x+k}`
- 纯生存：`_n E_x = _n p_x · v^n`
- 两全净保费：`A_{x:n} = A¹_{x:n} + _n E_x`

恒等式（测试钉死）：`1 = A_x + d · ä_x`（终龄死亡率为 1 时严格闭合）。
全程逐年离散递推，不引入连续死亡力近似。

## 年缴保费与准备金口径（同样钉死）

- **均衡年缴净保费**（等价原则：签单时点保费现值 = 给付现值）
  - 终身寿险：`P = A_x / ä_x`（每年年初缴，缴到终龄）
  - n 年两全：`P = A_{x:n} / ä_{x:n}`（每年年初缴，缴到保障年限满）
- **第 t 年末净准备金 · 往后看**：以「人已活到 x+t」为新起点重切生命表，
  `_tV = 剩余给付现值 − 剩余净保费现值`
- **第 t 年末净准备金 · 回算**：`_tV = (P·ä_{x:t} − S·A¹_{x:t}) / _tE_x`
  （已收保费积累 − 已发生给付积累，按生存者分摊）
- **递推关系**：`(_tV + P)·(1+i) = q_{x+t}·S + p_{x+t}·_{t+1}V`
- 边界（测试钉死）：签单时点 `_0V = 0`；两全满期、给付纯生存金之前 `_nV = S`；
  终身险到终龄全部给付了结后 `V = 0`；回算口径在生存者灭绝的时点为 0/0 无定义，
  响应中以 `retrospectiveBoundaryFilled: true` 标明该点以边界值补齐

## 一条命令构建并启动（容器，基础镜像锁定 node:20）

```bash
docker build -t life-apv:latest .
docker run --rm -p 3000:3000 life-apv:latest
# 换端口： -e PORT=8080 -p 8080:8080
```

## 本地开发

```bash
npm ci          # 或 npm install
npm test        # node:test，61 项测试
npm start       # http://localhost:3000
```

## HTTP 接口（JSON）

### 1）终身寿险 + 期初年金 —— `POST /api/v1/life-table`

请求：

```json
{
  "startAge": 40,
  "mortalityRates": [0.1, 0.2, 0.25, 0.5, 1],
  "interestRate": 0.25
}
```

- `startAge`：起始整数年龄（0–120）
- `mortalityRates`：从起始年龄起逐岁死亡率，每项 [0,1]，**终龄最后一项固定为 1**
- `interestRate`：年利率，要求 `i > -1`

响应（节选）：

```json
{
  "wholeLifeInsuranceAPV": 0.4864256,
  "annuityDueAPV": 2.567872,
  "discountFactor": 0.8,
  "discountRate": 0.2,
  "identity": { "residual": -4.4e-16, "closed": true }
}
```

### 2）两全净保费（含两个分项）—— `POST /api/v1/endowment`

在上面字段基础上增加：

```json
{ "years": 3, "sumInsured": 100000 }
```

响应同时给出单位保额口径 `perUnit` 与金额口径 `money`：

```json
{
  "perUnit": {
    "termInsuranceAPV": 0.28736,
    "pureEndowmentAPV": 0.27648,
    "endowmentNetPremium": 0.56384
  },
  "money": {
    "termInsurance": 28736.0,
    "pureEndowment": 27648.0,
    "endowmentNetPremium": 56384.0
  }
}
```

### 3）按年缴费保单：均衡保费 + 逐年准备金 —— `POST /api/v1/policy`

在生命表、利率、保额之外指定产品形态；两全需再给保障/缴费年限：

```json
{
  "startAge": 40,
  "mortalityRates": [0.1, 0.2, 0.25, 0.5, 1],
  "interestRate": 0.25,
  "sumInsured": 100000,
  "productType": "endowment",
  "years": 3
}
```

- `productType`：`"wholeLife"`（终身寿险，保费缴到终龄）或
  `"endowment"`（限期两全，保费缴到 `years` 年满）
- `years`：两全必填，整数 `1..表长`（年缴口径下 0 年无意义，直接拒掉）

响应（节选，标准示范表 n=3）：

```json
{
  "product": { "type": "endowment", "years": 3, "premiumYears": 3, "coverageYears": 3 },
  "netPremium": {
    "perUnit": 0.25854732,
    "annual": 25854.73,
    "benefitAPVPerUnit": 0.56384,
    "premiumAnnuityAPVPerUnit": 2.1808,
    "equivalence": { "formula": "P * ä = A（签单时点保费现值 = 给付现值）", "closed": true }
  },
  "initialReserve": 0,
  "reserves": [
    { "year": 1, "attainedAge": 41, "prospective": 24798.24, "retrospective": 24798.24,
      "retrospectiveBoundaryFilled": false, "recursionResidual": -7.3e-12,
      "perUnit": { "prospective": 0.2479824, "retrospective": 0.2479824 } },
    { "year": 2, "attainedAge": 42, "prospective": 54145.27, "..." : "..." },
    { "year": 3, "attainedAge": 43, "prospective": 100000.0, "..." : "..." }
  ],
  "checks": {
    "initialReserveZero": { "passed": true },
    "recursionClosed":    { "formula": "(V_t + P)·(1+i) = q_{x+t}·S + p_{x+t}·V_{t+1}", "passed": true },
    "pathsAgree":         { "formula": "往后看口径 = 回算口径（仅差数值误差）", "passed": true },
    "terminalReserve":    { "value": 100000, "expected": 100000, "passed": true }
  }
}
```

- `reserves` 从第 1 个保单年度末排到保单终止：两全排到满期（末点 = 保额），
  终身险排到终龄（末点 = 0）
- 每年同时给往后看（`prospective`）与回算（`retrospective`）两个口径，
  以及把上一年准备金滚到本年的递推残差 `recursionResidual`
- `checks` 把四条准绳全部显式报告：签单为零、递推闭合、双口径一致、期末收敛

### 示范生命表（手工校算）

- `GET /api/v1/sample-table`：两份示范表（40 岁起、i=25%，v=0.8/d=0.2，手算无压力）
  - `standard-40`：逐年非零，验证恒等式闭合
  - `zero-segment-40`：前三年死亡率全 0，验证定期死亡=0、纯生存退化为纯贴现 v³=0.512

`GET /api/v1/sample-table?id=standard-40` 返回含手算参考值的完整数据
（含均衡保费与逐年准备金参考值）。

### 标准表手工复算（v=0.8）

| k | 年龄 | q   | _k p | 死亡概率 _k p·q | v^(k+1)·死亡 | v^k·_k p |
|---|------|-----|------|-----------------|--------------|----------|
| 0 | 40 | 0.10 | 1.00 | 0.10 | 0.08000 | 1.00000 |
| 1 | 41 | 0.20 | 0.90 | 0.18 | 0.11520 | 0.72000 |
| 2 | 42 | 0.25 | 0.72 | 0.18 | 0.09216 | 0.46080 |
| 3 | 43 | 0.50 | 0.54 | 0.27 | 0.110592 | 0.27648 |
| 4 | 44 | 1.00 | 0.27 | 0.27 | 0.0884736 | 0.110592 |

合计 `A_x = 0.4864256`，`ä_x = 2.567872`，`A_x + 0.2·ä_x = 1`。
n=3：定期死亡 `0.28736`、纯生存 `0.54·0.8³ = 0.27648`、两全 `0.56384`。

**均衡保费与准备金（单位保额）手工复算**：

- 终身：`P = 0.4864256 / 2.567872 = 0.1894275`
- 两全 n=3：`ä_{40:3} = 1 + 0.72 + 0.4608 = 2.1808`，`P = 0.56384 / 2.1808 = 0.2585473`

两全 n=3 逐年准备金（往后看：以 x+t 重切表；回算：积累差 ÷ `_tE_x`）：

| t | 剩余口径（往后看） | _tV | 回算核对 |
|---|--------------------|-----|----------|
| 1 | `A_{41:2}=0.672`，`ä_{41:2}=1.64` | `0.672 − P·1.64 = 0.2479824` | `(P·1 − 0.08)/0.72` |
| 2 | `A_{42:1}=0.8`，`ä_{42:1}=1` | `0.8 − P = 0.5414527` | `(P·1.72 − 0.1952)/0.4608` |
| 3 | 满期，给付纯生存金之前 | `= 1`（= 保额） | `(P·2.1808 − 0.28736)/0.27648 = 1` |

递推抽核（第 2→3 年）：`(0.5414527 + 0.2585473)·1.25 = 1.0`
`= q₄₂·1 + p₄₂·_3V = 0.25 + 0.75·1`。

终身险逐年准备金：`[0.1519827, 0.2834534, 0.4548015, 0.6105725, 0]`，
末点随终龄全部给付了结收敛到 0。

## 非法输入（计算前挡下，HTTP 400 结构化错误）

年龄越界、死亡率超出 [0,1]、终龄死亡率不为 1、利率 `i ≤ -1`（贴现因子非正）、
保额非正、保障年限为负或超出表长；保单接口另挡：产品形态非法、两全缺年限、
年限为 0 / 非整数（年缴口径下无意义）。响应形如：

```json
{
  "error": "VALIDATION_FAILED",
  "message": "请求参数校验失败，未执行任何精算计算",
  "issues": [
    { "field": "sumInsured", "code": "NON_POSITIVE_AMOUNT", "detail": "保额必须为正数，收到 0" }
  ]
}
```

## 代码结构（按职责一模块一文件）

```
src/
  actuarial/
    discount.js       # v、d 换算与贴现幂次
    survival.js       # 生存概率逐年连乘递推
    wholeLife.js      # 终身寿险现值
    annuity.js        # 期初年金 / 限期期初年金现值
    endowment.js      # 定期死亡 / 纯生存 / 两全两个分项
    premium.js        # 均衡年缴净保费反解（等价原则）
    reserve.js        # 逐年净准备金 · 往后看口径
    retrospective.js  # 逐年净准备金 · 回算口径
    recursion.js      # 准备金递推关系逐步校验
    valuation.js      # 趸缴请求编排（局部中间量，无共享可变状态）
    policy.js         # 保单核算编排（保费 + 双口径准备金 + 递推校验）
  validation/
    validate.js       # 参数校验
  http/
    routes.js         # 请求处理层（不含计算口径）
  data/sampleTable.js
  errors.js  app.js  server.js
test/                 # 恒等式 / 保费配平 / 准备金双口径 / 递推闭合 / 非法入参 / 并发隔离
```

并发隔离：每次请求在自己的调用栈内新建 `kp`/`deathInYear`、准备金序列等累积量，
无任何模块级可变状态，多个核算请求各算各的、互不串写
（趸缴口径 20 路、保单口径 24 路并发测试钉住）。


# 离散生命表寿险精算现值服务（APV Service）

把离散生命表下的精算现值口径固化为常驻 HTTP 服务，Node.js 20 + Fastify 实现，
供产品系统反复直接调用，统一趸缴终身寿险、期初生存年金、定期/两全净保费、
**按年缴费保单的均衡年缴净保费与逐年净准备金**的计算口径。

## 口径约定（离散精算惯例，钉死）

- 贴现因子 `v = 1 / (1 + i)`；贴现率 `d = i / (1 + i)`（**不是利率 `i` 本身**）
- 活过前 k 年的概率连乘递推：`_0 p_x = 1`，`_{k+1} p_x = _k p_x · (1 − q_{x+k})`
- 第 k 年死亡概率：`_k p_x · q_{x+k}`
- 终身寿险（年末赔付）：`A_x = Σ v^(k+1) · _k p_x · q_{x+k}`
- 期初生存年金：`ä_x = Σ v^k · _k p_x`
- n 年定期期初年金：`ä_{x:n} = Σ_{k=0}^{n-1} v^k · _k p_x`（n 笔，年初缴）
- 定期死亡（保障年限 n）：`A¹_{x:n} = Σ_{k=0}^{n-1} v^(k+1) · _k p_x · q_{x+k}`
- 纯生存：`_n E_x = _n p_x · v^n`
- 两全净保费：`A_{x:n} = A¹_{x:n} + _n E_x`

恒等式（测试钉死）：`1 = A_x + d · ä_x`（终龄死亡率为 1 时严格闭合）。
全程逐年离散递推，不引入连续死亡力近似。

## 按年缴费保单口径（新增）

保费每年年初缴、缴到规定期数为止（全期缴费）：终身险缴到终龄，两全缴到保障年限满。

- **均衡年缴净保费**（等价原则：签单时保费收入现值 = 未来给付现值）
  - 终身：`P_x = A_x / ä_x`
  - 两全：`P_{x:n} = A_{x:n} / ä_{x:n}`
- **逐年净准备金** `_t V`（第 t 个保单年度末，t=0 为签单时刻），两条路径：
  - 往后看：`_t V = APV_{x+t}(剩余给付) − P · ä_{x+t : 剩余缴费期}`，
    生存概率以「人当下已活到 x+t」为新起点，用 qx 第 t 项起的子表**重新递推**
  - 回算：`_t V = [P · ä_{x:t} − A¹_{x:t}] / _t E_x`
    （已收保费积累 − 已发生给付积累，在仍生存者间分摊）
- **逐年递推关系**（测试逐段钉死）：
  `(_t V + P)(1 + i) = q_{x+t} · S + p_{x+t} · _{t+1}V`
- 闭合条件：签单 `_0 V = 0`；两全满期给付前 `_n V = S`；终身险终龄后准备金收敛为 0。
  两条准备金路径逐年只差在数值误差量级。`_t p_x = 0` 的时点回算为 0/0 不定式，回算值给 `null`。

## 一条命令构建并启动（容器，基础镜像锁定 node:20）

```bash
docker build -t life-apv:latest .
docker run --rm -p 3000:3000 life-apv:latest
# 换端口： -e PORT=8080 -p 8080:8080
```

## 本地开发

```bash
npm ci          # 或 npm install
npm test        # node:test，60 项测试
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

### 3）均衡年缴净保费 —— `POST /api/v1/premium`

在生命表/利率/保额基础上增加：

```json
{ "productType": "endowment", "years": 3 }
```

- `productType`：`whole-life`（终身寿险，缴到终龄）或 `endowment`（两全，缴到 `years` 满）
- `years`：仅两全必填，整数且 `1 <= years <= 生命表长`；终身险忽略该字段

响应（节选，两全 n=3、保额 100000）：

```json
{
  "productType": "endowment",
  "years": 3,
  "premiumYears": 3,
  "sumInsured": 100000,
  "premium": {
    "perUnit": 0.25854732,
    "annual": 25854.7322,
    "benefitAPVPerUnit": 0.56384,
    "annuityAPVPerUnit": 2.1808,
    "benefitAPV": 56384.0,
    "annuityAPV": 218080.0
  },
  "equivalence": { "residual": 0, "closed": true }
}
```

### 4）逐年净准备金 + 递推关系 —— `POST /api/v1/reserves`

入参与口子三相同。响应给出保费、逐年准备金（往后看 `prospective` 与回算
`retrospective` 两个值及逐年差 `pathDifference`）、把各年串起来的递推段
`recurrence.steps`（每段同时给 `lhs`/`rhs`/`residual`/`closed`），以及闭合检查：

```json
{
  "reserves": [
    { "t": 0, "age": 40, "prospective": 0, "retrospective": 0, "pathDifference": 0 },
    { "t": 1, "age": 41, "prospective": 24798.24, "retrospective": 24798.24, "pathDifference": 2.5e-11 },
    { "t": 2, "age": 42, "prospective": 54145.27, "retrospective": 54145.27, "pathDifference": 2.9e-11 },
    { "t": 3, "age": 43, "prospective": 100000, "retrospective": 100000, "pathDifference": 0 }
  ],
  "recurrence": {
    "formula": "(_t V + P)(1+i) = q_{x+t}*S + p_{x+t}*_(t+1)V",
    "steps": [ ... ],
    "maxAbsResidual": 1.8e-11,
    "closed": true
  },
  "checks": {
    "reserveAtIssue": { "closed": true },
    "maturityReserve": { "value": 100000, "sumInsured": 100000, "closed": true },
    "terminalReserveZero": null,
    "pathsAgree": { "maxAbsDifference": 2.9e-11, "closed": true },
    "recurrenceClosed": true
  }
}
```

终身险时 `maturityReserve` 为 `null`、`terminalReserveZero` 给出期末收敛检查
（序列末项为 0）。回算无定义的年（`_t p_x = 0`）`retrospective` 与
`pathDifference` 为 `null`，不参与两路径比对。

### 示范生命表（手工校算）

- `GET /api/v1/sample-table`：两份示范表（40 岁起、i=25%，v=0.8/d=0.2，手算无压力）
  - `standard-40`：逐年非零，验证恒等式闭合
  - `zero-segment-40`：前三年死亡率全 0，验证定期死亡=0、纯生存退化为纯贴现 v³=0.512

`GET /api/v1/sample-table?id=standard-40` 返回含手算参考值的完整数据，
其中 `handCheck` 同时含保费与逐年准备金参考值（两全 n=3 与终身），
可直接拿 `/api/v1/reserves` 复算对账（测试已钉死）。

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

按年缴费（同一套口径继续算）：

| 产品 | 保费年金 | 均衡年缴保费（单位保额） |
|---|---|---|
| 终身 | `ä_x = 2.567872` | `P_x = 0.4864256/2.567872 = 0.18942751` |
| 两全 n=3 | `ä_{40:3} = 1+0.72+0.4608 = 2.1808` | `P_{40:3} = 0.56384/2.1808 = 0.25854732` |

两全 n=3 逐年净准备金（单位保额；t=0 签单、t=3 满期给付前）：

| t | 年龄 | 往后看 `_t V` | 回算 `_t V` |
|---|------|---------------|-------------|
| 0 | 40 | 0 | 0 |
| 1 | 41 | `A_{41:2} − P·ä_{41:2} = 0.672 − P·1.64 = 0.24798239` | `(P·1 − 0.08)/0.72 = 0.24798239` |
| 2 | 42 | `A_{42:1} − P = 0.8 − P = 0.54145268` | `(P·1.72 − 0.1952)/0.4608` |
| 3 | 43 | `1`（满期生存金） | `(P·2.1808 − 0.28736)/0.27648 = 1` |

终身险（单位保额，t=5 终龄后收敛为 0）：
`0, 0.15198265, 0.28345338, 0.45480149, 0.61057249, 0`。
每段都满足 `(_t V + P)·1.25 = q·1 + p·_(t+1)V`（例如 t=2→3：
`(0.54145268+0.25854732)·1.25 = 0.25 + 0.75·1 = 1`）。

## 非法输入（计算前挡下，HTTP 400 结构化错误）

年龄越界、死亡率超出 [0,1]、终龄死亡率不为 1、利率 `i ≤ -1`（贴现因子非正）、
保额非正、产品形态缺失或非法、保障年限为负或超出表长；**按年缴费保单还拦截
保障年限 0 年（0 年期两全无缴费期、保费年金为 0，无法反解）与缺失**。
响应形如：

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
    discount.js     # v、d 换算与贴现幂次
    survival.js     # 生存概率逐年连乘递推（准备金也共用这一份）
    wholeLife.js    # 终身寿险现值
    annuity.js      # 全期 / n 年定期期初年金现值
    endowment.js    # 定期死亡 / 纯生存 / 两全两个分项
    premium.js      # 均衡年缴净保费反解（P = 给付现值 / 年金现值）
    reserve.js      # 往后看准备金 / 回算准备金 / 递推关系校验
    valuation.js    # 单次请求编排（局部中间量，无共享可变状态）
  validation/
    validate.js     # 参数校验（含产品形态与保单年限）
  http/
    routes.js       # 请求处理层（不含计算口径）
  data/sampleTable.js
  errors.js  app.js  server.js
test/               # 恒等式 / 零死亡率退化 / 利率敏感性 / 保额比例 / 非法入参 /
                    # 保费反解 / 准备金两路径 / 递推闭合 / 满期与期末 / 并发隔离
```

口径不复制：准备金的每一种现值都调用上面同一批 `survival`/`discount`/
`wholeLife`/`annuity`/`endowment` 模块（往后看时对 qx 子表重新跑同一个
`survivalProbabilities` 递推），「趸缴现值」与「准备金递推」不会出现口径漂移。

并发隔离：每次请求在自己的调用栈内新建 `kp`/`deathInYear`/准备金序列等累积量，
无任何模块级可变状态，多张保单并发核算各自的生命表、保费与逐年准备金各算各的、
互不串写（20 路混合产品形态的并发测试钉住）。

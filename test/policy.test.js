// 按年缴费保单测试：均衡净保费、逐年净准备金（往后看/回算）、递推关系、
// 签单与满期闭合、参数校验、HTTP 接口、并发隔离、示范表复算。
import test from 'node:test';
import assert from 'node:assert/strict';

import { survivalProbabilities } from '../src/actuarial/survival.js';
import { temporaryAnnuityDueAPV } from '../src/actuarial/annuity.js';
import {
  wholeLifeNetPremium,
  endowmentNetPremium,
} from '../src/actuarial/premium.js';
import {
  prospectiveReservePerUnit,
  retrospectiveReservePerUnit,
} from '../src/actuarial/reserve.js';
import { valuePremium, valuePolicy } from '../src/actuarial/valuation.js';
import { validatePolicyInput } from '../src/validation/validate.js';
import { ValidationError } from '../src/errors.js';
import { buildApp } from '../src/app.js';

const EPS = 1e-9;
const HAND = 1e-7; // 手算参考值保留 8 位小数的比对容差

// 标准示范表（40 岁起，i=25%，v=0.8，d=0.2）
const STD = { qx: [0.1, 0.2, 0.25, 0.5, 1], i: 0.25 };
// 零死亡率段表：前三年 q=0
const ZERO = { qx: [0, 0, 0, 0.5, 1], i: 0.25 };

const endowmentPolicy = (qx, i, years, sumInsured = 1) =>
  valuePolicy({
    startAge: 40,
    qx,
    interestRate: i,
    productType: 'endowment',
    years,
    sumInsured,
  });
const wholeLifePolicy = (qx, i, sumInsured = 1) =>
  valuePolicy({
    startAge: 40,
    qx,
    interestRate: i,
    productType: 'whole-life',
    sumInsured,
  });

// ---------- 均衡净保费：落在已有现值口径上 ----------

test('均衡净保费 = 给付趸缴现值 / 保费年金现值（不另起口径）', () => {
  const s = survivalProbabilities(STD.qx);
  const wl = wholeLifeNetPremium(s, STD.i);
  const en = endowmentNetPremium(s, STD.i, 3);
  // 分母分子正是服务已有的现值口径
  assert.ok(Math.abs(wl.benefitAPV - 0.4864256) < EPS);
  assert.ok(Math.abs(wl.annuityAPV - 2.567872) < EPS);
  assert.ok(Math.abs(en.benefitAPV - 0.56384) < EPS);
  assert.ok(Math.abs(en.annuityAPV - 2.1808) < EPS); // ä_{40:3} = 1+0.72+0.4608
  // 手算商
  assert.ok(Math.abs(wl.premiumPerUnit - 0.18942751) < HAND);
  assert.ok(Math.abs(en.premiumPerUnit - 0.25854732) < HAND);
});

test('等价原则：P·ä − 给付现值 ≈ 0（签单时点配平）', () => {
  for (const p of [endowmentPolicy(STD.qx, STD.i, 3), wholeLifePolicy(STD.qx, STD.i)]) {
    assert.ok(Math.abs(p.equivalenceResidual) < EPS);
    assert.equal(p.equivalenceClosed, true);
  }
});

test('缴费期口径：终身险缴到终龄（表长），两全缴到保障年限满', () => {
  const wl = valuePremium({
    startAge: 40, qx: STD.qx, interestRate: STD.i,
    productType: 'whole-life', sumInsured: 1,
  });
  assert.equal(wl.premiumYears, STD.qx.length);
  const en = valuePremium({
    startAge: 40, qx: STD.qx, interestRate: STD.i,
    productType: 'endowment', years: 3, sumInsured: 1,
  });
  assert.equal(en.premiumYears, 3);
  // 两全保费年金只数前 3 个年初：1 + 0.9·0.8 + 0.72·0.64
  const s = survivalProbabilities(STD.qx);
  assert.ok(Math.abs(temporaryAnnuityDueAPV(s, STD.i, 3) - 2.1808) < EPS);
  assert.equal(temporaryAnnuityDueAPV(s, STD.i, 0), 0); // 无缴费期
});

// ---------- 逐年净准备金：手算值与闭合关系 ----------

test('两全逐年准备金手算值（标准表 n=3，单位保额）', () => {
  const p = endowmentPolicy(STD.qx, STD.i, 3);
  const expected = [0, 0.24798239, 0.54145268, 1];
  assert.equal(p.reserves.length, 4); // t = 0..3
  p.reserves.forEach((r, t) => {
    assert.equal(r.t, t);
    assert.equal(r.age, 40 + t);
    assert.ok(Math.abs(r.prospective - expected[t]) < HAND,
      `t=${t}: ${r.prospective} != ${expected[t]}`);
  });
});

test('终身险逐年准备金手算值（标准表，单位保额）', () => {
  const p = wholeLifePolicy(STD.qx, STD.i);
  const expected = [0, 0.15198265, 0.28345338, 0.45480149, 0.61057249, 0];
  assert.equal(p.reserves.length, STD.qx.length + 1); // t = 0..5
  p.reserves.forEach((r, t) => {
    assert.ok(Math.abs(r.prospective - expected[t]) < HAND,
      `t=${t}: ${r.prospective} != ${expected[t]}`);
  });
});

test('签单时点准备金为零（等价原则直接后果）', () => {
  for (const p of [
    endowmentPolicy(STD.qx, STD.i, 3, 100000),
    wholeLifePolicy(STD.qx, STD.i, 100000),
    endowmentPolicy(ZERO.qx, ZERO.i, 3, 50000),
  ]) {
    assert.ok(Math.abs(p.reserves[0].prospective) < 1e-6);
    assert.equal(p.checks.reserveAtIssue.closed, true);
  }
});

test('两全满期前一刻准备金恰为保额', () => {
  const S = 100000;
  const p = endowmentPolicy(STD.qx, STD.i, 3, S);
  const last = p.reserves[p.reserves.length - 1];
  assert.ok(Math.abs(last.prospective - S) < 1e-6);
  assert.equal(p.checks.maturityReserve.closed, true);
  assert.ok(Math.abs(p.checks.maturityReserve.value - S) < 1e-6);
});

test('终身险到期末收敛：终龄后准备金为 0，最后一年 (V+P)(1+i) = 保额', () => {
  const S = 100000;
  const p = wholeLifePolicy(STD.qx, STD.i, S);
  const last = p.reserves[p.reserves.length - 1];
  assert.ok(Math.abs(last.prospective) < 1e-6);
  assert.equal(p.checks.terminalReserveZero.closed, true);
  // 最后一段递推：(_4V + P)(1+i) = 1·S + 0·_5V（终龄 q=1）
  const step = p.recurrence.steps[p.recurrence.steps.length - 1];
  assert.ok(Math.abs(step.rhs - S) < 1e-6);
  assert.ok(Math.abs(step.lhs - S) < 1e-6);
  assert.equal(step.fromT, STD.qx.length - 1);
});

test('递推关系逐段闭合：(_tV + P)(1+i) = q·S + p·_(t+1)V', () => {
  for (const p of [
    endowmentPolicy(STD.qx, STD.i, 3, 100000),
    wholeLifePolicy(STD.qx, STD.i, 100000),
    endowmentPolicy(ZERO.qx, ZERO.i, 3, 77777),
    wholeLifePolicy(ZERO.qx, ZERO.i, 12345),
  ]) {
    assert.equal(p.recurrence.steps.length, p.reserves.length - 1);
    assert.equal(p.recurrence.closed, true,
      `maxAbsResidual=${p.recurrence.maxAbsResidual}`);
    for (const s of p.recurrence.steps) {
      assert.equal(s.closed, true, `t=${s.fromT}: residual=${s.residual}`);
    }
  }
});

test('递推手算抽查（标准表两全，S=1）：t=0→1 两端各自独立算', () => {
  const p = endowmentPolicy(STD.qx, STD.i, 3);
  const P = p.perUnit.netPremium;
  const V1 = p.reserves[1].prospective;
  const lhs = (0 + P) * 1.25;
  const rhs = 0.1 * 1 + 0.9 * V1;
  assert.ok(Math.abs(lhs - rhs) < EPS);
  assert.ok(Math.abs(lhs - 0.32318415) < HAND);
});

test('回算路径与往后看路径逐年一致（仅数值误差量级）', () => {
  for (const p of [
    endowmentPolicy(STD.qx, STD.i, 3, 100000),
    wholeLifePolicy(STD.qx, STD.i, 250000),
    endowmentPolicy(ZERO.qx, ZERO.i, 3, 50000),
  ]) {
    assert.equal(p.checks.pathsAgree.closed, true);
    for (const r of p.reserves) {
      if (r.retrospective === null) continue;
      const tol = 1e-9 * Math.max(1, Math.abs(r.prospective));
      assert.ok(Math.abs(r.pathDifference) <= tol,
        `t=${r.t}: pro=${r.prospective} retro=${r.retrospective}`);
    }
  }
});

test('回算口径手算抽查（标准表两全 t=1）：(P·ä_{x:1} − A¹_{x:1}) / _1E_x', () => {
  const s = survivalProbabilities(STD.qx);
  const P = 0.56384 / 2.1808;
  const retro = retrospectiveReservePerUnit({
    survival: s, interestRate: STD.i, premiumPerUnit: P, t: 1,
  });
  // (P·1 − 0.1·0.8) / (0.9·0.8)
  assert.ok(Math.abs(retro - (P - 0.08) / 0.72) < EPS);
  assert.ok(Math.abs(retro - 0.24798239) < HAND);
});

test('往后看口径以当下年龄为新起点：等价于子表重新递推', () => {
  // _1V 用 41 岁起子表 [0.2,0.25,0.5,1] 手算：A_{41:2}=0.672，ä_{41:2}=1.64
  const P = 0.56384 / 2.1808;
  const v1 = prospectiveReservePerUnit({
    qx: STD.qx, interestRate: STD.i, productType: 'endowment',
    termYears: 3, premiumPerUnit: P, t: 1,
  });
  assert.ok(Math.abs(v1 - (0.672 - P * 1.64)) < EPS);
});

test('零死亡率段：准备金 = 保费纯积累（无死亡给付消耗）', () => {
  const p = endowmentPolicy(ZERO.qx, ZERO.i, 3);
  const expected = [0, 0.26229508, 0.59016393, 1];
  p.reserves.forEach((r, t) => {
    assert.ok(Math.abs(r.prospective - expected[t]) < HAND, `t=${t}`);
  });
  // 零死亡段内递推退化为纯利息滚动：(_tV + P)(1+i) = _{t+1}V
  const P = p.perUnit.netPremium;
  assert.ok(Math.abs((0 + P) * 1.25 - p.reserves[1].prospective) < EPS);
});

test('中间死亡率即为 1 的表：回算无定义的年返回 null，往后看与递推仍闭合', () => {
  const qx = [0.1, 1, 0.5, 1]; // 41 岁当年必死，之后无人生存
  const p = wholeLifePolicy(qx, STD.i, 1000);
  // _2p = 0 起回算为 0/0 不定式
  assert.equal(p.reserves[2].retrospective, null);
  assert.equal(p.reserves[3].retrospective, null);
  assert.ok(p.reserves[1].retrospective !== null);
  // 递推仍然逐段闭合（t=1→2 段 rhs = 1·S + 0·V）
  assert.equal(p.recurrence.closed, true);
  const step = p.recurrence.steps[1];
  assert.ok(Math.abs(step.rhs - 1000) < 1e-6);
});

test('两全保障年限取满表长：满期准备金仍为保额，该年回算无定义', () => {
  const p = endowmentPolicy(STD.qx, STD.i, STD.qx.length, 1000);
  const last = p.reserves[p.reserves.length - 1];
  assert.ok(Math.abs(last.prospective - 1000) < 1e-6);
  assert.equal(last.retrospective, null); // _5p = 0
  assert.equal(p.recurrence.closed, true);
  assert.equal(p.checks.maturityReserve.closed, true);
});

test('保额同比例放大：保费与逐年准备金同比例放大', () => {
  const base = endowmentPolicy(STD.qx, STD.i, 3, 1);
  const scaled = endowmentPolicy(STD.qx, STD.i, 3, 50000);
  assert.ok(Math.abs(scaled.money.netPremium - base.perUnit.netPremium * 50000) < 1e-6);
  scaled.reserves.forEach((r, t) => {
    assert.ok(
      Math.abs(r.prospective - base.reserves[t].prospective * 50000) < 1e-6,
      `t=${t}`,
    );
  });
});

// ---------- 参数校验：非法输入在计算前挡下 ----------

const goodPolicy = {
  startAge: 40,
  mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
  interestRate: 0.05,
  productType: 'endowment',
  years: 3,
  sumInsured: 100000,
};

function expectValidation(fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.statusCode, 400);
    assert.ok(err.issues.every((x) => x.field && x.code && x.detail));
    return true;
  });
}

test('保单入参：合法输入通过（两全 / 终身）', () => {
  const e = validatePolicyInput(goodPolicy);
  assert.equal(e.years, 3);
  const w = validatePolicyInput({ ...goodPolicy, productType: 'whole-life', years: undefined });
  assert.equal(w.years, goodPolicy.mortalityRates.length); // 终身缴到终龄
});

test('产品形态非法 / 缺失被挡', () => {
  expectValidation(() => validatePolicyInput({ ...goodPolicy, productType: 'term' }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, productType: undefined }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, productType: 3 }));
});

test('两全保障年限：0 年 / 负值 / 非整数 / 缺失 / 超表长都被挡', () => {
  const mk = (years) => () => validatePolicyInput({ ...goodPolicy, years });
  expectValidation(mk(0)); // 0 年期保单无缴费期，无意义
  expectValidation(mk(-2));
  expectValidation(mk(2.5));
  expectValidation(mk(undefined));
  expectValidation(mk(99)); // 超出生命表覆盖
  assert.doesNotThrow(mk(1));
  assert.doesNotThrow(mk(goodPolicy.mortalityRates.length));
});

test('保单入参沿用既有校验：年龄 / 死亡率 / 利率 / 保额', () => {
  expectValidation(() => validatePolicyInput({ ...goodPolicy, startAge: 130 }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, mortalityRates: [0.1, 2, 1] }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, mortalityRates: [0.1, 0.9] }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, interestRate: -1 }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, sumInsured: 0 }));
});

// ---------- HTTP 接口 ----------

function withApp(run) {
  return async () => {
    const app = buildApp();
    try {
      await run(app);
    } finally {
      await app.close();
    }
  };
}

const premiumBody = {
  startAge: 40,
  mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
  interestRate: 0.25,
  productType: 'endowment',
  years: 3,
  sumInsured: 100000,
};

test('POST /api/v1/premium：均衡净保费（两全）', withApp(async (app) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/premium', payload: premiumBody });
  assert.equal(res.statusCode, 200);
  const j = res.json();
  assert.equal(j.productType, 'endowment');
  assert.equal(j.premiumYears, 3);
  assert.ok(Math.abs(j.premium.perUnit - 0.25854732) < HAND);
  assert.ok(Math.abs(j.premium.annual - 25854.732) < 1e-3);
  assert.ok(Math.abs(j.premium.benefitAPVPerUnit - 0.56384) < EPS);
  assert.ok(Math.abs(j.premium.annuityAPVPerUnit - 2.1808) < EPS);
  assert.equal(j.equivalence.closed, true);
}));

test('POST /api/v1/premium：终身寿险缴到终龄', withApp(async (app) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/premium',
    payload: { ...premiumBody, productType: 'whole-life', years: undefined },
  });
  assert.equal(res.statusCode, 200);
  const j = res.json();
  assert.equal(j.premiumYears, 5);
  assert.ok(Math.abs(j.premium.perUnit - 0.18942751) < HAND);
}));

test('POST /api/v1/reserves：逐年准备金 + 递推 + 闭合校验', withApp(async (app) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/reserves', payload: premiumBody });
  assert.equal(res.statusCode, 200);
  const j = res.json();
  assert.equal(j.reserves.length, 4);
  // 签单为 0、满期为保额
  assert.ok(Math.abs(j.reserves[0].prospective) < 1e-6);
  assert.ok(Math.abs(j.reserves[3].prospective - 100000) < 1e-3);
  // 递推关系随序列一并交出且逐段闭合
  assert.equal(j.recurrence.steps.length, 3);
  assert.equal(j.recurrence.closed, true);
  assert.equal(j.checks.reserveAtIssue.closed, true);
  assert.equal(j.checks.maturityReserve.closed, true);
  assert.equal(j.checks.pathsAgree.closed, true);
  // 两路径逐年数值一致
  for (const r of j.reserves) {
    assert.ok(Math.abs(r.pathDifference) < 1e-3);
  }
}));

test('POST /api/v1/reserves：非法年限口径返回 400 结构化错误', withApp(async (app) => {
  const cases = [
    { ...premiumBody, years: 0 },
    { ...premiumBody, years: -1 },
    { ...premiumBody, years: 99 },
    { ...premiumBody, years: undefined },
    { ...premiumBody, productType: 'whole-life-plus' },
  ];
  for (const payload of cases) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/reserves', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    const j = res.json();
    assert.equal(j.error, 'VALIDATION_FAILED');
    assert.ok(j.issues.length > 0);
  }
  // premium 口子同样拦截
  const res = await app.inject({
    method: 'POST', url: '/api/v1/premium', payload: { ...premiumBody, years: 0 },
  });
  assert.equal(res.statusCode, 400);
}));

test('并发核算：多张保单各自的保费与逐年准备金互不串写', withApp(async (app) => {
  const requests = [];
  const N = 20;
  for (let k = 0; k < N; k++) {
    const isEndowment = k % 2 === 0;
    requests.push(
      app.inject({
        method: 'POST',
        url: '/api/v1/reserves',
        payload: {
          startAge: 40 + (k % 30),
          mortalityRates: [(k % 5) * 0.02 + 0.01, 0.3, 1],
          interestRate: 0.01 * (k + 1),
          productType: isEndowment ? 'endowment' : 'whole-life',
          years: isEndowment ? 1 + (k % 3) : undefined,
          sumInsured: 1000 * (k + 1),
        },
      }),
    );
  }
  const responses = await Promise.all(requests);
  responses.forEach((res, k) => {
    assert.equal(res.statusCode, 200, `第 ${k} 个请求失败: ${res.body}`);
    const j = res.json();
    const isEndowment = k % 2 === 0;
    const S = 1000 * (k + 1);
    // 回显与各自请求一致
    assert.equal(j.sumInsured, S);
    assert.equal(j.years, isEndowment ? 1 + (k % 3) : 3);
    assert.ok(Math.abs(j.interestRate - 0.01 * (k + 1)) < 1e-12);
    // 金额口径 = 单位口径 × 自己的保额
    assert.ok(Math.abs(j.premium.annual - j.premium.perUnit * S) < 1e-6);
    // 每张保单自己的闭合关系都成立
    assert.equal(j.recurrence.closed, true, `第 ${k} 张保单递推未闭合`);
    assert.ok(Math.abs(j.reserves[0].prospective) < 1e-6);
    if (isEndowment) {
      assert.ok(Math.abs(j.reserves[j.reserves.length - 1].prospective - S) < 1e-6);
    } else {
      assert.ok(Math.abs(j.reserves[j.reserves.length - 1].prospective) < 1e-6);
    }
  });
}));

// ---------- 示范表复算 ----------

test('示范表复算：standard-40 的保费与逐年准备金与手算参考值一致', withApp(async (app) => {
  const tableRes = await app.inject({
    method: 'GET', url: '/api/v1/sample-table?id=standard-40',
  });
  const table = tableRes.json();
  const base = {
    startAge: table.startAge,
    mortalityRates: table.mortalityRates,
    interestRate: table.interestRate,
    sumInsured: 1,
  };
  // 两全 n=3
  const e = await app.inject({
    method: 'POST', url: '/api/v1/reserves',
    payload: { ...base, productType: 'endowment', years: table.suggestedYears },
  }).then((r) => r.json());
  assert.ok(Math.abs(e.premium.perUnit - table.handCheck.premiumEndowment3) < HAND);
  e.reserves.forEach((r, t) => {
    assert.ok(Math.abs(r.prospective - table.handCheck.reservesEndowment3[t]) < HAND,
      `endowment t=${t}`);
  });
  // 终身
  const w = await app.inject({
    method: 'POST', url: '/api/v1/reserves',
    payload: { ...base, productType: 'whole-life' },
  }).then((r) => r.json());
  assert.ok(Math.abs(w.premium.perUnit - table.handCheck.premiumWholeLife) < HAND);
  w.reserves.forEach((r, t) => {
    assert.ok(Math.abs(r.prospective - table.handCheck.reservesWholeLife[t]) < HAND,
      `whole-life t=${t}`);
  });
}));

test('示范表复算：zero-segment-40 零死亡段准备金为纯积累', withApp(async (app) => {
  const table = (await app.inject({
    method: 'GET', url: '/api/v1/sample-table?id=zero-segment-40',
  })).json();
  const j = await app.inject({
    method: 'POST', url: '/api/v1/reserves',
    payload: {
      startAge: table.startAge,
      mortalityRates: table.mortalityRates,
      interestRate: table.interestRate,
      productType: 'endowment',
      years: table.suggestedYears,
      sumInsured: 1,
    },
  }).then((r) => r.json());
  assert.ok(Math.abs(j.premium.perUnit - table.handCheck.premiumEndowment3) < HAND);
  j.reserves.forEach((r, t) => {
    assert.ok(Math.abs(r.prospective - table.handCheck.reservesEndowment3[t]) < HAND,
      `t=${t}`);
  });
}));

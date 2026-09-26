// HTTP 接口测试：两个核算口子、结构化错误、示范表、并发请求互不串写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { buildApp } from '../src/app.js';
import { valuePolicy } from '../src/actuarial/policy.js';

const EPS = 1e-9;

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

test('GET /health', withApp(async (app) => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
}));

test('GET /api/v1/sample-table 返回示范表', withApp(async (app) => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/sample-table' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().tables.length >= 2);
}));

test('POST /api/v1/life-table：终身寿险 + 年金，恒等式闭合', withApp(async (app) => {
  const body = {
    startAge: 40,
    mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
    interestRate: 0.25,
  };
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/life-table',
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  const j = res.json();
  assert.ok(Math.abs(j.wholeLifeInsuranceAPV - 0.4864256) < EPS);
  assert.ok(Math.abs(j.annuityDueAPV - 2.567872) < EPS);
  assert.ok(Math.abs(j.discountRate - 0.2) < EPS);
  assert.ok(Math.abs(j.identity.residual) < EPS);
  assert.equal(j.identity.closed, true);
}));

test('POST /api/v1/endowment：两全净保费及两个分项（单位与金额口径）', withApp(async (app) => {
  const body = {
    startAge: 40,
    mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
    interestRate: 0.25,
    years: 3,
    sumInsured: 100000,
  };
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/endowment',
    payload: body,
  });
  assert.equal(res.statusCode, 200);
  const j = res.json();
  assert.ok(Math.abs(j.perUnit.termInsuranceAPV - 0.28736) < EPS);
  assert.ok(Math.abs(j.perUnit.pureEndowmentAPV - 0.27648) < EPS);
  assert.ok(Math.abs(j.perUnit.endowmentNetPremium - 0.56384) < EPS);
  assert.ok(Math.abs(j.money.endowmentNetPremium - 56384) < 1e-6);
  // 净保费 = 两个分项之和
  assert.ok(
    Math.abs(
      j.money.endowmentNetPremium -
        (j.money.termInsurance + j.money.pureEndowment),
    ) < 1e-6,
  );
}));

test('零死亡率段表走接口：定期为 0、纯生为纯贴现', withApp(async (app) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/endowment',
    payload: {
      startAge: 40,
      mortalityRates: [0, 0, 0, 0.5, 1],
      interestRate: 0.25,
      years: 3,
      sumInsured: 100000,
    },
  });
  assert.equal(res.statusCode, 200);
  const j = res.json();
  assert.equal(j.money.termInsurance, 0);
  assert.ok(Math.abs(j.perUnit.pureEndowmentAPV - 0.512) < EPS);
}));

test('非法入参返回 400 结构化错误且含清晰说明', withApp(async (app) => {
  const cases = [
    { startAge: -1, mortalityRates: [1], interestRate: 0.05 },
    { startAge: 40, mortalityRates: [0.1, 0.9], interestRate: 0.05 }, // 终龄 q≠1
    { startAge: 40, mortalityRates: [1], interestRate: -1 },
  ];
  for (const payload of cases) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/life-table',
      payload,
    });
    assert.equal(res.statusCode, 400);
    const j = res.json();
    assert.equal(j.error, 'VALIDATION_FAILED');
    assert.ok(Array.isArray(j.issues) && j.issues.length > 0);
    assert.ok(j.issues[0].detail.length > 0);
  }
}));

test('endowment 保额非正返回 400', withApp(async (app) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/endowment',
    payload: {
      startAge: 40,
      mortalityRates: [0.1, 1],
      interestRate: 0.05,
      years: 1,
      sumInsured: 0,
    },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'VALIDATION_FAILED');
}));

test('POST /api/v1/policy：两全保单均衡保费 + 逐年准备金', withApp(async (app) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/policy',
    payload: {
      startAge: 40,
      mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
      interestRate: 0.25,
      sumInsured: 100000,
      productType: 'endowment',
      years: 3,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json();

  // 均衡保费：P = 0.56384 / 2.1808 = 0.25854732...
  assert.ok(Math.abs(j.netPremium.perUnit - 0.25854732) < 1e-7);
  assert.ok(Math.abs(j.netPremium.annual - (0.56384 / 2.1808) * 100000) < 1e-6);
  assert.equal(j.netPremium.equivalence.closed, true);
  assert.equal(j.product.type, 'endowment');
  assert.equal(j.product.premiumYears, 3);

  // 准备金序列：3 年，末点满期前正好压着保额
  assert.equal(j.reserves.length, 3);
  assert.deepEqual(j.reserves.map((r) => r.year), [1, 2, 3]);
  assert.deepEqual(j.reserves.map((r) => r.attainedAge), [41, 42, 43]);
  assert.ok(Math.abs(j.reserves[0].perUnit.prospective - 0.2479824) < 1e-6);
  assert.ok(Math.abs(j.reserves[1].perUnit.prospective - 0.5414527) < 1e-6);
  assert.ok(Math.abs(j.reserves[2].prospective - 100000) < 1e-6);

  // 签单时点准备金为零
  assert.ok(Math.abs(j.initialReserve) < 1e-6);

  // 所有闭合检查通过：递推、双口径一致、满期
  for (const check of Object.values(j.checks)) {
    assert.equal(check.passed, true, JSON.stringify(check));
  }
  // 回算口径与往后看逐年对得上
  for (const r of j.reserves) {
    assert.ok(Math.abs(r.prospective - r.retrospective) < 1e-6);
  }
}));

test('POST /api/v1/policy：终身寿险准备金排到终龄、末点收敛为 0', withApp(async (app) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/policy',
    payload: {
      startAge: 40,
      mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
      interestRate: 0.25,
      sumInsured: 100000,
      productType: 'wholeLife',
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json();

  assert.equal(j.product.type, 'wholeLife');
  assert.equal(j.product.premiumYears, 5);
  assert.equal(j.reserves.length, 5);
  assert.ok(Math.abs(j.netPremium.perUnit - 0.18942751) < 1e-7);
  assert.ok(Math.abs(j.reserves[3].perUnit.prospective - 0.6105725) < 1e-6);
  // 终龄年所有死亡给付了结，准备金归零
  assert.ok(Math.abs(j.reserves[4].prospective) < EPS);
  // 最后一个回算点为边界补齐（终龄后无生存者）
  assert.equal(j.reserves[4].retrospectiveBoundaryFilled, true);
  for (const check of Object.values(j.checks)) {
    assert.equal(check.passed, true, JSON.stringify(check));
  }
}));

test('POST /api/v1/policy：零死亡率段表也能逐年复算', withApp(async (app) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/policy',
    payload: {
      startAge: 40,
      mortalityRates: [0, 0, 0, 0.5, 1],
      interestRate: 0.25,
      sumInsured: 1,
      productType: 'endowment',
      years: 3,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json();
  assert.ok(Math.abs(j.netPremium.perUnit - 0.2098361) < 1e-6);
  assert.ok(Math.abs(j.reserves[0].perUnit.prospective - 0.2622951) < 1e-6);
  assert.ok(Math.abs(j.reserves[2].prospective - 1) < 1e-9);
}));

test('POST /api/v1/policy：新增非法口径在计算前挡下（400 结构化）', withApp(async (app) => {
  const badCases = [
    { productType: 'term', years: 3 }, // 产品形态非法
    { productType: 'endowment', years: 0 }, // 年缴口径不允许 0 年期
    { productType: 'endowment', years: -1 }, // 负年限
    { productType: 'endowment', years: 2.5 }, // 非整数
    { productType: 'endowment', years: 99 }, // 超出生命表覆盖
    { productType: 'endowment' }, // 两全缺年限
    { productType: 'endowment', years: 3, sumInsured: 0 }, // 保额非正
  ];
  for (const override of badCases) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/policy',
      payload: {
        startAge: 40,
        mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
        interestRate: 0.25,
        sumInsured: 100000,
        ...override,
      },
    });
    assert.equal(res.statusCode, 400, JSON.stringify(override));
    const j = res.json();
    assert.equal(j.error, 'VALIDATION_FAILED');
    assert.ok(j.issues.length > 0);
    assert.ok(j.issues.every((x) => x.field && x.code && x.detail));
  }
}));

test('非法 JSON 返回 400 结构化错误', withApp(async (app) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/life-table',
    headers: { 'content-type': 'application/json' },
    payload: '{ not json',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'BAD_REQUEST');
}));

test('未知路径返回 404', withApp(async (app) => {
  const res = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'NOT_FOUND');
}));

test('并发核算：不同生命表与利率的请求互不串写', withApp(async (app) => {
  const requests = [];
  // 同一时刻灌进多份不同表 / 不同利率 / 不同保额，结果必须各自独立
  for (let k = 0; k < 20; k++) {
    const q = [(k % 5) * 0.02 + 0.01, 0.3, 1];
    requests.push(
      app.inject({
        method: 'POST',
        url: '/api/v1/endowment',
        payload: {
          startAge: 40 + (k % 30),
          mortalityRates: q,
          interestRate: 0.01 * (k + 1),
          years: 1 + (k % 2),
          sumInsured: 1000 * (k + 1),
        },
      }),
    );
  }
  const responses = await Promise.all(requests);
  responses.forEach((res, k) => {
    assert.equal(res.statusCode, 200, `第 ${k} 个请求失败: ${res.body}`);
    const j = res.json();
    // 每份响应的回显参数必须与它自己的请求一致（无共享状态串写）
    assert.equal(j.sumInsured, 1000 * (k + 1));
    assert.equal(j.years, 1 + (k % 2));
    assert.ok(Math.abs(j.interestRate - 0.01 * (k + 1)) < 1e-12);
    // 金额口径 = 单位口径 × 该请求自己的保额
    assert.ok(
      Math.abs(
        j.money.endowmentNetPremium -
          j.perUnit.endowmentNetPremium * j.sumInsured,
      ) < 1e-6,
    );
  });
}));

test('并发保单核算：各自的保费与逐年准备金各算各的', withApp(async (app) => {
  // 构造 24 张互不相同的保单：不同生命表 / 利率 / 保额 / 产品形态
  const specs = [];
  for (let k = 0; k < 24; k++) {
    const qx = [
      (k % 4) * 0.03 + 0.01,
      (k % 3) * 0.1 + 0.05,
      0.4,
      1,
    ];
    const isEndowment = k % 2 === 0;
    specs.push({
      startAge: 35 + (k % 20),
      mortalityRates: qx,
      interestRate: 0.02 + 0.005 * k,
      sumInsured: 5000 * (k + 1),
      productType: isEndowment ? 'endowment' : 'wholeLife',
      years: isEndowment ? 1 + (k % qx.length) : undefined,
    });
  }

  const responses = await Promise.all(
    specs.map((payload) => app.inject({
      method: 'POST',
      url: '/api/v1/policy',
      payload,
    })),
  );

  responses.forEach((res, k) => {
    assert.equal(res.statusCode, 200, `第 ${k} 张保单核算失败: ${res.body}`);
    const j = res.json();
    const spec = specs[k];

    // 回显与各自请求严格一致
    assert.equal(j.sumInsured, spec.sumInsured);
    assert.equal(j.startAge, spec.startAge);
    assert.ok(Math.abs(j.interestRate - spec.interestRate) < 1e-12);
    assert.equal(j.product.type, spec.productType);

    // 用同一份入参在本地独立重算，响应必须与之逐点一致
    const expected = valuePolicy({
      qx: spec.mortalityRates,
      interestRate: spec.interestRate,
      sumInsured: spec.sumInsured,
      product: spec.productType === 'endowment'
        ? { type: 'endowment', years: spec.years }
        : { type: 'wholeLife' },
    });
    assert.ok(Math.abs(j.netPremium.annual - expected.netPremium.annual) < 1e-9);
    assert.equal(j.reserves.length, expected.reserves.length);
    expected.reserves.forEach((e, idx) => {
      assert.ok(
        Math.abs(j.reserves[idx].prospective - e.prospective) < 1e-9,
        `第 ${k} 张保单第 ${idx + 1} 年准备金被串写`,
      );
      assert.ok(
        Math.abs(j.reserves[idx].retrospective - e.retrospective) < 1e-9,
      );
    });

    // 每张保单自己的闭合检查都必须通过
    for (const check of Object.values(j.checks)) {
      assert.equal(check.passed, true, `第 ${k} 张保单: ${JSON.stringify(check)}`);
    }
  });
}));

test('真实 HTTP 监听也能正常服务（listen + fetch）', async () => {
  const app = buildApp();
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  } finally {
    await app.close();
  }
});

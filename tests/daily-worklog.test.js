/* daily-worklog 端到端逻辑自测：在 Node 里用 mock DOM 实际执行整个 <script>。
 * 零依赖（仅用 Node 内置 fs / vm / assert），可直接 `node tests/daily-worklog.test.js` 运行。
 * 可选对照：设置环境变量 DW_ORIG 指向修复前的 html 副本（如 /tmp/daily-worklog.orig.html），
 *          即可在若干用例里同时校验「旧版 vs 新版」差异；不设则只验证当前版本行为。 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const FILE = path.join(__dirname, '..', 'daily-worklog.html');
const ORIG = process.env.DW_ORIG || '/tmp/daily-worklog.orig.html';
const codeOf = p => fs.readFileSync(p, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const NEW_CODE = codeOf(FILE);
const OLD_CODE = fs.existsSync(ORIG) ? codeOf(ORIG) : null;
const hasOld = !!OLD_CODE;

const pad = n => String(n).padStart(2, '0');
const dstr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const d0 = new Date(); d0.setHours(0, 0, 0, 0);
const at = (dayOffset, hour) => new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + dayOffset, hour).getTime();
const ds = off => {
  const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + off);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const H = 3600;

function mkEl() {
  const e = {
    textContent: '', value: '', hidden: false, title: '', className: '', _html: '',
    open: false, offsetWidth: 1, checked: undefined, _val: undefined, _init: false, _raf: 0,
    dataset: {}, style: {}, children: [], _handlers: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this._handlers[ev] ||= []).push(fn); },
    removeEventListener() {},
    querySelector() { return mkEl(); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, height: 0 }; },
    focus() {}, select() {}, click() {}, remove() {}, setAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }
  };
  /* 真实 DOM 里 innerHTML='' 会清空子节点，mock 里对齐，便于断言渲染出的卡片 */
  Object.defineProperty(e, 'innerHTML', {
    get() { return e._html; },
    set(v) { e._html = v; e.children.length = 0; }
  });
  return e;
}

function boot(code, seed, sharedStore) {
  const store = sharedStore || new Map(seed || []);
  const els = new Map();
  const intervals = [];
  const globalHandlers = {};
  let editingEl = null;
  const getEl = k => { if (!els.has(k)) els.set(k, mkEl()); return els.get(k); };
  const document = {
    querySelector: sel => sel === '.rename-input, .note-input' ? editingEl : getEl(sel),
    getElementById: id => getEl('#' + id),
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    documentElement: mkEl(), body: mkEl(),
    addEventListener() {}, visibilityState: 'visible', title: ''
  };
  const sandbox = {
    document,
    localStorage: {
      getItem: k => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    matchMedia: () => ({ matches: false }),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    setTimeout: () => 1, clearTimeout: () => {},
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    addEventListener: (ev, fn) => { (globalHandlers[ev] ||= []).push(fn); },
    removeEventListener: () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    Blob: class {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    console
  };
  sandbox.window = {};
  const probe = '\n;window.__probe = { todayTotal, dayTotalOf, buildReport, elapsedOf, inWorkTime,'
              + ' fmtDur, fmtReport, fmtClock, buildCsv, segmentWorkMs, tickDynamic,'
              + ' dayRange: (typeof dayRange !== "undefined" ? dayRange : null),'
              + ' dayRows: (typeof dayRows !== "undefined" ? dayRows : null),'
              + ' taskSecondsOn: (typeof taskSecondsOn !== "undefined" ? taskSecondsOn : null),'
              + ' invalidateDayIndex: (typeof invalidateDayIndex !== "undefined" ? invalidateDayIndex : null),'
              + ' buildDayIndex: (typeof buildDayIndex !== "undefined" ? buildDayIndex : null) };';
  vm.runInNewContext(code + probe, sandbox, { filename: 'daily-worklog.html' });
  return { wl: sandbox.window.__wl, probe: sandbox.window.__probe,
           getEl, store, intervals, document, globalHandlers,
           setEditing: v => { editingEl = v; } };
}

/* 造一组跨天数据：A 跨零点、B 今日、C 三天前创建但今天又做了一轮 */
function crossDayTasks() {
  return [
    { id: 'A', name: '跨零点任务', note: '', date: ds(-1), status: 'paused',
      segments: [{ start: at(-1, 23), end: at(0, 1) }], manualAdjustSeconds: 0,
      createdAt: at(-1, 23), doneAt: null },
    { id: 'B', name: '今日任务', note: '', date: ds(0), status: 'done',
      segments: [{ start: at(0, 9), end: at(0, 10) }], manualAdjustSeconds: 0,
      createdAt: at(0, 9), doneAt: at(0, 10) },
    { id: 'C', name: '历史任务再来一轮', note: '', date: ds(-3), status: 'done',
      segments: [{ start: at(-3, 10), end: at(-3, 11) }, { start: at(0, 11), end: at(0, 12) }],
      manualAdjustSeconds: 0, createdAt: at(-3, 10), doneAt: at(0, 12) }
  ];
}

const mkTask = (id, start, end, extra) => Object.assign({
  id, name: '任务' + id, note: '', date: dstr(new Date(start)), status: 'done',
  segments: [{ start, end }], manualAdjustSeconds: 0, createdAt: start, doneAt: end
}, extra || {});

const results = [];
const check = (name, fn) => { fn(); results.push(name); };

(async () => {
  /* ── 1. 初始化不抛错，__wl 可用 ── */
  let env;
  check('T1 冷启动初始化 + renderAll 无异常', () => {
    env = boot(NEW_CODE);
    assert.ok(env.wl && env.probe, '__wl / __probe 未挂出');
    env.wl.renderAll();
  });

  /* ── 2. B 方案：跨零点 / 历史任务按自然日归属，并与原版对比（可选） ── */
  check('T2 今日投入跨天逐日归属正确', () => {
    const e = boot(NEW_CODE);
    e.wl.state.tasks = crossDayTasks();
    assert.strictEqual(e.probe.todayTotal(), 3 * H, '今日应为 3h');
    assert.strictEqual(e.probe.dayTotalOf(ds(-1)), H, '昨日应为 1h');
    assert.strictEqual(e.probe.dayTotalOf(ds(-3)), H, '3天前应为 1h');
    assert.strictEqual(Math.round(e.probe.taskSecondsOn(e.wl.state.tasks[0], ds(0))), H,
      '跨零点段应拆 1h 给今天');
    if (hasOld) {
      const o = boot(OLD_CODE);
      o.wl.state.tasks = crossDayTasks();
      const oldTotal = o.probe.todayTotal();
      assert.strictEqual(oldTotal, H, '原版应只统计到 1h');
      console.log('   · 修复前 todayTotal = ' + (oldTotal / H) + 'h → 修复后 = ' + (e.probe.todayTotal() / H) + 'h');
    } else console.log('   · （跳过旧版对照）修复后 todayTotal = ' + (e.probe.todayTotal() / H) + 'h');
  });

  /* ── 3. 日报明细与总计同源、加总自洽 ── */
  check('T3 日报明细与「今日总投入」加总自洽', () => {
    const e = boot(NEW_CODE);
    e.wl.state.tasks = crossDayTasks();
    const rep = e.probe.buildReport();
    assert.ok(rep.includes('今日总投入 3 小时 0 分钟'), '总计应为 3h');
    assert.ok(rep.includes('1. 今日任务（1 小时 0 分钟）'), '应包含今日 done 明细');
    assert.ok(rep.includes('历史任务再来一轮（1 小时 0 分钟）'), '应包含跨天 done 明细');
    assert.ok(rep.includes('跨零点任务（1 小时 0 分钟'), '应包含跨零点 active 明细');
  });

  /* ── 4. P0：空 segments 的 paused 任务不再让 renderAll 抛错 ── */
  check('T4 空 segments 记录渲染不崩（原 P0）', () => {
    const e = boot(NEW_CODE);
    e.wl.state.tasks.push({ id: 'empty', name: '空段', note: '', date: ds(0), status: 'paused',
      segments: [], manualAdjustSeconds: 0, createdAt: Date.now(), doneAt: null });
    e.wl.renderAll();
    assert.strictEqual(e.wl.state.tasks.length, 1);
    if (hasOld) {
      let oldThrew = false;
      try {
        const o = boot(OLD_CODE);
        o.wl.state.tasks.push({ id: 'empty', name: '空段', note: '', date: ds(0), status: 'paused',
          segments: [], manualAdjustSeconds: 0, createdAt: Date.now(), doneAt: null });
        o.wl.renderAll();
      } catch (err) { oldThrew = true; }
      assert.strictEqual(oldThrew, true, '原版应确实抛错，否则用例无效');
      console.log('   · 原版 renderAll 抛错 = ' + oldThrew + ' → 新版无异常');
    } else console.log('   · （跳过旧版对照）新版空段渲染无异常');
  });

  /* ── 5. P0 链路：备份含 end:null 运行段 + done，导入合并后不崩且状态保留 ── */
  await (async () => {
    const e = boot(NEW_CODE);
    const backup = { version: 1, exportedAt: Date.now(), tasks: [
      { id: 'imp1', name: '导入运行项', note: '', date: ds(0), status: 'running',
        segments: [{ start: at(0, 9), end: null }], manualAdjustSeconds: 0,
        createdAt: at(0, 9), doneAt: null },
      { id: 'imp2', name: '导入完成项', note: '', date: ds(-1), status: 'done',
        segments: [{ start: at(-1, 10), end: at(-1, 11) }], manualAdjustSeconds: 0,
        createdAt: at(-1, 10), doneAt: at(-1, 11) }
    ] };
    const evt = { target: { files: [{ text: async () => JSON.stringify(backup) }], value: '' } };
    await e.getEl('#bkFile')._handlers.change[0](evt);
    e.getEl('#impMerge')._handlers.click[0]();
    assert.strictEqual(e.wl.state.tasks.length, 2, '应导入 2 条');
    const t1 = e.wl.state.tasks.find(t => t.id === 'imp1');
    const t2 = e.wl.state.tasks.find(t => t.id === 'imp2');
    assert.strictEqual(t1.segments.length, 1, '运行段不应被丢弃');
    assert.ok(t1.segments[0].end > t1.segments[0].start, '运行段应已封口');
    assert.strictEqual(t1.status, 'paused', 'running 应降为 paused');
    assert.strictEqual(t2.status, 'done', 'done 状态应保留');
    results.push('T5 导入备份（含运行中段）不崩、段不丢、done 状态保留');
    console.log('   · 导入后 imp1 segments=' + t1.segments.length + ' status=' + t1.status
      + ' / imp2 status=' + t2.status);
  })();

  /* ── 6. 目标进度条与百分比同源 ── */
  check('T6 goalHours=4 时进度条与百分比一致（均为 75%）', () => {
    const e = boot(NEW_CODE);
    e.wl.state.tasks = crossDayTasks();
    e.wl.state.settings.goalHours = 4;
    e.wl.renderAll();
    const tick = e.intervals.find(i => i.ms === 500).fn;
    tick();
    assert.strictEqual(e.getEl('#goalFill').style.width, '75%', '进度条应按 4h 算');
    assert.strictEqual(e.getEl('#goalPct').textContent, '75%', '百分比文字应同源');
    if (hasOld) {
      const o = boot(OLD_CODE);
      o.wl.state.tasks = crossDayTasks();
      o.wl.state.settings.goalHours = 4;
      o.wl.renderAll();
      o.intervals.find(i => i.ms === 500).fn();
      console.log('   · 原版 goalFill=' + o.getEl('#goalFill').style.width
        + ' goalPct=' + o.getEl('#goalPct').textContent + ' → 新版均为 75%');
    } else console.log('   · （跳过旧版对照）新版 goalFill/goalPct 均为 75%');
  });

  /* ── 7. 设置 7.5 小时不被吞成 8 ── */
  check('T7 每日目标 7.5h 保留小数', () => {
    const e = boot(NEW_CODE);
    e.getEl('#setGoal').value = '7.5';
    e.getEl('#setSave')._handlers.click[0]();
    assert.strictEqual(e.wl.state.settings.goalHours, 7.5);
  });

  /* ── 8. 关页/休眠心跳封口，不再虚增 63 小时 ── */
  check('T8 关闭 3 天后重开，运行段封口到 1h 而非虚增', () => {
    const start = Date.now() - 3 * 864e5;
    const seen = start + H * 1000;
    const seed = [
      ['daily-worklog.v1', JSON.stringify({ theme: null, lastBackupAt: null, settings: {}, tasks: [
        { id: 'x', name: '关页任务', note: '', date: ds(0), status: 'running',
          segments: [{ start, end: null }], manualAdjustSeconds: 0, createdAt: start, doneAt: null }
      ] })],
      ['daily-worklog.v1.seen', String(seen)]
    ];
    const e = boot(NEW_CODE, seed);
    const t = e.wl.state.tasks[0];
    assert.strictEqual(t.status, 'paused', '应自动置为暂停');
    assert.ok(t.segments[0].end != null, 'open 段应封口');
    const sec = Math.round(e.probe.elapsedOf(t) / H);
    assert.strictEqual(sec, 1, '计时应为 1h');
    console.log('   · 封口后 elapsedOf = ' + sec + 'h（原逻辑会是 72h）');
  });

  /* ── 9. 确认弹窗文案按场景切换 ── */
  check('T9 覆盖导入复用确认框时标题/按钮文案正确', () => {
    const e = boot(NEW_CODE);
    const html = fs.readFileSync(FILE, 'utf8');
    assert.ok(html.includes('id="confirmTitle"'), '标题应可编程改写');
    assert.ok(html.includes("title: '覆盖导入确认'"), '应传入场景文案');
    assert.ok(e.wl, '代码可执行');
  });

  /* ── 11. 跨天遗留任务不再出现在今日事项，归档到历史记录 ── */
  check('T11 11/6 遗留 paused 任务在 11/9 归历史、今日事项只留当天', () => {
    const e = boot(NEW_CODE);
    e.wl.state.tasks = [
      { id: 'old', name: '11/6 遗留', note: '', date: ds(-3), status: 'paused',
        segments: [{ start: at(-3, 10), end: at(-3, 11) }], manualAdjustSeconds: 0,
        createdAt: at(-3, 10), doneAt: null },
      { id: 'today', name: '今日事项', note: '', date: ds(0), status: 'paused',
        segments: [{ start: at(0, 9), end: at(0, 10) }], manualAdjustSeconds: 0,
        createdAt: at(0, 9), doneAt: null }
    ];
    e.wl.renderAll();
    const cards = e.getEl('#activeList').children;
    assert.strictEqual(cards.length, 1, '今日事项应只剩 1 张卡片');
    assert.strictEqual(cards[0].dataset.taskId, 'today', '留下的应是当天任务');
    assert.strictEqual(e.getEl('#historySection').hidden, false, '历史记录区应显示');
    assert.strictEqual(e.getEl('#histMeta').textContent, '1 天');
    if (hasOld) {
      const o = boot(OLD_CODE);
      o.wl.state.tasks = e.wl.state.tasks;
      o.wl.renderAll();
      console.log('   · 原版今日事项卡片数 = ' + o.getEl('#activeList').children.length
        + ' → 新版 = ' + cards.length + '，历史区 ' + e.getEl('#histMeta').textContent);
    } else console.log('   · 新版今日事项 ' + cards.length + ' 张，历史区 ' + e.getEl('#histMeta').textContent);
  });

  /* ── 12. 7h59m / 8h 边界：只修显示取整，计时数据分毫不动 ── */
  check('T12 7:59:59.x 稳定显示 8h00m，fmtClock 保持秒级，elapsedOf 不变', () => {
    const e = boot(NEW_CODE);
    if (hasOld) {
      const o = boot(OLD_CODE);
      assert.strictEqual(o.probe.fmtDur(28799.4), '7h 59m', '原版应能复现 7h59m');
      assert.strictEqual(o.probe.fmtReport(28799.4), '7 小时 59 分钟', '日报同样受影响');
      assert.strictEqual(e.probe.elapsedOf({ manualAdjustSeconds: 0, segments: [{ start: 1000, end: 1000 + 28799400 }] }),
                         o.probe.elapsedOf({ manualAdjustSeconds: 0, segments: [{ start: 1000, end: 1000 + 28799400 }] }),
                         '计时数据必须与原版完全一致');
      console.log('   · 原版 fmtDur(7:59:59.4)=' + o.probe.fmtDur(28799.4)
        + ' → 新版 ' + e.probe.fmtDur(28799.4) + '，elapsedOf 与原版一致');
    } else console.log('   · （跳过旧版对照）新版 fmtDur(7:59:59.4)=' + e.probe.fmtDur(28799.4));
    assert.strictEqual(e.probe.fmtDur(28799.4), '8h 00m');
    assert.strictEqual(e.probe.fmtDur(28799.6), '8h 00m');
    assert.strictEqual(e.probe.fmtReport(28799.4), '8 小时 0 分钟');
    assert.strictEqual(e.probe.fmtDur(30), '30s', '短时长仍按秒显示');
    assert.strictEqual(e.probe.fmtClock(28799.4), '07:59:59', '秒级时钟不应被改动');
    assert.strictEqual(e.probe.elapsedOf({ manualAdjustSeconds: 0, segments: [{ start: 1000, end: 1000 + 28799400 }] }), 28799.4);
  });

  /* ── 13. 多标签页：各自新增不再互相覆盖 ── */
  check('T13 两个标签页各自新增任务，写回后两条都在', () => {
    const shared = new Map();
    const a = boot(NEW_CODE, null, shared), b = boot(NEW_CODE, null, shared);
    a.wl.state.tasks.push(mkTask('fromA', at(0, 9), at(0, 10)));
    a.wl.save();
    b.wl.state.tasks.push(mkTask('fromB', at(0, 11), at(0, 12)));
    b.wl.save();
    const final = JSON.parse(shared.get('daily-worklog.v1'));
    assert.ok(final.tasks.some(t => t.id === 'fromA'), 'A 的新增不能丢');
    assert.ok(final.tasks.some(t => t.id === 'fromB'), 'B 的新增不能丢');
    assert.strictEqual(final.tasks.length, 2);
    console.log('   · 两次独立写回后共 ' + final.tasks.length + ' 条（原实现后写会只剩 1 条）');
  });

  /* ── 14. 删除墓碑：另一标签页旧快照写回不能复活已删记录 ── */
  check('T14 删除记录不会被另一标签页的旧副本复活', () => {
    const shared = new Map();
    const a = boot(NEW_CODE, null, shared), b = boot(NEW_CODE, null, shared);
    a.wl.state.tasks.push(mkTask('doomed', at(0, 9), at(0, 10)));
    a.wl.save();
    b.globalHandlers.storage[0]({ key: 'daily-worklog.v1', newValue: '1' });
    a.wl.state.tasks = [];
    a.wl.state.deletedIds = ['doomed'];       // 模拟 deleteTask 的墓碑
    a.wl.save();
    b.wl.save();                              // B 未收到 storage，仍持有旧快照
    const final = JSON.parse(shared.get('daily-worklog.v1'));
    assert.ok(!final.tasks.some(t => t.id === 'doomed'), '已删记录不应复活');
  });

  /* ── 15/16. storage 广播与编辑保护 ── */
  check('T15 storage 事件触发重载并提示同步', () => {
    const shared = new Map();
    const e = boot(NEW_CODE, null, shared);
    assert.ok(e.globalHandlers.storage, '应注册 storage 监听');
    shared.set('daily-worklog.v1', JSON.stringify({ tasks: [mkTask('remote', at(0, 9), at(0, 10))], settings: {} }));
    e.globalHandlers.storage[0]({ key: 'daily-worklog.v1', newValue: '1' });
    assert.ok(e.wl.state.tasks.some(t => t.id === 'remote'));
    assert.ok(e.getEl('#toast').textContent.includes('已同步'));
  });
  check('T16 正在编辑时延迟同步，下次渲染再消费', () => {
    const shared = new Map();
    const e = boot(NEW_CODE, null, shared);
    e.setEditing(e.getEl('#fakeEdit'));
    shared.set('daily-worklog.v1', JSON.stringify({ tasks: [mkTask('remote', at(0, 9), at(0, 10))], settings: {} }));
    e.globalHandlers.storage[0]({ key: 'daily-worklog.v1', newValue: '1' });
    assert.ok(!e.wl.state.tasks.some(t => t.id === 'remote'), '编辑中不应立即 reload');
    e.setEditing(null);
    e.wl.renderAll();
    assert.ok(e.wl.state.tasks.some(t => t.id === 'remote'), '下次 renderAll 应补上同步');
  });

  /* ── 17. 索引与权威计算口径一致 ── */
  check('T17 索引与 taskSecondsOn 逐日结果一致（跨天/manualAdjust/open 段）', () => {
    const e = boot(NEW_CODE);
    const open = mkTask('c', at(0, 11), null, { status: 'running', doneAt: null });
    e.wl.state.tasks = [
      mkTask('a', at(-1, 23), at(0, 1)),
      mkTask('b', at(0, 9), at(0, 10), { manualAdjustSeconds: 600 }),
      open
    ];
    e.probe.invalidateDayIndex();
    for (const off of [-1, 0]) {
      const d = ds(off);
      const rows = new Map(e.probe.dayRows(d).map(r => [r.t.id, r.sec]));
      for (const t of e.wl.state.tasks) {
        const expect = e.probe.taskSecondsOn(t, d, e.probe.dayRange(d));
        assert.ok(Math.abs((rows.get(t.id) || 0) - expect) < 0.1,
          d + ' / ' + t.id + ' 索引与权威计算不一致');
      }
      const sum = [...rows.values()].reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(e.probe.dayTotalOf(d) - sum) < 0.1, 'dayTotalOf 应等于明细之和');
    }
  });
  check('T18 state.tasks 被整体替换后索引自动重建', () => {
    const e = boot(NEW_CODE);
    e.wl.state.tasks = [];
    e.wl.renderAll();
    e.wl.state.tasks = [mkTask('late', at(0, 9), at(0, 10))];
    assert.ok(Math.abs(e.probe.dayTotalOf(ds(0)) - 3600) < 1, '索引应识别到引用变化');
  });

  /* ── 19. 跨零点自动暂停 ── */
  check('T19 页面不关跨零点，running 段封口到今天 00:00 并暂停', () => {
    const e = boot(NEW_CODE);
    const t = mkTask('overnight', at(-1, 22), null,
      { status: 'running', doneAt: null, date: ds(-1) });
    e.wl.state.tasks = [t];
    e.probe.tickDynamic();
    assert.strictEqual(t.status, 'paused');
    assert.strictEqual(t.segments[0].end, e.probe.dayRange(ds(0))[0]);
  });

  /* ── 20. CSV 完整日期时间 / 最后一段 end ── */
  check('T20 CSV 输出完整日期时间，最后结束取最后一段 end', () => {
    const e = boot(NEW_CODE);
    const t = mkTask('csv', at(-1, 9), at(-1, 10), { status: 'paused', doneAt: null });
    t.segments.push({ start: at(-1, 14), end: at(-1, 15) });
    e.wl.state.tasks = [t];
    const line = e.probe.buildCsv().split('\r\n')[1];
    assert.ok(line.includes(ds(-1) + ' 09:00'), '首次开始应带日期');
    assert.ok(line.includes(ds(-1) + ' 15:00'), '暂停中的任务也应取最后一段 end');
  });

  /* ── 21. 导入 ID 冲突显式报告 ── */
  await (async () => {
    const e = boot(NEW_CODE);
    e.wl.state.tasks = [mkTask('dup', at(0, 9), at(0, 10))];
    e.wl.save();
    const backup = { tasks: [mkTask('dup', at(0, 9), at(0, 10)), mkTask('fresh', at(0, 11), at(0, 12))] };
    await e.getEl('#bkFile')._handlers.change[0]({
      target: { files: [{ text: async () => JSON.stringify(backup) }], value: '' }
    });
    assert.ok(e.getEl('#impInfo').textContent.includes('保留本地版本'), '导入对话框应说明冲突策略');
    e.getEl('#impMerge')._handlers.click[0]();
    assert.ok(e.getEl('#toast').textContent.includes('跳过 1 条同 ID'), '合并结果应报告跳过数');
    results.push('T21 导入同 ID 冲突不再静默跳过');
  })();

  /* ── 22. 刷新拦截移除 + 历史汇总按日归属 ── */
  check('T22 移除 beforeunload 拦截，历史汇总改按日归属', () => {
    const html = fs.readFileSync(FILE, 'utf8');
    assert.ok(!html.includes('handleBeforeUnload'), '普通刷新不应再被拦截');
    assert.ok(!html.includes('items.reduce((a,t) => a + elapsedOf(t), 0)'), '历史汇总不应再用全量 elapsedOf');
    assert.ok(html.includes('taskSecondsOn(t, ds, range)'), '历史汇总应改按日归属');
  });

  /* ── 23. 历史区懒渲染：默认不建卡片，展开才建，收起后卡片保留 ── */
  check('T23 历史区懒渲染：默认不创建卡片，展开后才建，状态跨渲染保留', () => {
    const e = boot(NEW_CODE);
    e.wl.state.tasks = [
      { id: 'old', name: '11/6 遗留', note: '', date: ds(-3), status: 'paused',
        segments: [{ start: at(-3, 10), end: at(-3, 11) }], manualAdjustSeconds: 0,
        createdAt: at(-3, 10), doneAt: null },
      { id: 'today', name: '今日事项', note: '', date: ds(0), status: 'paused',
        segments: [{ start: at(0, 9), end: at(0, 10) }], manualAdjustSeconds: 0,
        createdAt: at(0, 9), doneAt: null }
    ];
    e.wl.renderAll();
    const textOf = node => (node.textContent || '') + (node._html || '');
    const walk = (node, out) => { if (!node) return; out.push(node); (node.children || []).forEach(c => walk(c, out)); };
    const findName = root => { const all = []; walk(root, all); return all.filter(n => textOf(n).includes('11/6 遗留')); };

    assert.strictEqual(e.getEl('#historySection').hidden, false, '历史区应显示');
    assert.strictEqual(findName(e.getEl('#historyDays')).length, 0, '默认折叠时不应创建历史卡片');

    e.wl.toggleHistoryDay(ds(-3));
    assert.ok(findName(e.getEl('#historyDays')).length > 0, '展开后历史卡片应出现');
    assert.ok(e.wl.expandedDays.has(ds(-3)), '展开态应被记录');

    e.wl.toggleHistoryDay(ds(-3)); // 收起
    assert.ok(!e.wl.expandedDays.has(ds(-3)), '收起后展开态应清除');
    assert.strictEqual(findName(e.getEl('#historyDays')).length, 0, '收起后卡片从 DOM 移除（懒渲染，减轻布局负担）');

    /* 展开全部按钮路径：expandAllHistory 后所有历史日都应建卡 */
    e.wl.expandAllHistory(true);
    assert.ok(findName(e.getEl('#historyDays')).length > 0, '展开全部后历史卡片应出现');
  });

  /* ── 24. 懒渲染在 2000 条数据下：默认零卡片，展开全部才建全量 ── */
  check('T24 2000 条历史默认零卡片，展开全部才构建全部（避免卡顿）', () => {
    const e = boot(NEW_CODE);
    const N = 2000;
    const tasks = [];
    for (let i = 0; i < N; i++){
      const off = -(1 + (i % 400)); // 约 400 个历史日期，全部在过去
      tasks.push(mkTask('h' + i, at(off, 9), at(off, 10)));
    }
    e.wl.state.tasks = tasks;
    e.wl.renderAll();
    const textOf = node => (node.textContent || '') + (node._html || '');
    const walk = (node, out) => { if (!node) return; out.push(node); (node.children || []).forEach(c => walk(c, out)); };
    const all = []; walk(e.getEl('#historyDays'), all);
    const nameSpans = all.filter(n => textOf(n).startsWith('任务h'));
    assert.strictEqual(nameSpans.length, 0, '默认折叠时 2000 张卡片都不应被创建');
    const dayGroups = all.filter(n => n.className === 'day');
    assert.ok(dayGroups.length > 0 && dayGroups.length <= 400, '仅日期分组表头应被渲染（' + dayGroups.length + ' 天）');
    e.wl.expandAllHistory(true);
    const all2 = []; walk(e.getEl('#historyDays'), all2);
    const nameSpans2 = all2.filter(n => textOf(n).startsWith('任务h'));
    assert.strictEqual(nameSpans2.length, N, '展开全部后应构建全部 ' + N + ' 张卡片');
    console.log('   · 2000 条默认建卡 ' + nameSpans.length + ' 张 → 展开全部 ' + nameSpans2.length + ' 张');
  });

  /* ── 10. 损坏数据被另存副本而非静默覆盖 ── */
  check('T10 localStorage 数据损坏时另存 .broken 副本', () => {
    const e = boot(NEW_CODE, [['daily-worklog.v1', '{oops not json']]);
    const keys = [...e.store.keys()];
    assert.ok(keys.some(k => k.startsWith('daily-worklog.v1.broken.')), '应存在损坏副本');
    assert.ok(e.getEl('#storageBanner').hidden === false, '应提示用户');
  });

  console.log('\n===== 全部 ' + results.length + ' 项通过 =====');
  results.forEach(r => console.log('  PASS  ' + r));
  console.log('EXIT=0');
})().catch(err => {
  console.error('\nFAIL:', err && err.stack || err);
  process.exit(1);
});

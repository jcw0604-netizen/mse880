/* ============================================================
   rq 背诵站 · app.js
   单页应用：卡组 / 学习（SRS 间隔重复）/ 统计 / 管理
   数据全部存 localStorage，不联网。
   ============================================================ */
(function () {
'use strict';

const LS_KEY = 'rq_recite_v1';
const DAY = 86400000;
const MIN = 60000;

/* ---------------- 状态 ---------------- */
let S = null;            // 全站数据
const ui = {
  tab: 'home',
  studyDeckId: null,
  queue: [],
  qi: 0,
  flipped: false,
  revealed: false,          // 骨架模式下是否已展开完整答案
  animating: false,         // 出卡动画进行中，防连点
  picked: null,             // 选择题：已选项 Set
  judged: false,            // 选择题：是否已判定
  tags: new Set(),       // 学习页标签筛选
  mngDeckId: null,
  impDeckId: null,
  editCard: null,        // {deckId, cardId|null}
  editDeck: null         // {deckId|null}
};

/* ---------------- 小工具 ---------------- */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
const uid = (p) => (p || 'c') + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function dayKey(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2000);
}
function download(name, text, mime) {
  const blob = new Blob(['\ufeff' + text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------------- 富文本渲染 ---------------- */
function rich(text, revealCloze) {
  let s = escapeHtml(text);
  const blocks = [];
  // 先摘出 $$…$$，避免内部换行被 <br> 破坏
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, a) => {
    blocks.push(a);
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // ==重点== → 红色高亮（一页纸卡片的标题与重点）
  s = s.replace(/==([^=]+)==/g, '<span class="hl">$1</span>');
  // 挖空 {{答案}} 或 {{c1::答案}}
  s = s.replace(/\{\{(?:c\d+::)?([\s\S]+?)\}\}/g, (m, a) => {
    if (revealCloze) return '<span class="cloze" data-a="' + a + '">' + a + '</span>';
    return '<span class="cloze hidden" data-a="' + a + '">' + a + '</span>';
  });
  s = s.replace(/\n/g, '<br>');
  s = s.replace(/\u0000B(\d+)\u0000/g, (m, i) => '$$' + blocks[+i] + '$$');
  return s;
}
function renderMath(el) {
  if (typeof renderMathInElement !== 'function') return;
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false }
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
    });
  } catch (e) { /* 静默 */ }
}
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/\$[^$]*\$/g, '').slice(0, 400));
    u.lang = 'zh-CN';
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch (e) { /* 静默 */ }
}

/* ---------------- 数据存取 ---------------- */
function defaultSettings() {
  return {
    newPerDay: 20,        // 每天新卡上限（超武 14:51 指定：每天计划 20 个）
    revPerDay: 400,
    mature: 21,
    retention: 0.92,      // FSRS 目标保留率（考研推荐）
    maxInterval: 21       // 最大间隔（天），还会被「距初试天数」再截一次
  };
}

function load() {
  let raw = null;
  try { raw = localStorage.getItem(LS_KEY); } catch (e) { /* 隐私模式 */ }
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && Array.isArray(j.decks)) {
        S = j;
        S.settings = Object.assign(defaultSettings(), S.settings || {});
        S.log = S.log || {};
        S.decks.forEach((d) => {
          d.cards = d.cards || [];
          d.cards.forEach(normCard);
        });
        mergeSeed();
        return;
      }
    } catch (e) { /* 坏数据，走种子 */ }
  }
  seed();
}
function seed() {
  const base = (typeof window.SEED_DECKS !== 'undefined' && Array.isArray(window.SEED_DECKS)) ? window.SEED_DECKS : [];
  S = {
    v: 1,
    settings: defaultSettings(),
    log: {},
    decks: JSON.parse(JSON.stringify(base))
  };
  S.decks.forEach((d) => { d.cards = d.cards || []; d.cards.forEach(normCard); });
  if (!S.decks.length) S.decks.push({ id: uid('d'), name: '默认卡组', desc: '', color: '#4a90d9', cards: [] });
  save();
}
function normCard(c) {
  c.id = c.id || uid('c');
  c.front = c.front == null ? '' : String(c.front);
  c.back = c.back == null ? '' : String(c.back);
  c.tags = Array.isArray(c.tags) ? c.tags : (c.tags ? String(c.tags).split(/[,，]/).filter(Boolean) : []);
  c.st = c.st || 0;
  c.due = c.due || 0;
  c.ivl = c.ivl || 0;
  c.reps = c.reps || 0;
  c.lapses = c.lapses || 0;
  c.last = c.last || 0;
  c.okN = c.okN || 0;
  c.badN = c.badN || 0;
  c.grad = c.grad || 0;           // 是否已首次毕业
  c.S = c.S || 0;                 // FSRS 稳定性
  c.D = c.D || 0;                 // FSRS 难度
  c.lastReview = c.lastReview || 0;
  c.ease = c.ease || 2.5;         // 旧字段，保留兼容
  return c;
}
/**
 * 把「新版种子」里新增的内容并进已有数据。
 * 为什么要这个：种子只在 localStorage 为空时写入，
 * 老用户升级后新卡组/新内容不会自动出现。
 * 规则（幂等，不会重复加）：
 *   · 卡组 id 不在本地 → 新增（除非用户主动删过）
 *   · 卡组在本地但是空的、种子里有内容 → 补上（进度为 0，不影响任何东西）
 *   · 卡组在本地且已有卡片 → 一律不动（保住学习进度）
 */
function mergeSeed() {
  if (typeof window.SEED_DECKS === 'undefined' || !Array.isArray(window.SEED_DECKS)) return;
  S.removedDecks = S.removedDecks || [];
  // 「政治 · 一页纸」改回单个大卡组（v4）；v4 曾拆出的 219 个 dp* 主题卡组要清掉
  const beforeN = S.decks.length;
  S.decks = S.decks.filter(function (d) {
    return d.id !== 'd_politics_retired' && !/^dp\d+$/.test(d.id);
  });
  const retired = beforeN - S.decks.length;
  // 每日新卡上限迁到 20（老数据里是 60）
  if (S.settings && !S.settings.dailyMigrated) {
    S.settings.newPerDay = 20;
    S.settings.dailyMigrated = 1;
  }
  let added = 0, filled = 0;
  window.SEED_DECKS.forEach(function (sd) {
    if (S.removedDecks.indexOf(sd.id) >= 0) return;
    const local = S.decks.find(function (d) { return d.id === sd.id; });
    if (!local) {
      const copy = JSON.parse(JSON.stringify(sd));
      (copy.cards || []).forEach(normCard);
      S.decks.push(copy);
      added++;
    } else if (sd.v && (!local.v || local.v < sd.v)) {
      // 种子版本升级：内容整体重做过 → 整组替换；但 id 和 front 都没变的卡保留学习进度
      const oldMap = {};
      (local.cards || []).forEach(function (c) { oldMap[c.id + '|' + c.front] = c; });
      local.cards = JSON.parse(JSON.stringify(sd.cards));
      local.cards.forEach(function (c) {
        normCard(c);
        const old = oldMap[c.id + '|' + c.front];
        if (old) {
          ['st','due','ivl','ease','reps','lapses','last','okN','badN','grad','S','D','lastReview'].forEach(function (k) {
            if (old[k] !== undefined) c[k] = old[k];
          });
        }
      });
      local.v = sd.v;
      local.desc = sd.desc || local.desc;
      local.name = sd.name || local.name;
      filled++;
    } else if ((!local.cards || !local.cards.length) && sd.cards && sd.cards.length) {
      local.cards = JSON.parse(JSON.stringify(sd.cards));
      local.cards.forEach(normCard);
      local.desc = sd.desc || local.desc;
      filled++;
    }
  });
  if (added || filled || retired) {
    save();
    setTimeout(function () {
      const parts = [];
      if (added) parts.push('新增 ' + added + ' 个卡组');
      if (filled) parts.push('补充 ' + filled + ' 个卡组的内容');
      if (parts.length) toast('已更新：' + parts.join('，'));
    }, 900);
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S)); }
    catch (e) { toast('保存失败：浏览器存储空间不足'); }
  }, 120);
}
function getDeck(id) { return S.decks.find((d) => d.id === id) || null; }
function allCards() { return S.decks.reduce((a, d) => a.concat(d.cards), []); }
function isMastered(c) { return c.st === 2 && c.ivl >= S.settings.mature; }
function isDue(c) { return c.reps > 0 && c.due <= Date.now(); }
function logOf(k) { k = k || dayKey(); return S.log[k] || { r: 0, n: 0 }; }
function bumpLog(kind) {
  const k = dayKey();
  const l = S.log[k] || { r: 0, n: 0 };
  if (kind === 'n') l.n++; else l.r++;
  S.log[k] = l;
}

/* ============================================================
   FSRS 记忆引擎（Free Spaced Repetition Scheduler）
   模型：DSR —— Difficulty（难度）/ Stability（稳定性）/ Retrievability（可提取性）
   公式与默认权重取自参考实现 rs-fsrs（Anki 同源）。
   三档评分映射：不认识→Again(1) / 模糊→Hard(2) / 认识→Good(3)
   ============================================================ */
const FSRS = (function () {
  const W = [0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
             0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567];
  const DECAY = -0.5;
  const FACTOR = 19 / 81;                     // = (9/10)^(1/DECAY) - 1
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** 可提取性 R(t,S)：距今 t 天后还记得的概率 */
  function forgettingCurve(t, S) {
    return Math.pow(1 + FACTOR * t / S, DECAY);
  }
  function initStability(g) { return Math.max(W[g - 1], 0.1); }
  function initDifficulty(g) { return clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10); }
  function nextDifficulty(D, g) {
    const nd = D + W[6] * -(g - 3);
    const mr = W[7] * initDifficulty(4) + (1 - W[7]) * nd;
    return clamp(mr, 1, 10);
  }
  function shortTermStability(S, g) {
    return S * Math.exp(W[17] * (g - 3 + W[18]));
  }
  function nextRecallStability(D, S, R, g) {
    const modifier = g === 2 ? W[15] : (g === 4 ? W[16] : 1);
    const M = Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp((1 - R) * W[10]) - 1);
    return S * (1 + modifier * M);
  }
  function nextForgetStability(D, S, R) {
    return W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp((1 - R) * W[14]);
  }
  /** 由稳定性反解间隔：R 降到目标保留率需要多少天 */
  function intervalFrom(S, retention, maxI) {
    const iv = Math.round(S / FACTOR * (Math.pow(retention, 1 / DECAY) - 1));
    return clamp(iv, 1, maxI);
  }
  return { W, DECAY, FACTOR, forgettingCurve, initStability, initDifficulty,
           nextDifficulty, shortTermStability, nextRecallStability,
           nextForgetStability, intervalFrom };
})();

/* 初试日期（用于把间隔截在考前） */
const EXAM_DATE = new Date('2026-12-19T08:00:00');
function daysToExam() {
  return Math.max(1, Math.ceil((EXAM_DATE - Date.now()) / DAY));
}

/**
 * 核心调度：改一张卡的状态
 * 三档评分 g：0=不认识(Again) / 1=模糊(Hard) / 2=认识(Good)
 * 返回 { due, ivl, st, short } —— short 表示本轮内还会再出现
 */
function gradeCard(card, g, nowTs, opt) {
  const t = nowTs || Date.now();
  const r = g + 1;                                  // 0/1/2 → 1/2/3
  const retention = (opt && opt.retention) || S.settings.retention;
  const maxI = (opt && opt.maxI) || Math.min(S.settings.maxInterval, daysToExam());
  const prevReview = card.lastReview || card.last || 0;
  const elapsed = Math.max(0, (t - prevReview) / DAY);   // 必须在写 last 之前算
  card.reps++;
  card.last = t;
  card.lastReview = t;
  if (!card.S) card.S = 0;
  if (!card.D) card.D = 0;

  const st = card.st || 0;

  /* ---- 新卡（从没学过） ---- */
  if (st === 0) {
    card.S = FSRS.initStability(r);
    card.D = FSRS.initDifficulty(r);
    if (r === 3) {                                  // 认识 → 毕业
      card.ivl = 1;                                 // 首次毕业统一 1 天（艾宾浩斯第一节点）
      card.due = t + card.ivl * DAY;
      card.st = 2; card.grad = 1;
      card.okN++;
      return { short: false };
    }
    card.st = 1;
    card.ivl = 0;
    card.due = t + (r === 1 ? MIN : 10 * MIN);
    if (r === 1) card.badN++; else card.okN++;
    return { short: true };
  }

  /* ---- 学习中 / 重学中 ---- */
  if (st === 1 || st === 3) {
    card.S = FSRS.shortTermStability(card.S, r);
    card.D = FSRS.nextDifficulty(card.D, r);
    if (r === 3) {                                  // 毕业
      card.ivl = card.grad ? FSRS.intervalFrom(card.S, retention, maxI) : 1;
      card.due = t + card.ivl * DAY;
      card.st = 2; card.grad = 1;
      card.okN++;
      return { short: false };
    }
    card.st = r === 1 ? 3 : 1;
    card.ivl = 0;
    card.due = t + (r === 1 ? MIN : 10 * MIN);
    if (r === 1) card.badN++; else card.okN++;
    return { short: true };
  }

  /* ---- 复习中（走完整 FSRS） ---- */
  const R = FSRS.forgettingCurve(elapsed, card.S);
  card.lastR = R;
  card.D = FSRS.nextDifficulty(card.D, r);
  if (r === 1) {
    card.S = FSRS.nextForgetStability(card.D, card.S, R);
    card.lapses++; card.badN++;
    card.ivl = 0; card.st = 3;
    card.due = t + MIN;                             // 本轮重来
    return { short: true };
  }
  card.S = FSRS.nextRecallStability(card.D, card.S, R, r);
  card.ivl = FSRS.intervalFrom(card.S, retention, maxI);
  card.st = 2;
  card.due = t + card.ivl * DAY;
  card.okN++;
  return { short: false };
}

/** 评分按钮上的「下次什么时候见」提示 */
function nextLabel(card, g) {
  const tmp = Object.assign({}, card);
  gradeCard(tmp, g);
  if (tmp.st === 1 || tmp.st === 3) {
    const m = Math.round((tmp.due - Date.now()) / MIN);
    return m <= 1 ? '1 分钟后' : m + ' 分钟后';
  }
  if (tmp.ivl >= 1) return tmp.ivl + ' 天后';
  return '稍后';
}

/**
 * 骨架模式：把答案压成「主干 + ……」
 * 规则：按句切分 → 每句只留到第一个逗号/冒号/顿号之前；
 *       前缀太短（如「结论」「意义」）就多取一个分句，免得把提示词本身吃掉；
 *       没有逗号的句子（多是定义句）原样保留 —— 那是必须整句记住的。
 */
function skeletonize(text) {
  if (text == null) return '';
  const paras = String(text).split(/\n+/).filter(function (s) { return s.trim(); });
  return paras.map(function (p) {
    const sents = p.split(/(?<=[。；！？])/).filter(function (s) { return s.trim(); });
    return sents.map(function (s) {
      const t = s.trim();
      if (!t) return '';
      const m = t.match(/^([^，,：:；;]{1,40})/);
      if (!m) return t;
      let head = m[1];
      if (head.length >= t.length - 2) return t;        // 没东西可截
      if (head.length < 6) {                            // 「结论：…」这种
        const m2 = t.match(/^([^，,：:；;]+[，,：:；;][^，,：:；;]{0,30})/);
        if (m2) head = m2[1];
      }
      return head + '……';
    }).join('');
  }).join('\n');
}

/** 预览一张新卡的间隔阶梯：直接用真引擎跑「每次都答认识」的时间线 */
function previewLadder(n, retention, maxI) {
  const c = normCard({ id: 'preview', front: '', back: '' });
  const out = [];
  let t = Date.now();
  for (let i = 0; i < n; i++) {
    gradeCard(c, 2, t, { retention: retention, maxI: maxI });   // 2 = 认识
    out.push(c.ivl);
    t = c.due;                                                   // 推进到下次到期
  }
  return out;
}

/* ---------------- Tab 切换 ---------------- */
const TAB_META = {
  home:   { t: '卡组', s: '' },
  study:  { t: '学习', s: '' },
  stats:  { t: '统计', s: '近 30 天' },
  docs:   { t: '资料', s: '阅读材料' },
  manage: { t: '管理', s: '内容与设置' }
};
function setBigTitle(tab, sub) {
  const m = TAB_META[tab] || { t: '', s: '' };
  const t = $('#bigTitle'), s = $('#bigSub');
  if (t) t.firstChild.nodeValue = m.t;
  if (s) s.textContent = sub != null ? sub : m.s;
}
function go(tab) {
  ui.tab = tab;
  try { if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab); } catch (e) { /* ignore */ }
  document.body.dataset.tab = tab;
  $$('nav.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('main section').forEach((s) => s.classList.toggle('on', s.id === 'tab-' + tab));
  if (tab === 'home') {
    renderHome();
    const n = S.decks.length, c = allCards().length;
    setBigTitle('home', n + ' 个卡组 · ' + c + ' 张卡片');
  }
  if (tab === 'study') {
    fillDeckSelects(); renderStudyChrome(); resetQueue();
    const d = studyDeckObj();
    setBigTitle('study', d ? d.name : '');
  }
  if (tab === 'stats') { renderStats(); setBigTitle('stats'); }
  if (tab === 'docs') { renderDocs(); setBigTitle('docs'); }
  if (tab === 'manage') { fillDeckSelects(); renderCardList(); renderSettings(); setBigTitle('manage'); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
   卡组页
   ============================================================ */
function deckIcon(d) {
  const n = d.name || '';
  if (/名词/.test(n)) return '📘';
  if (/简答|论述/.test(n)) return '📗';
  if (/政治|马原|毛中特|史纲|思修/.test(n)) return '📙';
  if (/英语|单词|词汇/.test(n)) return '📕';
  if (/数学|公式|定理/.test(n)) return '📐';
  if (/真题|错题/.test(n)) return '📝';
  return '📒';
}
/* 卡片类型标签（背面顶部显示） */
function deckType(d) {
  const n = (d && d.name) || '';
  if (/名词/.test(n)) return '名词解释';
  if (/简答|论述/.test(n)) return '简答论述';
  if (/政治|马原|毛中特|史纲|思修/.test(n)) return '政治';
  if (/英语|单词|词汇/.test(n)) return '英语';
  if (/数学|公式|定理/.test(n)) return '数学';
  return '卡片';
}

function renderHome() {
  const now = Date.now();
  const cards = allCards();
  const done = logOf().r + logOf().n;
  $('#homeToday').innerHTML = done + '<small>张</small>';
  const h = $('#hStat'); if (h) h.innerHTML = '今日 <b>' + done + '</b> 张';
  const dueAll = cards.filter(isDue).length;
  const newAll = cards.filter((c) => !c.reps).length;
  const masAll = cards.filter(isMastered).length;
  const meta = $('#homeMeta');
  if (meta) {
    meta.textContent = cards.length
      ? (dueAll > 0 ? ('待复习 ' + dueAll + ' · 新卡 ' + newAll) : ('新卡 ' + newAll + ' 张 · 共 ' + cards.length + ' 张'))
      : '还没有内容，去「管理」导入';
  }

  const big = $('#bigDecks'), small = $('#deckList'), other = $('#otherWrap');
  if (!S.decks.length) {
    big.innerHTML = '<div class="empty">还没有卡组</div>';
    if (other) other.style.display = 'none';
    return;
  }
  const html = S.decks.map((d, idx) => {
    const total = d.cards.length;
    const isRead = d.mode === 'read';          // 速览型：不是翻转卡，点击直接展开全文
    const mas = isRead ? 0 : d.cards.filter(isMastered).length;
    const due = isRead ? 0 : d.cards.filter((c) => c.reps > 0 && c.due <= now).length;
    const neu = isRead ? 0 : d.cards.filter((c) => !c.reps).length;
    const pct = total ? Math.round(mas / total * 100) : 0;
    const col = d.color || '#007AFF';
    const delay = (idx * 0.02).toFixed(3);
    if (isRead) {
      return '<button class="deckRow" data-read="' + d.id + '" style="animation-delay:' + delay + 's">' +
        '<span class="ic">📖</span>' +
        '<span class="mid">' +
          '<span class="nm" style="display:block">' + escapeHtml(d.name) + '</span>' +
          '<span class="sub" style="display:block">速览 · 点击展开</span>' +
        '</span>' +
        '<span class="chev">⌄</span>' +
      '</button>' +
      '<div class="readBody" data-body="' + d.id + '" hidden></div>';
    }
    return '<button class="deckRow" data-deck="' + d.id + '" style="animation-delay:' + delay + 's">' +
      '<span class="ic">' + deckIcon(d) + '</span>' +
      '<span class="mid">' +
        '<span class="nm" style="display:block">' + escapeHtml(d.name) + '</span>' +
        (total
          ? (due > 0 ? '<span class="sub" style="display:block">待复习 ' + due + '</span>' : '')
          : '<span class="sub" style="display:block">空卡组 · 去「管理」导入</span>') +
      '</span>' +
      '<span class="cnt">' + (total || '') + '</span>' +
    '</button>';
  }).join('');

  big.innerHTML = html;
  if (small) small.innerHTML = '';
  if (other) other.style.display = 'none';

  $$('#bigDecks .deckRow').forEach((el) => {
    if (el.dataset.read) el.addEventListener('click', () => toggleRead(el));
    else el.addEventListener('click', () => startDeck(el.dataset.deck));
  });
}

/* 速览型条目：点一下展开，里面是二级标题，点哪个展开哪个 */
function toggleRead(el) {
  const d = getDeck(el.dataset.read);
  const box = document.querySelector('.readBody[data-body="' + el.dataset.read + '"]');
  if (!d || !box) return;
  if (box.hidden) {
    if (!box.dataset.filled) {
      box.innerHTML = readSectionsHtml(d);
      box.dataset.filled = '1';
      Array.prototype.forEach.call(box.querySelectorAll('.secHead'), function (h) {
        h.addEventListener('click', function (e) {
          e.stopPropagation();
          const body = box.querySelector('.secBody[data-secbody="' + h.dataset.sec + '"]');
          if (!body) return;
          body.hidden = !body.hidden;
          h.classList.toggle('open', !body.hidden);
        });
      });
    }
    box.hidden = false;
    el.classList.add('open');
  } else {
    box.hidden = true;
    el.classList.remove('open');
  }
}

/* 有 sections 就渲染成二级手风琴；老数据没有 sections 时退回单段文本 */
function readSectionsHtml(d) {
  const secs = (d.sections && d.sections.length)
    ? d.sections
    : [{ title: d.name, text: (d.cards[0] && d.cards[0].front) || '' }];
  return secs.map(function (s, i) {
    return '<div class="secItem">' +
      '<button class="secHead" data-sec="' + i + '">' +
        '<span class="secTitle">' + escapeHtml(s.title) + '</span>' +
        '<span class="chev2">⌄</span>' +
      '</button>' +
      '<div class="secBody" data-secbody="' + i + '" hidden>' + rich(s.text, false) + '</div>' +
    '</div>';
  }).join('');
}

function startDeck(id) {
  ui.studyDeckId = id;
  ui.tags.clear();
  go('study');
  const d = getDeck(id);
  // 空卡组直接引导去导入
  if (d && !d.cards.length) toast('「' + d.name + '」还没有卡片，去「管理」导入');
}

/* ============================================================
   学习页
   ============================================================ */
function fillDeckSelects() {
  const one = (d) => '<option value="' + d.id + '">' + escapeHtml(d.name) + '（' + d.cards.length + '）</option>';
  const studyOpts = '<option value="__all">全部卡组（' + allCards().length + '）</option>' + S.decks.map(one).join('');
  const plainOpts = S.decks.map(one).join('');

  // 保留已有选择，避免被重刷掉
  const keep = (el, opts, want) => {
    if (!el) return;
    const prev = (want != null ? want : el.value);
    el.innerHTML = opts;
    if (prev && Array.prototype.some.call(el.options, (o) => o.value === prev)) el.value = prev;
  };
  keep($('#studyDeck'), studyOpts, ui.studyDeckId);
  keep($('#impDeck'), plainOpts, ui.impDeckId);
  keep($('#mngDeck'), plainOpts, ui.mngDeckId);

  if (!ui.studyDeckId || !studyDeckObj()) ui.studyDeckId = S.decks[0] ? S.decks[0].id : null;
  if ($('#studyDeck') && ui.studyDeckId) $('#studyDeck').value = ui.studyDeckId;
  if (!ui.mngDeckId || !getDeck(ui.mngDeckId)) ui.mngDeckId = (S.decks[0] || {}).id || null;
  if ($('#mngDeck') && ui.mngDeckId) $('#mngDeck').value = ui.mngDeckId;
  if (!ui.impDeckId || !getDeck(ui.impDeckId)) ui.impDeckId = ui.mngDeckId;
  if ($('#impDeck') && ui.impDeckId) $('#impDeck').value = ui.impDeckId;
}

/* 学习对象：支持「全部卡组」 */
function studyDeckObj() {
  if (ui.studyDeckId === '__all') return { id: '__all', name: '全部卡组', cards: allCards() };
  return getDeck(ui.studyDeckId);
}

function deckTagCounts(deck) {
  const m = new Map();
  deck.cards.forEach((c) => c.tags.forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

function renderStudyChrome() {
  const d = studyDeckObj();
  $('#studyDeckName').textContent = d ? d.name : '—';
  const chips = $('#studyTags');
  if (!d) { chips.innerHTML = ''; $('#studyProgress').textContent = '—'; return; }
  const counts = deckTagCounts(d);
  if (!counts.length) { chips.innerHTML = ''; }
  else {
    chips.innerHTML = counts.map(([t, n]) =>
      '<button class="chip' + (ui.tags.has(t) ? ' on' : '') + '" data-tag="' + escapeHtml(t) + '">' +
      escapeHtml(t) + ' <span style="opacity:.6">' + n + '</span></button>'
    ).join('') + (ui.tags.size ? '<button class="chip" id="chipClear">清除筛选</button>' : '');
    $$('#studyTags .chip').forEach((el) => {
      el.addEventListener('click', () => {
        const t = el.dataset.tag;
        if (!t) { ui.tags.clear(); }
        else if (ui.tags.has(t)) ui.tags.delete(t);
        else ui.tags.add(t);
        renderStudyChrome();
        resetQueue();
      });
    });
  }
  const total = d.cards.length;
  const mas = d.cards.filter(isMastered).length;
  setBigTitle('study', d.name);
  $('#studyProgress').textContent = total
    ? ('本卡组 ' + total + ' 张 · 已掌握 ' + mas + ' · 今日到期 ' + d.cards.filter(isDue).length + ' · 未学 ' + d.cards.filter((c) => !c.reps).length)
    : '空卡组，去「管理」加卡或导入';
}

function passTags(c) {
  if (!ui.tags.size) return true;
  return c.tags.some((t) => ui.tags.has(t));
}

function buildQueue() {
  const d = studyDeckObj();
  if (!d) return [];
  const now = Date.now();
  const pool = d.cards.filter(passTags);
  const range = $('#studyRange').value;
  let list = [];
  if (range === 'due') {
    const st = S.settings;
    const newBudget = Math.max(0, st.newPerDay - logOf().n);
    const dues = pool.filter((c) => c.reps > 0 && c.due <= now).slice(0, st.revPerDay);
    const news = pool.filter((c) => !c.reps).slice(0, newBudget);
    list = dues.concat(news);
  } else if (range === 'all') {
    list = pool.slice();
  } else if (range === 'wrong') {
    list = pool.filter((c) => c.badN > 0);
  } else if (range === 'unmastered') {
    list = pool.filter((c) => !isMastered(c));
  }
  if ($('#optShuffle').checked) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = list[i]; list[i] = list[j]; list[j] = t;
    }
  }
  return list;
}

function resetQueue() {
  ui.queue = buildQueue();
  ui.qi = 0;
  ui.flipped = false;
  ui.revealed = false;
  ui.picked = null;
  ui.judged = false;
  drawCard();
}

/* ============================================================
   选择题卡
   ============================================================ */
function sameSet(a, b) {
  if (a.size !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (!a.has(b[i])) return false;
  return true;
}

function drawChoice(c) {
  const dk = studyDeckObj();
  const picked = ui.picked || (ui.picked = new Set());
  const judged = ui.judged;
  const multi = !!c.multi;
  const ans = c.answer || [];
  const front = $('#cardFront');

  // 顶部信息条
  $('#cardTag').innerHTML =
    (dk ? '<span class="deckname">' + escapeHtml(dk.name) + '</span>' : '') +
    '<span class="prog">第 ' + (ui.qi + 1) + ' / ' + ui.queue.length + ' 题</span>' +
    c.tags.map(function (t) { return '<span class="tg">' + escapeHtml(t) + '</span>'; }).join('');

  front.className = 'face quiz';
  let h = '<div class="quizWrap">';
  h += '<div class="qmeta">' + (multi ? '多项选择题' : '单项选择题') + '</div>';
  h += '<div class="qstem">' + rich(c.front, false) + '</div>';
  (c.options || []).forEach(function (o) {
    let cls = 'opt';
    if (judged) {
      const isAns = ans.indexOf(o.k) >= 0;
      const isPick = picked.has(o.k);
      if (isAns && (isPick || !multi)) cls += ' right';   // 单选题：正确答案一律实线绿
      else if (isAns && !isPick) cls += ' missed';        // 多选题：漏选的标虚线
      else if (!isAns && isPick) cls += ' wrong';
    } else if (picked.has(o.k)) cls += ' picked';
    h += '<button class="' + cls + '" data-k="' + o.k + '"' + (judged ? ' disabled' : '') + '>' +
         '<span class="k">' + o.k + '</span><span class="t">' + escapeHtml(o.t) + '</span></button>';
  });
  if (!judged && multi) h += '<button class="btn qsubmit" id="btnSubmitQ">提交答案</button>';
  if (judged) {
    const ok = sameSet(picked, ans);
    h += '<div class="qexp"><div class="verdict ' + (ok ? 'ok' : 'no') + '">' +
         (ok ? '✓ 答对了' : '✗ 答错了') + '　正确答案：' + ans.join('') + '</div>' +
         (c.explain ? '<div>' + rich(c.explain, true) + '</div>' : '') +
         (c.distract ? '<div class="dis">' + rich(c.distract, true) + '</div>' : '') +
         '</div>';
    h += '<button class="btn qsubmit" id="btnNextQ">下一题</button>';
  }
  h += '</div>';

  const el = $('#cardFrontInner');
  el.className = 'quizWrap';
  el.innerHTML = h;
  renderMath(el);

  $('#cardBack').innerHTML = '';
  $('#gradeRow').style.display = 'none';
  $('#cardHint').textContent = judged
    ? ''
    : (multi ? '可多选，选完点「提交答案」' : '选一个，立刻判对错');
}

function pickOption(k) {
  if (ui.judged) return;
  const c = ui.queue[ui.qi];
  if (!c || c.type !== 'choice') return;
  const multi = !!c.multi;
  const picked = ui.picked || (ui.picked = new Set());
  if (multi) {
    if (picked.has(k)) picked.delete(k); else picked.add(k);
    drawChoice(c);
  } else {
    picked.clear(); picked.add(k);
    judgeChoice();
  }
}

function judgeChoice() {
  const c = ui.queue[ui.qi];
  if (!c || c.type !== 'choice' || ui.judged) return;
  const picked = ui.picked || new Set();
  if (!picked.size) { toast('先选一个'); return; }
  ui.judged = true;
  drawChoice(c);
  fitCard();
  setTimeout(function () {                 // 判定后滚到解析开头（「下一题」已吸附在卡片底部，无需滚到底）
    const front = $('#cardFront');
    const ex = front && front.querySelector('.qexp');
    if (front && ex) {
      const top = Math.max(0, ex.offsetTop - 8);
      if (front.scrollTo) front.scrollTo({ top: top, behavior: 'smooth' });
      else front.scrollTop = top;
    }
  }, 140);
}

/* ============================================================
   资料（阅读材料）
   ============================================================ */
const DOCS = [
  { name: '政治总结 · 时间表（阅读版）', sub: '重点会议 / 土地政策 / 重要著作 / 近代史时间表 · 50 页',
    path: '资料/政治总结时间表_阅读版.pdf', thumb: '资料/封面.jpg' }
];

function renderDocs() {
  const box = $('#docList');
  if (!box) return;
  box.innerHTML = DOCS.map(function (d, i) {
    return '<button class="docRow" data-doc="' + i + '">' +
      '<img class="thumb" src="' + d.thumb + '" alt="" onerror="this.style.visibility=\'hidden\'">' +
      '<span class="mid"><span class="nm" style="display:block">' + escapeHtml(d.name) + '</span>' +
      '<span class="sub" style="display:block">' + escapeHtml(d.sub) + '</span></span>' +
      '<span class="cnt">›</span></button>';
  }).join('');
  $$('#docList .docRow').forEach(function (el) {
    el.addEventListener('click', function () {
      const d = DOCS[Number(el.dataset.doc)];
      if (d) window.open(d.path, '_blank');
    });
  });
}

/* 卡片高度自适应：让「评分栏」永远完整落在标签栏之上，不用滚动就能点到。
   做法：先量卡片上方占了多高 → 给一个初值 → 再量真实底边，溢出多少就再减多少。 */
function fitCard() {
  const wrap = $('#cardWrap'), inner = $('#cardInner'), grade = $('#gradeRow');
  const tabbar = document.querySelector('nav.tabbar');
  if (!wrap || !inner || !tabbar || ui.tab !== 'study') return;

  inner.style.height = '10px';                       // 先塌掉，避免自反馈
  const top = wrap.getBoundingClientRect().top;
  const tabTop = tabbar.getBoundingClientRect().top;
  const gradeH = ui.flipped ? 84 : 0;
  let avail = tabTop - top - 22 /*hint*/ - gradeH - 20 /*gap*/;
  inner.style.height = Math.max(240, avail) + 'px';

  const over = grade.getBoundingClientRect().bottom - tabTop;
  if (over > 0) inner.style.height = Math.max(220, avail - over - 6) + 'px';
}

function drawCard(intro) {
  const wrap = $('#cardWrap');
  if (intro) { wrap.classList.add('in'); setTimeout(() => wrap.classList.remove('in'), 460); }
  wrap.classList.toggle('flip', ui.flipped);
  const total = ui.queue.length;
  const done = ui.qi;
  $('#studyBar').style.width = (total ? Math.round(done / total * 100) : 0) + '%';

  if (!total) {
    $('#cardTag').textContent = '';
    $('#cardFront').innerHTML = '<span class="dim">没有符合条件的卡片<br><span class="dim2">换个范围 / 清掉标签筛选 / 或去「管理」导入内容</span></span>';
    $('#cardBack').innerHTML = '';
    $('#gradeRow').style.display = 'none';
    $('#cardHint').textContent = '点击卡片可重新取队列';
    return;
  }
  if (ui.qi >= total) {
    $('#cardTag').textContent = '本轮完成';
    $('#cardFront').innerHTML = '<span>本轮 ' + total + ' 张，全部过完 ✓<br><span class="dim2">点「重新开始」再来一轮</span></span>';
    $('#cardBack').innerHTML = '';
    $('#gradeRow').style.display = 'none';
    $('#cardHint').textContent = '';
    return;
  }
  const c = ui.queue[ui.qi];
  if (c.type === 'choice') {          // 选择题卡：不翻面，走答题界面
    ui.flipped = false;
    wrap.classList.remove('flip');
    drawChoice(c);
    fitCard();
    return;
  }
  const reverse = $('#optReverse').checked;
  const hasCloze = /\{\{(?:c\d+::)?[\s\S]+?\}\}/.test(c.front);
  let frontTxt, backTxt;
  if (reverse) { frontTxt = c.back; backTxt = c.front; }
  else if (hasCloze) {
    // 挖空卡：背面 = 正面（已填）+ 补充说明
    frontTxt = c.front;
    backTxt = c.front + (c.back ? '\n\n' + c.back : '');
  } else { frontTxt = c.front; backTxt = c.back; }

  // 顶部：卡组名 + 进度 + 标签
  const dk = studyDeckObj();
  $('#cardTag').innerHTML =
    (dk ? '<span class="deckname">' + escapeHtml(dk.name) + '</span>' : '') +
    '<span class="prog">第 ' + (ui.qi + 1) + ' / ' + total + ' 张</span>' +
    c.tags.map(function (t) { return '<span class="tg">' + escapeHtml(t) + '</span>'; }).join('');

  const fcEl = $('#cardFrontInner');
  if (fcEl) {
    fcEl.className = 'fc' + (frontTxt.length > 110 ? ' long' : '');
    fcEl.innerHTML = rich(frontTxt, false);
  } else {
    $('#cardFront').innerHTML = rich(frontTxt, false);
  }

  // 背面：题干条（类型标签 + 题目原文）+ 答案
  const type = deckType(dk);
  const qHead = '<div class="qhead"><span class="qtype">' + type + '</span>' +
                rich(frontTxt, false) + '</div>';
  const skelOn = $('#optSkeleton') && $('#optSkeleton').checked;
  if (skelOn && !ui.revealed) {
    $('#cardBack').innerHTML = qHead +
      '<div class="qbody skel">' + rich(skeletonize(backTxt), true) + '</div>' +
      '<button class="btn sm revealBtn" id="btnReveal">展开完整答案</button>';
  } else {
    $('#cardBack').innerHTML = qHead + '<div class="qbody">' + rich(backTxt, true) + '</div>';
  }
  const rb = $('#btnReveal');
  if (rb) {
    rb.addEventListener('click', function (e) {
      e.stopPropagation();
      ui.revealed = true;
      drawCard();
    });
  }
  renderMath($('#cardFrontInner') || $('#cardFront'));
  renderMath($('#cardBack'));

  $('#gradeRow').style.display = ui.flipped ? 'grid' : 'none';
  $('#cardHint').textContent = ui.flipped ? '给个反馈 · 1 不认识 / 2 模糊 / 3 认识' : '点击卡片翻转（空格）';
  if (ui.flipped) {
    const btns = $$('#gradeRow button');
    btns[0].querySelector('small').textContent = nextLabel(c, 0);
    btns[1].querySelector('small').textContent = nextLabel(c, 1);
    btns[2].querySelector('small').textContent = nextLabel(c, 2);
  }
  fitCard();
}

function flip() {
  if (!ui.queue.length || ui.qi >= ui.queue.length) { resetQueue(); return; }
  const cur = ui.queue[ui.qi];
  if (cur && cur.type === 'choice') return;      // 选择题不翻面
  ui.flipped = !ui.flipped;
  if (!ui.flipped) ui.revealed = false;
  if (ui.flipped && $('#optSpeak').checked) {
    const c = ui.queue[ui.qi];
    speak($('#optReverse').checked ? c.front : c.back);
  }
  drawCard();
}

function submitGrade(g) {
  const cur = ui.queue[ui.qi];
  const isChoice = cur && cur.type === 'choice';
  // 选择题不翻面，所以不能用 ui.flipped 当门禁；已判定即可提交
  if ((!ui.flipped && !(isChoice && ui.judged)) || ui.qi >= ui.queue.length) return;
  if (ui.animating) return;
  ui.animating = true;
  const c = ui.queue[ui.qi];
  const isNew = !c.reps;
  const res = gradeCard(c, g);
  bumpLog(isNew ? 'n' : 'r');
  if (res.short) {
    // 本轮内还要再见：往后排 5 张
    const at = Math.min(ui.queue.length, ui.qi + 1 + 5);
    ui.queue.splice(at, 0, c);
  }
  save();
  const wrap = $('#cardWrap');
  wrap.classList.add(g === 0 ? 'out-left' : (g === 2 ? 'out-right' : 'out-up'));
  setTimeout(function () {
    const inner = $('#cardInner');
    if (inner) inner.style.transition = 'none';
    wrap.classList.remove('out-left', 'out-right', 'out-up');
    ui.qi++;
    ui.flipped = false;
    ui.revealed = false;
    ui.animating = false;
    ui.picked = null;
    ui.judged = false;
    drawCard(true);
    if (inner) { void inner.offsetWidth; inner.style.transition = ''; }
  }, 210);
}

/* ============================================================
   统计页
   ============================================================ */
function renderStats() {
  const cards = allCards();
  const today = logOf();
  $('#stToday').textContent = (today.r + today.n);
  $('#stMastered').textContent = cards.filter(isMastered).length;
  $('#stDue').textContent = cards.filter(isDue).length;
  renderCurve();
  renderForecast();

  // 连续打卡
  let streak = 0;
  const d = new Date();
  if (!((S.log[dayKey(d)] || {}).r || (S.log[dayKey(d)] || {}).n)) d.setDate(d.getDate() - 1);
  for (;;) {
    const l = S.log[dayKey(d)];
    if (l && (l.r || l.n)) { streak++; d.setDate(d.getDate() - 1); } else break;
  }
  $('#stStreak').textContent = streak;

  // 热力图（近 30 天）
  const heat = $('#heat');
  const cells = [];
  let sum = 0;
  const dd = new Date();
  dd.setDate(dd.getDate() - 29);
  for (let i = 0; i < 30; i++) {
    const k = dayKey(dd);
    const l = S.log[k] || { r: 0, n: 0 };
    const v = l.r + l.n;
    sum += v;
    const lvl = v === 0 ? '' : v < 20 ? 'l1' : v < 60 ? 'l2' : 'l3';
    cells.push('<i class="' + lvl + '" title="' + k + '：' + v + ' 张"></i>');
    dd.setDate(dd.getDate() + 1);
  }
  heat.innerHTML = cells.join('');
  $('#heatTip').textContent = '30 天共复习 ' + sum + ' 张次';

  // 各卡组进度
  const rows = S.decks.map((d) => {
    const t = d.cards.length;
    const m = d.cards.filter(isMastered).length;
    const due = d.cards.filter(isDue).length;
    const pct = t ? Math.round(m / t * 100) : 0;
    return '<tr><td>' + escapeHtml(d.name) + '</td><td class="num">' + t + '</td><td class="num">' + m +
      '</td><td class="num">' + due + '</td><td class="num">' + pct + '%</td></tr>';
  }).join('');
  $('#deckStats').innerHTML = '<table><thead><tr><th>卡组</th><th class="num">总数</th><th class="num">掌握</th><th class="num">待复习</th><th class="num">进度</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="5" class="dim2">暂无</td></tr>') + '</tbody></table>';

  // 错得最多
  const worst = cards.filter((c) => c.badN > 0).sort((a, b) => b.badN - a.badN).slice(0, 20);
  $('#worstList').innerHTML = worst.length
    ? '<table><thead><tr><th>卡片</th><th class="num">不认识</th><th class="num">认识</th><th class="num">间隔</th></tr></thead><tbody>' +
      worst.map((c) => '<tr><td>' + escapeHtml(c.front.slice(0, 34)) + (c.front.length > 34 ? '…' : '') +
        '</td><td class="num" style="color:var(--bad)">' + c.badN + '</td><td class="num">' + c.okN +
        '</td><td class="num">' + c.ivl + '天</td></tr>').join('') + '</tbody></table>'
    : '<div class="dim2">还没有「不认识」记录</div>';
}

/* ============================================================
   管理页
   ============================================================ */
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try { localStorage.setItem('rq_theme', mode); } catch (e) { /* ignore */ }
  const m = document.querySelector('meta[name=theme-color]');
  if (m) {
    const dark = mode === 'dark';
    m.setAttribute('content', dark ? '#1C1C1E' : '#F2F2F7');
  }
}

function renderSettings() {
  $('#setNew').value = S.settings.newPerDay;
  $('#setRev').value = S.settings.revPerDay;
  $('#setMature').value = S.settings.mature;
  const rt = $('#setRet');
  if (rt) {
    rt.value = String(S.settings.retention);
    if (!rt.value) { rt.value = '0.90'; S.settings.retention = 0.90; }
  }
  if ($('#setMaxI')) $('#setMaxI').value = S.settings.maxInterval;
  const th = $('#setTheme');
  if (th) {
    let cur = 'light';
    try { cur = localStorage.getItem('rq_theme') || 'light'; } catch (e) { /* ignore */ }
    th.value = cur;
  }
  renderLadder();
}

/** 设置页：预览新卡的间隔阶梯 */
function renderLadder() {
  const box = $('#ladderBox');
  if (!box) return;
  const lad = previewLadder(6, S.settings.retention, S.settings.maxInterval);
  let acc = 0;
  box.innerHTML = lad.map(function (d, i) {
    acc += d;
    return '第' + (i + 1) + '次 <b>' + d + '天</b><span class="dim2">(第' + acc + '天)</span>';
  }).join(' → ');
  const ex = $('#examCap');
  if (ex) {
    const de = daysToExam();
    const eff = Math.min(S.settings.maxInterval, de);
    ex.textContent = '距初试 ' + de + ' 天 · 实际最大间隔取 min(' + S.settings.maxInterval + ', ' + de + ') = ' + eff + ' 天（保证考前每张卡都还能再滚一轮）';
  }
}

/** 统计页：遗忘曲线 */
function renderCurve() {
  const box = $('#curveBox');
  if (!box) return;
  const W = 640, H = 210, PL = 40, PR = 14, PT = 14, PB = 30;
  const maxT = 30;
  const xs = function (t) { return PL + (t / maxT) * (W - PL - PR); };
  const ys = function (r) { return PT + (1 - r) * (H - PT - PB); };
  const Ss = [1, 3, 10, 30];
  const cols = ['#f85149', '#e3a008', '#3fb950', '#4a90d9'];
  let g = '';
  // 网格 + y 轴
  [0, 0.25, 0.5, 0.75, 1].forEach(function (r) {
    g += '<line x1="' + PL + '" y1="' + ys(r).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + ys(r).toFixed(1) +
         '" stroke="#2a2f3a" stroke-width="1"/>' +
         '<text x="' + (PL - 6) + '" y="' + (ys(r) + 4).toFixed(1) + '" fill="#6b7280" font-size="10" text-anchor="end">' +
         Math.round(r * 100) + '%</text>';
  });
  [0, 7, 14, 21, 30].forEach(function (t) {
    g += '<line x1="' + xs(t).toFixed(1) + '" y1="' + PT + '" x2="' + xs(t).toFixed(1) + '" y2="' + (H - PB) +
         '" stroke="#22262f" stroke-width="1"/>' +
         '<text x="' + xs(t).toFixed(1) + '" y="' + (H - PB + 15) + '" fill="#6b7280" font-size="10" text-anchor="middle">' + t + '天</text>';
  });
  // 目标保留率线
  const ret = S.settings.retention;
  g += '<line x1="' + PL + '" y1="' + ys(ret).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + ys(ret).toFixed(1) +
       '" stroke="#4a90d9" stroke-width="1.4" stroke-dasharray="5 4"/>' +
       '<text x="' + (W - PR - 4) + '" y="' + (ys(ret) - 5).toFixed(1) + '" fill="#4a90d9" font-size="10" text-anchor="end">目标 ' + Math.round(ret * 100) + '%</text>';
  // 各稳定性曲线
  Ss.forEach(function (S, i) {
    let d = '';
    for (let t = 0; t <= maxT; t += 0.25) {
      d += (d ? 'L' : 'M') + xs(t).toFixed(1) + ' ' + ys(FSRS.forgettingCurve(t, S)).toFixed(1) + ' ';
    }
    g += '<path d="' + d + '" fill="none" stroke="' + cols[i] + '" stroke-width="2"/>' +
         '<text x="' + (xs(maxT) - 3) + '" y="' + (ys(FSRS.forgettingCurve(maxT, S)) - 5).toFixed(1) +
         '" fill="' + cols[i] + '" font-size="10" text-anchor="end">S=' + S + 'd</text>';
  });
  box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">' + g + '</svg>';
}

/** 统计页：未来 7 天到期量 */
function renderForecast() {
  const box = $('#forecast');
  if (!box) return;
  const cards = allCards();
  const now = Date.now();
  const bars = [];
  let max = 1;
  for (let i = 0; i < 7; i++) {
    const a = now + i * DAY, b = now + (i + 1) * DAY;
    const n = cards.filter(function (c) { return c.reps > 0 && c.due > a - DAY && c.due <= b; }).length;
    bars.push(n);
    if (n > max) max = n;
  }
  const newN = cards.filter(function (c) { return !c.reps; }).length;
  const lbl = ['今天', '明天', '后天', '+3', '+4', '+5', '+6'];
  box.innerHTML = bars.map(function (n, i) {
    const pct = Math.round(n / max * 100);
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '<span class="dim2" style="width:34px;flex:0 0 auto">' + lbl[i] + '</span>' +
      '<span class="bar" style="flex:1;margin:0"><i style="width:' + pct + '%"></i></span>' +
      '<span style="width:34px;text-align:right;font-size:12px;color:var(--dim)">' + n + '</span></div>';
  }).join('') +
  '<div class="dim2" style="margin-top:8px">未学新卡 ' + newN + ' 张（按每日上限 ' + S.settings.newPerDay + ' 张释放）</div>';
}

function renderCardList() {
  const d = getDeck(ui.mngDeckId);
  const box = $('#cardList');
  if (!d) { box.innerHTML = '<div class="empty">先选个卡组</div>'; return; }
  const q = ($('#cardSearch').value || '').trim().toLowerCase();
  let list = d.cards;
  if (q) {
    list = list.filter((c) =>
      c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q) ||
      c.tags.join(' ').toLowerCase().includes(q));
  }
  const cap = list.slice(0, 300);
  box.innerHTML =
    '<div class="dim2" style="margin-bottom:8px">共 ' + list.length + ' 张' + (list.length > 300 ? '（只显示前 300）' : '') + '</div>' +
    '<table><thead><tr><th>正面</th><th>标签</th><th class="num">间隔</th><th></th></tr></thead><tbody>' +
    cap.map((c) => '<tr>' +
      '<td>' + escapeHtml(c.front.slice(0, 40)) + (c.front.length > 40 ? '…' : '') + '</td>' +
      '<td class="dim2">' + escapeHtml(c.tags.join(' / ')) + '</td>' +
      '<td class="num">' + c.ivl + '天</td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn ghost xs" data-edit="' + c.id + '">改</button> ' +
        '<button class="btn ghost xs" data-del="' + c.id + '" style="color:var(--bad)">删</button>' +
      '</td></tr>').join('') +
    '</tbody></table>';
  $$('#cardList [data-edit]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.edit)));
  $$('#cardList [data-del]').forEach((b) => b.addEventListener('click', () => {
    const deck = getDeck(ui.mngDeckId);
    const i = deck.cards.findIndex((c) => c.id === b.dataset.del);
    if (i < 0) return;
    if (!confirm('删除这张卡片？\n' + deck.cards[i].front.slice(0, 60))) return;
    deck.cards.splice(i, 1);
    save(); renderCardList(); renderHome(); toast('已删除');
  }));
}

/* ---------- 卡片弹窗 ---------- */
function openCard(cardId) {
  const d = getDeck(ui.mngDeckId);
  if (!d) return;
  ui.editCard = { deckId: d.id, cardId: cardId || null };
  const c = cardId ? d.cards.find((x) => x.id === cardId) : null;
  $('#mCardTitle').textContent = c ? '编辑卡片' : '新增卡片';
  $('#mFront').value = c ? c.front : '';
  $('#mBack').value = c ? c.back : '';
  $('#mTags').value = c ? c.tags.join(', ') : '';
  $('#maskCard').classList.add('on');
  setTimeout(() => $('#mFront').focus(), 50);
}
function saveCard() {
  const d = getDeck(ui.editCard.deckId);
  if (!d) return;
  const front = $('#mFront').value.trim();
  const back = $('#mBack').value;
  const tags = $('#mTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!front) { toast('正面不能为空'); return; }
  if (ui.editCard.cardId) {
    const c = d.cards.find((x) => x.id === ui.editCard.cardId);
    if (c) { c.front = front; c.back = back; c.tags = tags; }
  } else {
    d.cards.push(normCard({ id: uid('c'), front: front, back: back, tags: tags }));
  }
  save();
  $('#maskCard').classList.remove('on');
  renderCardList(); renderHome(); fillDeckSelects();
  toast('已保存');
}

/* ---------- 卡组弹窗 ---------- */
function openDeck(deckId) {
  ui.editDeck = { deckId: deckId || null };
  const d = deckId ? getDeck(deckId) : null;
  $('#mDeckTitle').textContent = d ? '编辑卡组' : '新建卡组';
  $('#dName').value = d ? d.name : '';
  $('#dDesc').value = d ? (d.desc || '') : '';
  $('#dColor').value = d ? (d.color || '#4a90d9') : '#4a90d9';
  $('#maskDeck').classList.add('on');
  setTimeout(() => $('#dName').focus(), 50);
}
function saveDeck() {
  const name = $('#dName').value.trim();
  if (!name) { toast('名称不能为空'); return; }
  if (ui.editDeck.deckId) {
    const d = getDeck(ui.editDeck.deckId);
    if (d) { d.name = name; d.desc = $('#dDesc').value.trim(); d.color = $('#dColor').value; }
  } else {
    S.decks.push({ id: uid('d'), name: name, desc: $('#dDesc').value.trim(), color: $('#dColor').value, cards: [] });
  }
  save();
  $('#maskDeck').classList.remove('on');
  fillDeckSelects(); renderHome();
  toast('已保存');
}

/* ============================================================
   导入 / 导出
   ============================================================ */
function parseDelim(text, d) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === d) { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
  }
  row.push(cur); rows.push(row);
  const out = [];
  for (const r of rows) {
    if (!r.join('').trim()) continue;
    const front = (r[0] || '').trim();
    if (!front) continue;
    if (/^(正面|front|问题|题目|question)$/i.test(front)) continue;
    const back = (r[1] || '').trim();
    const tags = (r[2] || '').split(/[,，;；|]+/).map((s) => s.trim()).filter(Boolean);
    out.push({ front: front, back: back, tags: tags });
  }
  return out;
}
function parseMarkji(t) {
  const out = [];
  let tags = [], buf = [];
  const flush = () => {
    const b = buf.filter((x) => x.trim() !== '');
    for (let i = 0; i < b.length; i += 2) {
      out.push({ front: b[i].trim(), back: (b[i + 1] || '').trim(), tags: tags.slice() });
    }
    buf = [];
  };
  for (const line of t.split('\n')) {
    if (/^\s*#/.test(line)) { flush(); tags = line.replace(/^\s*#+\s*/, '').split(/[\s,，;；]+/).filter(Boolean); continue; }
    if (line.trim() === '') { flush(); continue; }
    buf.push(line);
  }
  flush();
  return out.filter((c) => c.front);
}
function parseImport(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!t) return [];
  // JSON
  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(t);
      let arr = [];
      if (Array.isArray(j)) arr = j;
      else if (Array.isArray(j.decks)) j.decks.forEach((d) => (d.cards || []).forEach((c) => arr.push(Object.assign({}, c, { tags: c.tags || [d.name] }))));
      else if (Array.isArray(j.cards)) arr = j.cards;
      return arr.map((c) => ({
        front: String(c.front != null ? c.front : (c.正面 || '')).trim(),
        back: String(c.back != null ? c.back : (c.背面 || '')),
        tags: Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(/[,，]/).filter(Boolean)
      })).filter((c) => c.front);
    } catch (e) { /* 落到文本解析 */ }
  }
  const lines = t.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l));
  if (lines.length) {
    const tabN = lines.filter((l) => l.includes('\t')).length;
    if (tabN >= Math.ceil(lines.length * 0.5)) return parseDelim(t, '\t');
    const commaN = lines.filter((l) => l.split(',').length >= 2).length;
    if (commaN >= Math.ceil(lines.length * 0.6) && lines.length >= 2) return parseDelim(t, ',');
  }
  return parseMarkji(t);
}
function doImport(text, srcLabel) {
  const deck = getDeck(ui.impDeckId || ($('#impDeck') || {}).value);
  if (!deck) { toast('先选目标卡组'); return; }
  const items = parseImport(text);
  if (!items.length) { toast('没解析出内容，检查一下格式'); return; }
  const append = $('#impAppend').checked;
  if (!append) deck.cards = [];
  items.forEach((it) => deck.cards.push(normCard({ id: uid('c'), front: it.front, back: it.back, tags: it.tags })));
  save();
  ui.impDeckId = deck.id;
  fillDeckSelects(); renderHome(); renderCardList(); renderStudyChrome(); resetQueue();
  toast((append ? '追加 ' : '替换为 ') + items.length + ' 张 → ' + deck.name);
}
function csvCell(s) {
  s = String(s == null ? '' : s);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv() {
  const lines = ['正面,背面,标签'];
  S.decks.forEach((d) => d.cards.forEach((c) => {
    lines.push([c.front, c.back, c.tags.join(' ')].map(csvCell).join(','));
  }));
  download('rq背诵站_导出_' + dayKey() + '.csv', lines.join('\n'), 'text/csv');
  toast('已导出 CSV');
}
function exportJson() {
  download('rq背诵站_备份_' + dayKey() + '.json', JSON.stringify(S, null, 1), 'application/json');
  toast('已导出 JSON');
}
function exportMarkji() {
  const parts = [];
  S.decks.forEach((d) => {
    parts.push('# ' + d.name);
    d.cards.forEach((c) => {
      if (c.tags.length) parts.push('# ' + c.tags.join(' '));
      parts.push(c.front);
      parts.push(c.back);
      parts.push('');
    });
    parts.push('');
  });
  download('rq背诵站_Markji文本_' + dayKey() + '.txt', parts.join('\n'), 'text/plain');
  toast('已导出 Markji 文本');
}

/* ============================================================
   事件绑定
   ============================================================ */
function bind() {
  $$('nav.tabbar button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
    $('#maskCard').classList.remove('on');
    $('#maskDeck').classList.remove('on');
  }));
  $$('.mask').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('on'); }));

  // 首页
  $('#btnQuick').addEventListener('click', () => {
    ui.studyDeckId = '__all';
    ui.tags.clear();
    $('#studyRange').value = 'due';
    go('study');
  });
  $('#btnNewDeck').addEventListener('click', () => openDeck(null));
  $('#btnEditDeck').addEventListener('click', () => { if (ui.mngDeckId) openDeck(ui.mngDeckId); });
  $('#btnDelDeck').addEventListener('click', () => {
    const d = getDeck(ui.mngDeckId);
    if (!d) return;
    if (S.decks.length <= 1) { toast('至少保留一个卡组'); return; }
    if (!confirm('删除卡组「' + d.name + '」及其 ' + d.cards.length + ' 张卡片？')) return;
    S.removedDecks = S.removedDecks || [];
    if (S.removedDecks.indexOf(d.id) < 0) S.removedDecks.push(d.id);
    S.decks = S.decks.filter((x) => x.id !== d.id);
    ui.mngDeckId = null; ui.studyDeckId = S.decks[0].id; ui.impDeckId = null;
    save(); fillDeckSelects(); renderHome(); renderCardList(); renderStudyChrome();
    toast('已删除');
  });

  // 学习页
  $('#studyDeck').addEventListener('change', (e) => {
    ui.studyDeckId = e.target.value;
    ui.tags.clear();
    renderStudyChrome(); resetQueue();
  });
  $('#studyRange').addEventListener('change', resetQueue);
  $('#optShuffle').addEventListener('change', resetQueue);
  $('#optReverse').addEventListener('change', drawCard);
  if ($('#optSkeleton')) $('#optSkeleton').addEventListener('change', () => { ui.revealed = false; drawCard(); });
  $('#btnRestart').addEventListener('click', () => { resetQueue(); toast('已重新取队列'); });
  $('#btnExitStudy').addEventListener('click', () => go('home'));
  if ($('#btnFilters')) {
    $('#btnFilters').addEventListener('click', () => {
      const f = $('#studyFilters');
      const open = f.style.display === 'none' || !f.style.display;
      f.style.display = open ? 'block' : 'none';
      $('#btnFilters').textContent = open ? '收起' : '筛选';
      setTimeout(fitCard, 30);
    });
  }

  $('#cardWrap').addEventListener('click', (e) => {
    const T = e.target;
    if (!T.closest) { flip(); return; }
    const opt = T.closest('.opt');
    if (opt) { pickOption(opt.dataset.k); return; }
    if (T.closest('#btnSubmitQ')) { judgeChoice(); return; }
    if (T.closest('#btnNextQ')) {
      const c = ui.queue[ui.qi];
      const ok = c && sameSet(ui.picked || new Set(), c.answer || []);
      submitGrade(ok ? 2 : 0);
      return;
    }
    const cl = T.closest('.cloze');
    if (cl && cl.classList.contains('hidden')) { cl.classList.remove('hidden'); return; }
    flip();
  });
  $$('#gradeRow button').forEach((b) => b.addEventListener('click', () => submitGrade(Number(b.dataset.g))));

  // 管理页
  $('#btnImpFile').addEventListener('click', () => $('#impFile').click());
  $('#impFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { doImport(r.result, f.name); e.target.value = ''; };
    r.readAsText(f, 'utf-8');
  });
  $('#btnImpText').addEventListener('click', () => {
    const t = $('#impText').value;
    if (!t.trim()) { toast('先粘点内容'); return; }
    doImport(t, '粘贴');
    $('#impText').value = '';
  });
  $('#btnExpJson').addEventListener('click', exportJson);
  $('#btnExpCsv').addEventListener('click', exportCsv);
  $('#btnExpMarkji').addEventListener('click', exportMarkji);

  $('#mngDeck').addEventListener('change', (e) => { ui.mngDeckId = e.target.value; renderCardList(); });
  $('#impDeck').addEventListener('change', (e) => { ui.impDeckId = e.target.value; });
  $('#cardSearch').addEventListener('input', renderCardList);
  $('#btnAddCard').addEventListener('click', () => openCard(null));
  $('#mSave').addEventListener('click', saveCard);
  $('#dSave').addEventListener('click', saveDeck);

  ['setNew', 'setRev', 'setMature', 'setMaxI'].forEach((id) => {
    const el = $('#' + id);
    if (!el) return;
    el.addEventListener('change', () => {
      S.settings.newPerDay = clamp(parseInt($('#setNew').value, 10) || 0, 0, 999);
      S.settings.revPerDay = clamp(parseInt($('#setRev').value, 10) || 0, 0, 9999);
      S.settings.mature = clamp(parseInt($('#setMature').value, 10) || 21, 1, 365);
      S.settings.maxInterval = clamp(parseInt($('#setMaxI').value, 10) || 21, 1, 365);
      save(); renderSettings(); toast('已保存设置');
    });
  });
  if ($('#setTheme')) {
    $('#setTheme').addEventListener('change', (e) => {
      applyTheme(e.target.value);
      toast('主题：' + e.target.selectedOptions[0].textContent);
    });
  }
  if ($('#setRet')) {
    $('#setRet').addEventListener('change', (e) => {
      S.settings.retention = parseFloat(e.target.value) || 0.90;
      save(); renderSettings();
      toast('目标保留率 ' + Math.round(S.settings.retention * 100) + '%');
    });
  }

  $('#btnResetProgress').addEventListener('click', () => {
    if (!confirm('重置所有卡片的复习进度（卡片内容保留）？')) return;
    allCards().forEach((c) => {
      c.st = 0; c.due = 0; c.ivl = 0; c.ease = 2.5;
      c.reps = 0; c.lapses = 0; c.last = 0; c.lastReview = 0;
      c.S = 0; c.D = 0; c.okN = 0; c.badN = 0; c.lastR = 0;
    });
    S.log = {};
    save(); renderHome(); renderStats(); renderSettings(); toast('进度已重置');
  });
  $('#btnWipe').addEventListener('click', () => {
    if (!confirm('清空全部数据（卡组、卡片、进度）？此操作不可撤销。')) return;
    if (!confirm('真的确定？建议先导出 JSON 备份。')) return;
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
    location.reload();
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (ui.tab !== 'study') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const cur = ui.queue[ui.qi];
    const isChoice = cur && cur.type === 'choice';
    if (isChoice) {
      const k = e.key.toUpperCase();
      if (['A', 'B', 'C', 'D'].indexOf(k) >= 0) { e.preventDefault(); pickOption(k); }
      else if (e.key === 'Enter' && ui.judged) {
        e.preventDefault();
        submitGrade(sameSet(ui.picked || new Set(), cur.answer || []) ? 2 : 0);
      } else if (e.key === 'Enter') { e.preventDefault(); judgeChoice(); }
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
    else if (e.key === '1') submitGrade(0);
    else if (e.key === '2') submitGrade(1);
    else if (e.key === '3') submitGrade(2);
  });
}

/* ---------------- 启动 ---------------- */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
function renderAbout() {
  const box = $('#aboutBox');
  if (!box) return;
  const cards = allCards().length;
  const decks = S.decks.length;
  const used = (() => { try { return (localStorage.getItem(LS_KEY) || '').length; } catch (e) { return 0; } })();
  box.innerHTML =
    'rq 背诵站 v1.1 · 离线可用<br>' +
    decks + ' 个卡组 / ' + cards + ' 张卡片 · 本地占用 ' + (used / 1024).toFixed(1) + ' KB<br>' +
    '记忆引擎：<b>FSRS</b>（DSR 模型 · 遗忘曲线）· 目标保留率 ' + Math.round(S.settings.retention * 100) +
    '% · 最大间隔 ' + S.settings.maxInterval + ' 天<br>' +
    '评分：不认识 / 模糊 / 认识 → 每张卡单独算下次复习时间<br>' +
    '已安装到主屏幕：' + (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches ? '是' : '否（Safari → 分享 → 添加到主屏幕）');
}
function init() {
  load();
  bind();
  fillDeckSelects();
  // 深链：?deck=政治 直接选中对应卡组
  try {
    const want = new URLSearchParams(location.search).get('deck');
    if (want) {
      const d = S.decks.find(function (x) { return x.name.indexOf(want) >= 0; });
      if (d) ui.studyDeckId = d.id;
    }
  } catch (e) { /* ignore */ }
  const h = (location.hash || '').replace('#', '');
  const start = ['home', 'study', 'stats', 'manage'].indexOf(h) >= 0 ? h : 'home';
  go(start);
  renderAbout();
  registerSW();
  window.addEventListener('resize', fitCard);
  window.addEventListener('orientationchange', () => setTimeout(fitCard, 260));
  window.addEventListener('beforeunload', () => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();

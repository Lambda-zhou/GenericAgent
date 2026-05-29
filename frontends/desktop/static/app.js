// GenericAgent 桌面版 —— bridge 适配 + 业务 UI（HTTP 命令 / WS 状态 / i18n）。
// 文案全部走 i18n：静态用 data-i18n / data-i18n-ph / data-i18n-title，
// 动态用 t(key)。dev 标注层与发给 agent 的预设 prompt 不进 UI 字典。
'use strict';

/* ═══════════════ 进程状态 store ═══════════════ */
const _serviceById = {};
const _serviceListeners = new Set();

function _serviceList() {
  return Object.values(_serviceById).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function _serviceNotify() {
  const items = _serviceList();
  for (const cb of _serviceListeners) {
    try { cb(items, _serviceById); } catch (e) { console.error('[service-store]', e); }
  }
}

const gaServiceStore = {
  applySnapshot(services) {
    for (const k of Object.keys(_serviceById)) delete _serviceById[k];
    for (const s of services || []) {
      if (s && s.id) _serviceById[s.id] = s;
    }
    _serviceNotify();
  },
  applyChanged(service) {
    if (service && service.id) _serviceById[service.id] = service;
    _serviceNotify();
  },
  onServices(cb) {
    _serviceListeners.add(cb);
    cb(_serviceList(), _serviceById);
    return () => _serviceListeners.delete(cb);
  },
  list: _serviceList,
  get: (id) => _serviceById[id],
};

/* ═══════════════ Bridge 适配（HTTP 命令 + WS 状态） ═══════════════ */
(function initGaBridge() {
  const listeners = new Map();
  let ws = null;
  let cachedBridgeReady = null;
  const bridgeBase = `${location.protocol}//${location.hostname}:14168`;
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:14168/ws`;

  function on(channel, cb) {
    if (typeof cb !== 'function') return () => {};
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    if (channel === 'bridge-ready' && cachedBridgeReady) {
      try { cb(cachedBridgeReady); } catch (err) { console.error('[ga bridge] replay bridge-ready', err); }
    }
    return () => listeners.get(channel)?.delete(cb);
  }

  function emit(channel, payload) {
    if (channel === 'bridge-ready') cachedBridgeReady = payload;
    const set = listeners.get(channel);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try { cb(payload); } catch (err) { console.error('[ga bridge]', channel, err); }
    }
  }

  function handleServiceWs(msg) {
    if (msg.type === 'services.snapshot') gaServiceStore.applySnapshot(msg.services);
    else if (msg.type === 'service.changed') gaServiceStore.applyChanged(msg.service);
    emit('service-state', msg);
  }

  async function http(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const init = Object.assign({}, options, { headers });
    if (init.body && typeof init.body !== 'string') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const res = await fetch(`${bridgeBase}${path}`, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => emit('bridge-log', 'WS connected'));
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === 'bridge-ready') emit('bridge-ready', msg);
        else if (msg.type === 'services.snapshot' || msg.type === 'service.changed') handleServiceWs(msg);
        else if (msg.type === 'session-state') emit('bridge-notification', msg);
        else if (msg.type === 'bridge-log') emit('bridge-log', msg.payload || msg);
        else if (msg.type === 'bridge-error') emit('bridge-error', msg.payload || msg);
      });
      ws.addEventListener('close', () => emit('bridge-closed', { reason: 'ws-closed' }));
      ws.addEventListener('error', () => emit('bridge-error', { type: 'ws-error', message: 'WebSocket error' }));
    } catch (err) {
      emit('bridge-error', { type: 'ws-error', message: err.message || String(err) });
    }
  }

  async function rpc(method, params = {}) {
    switch (method) {
      case 'app/status': return http('/status');
      case 'app/config/get': return http('/config');
      case 'app/config/save': return http('/config', { method: 'POST', body: params || {} });
      case 'get/model-profiles': return http('/model-profiles');
      case 'session/new': return http('/session/new', { method: 'POST', body: params || {} });
      case 'session/prompt': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/prompt missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/prompt`, { method: 'POST', body: params || {} });
      }
      case 'session/poll': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/poll missing sessionId');
        const after = params.afterId ?? params.after ?? 0;
        const limit = params.limit ?? 200;
        return http(`/session/${encodeURIComponent(sid)}/messages?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`);
      }
      case 'session/cancel': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/cancel missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/cancel`, { method: 'POST', body: params || {} });
      }
      case 'app/path/open': return http('/path/open', { method: 'POST', body: params || {} });
      case 'services/start': {
        const id = params.id;
        if (!id) throw new Error('services/start missing id');
        return http('/services/start', { method: 'POST', body: { id } });
      }
      case 'services/stop': {
        const id = params.id;
        if (!id) throw new Error('services/stop missing id');
        return http('/services/stop', { method: 'POST', body: { id } });
      }
      case 'services/logs': {
        const id = params.id;
        if (!id) throw new Error('services/logs missing id');
        const tail = params.tail ?? 200;
        return http(`/services/logs?id=${encodeURIComponent(id)}&tail=${encodeURIComponent(tail)}`);
      }
      case 'services/panel': return http('/services/panel');
      case 'services/mykey/get': return http('/services/mykey');
      case 'services/mykey/save': return http('/services/mykey', { method: 'POST', body: params || {} });
      case 'app/path/selectGaRoot': return http('/config');
      case 'list_continuable_sessions': return { sessions: [] };
      case 'restore_session': throw new Error('restore_session is not implemented in web2 bridge');
      default: throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  async function startService(id) {
    try {
      const res = await rpc('services/start', { id });
      if (res.service) gaServiceStore.applyChanged(res.service);
      return res;
    } catch (e) {
      if (e.data && e.data.service) gaServiceStore.applyChanged(e.data.service);
      throw e;
    }
  }

  async function stopService(id) {
    const res = await rpc('services/stop', { id });
    if (res.service) gaServiceStore.applyChanged(res.service);
    return res;
  }

  window.ga = {
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32',
    startBridge: async () => { connectWs(); return http('/status'); },
    stopBridge: async () => ({ ok: true }),
    checkStatus: () => rpc('app/status', {}),
    getConfig: () => rpc('app/config/get', {}),
    saveConfig: (cfg) => rpc('app/config/save', cfg || {}),
    getModelProfiles: () => rpc('get/model-profiles', {}),
    selectGaRoot: () => rpc('app/path/selectGaRoot', {}),
    openMykeyTemplate: () => rpc('app/path/open', { kind: 'mykeyTemplate' }),
    openMykey: () => rpc('app/path/open', { kind: 'mykey' }),
    startService,
    stopService,
    getServiceLogs: (id, tail = 200) => rpc('services/logs', { id, tail }),
    getServicePanel: () => rpc('services/panel', {}),
    getMykeyContent: () => rpc('services/mykey/get', {}),
    saveMykeyContent: (content) => rpc('services/mykey/save', { content }),
    pollSession: (sessionId, afterId = 0) => rpc('session/poll', { sessionId, afterId }),
    rpc,
    onBridgeMessage: (cb) => on('bridge-message', cb),
    onBridgeNotification: (cb) => on('bridge-notification', cb),
    onBridgeError: (cb) => on('bridge-error', cb),
    onBridgeClosed: (cb) => on('bridge-closed', cb),
    onBridgeReady: (cb) => on('bridge-ready', cb),
    onBridgeLog: (cb) => on('bridge-log', cb),
    onServiceState: (cb) => on('service-state', cb),
    onOpenSearch: (cb) => on('open-search', cb),
  };

  connectWs();
  http('/status').then(status => emit('bridge-ready', status))
    .catch(err => emit('bridge-error', { type: 'http-error', message: err.message || String(err) }));
})();

/* ═══════════════ i18n ═══════════════ */
const I18N = {
  zh: {
    'app.title': 'GenericAgent 桌面版',
    'brand.sub': '桌面终端',
    'nav.chat': '聊天', 'nav.channels': '消息通道', 'nav.status': '状态面板',
    'nav.collab': 'Agent 指挥', 'nav.token': 'Token 统计',
    'foot.settings': '配置', 'foot.ver': 'GenericAgent · 桌面版',
    'chat.startTitle': '开始对话', 'chat.startSub': '直接输入，或点预设功能一键启动',
    'preset.butler.t': 'Conductor', 'preset.butler.d': '复杂任务自动拆活，进度在 Conductor 查看',
    'preset.plan.t': 'Plan 模式', 'preset.plan.d': '加载 Plan SOP，按探索→规划→执行→验证流程',
    'preset.goal.t': 'Goal 模式', 'preset.goal.d': '设定目标，自主完成',
    'preset.explore.t': '自主探索', 'preset.explore.d': '自动浏览并周期汇总',
    'preset.hive.t': 'Hive 协作', 'preset.hive.d': '多 worker 协同攻坚',
    'preset.review.t': '深度复核', 'preset.review.d': '挑刺式质量把关',
    'preset.mine.t': '我的·周报', 'preset.mine.d': '自定义：抓本周提交并写周报',
    'preset.add.t': '自定义', 'preset.add.d': '任意一句话存为功能',
    'composer.placeholder': '输入消息… (Enter 发送, Shift+Enter 换行)',
    'search.placeholder': '搜索会话…', 'conv.new': '新对话',
    'ctx.pin': '置顶', 'ctx.unpin': '取消置顶', 'ctx.rename': '重命名', 'ctx.del': '删除',
    'common.close': '关闭', 'common.more': '更多', 'common.optional': '选填', 'common.save': '保存',
    'modal.preset': '预设功能', 'modal.addModel': '添加模型', 'modal.editModel': '编辑模型', 'modal.settings': '配置',
    'modal.customPreset': '自定义预设',
    'customPreset.titlePh': '标题，例如「写周报」',
    'customPreset.promptPh': 'Prompt 内容，发送时会作为消息提交',
    'customPreset.empty': '标题和 Prompt 不能为空',
    'customPreset.removeTitle': '删除',
    'builtinPreset.restoreBtn': '恢复默认预设',
    'set.appearance': '外观', 'set.plainUi': '素色', 'set.fontSize': '聊天字号', 'set.theme': '颜色', 'set.lang': '语言', 'set.model': '模型', 'set.addModel': '添加模型',
    'appearance.light': '浅色', 'appearance.dark': '深色',
    'set.noModels': '暂无模型，点击下方添加',
    'lang.zh': '简体中文', 'lang.en': 'English',
    'model.name': '备注', 'model.namePh': '会显示在模型列表',
    'model.apikey': 'API Key', 'model.apikeyPh': 'sk-...', 'model.apikeyKeep': '留空则保持原 Key 不变',
    'model.apibase': 'API 地址', 'model.apibasePh': 'https://.../v1/messages',
    'model.protocol': '协议', 'model.protocolPick': '请选择…', 'model.protocolOai': 'OpenAI 兼容 (chat/completions)', 'model.protocolClaude': 'Anthropic (Claude /v1/messages)',
    'model.model': '模型', 'model.modelPh': 'model 参数名',
    'model.modelHint': '须与中转站/官方文档中的 model 字段完全一致',
    'model.retries': '重试 (次)', 'model.connTimeout': '连接超时 (s)', 'model.readTimeout': '读取超时 (s)',
    'model.save': '保存', 'common.cancel': '取消', 'common.edit': '编辑', 'common.delete': '删除',
    'err.modelSave': '保存失败', 'err.modelRequired': '请填写模型、API Key 和 API 地址',
    'err.modelDelete': '删除失败', 'err.modelDeleteLast': '至少保留一个模型',
    'confirm.modelDelete': '确定删除该模型配置？',
    'page.channels.title': '消息通道', 'page.channels.sub': '后台 IM 进程：列表、启停与日志（同 hub.pyw）',
    'page.status.title': '状态面板', 'page.status.sub': 'hub.pyw 管理的后台进程/服务，集中查看与启停',
    'page.collab.title': 'Conductor', 'page.collab.sub': '交代目标，自动拆活与跟进',
    'collab.progressTitle': '分工进度',
    'collab.progressEmpty': '还没有任务在执行。告诉 Conductor 你的目标后，这里会显示拆分后的处理进度。',
    'collab.chatTitle': '与 Conductor 对话',
    'collab.placeholder': '描述你想完成的目标，Enter 发送…',
    'collab.guideTitle': '把要完成的事告诉 Conductor',
    'collab.guideWhen': '适合需要多步处理、要花一些时间才能完成的目标。日常聊天和快问快答，请用左侧「聊天」。',
    'collab.guideStep1t': '描述目标',
    'collab.guideStep1d': '在聊天框里写下你想做的事，发给 Conductor',
    'collab.guideStep2t': '自动拆解',
    'collab.guideStep2d': 'Conductor 自动拆解、分配任务，实时监督和调度',
    'collab.guideStep3t': '交付摘要',
    'collab.guideStep3d': 'Conductor 根据执行状态，呈上任务简报',
    'collab.guideStep4t': '随时调整',
    'collab.guideStep4d': '随时补充要求或细节，Conductor 都会处理',
    'collab.chipProgress': '现在进展如何？',
    'collab.chipPause': '先暂停当前任务',
    'collab.chipSummary': '总结一下目前的结果',
    'collab.showProgressTitle': '查看任务执行进度（窄屏）',
    'collab.progressStats': '{running} 进行中 · {done} 已完成 · {issue} 需关注',
    'collab.typing': 'Conductor 正在处理',
    'collab.offline': '无法连接 Conductor（8900）。请确认服务已启动且本地已穿透 8900 端口。',
    'collab.retry': '重试',
    'collab.reconnect': '连接断开，正在重连… 已保留上次任务进度。',
    'collab.reconnectIn': '{n} 秒后重试',
    'collab.sticky': '{n} 个任务进行中',
    'collab.stRunning': '执行中', 'collab.stReported': '已回报', 'collab.stPaused': '已暂停',
    'collab.stFailed': '遇到问题', 'collab.stTerminated': '已终止',
    'collab.summaryRunning': '正在处理中…', 'collab.summaryWait': '等待回报',
    'collab.taskFallback': '任务 {n}',
    'collab.timeJust': '刚刚',
    'collab.timeSec': '{n} 秒前',
    'collab.timeMin': '{n} 分钟前',
    'collab.timeHr': '{n} 小时前',
    'collab.timeDay': '{n} 天前',
    'page.token.title': 'Token 统计', 'page.token.sub': '每会话与累计的 token 用量及估算成本',
    'status.connecting': '连接中…', 'status.ready': '就绪', 'status.running': '运行中',
    'status.disconnected': '未连接', 'status.stopped': '已停止', 'status.idle': '空闲',
    'conv.emptyList': '暂无会话，点「＋ 新对话」开始', 'conv.defaultTitle': '新对话',
    'err.bridge': 'bridge 未连接', 'err.newSession': '新建会话失败', 'err.poll': '轮询失败', 'err.stop': '停止失败',
    'err.interruptTimeout': '等待上一轮停止超时，请稍后再试',
    'sys.interruptPrev.hint': '已停止上一轮，正在处理新消息',
    'chat.interrupting': '正在停止上一轮…',
    'sys.stopRequested': '已请求停止',
    'slash.help': '可用命令：\n/new 新会话  /clear 清屏  /stop 停止  /settings 设置',
    'slash.unknown': '未知命令',
    'upload.hint': '上传文件：选择 / 拖拽 / 粘贴',
    'upload.button': '上传文件',
    'upload.tooLarge': '文件过大或数量超限', 'upload.empty': '跳过空文件',
    'upload.failed': '上传失败',
    'err.charLimit': '已达字数上限（{n}），发送时将自动截断', 'err.numMax': '不能超过 {n}',
    'file.openFailed': '无法打开文件',
    'file.kindGeneric': '文件',
    'file.kindDoc': '文档',
    'file.kindSheet': '表格',
    'file.kindSlide': '幻灯片',
    'file.kindCode': '代码',
    'file.kindArchive': '压缩包',
    'file.kindAudio': '音频',
    'file.kindVideo': '视频',
    'upload.removeTitle': '移除',
    'upload.dropHint': '松开以上传文件',
    'lightbox.closeTitle': '关闭',
    'fold.thinking': '思考', 'fold.tool': '工具调用', 'fold.toolResult': '工具结果', 'fold.llm': 'LLM Running', 'fold.turn': '第 {n} 轮',
    'timing.elapsed': '已运行 {t}',
    'model.auto': '自动选择',
    'model.menuLabel': '选择模型',
    'chip.plan': 'Plan',
    'chip.auto': 'Auto',
    'ch.wechat': '微信', 'ch.wecom': '企业微信', 'ch.lark': '飞书', 'ch.dingtalk': '钉钉',
    'ch.qq': 'QQ', 'ch.telegram': 'Telegram', 'ch.discord': 'Discord',
    'ch.loading': '加载中…', 'ch.empty': '未发现 IM 进程脚本',
    'ch.logEmpty': '暂无日志',
    'err.channelLoad': '加载失败', 'err.channelStart': '启动失败', 'err.channelStop': '停止失败',
    'err.channelNotConfigured': '请先在 mykey.py 中配置该平台',
    'sys.channelStarted': '已启动', 'sys.channelStopped': '已停止',
    'modal.channelLogs': '进程日志',
    'modal.mykeyConfig': 'mykey.py 配置',
    'sys.configSaved': '配置已保存',
    'st.starting': '启动中…', 'st.stopping': '停止中…',
    'st.online': '在线', 'st.offline': '离线', 'st.error': '错误', 'st.running': '运行', 'st.abnormal': '异常',
    'act.configure': '配置', 'act.logs': '日志', 'act.restart': '重启', 'act.stop': '停止', 'act.start': '启动',
    'act.copy': '复制', 'act.copied': '已复制', 'act.copyTex': 'TeX', 'act.send': '发送',
    'proc.imbotWechat': 'imbot · 微信', 'proc.imbotDing': 'imbot · 钉钉', 'proc.scheduler': '定时任务调度',
    'cm.scheduling': '调度中', 'cm.running': '执行中', 'cm.idleSt': '空闲',
    'cm.master': '已派 3 子任务', 'cm.w1': '子任务：抓取数据', 'cm.w2': '子任务：复核结果', 'cm.sub': '等待派单',
    'tok.total': '累计 token', 'tok.cost': '估算成本', 'tok.today': '今日 token', 'tok.tabAll': '总体', 'tok.tabConductor': 'Subagent Token 消耗',
    'tok.colSession': '会话', 'tok.colIn': '输入', 'tok.colOut': '输出', 'tok.colCacheW': '缓存写入', 'tok.colCache': '缓存读取', 'tok.colCost': '成本',
    'tok.from': '从', 'tok.to': '到', 'tok.reset': '重置', 'tok.noData': '暂无记录', 'tok.deleted': '此会话已删除',
    'tok.pricingUnknown': '⚠ 此模型计费规则尚未明确，按默认估算',
    'tok.priceInput': '输入: $', 'tok.priceOutput': '输出: $',
    'tok.priceCacheW': '缓存写入: $', 'tok.priceCacheR': '缓存读取: $',
    'presetPrompt.goal': '进入 Goal 模式：读 L3 goal mode SOP，自主达成我接下来描述的目标。',
    'presetPrompt.plan': '进入 Plan 模式：先读 memory/plan_sop.md，按其中「探索→规划→执行→验证」流程，等我接下来描述要做的任务。',
    'presetPrompt.explore': '进入自主探索模式：自动浏览并定期向我汇总要点。',
    'presetPrompt.hive': '启动 Goal Hive 模式：按 hive SOP 拉起多个 worker 协同完成我接下来的目标。',
    'presetPrompt.review': '进入监察者模式：对刚才的产出严格挑刺、逐项复核并报告问题。',
    'presetPrompt.mine': '抓取本周的 git 提交并写一份周报。',
    'ask.banner': 'GA 等你回答',
    'ask.replyHint': '在下方输入框回复',
    'ask.placeholderOpen': '在此输入你的回答… (Enter 发送)',
  },
  en: {
    'app.title': 'GenericAgent Desktop',
    'brand.sub': 'Desktop terminal',
    'nav.chat': 'Chat', 'nav.channels': 'Channels', 'nav.status': 'Status',
    'nav.collab': 'Conductor', 'nav.token': 'Token usage',
    'foot.settings': 'Settings', 'foot.ver': 'GenericAgent · Desktop',
    'chat.startTitle': 'Start a conversation', 'chat.startSub': 'Type a message, or pick a preset',
    'preset.butler.t': 'Conductor', 'preset.butler.d': 'Delegate complex tasks; track progress in Conductor',
    'preset.plan.t': 'Plan mode', 'preset.plan.d': 'Load Plan SOP — explore→plan→execute→verify',
    'preset.goal.t': 'Goal mode', 'preset.goal.d': 'Set a goal, run autonomously',
    'preset.explore.t': 'Auto explore', 'preset.explore.d': 'Browse & summarize periodically',
    'preset.hive.t': 'Hive', 'preset.hive.d': 'Multi-worker collaboration',
    'preset.review.t': 'Deep review', 'preset.review.d': 'Strict quality check',
    'preset.mine.t': 'My · Weekly', 'preset.mine.d': 'Custom: weekly report from commits',
    'preset.add.t': 'Custom', 'preset.add.d': 'Save any prompt as a function',
    'composer.placeholder': 'Type a message… (Enter to send, Shift+Enter for newline)',
    'search.placeholder': 'Search chats…', 'conv.new': 'New chat',
    'ctx.pin': 'Pin', 'ctx.unpin': 'Unpin', 'ctx.rename': 'Rename', 'ctx.del': 'Delete',
    'common.close': 'Close', 'common.more': 'More', 'common.optional': 'Optional', 'common.save': 'Save',
    'modal.preset': 'Presets', 'modal.addModel': 'Add model', 'modal.editModel': 'Edit model', 'modal.settings': 'Settings',
    'modal.customPreset': 'Custom preset',
    'customPreset.titlePh': 'Title, e.g. "Weekly report"',
    'customPreset.promptPh': 'Prompt body — sent as the message when clicked',
    'customPreset.empty': 'Title and Prompt cannot be empty',
    'customPreset.removeTitle': 'Delete',
    'builtinPreset.restoreBtn': 'Restore defaults',
    'set.appearance': 'Appearance', 'set.plainUi': 'Plain', 'set.fontSize': 'Chat font size', 'set.theme': 'Color', 'set.lang': 'Language', 'set.model': 'Model', 'set.addModel': 'Add model',
    'appearance.light': 'Light', 'appearance.dark': 'Dark',
    'set.noModels': 'No models yet — add one below',
    'lang.zh': '简体中文', 'lang.en': 'English',
    'model.name': 'Note', 'model.namePh': 'Shown in the model list',
    'model.apikey': 'API Key', 'model.apikeyPh': 'sk-...', 'model.apikeyKeep': 'Leave blank to keep the current key',
    'model.apibase': 'API base URL', 'model.apibasePh': 'https://.../v1/messages',
    'model.protocol': 'Protocol', 'model.protocolPick': 'Select…', 'model.protocolOai': 'OpenAI-compatible (chat/completions)', 'model.protocolClaude': 'Anthropic (Claude /v1/messages)',
    'model.model': 'Model', 'model.modelPh': 'model parameter name',
    'model.modelHint': 'Must match the model field in your provider docs exactly',
    'model.retries': 'Retries (×)', 'model.connTimeout': 'Connect (s)', 'model.readTimeout': 'Read (s)',
    'model.save': 'Save', 'common.cancel': 'Cancel', 'common.edit': 'Edit', 'common.delete': 'Delete',
    'err.modelSave': 'Save failed', 'err.modelRequired': 'Model, API Key and base URL are required',
    'err.modelDelete': 'Delete failed', 'err.modelDeleteLast': 'At least one model is required',
    'confirm.modelDelete': 'Delete this model profile?',
    'page.channels.title': 'Channels', 'page.channels.sub': 'Background IM processes: list, start/stop, logs (hub.pyw style)',
    'page.status.title': 'Status', 'page.status.sub': 'Background processes/services managed by hub.pyw',
    'page.collab.title': 'Conductor', 'page.collab.sub': 'Describe a goal — split, delegate, and follow up',
    'collab.progressTitle': 'Progress',
    'collab.progressEmpty': 'No tasks running yet. After you describe a goal to Conductor, split tasks will appear here.',
    'collab.chatTitle': 'Chat with Conductor',
    'collab.placeholder': 'Describe your goal, Enter to send…',
    'collab.guideTitle': 'Tell Conductor what you want done',
    'collab.guideWhen': 'Best for multi-step goals that take a while. For everyday chat and quick questions, use Chat in the sidebar.',
    'collab.guideStep1t': 'Describe your goal',
    'collab.guideStep1d': 'Write what you want done in the chat box and send it to Conductor',
    'collab.guideStep2t': 'Auto breakdown',
    'collab.guideStep2d': 'Conductor breaks down, assigns, monitors, and coordinates',
    'collab.guideStep3t': 'Summary',
    'collab.guideStep3d': 'Conductor delivers a briefing based on execution status',
    'collab.guideStep4t': 'Adjust anytime',
    'collab.guideStep4d': 'Add requirements or details anytime — Conductor handles them',
    'collab.chipProgress': 'How is it going?',
    'collab.chipPause': 'Pause current tasks',
    'collab.chipSummary': 'Summarize progress so far',
    'collab.showProgressTitle': 'View task progress (narrow screens)',
    'collab.progressStats': '{running} running · {done} done · {issue} need attention',
    'collab.typing': 'Conductor is working',
    'collab.offline': 'Cannot reach Conductor (8900). Start the service and forward port 8900.',
    'collab.retry': 'Retry',
    'collab.reconnect': 'Disconnected — reconnecting… Your last progress is kept.',
    'collab.reconnectIn': 'Retry in {n}s',
    'collab.sticky': '{n} task(s) running',
    'collab.stRunning': 'Running', 'collab.stReported': 'Reported', 'collab.stPaused': 'Paused',
    'collab.stFailed': 'Issue', 'collab.stTerminated': 'Ended',
    'collab.summaryRunning': 'Working…', 'collab.summaryWait': 'Awaiting report',
    'collab.taskFallback': 'Task {n}',
    'collab.timeJust': 'just now',
    'collab.timeSec': '{n}s ago',
    'collab.timeMin': '{n}m ago',
    'collab.timeHr': '{n}h ago',
    'collab.timeDay': '{n}d ago',
    'page.token.title': 'Token usage', 'page.token.sub': 'Per-session and total token usage & estimated cost',
    'status.connecting': 'Connecting…', 'status.ready': 'Ready', 'status.running': 'Running',
    'status.disconnected': 'Disconnected', 'status.stopped': 'Stopped', 'status.idle': 'Idle',
    'conv.emptyList': 'No chats yet — click “＋ New chat”', 'conv.defaultTitle': 'New chat',
    'err.bridge': 'Bridge not connected', 'err.newSession': 'Failed to create session', 'err.poll': 'Polling failed', 'err.stop': 'Stop failed',
    'err.interruptTimeout': 'Timed out waiting for the previous reply to stop — try again',
    'sys.interruptPrev.hint': 'Previous reply stopped — processing new message',
    'chat.interrupting': 'Stopping previous reply…',
    'sys.stopRequested': 'Stop requested',
    'slash.help': 'Commands:\n/new new chat  /clear clear  /stop stop  /settings settings',
    'slash.unknown': 'Unknown command',
    'upload.hint': 'Upload file: pick / drag / paste',
    'upload.button': 'Upload file',
    'upload.tooLarge': 'File too large or limit reached', 'upload.empty': 'Skipped empty file',
    'upload.failed': 'Upload failed',
    'err.charLimit': 'Character limit reached ({n}), text will be truncated on send', 'err.numMax': 'Cannot exceed {n}',
    'file.openFailed': 'Cannot open file',
    'file.kindGeneric': 'File',
    'file.kindDoc': 'Document',
    'file.kindSheet': 'Spreadsheet',
    'file.kindSlide': 'Slides',
    'file.kindCode': 'Code',
    'file.kindArchive': 'Archive',
    'file.kindAudio': 'Audio',
    'file.kindVideo': 'Video',
    'upload.removeTitle': 'Remove',
    'upload.dropHint': 'Drop to upload files',
    'lightbox.closeTitle': 'Close',
    'fold.thinking': 'Thinking', 'fold.tool': 'Tool call', 'fold.toolResult': 'Tool result', 'fold.llm': 'LLM Running', 'fold.turn': 'Turn {n}',
    'timing.elapsed': 'Elapsed {t}',
    'model.auto': 'Auto',
    'model.menuLabel': 'Select model',
    'chip.plan': 'Plan',
    'chip.auto': 'Auto',
    'ch.wechat': 'WeChat', 'ch.wecom': 'WeCom', 'ch.lark': 'Lark', 'ch.dingtalk': 'DingTalk',
    'ch.qq': 'QQ', 'ch.telegram': 'Telegram', 'ch.discord': 'Discord',
    'ch.loading': 'Loading…', 'ch.empty': 'No IM process scripts found',
    'ch.logEmpty': 'No log output yet',
    'err.channelLoad': 'Failed to load', 'err.channelStart': 'Start failed', 'err.channelStop': 'Stop failed',
    'err.channelNotConfigured': 'Configure this platform in mykey.py first',
    'sys.channelStarted': 'Started', 'sys.channelStopped': 'Stopped',
    'modal.channelLogs': 'Process logs',
    'modal.mykeyConfig': 'mykey.py',
    'sys.configSaved': 'Configuration saved',
    'st.starting': 'Starting…', 'st.stopping': 'Stopping…',
    'st.online': 'Online', 'st.offline': 'Offline', 'st.error': 'Error', 'st.running': 'Running', 'st.abnormal': 'Error',
    'act.configure': 'Configure', 'act.logs': 'Logs', 'act.restart': 'Restart', 'act.stop': 'Stop', 'act.start': 'Start',
    'act.copy': 'Copy', 'act.copied': 'Copied', 'act.copyTex': 'TeX', 'act.send': 'Send',
    'proc.imbotWechat': 'imbot · WeChat', 'proc.imbotDing': 'imbot · DingTalk', 'proc.scheduler': 'Scheduler',
    'cm.scheduling': 'Scheduling', 'cm.running': 'Running', 'cm.idleSt': 'Idle',
    'cm.master': 'Dispatched 3 subtasks', 'cm.w1': 'Subtask: fetch data', 'cm.w2': 'Subtask: review results', 'cm.sub': 'Waiting for tasks',
    'tok.total': 'Total tokens', 'tok.cost': 'Est. cost', 'tok.today': 'Today tokens', 'tok.tabAll': 'Overall', 'tok.tabConductor': 'Subagent token usage',
    'tok.colSession': 'Session', 'tok.colIn': 'Input', 'tok.colOut': 'Output', 'tok.colCacheW': 'Cache write', 'tok.colCache': 'Cache read', 'tok.colCost': 'Cost',
    'tok.from': 'From', 'tok.to': 'To', 'tok.reset': 'Reset', 'tok.noData': 'No records', 'tok.deleted': 'Session deleted',
    'tok.pricingUnknown': '⚠ Pricing not confirmed, using defaults',
    'tok.priceInput': 'Input: $', 'tok.priceOutput': 'Output: $',
    'tok.priceCacheW': 'Cache write: $', 'tok.priceCacheR': 'Cache read: $',
    'presetPrompt.goal': 'Enter Goal mode: read the L3 goal-mode SOP and autonomously achieve the goal I describe next.',
    'presetPrompt.plan': 'Enter Plan mode: first read memory/plan_sop.md, follow its explore→plan→execute→verify flow, and wait for the task I describe next.',
    'presetPrompt.explore': 'Enter auto-explore mode: browse autonomously and periodically summarize key points to me.',
    'presetPrompt.hive': 'Start Goal Hive mode: per the hive SOP, spawn multiple workers to collaboratively achieve the goal I describe next.',
    'presetPrompt.review': 'Enter reviewer mode: strictly scrutinize the previous output, review item by item and report issues.',
    'presetPrompt.mine': 'Collect this week\'s git commits and write a weekly report.',
    'ask.banner': 'GA is waiting for your answer',
    'ask.replyHint': 'Reply in the input below',
    'ask.placeholderOpen': 'Type your answer here… (Enter to send)',
  },
};
const LANGS = ['zh', 'en'];
const STORE = { lang: 'ga_lang', theme: 'ga_theme', appearance: 'ga_appearance', plain: 'ga_plain', fontSize: 'ga_font_size', llmNo: 'ga_llm_no' };
const APPEARANCE_IDS = ['light', 'dark'];
const CHAT_FONT_MIN = 10;
const CHAT_FONT_MAX = 20;
const CHAT_FONT_DEFAULT = 14;
const CHAT_FONT_LEGACY = { sm: 12, md: 14, lg: 16 };
const HLJS_THEME_BASE = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/';

function normalizeChatFontSize(value) {
  if (typeof value === 'string' && CHAT_FONT_LEGACY[value]) return CHAT_FONT_LEGACY[value];
  const n = parseInt(value, 10);
  if (Number.isFinite(n)) return Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, n));
  return CHAT_FONT_DEFAULT;
}

function bootUiFromDom() {
  const root = document.documentElement;
  const out = { lang: 'zh', theme: '1', appearance: 'light', plainUi: false, chatFontSize: CHAT_FONT_DEFAULT };
  if (root.lang === 'en') out.lang = 'en';
  if (root.dataset.theme) out.theme = root.dataset.theme;
  if (APPEARANCE_IDS.includes(root.dataset.appearance)) out.appearance = root.dataset.appearance;
  if (out.appearance === 'light' && root.dataset.plain === '1') out.plainUi = true;
  if (root.dataset.chatFont) out.chatFontSize = normalizeChatFontSize(root.dataset.chatFont);
  return out;
}
let { lang, theme, appearance, plainUi, chatFontSize } = bootUiFromDom();

function syncHljsTheme() {
  const link = document.getElementById('hljs-theme');
  if (link) link.href = HLJS_THEME_BASE + (appearance === 'dark' ? 'github-dark.min.css' : 'github.min.css');
  document.querySelectorAll('.bubble.md pre code').forEach(block => {
    if (typeof hljs !== 'undefined') hljs.highlightElement(block);
  });
}

/** 服务端 ui 落盘后的本地镜像，仅供 index.html 内联脚本首帧防闪；不是真相源。 */
function syncBootCache() {
  localStorage.setItem(STORE.lang, lang);
  localStorage.setItem(STORE.theme, theme);
  localStorage.setItem(STORE.appearance, appearance);
  localStorage.setItem(STORE.fontSize, String(chatFontSize));
  if (plainUi) localStorage.setItem(STORE.plain, '1');
  else localStorage.removeItem(STORE.plain);
  localStorage.setItem(STORE.llmNo, String(state.llmNo));
}
async function persistUiPrefs() {
  try {
    await window.ga.saveConfig({
      config: { lang, theme, appearance, plain: plainUi, llmNo: state.llmNo, fontSize: chatFontSize },
    });
    syncBootCache();
  } catch (_) {}
}
const bridgeHost = () => `${location.protocol}//${location.hostname}:14168`;
async function bridgeFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const init = { ...opts, headers };
  if (init.body && typeof init.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch(`${bridgeHost()}${path}`, init);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}
function t(key) { return (I18N[lang] && I18N[lang][key]) || (I18N.zh[key]) || key; }
window.gaT = t;
document.addEventListener('collab:running-count', e => {
  const b = document.getElementById('collab-badge');
  if (!b) return;
  const n = e.detail?.count || 0;
  b.hidden = !n;
  b.textContent = n ? (n > 9 ? '9+' : String(n)) : '';
});
function optionalPh(key) {
  const sep = (lang === 'en') ? ', ' : '，';
  return `${t('common.optional')}${sep}${t(key)}`;
}
function applyI18n() {
  document.documentElement.lang = (lang === 'en') ? 'en' : 'zh-CN';
  document.title = t('app.title');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const phKey = el.dataset.i18nPh;
    const val = el.hasAttribute('data-optional-ph') ? optionalPh(phKey) : t(phKey);
    if (el.isContentEditable) el.setAttribute('data-ph', val);  // contenteditable 用 :empty::before 显示
    else el.setAttribute('placeholder', val);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.dataset.i18nTitle)); });
  renderLangList();
  window.collabRetranslate?.();
  syncAskUserUi();
}
// 语言对应国旗 SVG(en 用美国旗,按要求)
const FLAGS = {
  zh: '<svg class="flag" viewBox="0 0 30 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="30" height="20" fill="#ee1c25"/><polygon points="6,3.5 6.9,6.2 9.7,6.2 7.4,7.9 8.3,10.6 6,8.9 3.7,10.6 4.6,7.9 2.3,6.2 5.1,6.2" fill="#ffde00"/><circle cx="11.5" cy="2.6" r=".9" fill="#ffde00"/><circle cx="13.2" cy="4.3" r=".9" fill="#ffde00"/><circle cx="13.2" cy="6.7" r=".9" fill="#ffde00"/><circle cx="11.5" cy="8.4" r=".9" fill="#ffde00"/></svg>',
  en: '<svg class="flag" viewBox="0 0 38 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="38" height="20" fill="#ffffff"/><g fill="#b22234"><rect width="38" height="1.54"/><rect y="3.08" width="38" height="1.54"/><rect y="6.16" width="38" height="1.54"/><rect y="9.24" width="38" height="1.54"/><rect y="12.32" width="38" height="1.54"/><rect y="15.4" width="38" height="1.54"/><rect y="18.48" width="38" height="1.54"/></g><rect width="15.2" height="10.78" fill="#3c3b6e"/></svg>',
};
function renderLangList() {
  const box = document.getElementById('lang-list');
  if (!box) return;
  box.innerHTML = '';
  LANGS.forEach(code => {
    const row = document.createElement('label');
    row.className = 'model-row' + (lang === code ? ' sel' : '');
    row.innerHTML = `<input type="radio" name="lang-pick"${lang === code ? ' checked' : ''}>${FLAGS[code] || ''}<span>${escapeHtml(t('lang.' + code))}</span>`;
    row.addEventListener('click', (e) => { e.preventDefault(); selectLang(code); });
    box.appendChild(row);
  });
}
function selectLang(code) {
  if (!LANGS.includes(code) || lang === code) return;
  lang = code;
  applyI18n();
  renderSessionList();
  refreshStatusLabel();
  updateModelChip();
  renderSettingsModels();
  if (typeof renderAllPresets === 'function') renderAllPresets();
  if (document.querySelector('.page[data-page="channels"].active')) renderChannelList(gaServiceStore.list());
  if (document.querySelector('.page[data-page="status"].active')) loadStatusPanel();
  void persistUiPrefs();
}
function syncChatFontSegments(value) {
  document.querySelectorAll('.chat-font-seg').forEach(el => {
    const v = parseInt(el.dataset.value, 10);
    el.classList.toggle('on', v <= value);
    el.classList.toggle('cur', v === value);
  });
  const stepper = document.getElementById('chat-font-stepper');
  if (stepper) {
    stepper.setAttribute('aria-valuenow', String(value));
    stepper.setAttribute('aria-valuetext', `${value}px`);
  }
}
function chatFontFromPointer(clientX) {
  const segs = document.getElementById('chat-font-segments');
  if (!segs) return chatFontSize;
  const rect = segs.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return CHAT_FONT_MIN + Math.round(ratio * (CHAT_FONT_MAX - CHAT_FONT_MIN));
}
function initChatFontStepper() {
  const segs = document.getElementById('chat-font-segments');
  if (!segs || segs.childElementCount) return;
  for (let i = CHAT_FONT_MIN; i <= CHAT_FONT_MAX; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-font-seg';
    btn.dataset.value = String(i);
    btn.tabIndex = -1;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyChatFontSize(i);
    });
    segs.appendChild(btn);
  }
  const stepper = document.getElementById('chat-font-stepper');
  if (!stepper || stepper.dataset.bound) return;
  stepper.dataset.bound = '1';
  let dragging = false;
  const pick = (clientX, persist) => applyChatFontSize(chatFontFromPointer(clientX), { persist });
  stepper.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    stepper.setPointerCapture(e.pointerId);
    pick(e.clientX, false);
  });
  stepper.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pick(e.clientX, false);
  });
  const endDrag = (e, persist) => {
    if (!dragging) return;
    dragging = false;
    try { stepper.releasePointerCapture(e.pointerId); } catch (_) {}
    pick(e.clientX, persist);
  };
  stepper.addEventListener('pointerup', (e) => endDrag(e, true));
  stepper.addEventListener('pointercancel', (e) => endDrag(e, false));
  stepper.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      applyChatFontSize(chatFontSize - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      applyChatFontSize(chatFontSize + 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      applyChatFontSize(CHAT_FONT_MIN);
    } else if (e.key === 'End') {
      e.preventDefault();
      applyChatFontSize(CHAT_FONT_MAX);
    }
  });
}
function applyChatFontSize(size, { persist } = { persist: true }) {
  chatFontSize = normalizeChatFontSize(size);
  document.documentElement.dataset.chatFont = String(chatFontSize);
  document.documentElement.style.setProperty('--chat-font', `${chatFontSize}px`);
  const label = document.getElementById('chat-font-value');
  if (label) label.textContent = `${chatFontSize}px`;
  syncChatFontSegments(chatFontSize);
  if (persist) void persistUiPrefs();
}
function applyTheme(id, { persist } = { persist: true }) {
  const n = parseInt(id, 10);
  theme = (n >= 1 && n <= 8) ? String(n) : '1';
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty('--accent', getComputedStyle(root).getPropertyValue(`--swatch-${theme}`).trim());
  document.querySelectorAll('#theme-swatches .swatch').forEach(el => {
    el.classList.toggle('sel', el.dataset.theme === theme);
  });
  if (persist) void persistUiPrefs();
}
function syncPlainSwitch() {
  const row = document.getElementById('plain-ui-row');
  const sw = document.getElementById('plain-ui-switch');
  if (!row || !sw) return;
  const show = appearance === 'light';
  row.hidden = !show;
  sw.setAttribute('aria-checked', plainUi ? 'true' : 'false');
}
function applyAppearance(nextApp, nextPlain, { persist } = { persist: true }) {
  appearance = APPEARANCE_IDS.includes(nextApp) ? nextApp : 'light';
  if (appearance === 'light') plainUi = !!nextPlain;
  else plainUi = false;
  document.documentElement.dataset.appearance = appearance;
  if (plainUi) document.documentElement.dataset.plain = '1';
  else delete document.documentElement.dataset.plain;
  document.querySelectorAll('#appearance-seg .appear-card').forEach(el => {
    const on = el.dataset.appearance === appearance;
    el.classList.toggle('sel', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  syncPlainSwitch();
  syncHljsTheme();
  if (persist) void persistUiPrefs();
}

/* ═══════════════ 侧边栏导航 ═══════════════ */
const nav = document.getElementById('nav');
const pages = document.querySelectorAll('#pages .page');
let currentPage = 'chat';
function gaGoPage(key) {
  const item = nav?.querySelector(`.nav-item[data-page="${key}"]`);
  if (!item) return;
  currentPage = key;
  nav.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n === item));
  pages.forEach(p => p.classList.toggle('active', p.dataset.page === key));
  renderSessionList();
  window.gaSetActiveFileComposer?.(key === 'collab' ? 'collab' : 'chat');
  if (key === 'collab') window.collabInit?.();
}
window.gaGoPage = gaGoPage;
nav.addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  gaGoPage(item.dataset.page);
});

/* ═══════════════ 弹窗开关 ═══════════════ */
const openModal = (id) => { const m = document.getElementById(id); if (m) m.hidden = false; };
const closeModals = () => document.querySelectorAll('.modal').forEach(m => {
  m.hidden = true;
  m.querySelectorAll('.field-limit-hint').forEach(h => h.style.display = 'none');
});
const bindClick = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
bindClick('add-model-btn', (e) => {
  e.stopPropagation();
  openAddModelForm();
});
bindClick('settings-btn',  (e) => { e.stopPropagation(); openSettings(); });
bindClick('preset-btn',    (e) => { e.stopPropagation(); openModal('preset-modal'); });
document.querySelectorAll('.modal').forEach(m =>
  m.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      m.hidden = true;
      m.querySelectorAll('.field-limit-hint').forEach(h => h.style.display = 'none');
    }
  }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

/* ═══════════════ Markdown ═══════════════ */
if (typeof marked !== 'undefined') {
  marked.setOptions({ gfm: true, breaks: true, mangle: false, headerIds: false });
}
const ALLOWED_URI_RE = /^(https?:|mailto:|tel:|#|\/)/i;
function escapeHtml(s) {
  const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML;
}
/** GA list_llms 形如 SessionClass/备注；桌面 UI 只展示 / 后一段 */
function profileLabel(name) {
  const s = String(name || '');
  const i = s.indexOf('/');
  return (i >= 0 ? s.slice(i + 1) : s).trim();
}
function normalizeProfiles(list) {
  return (list || []).map(p => ({ ...p, name: profileLabel(p.name) || p.name }));
}
function sanitizeMarkdown(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  const blocked = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','LINK','META','BASE','FORM','INPUT','BUTTON']);
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
  const rmv = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (blocked.has(el.tagName)) { rmv.push(el); continue; }
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase(), v = attr.value.trim();
      if (n.startsWith('on') || n === 'srcdoc') { el.removeAttribute(attr.name); continue; }
      if ((n === 'href' || n === 'src' || n === 'xlink:href') && v && !ALLOWED_URI_RE.test(v)) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') { el.setAttribute('rel','noopener noreferrer'); el.setAttribute('target','_blank'); }
  }
  rmv.forEach(el => el.remove());
  return tpl.innerHTML;
}
/* ═══════════════ LaTeX 保护 (PR移植) ═══════════════ */
const _latexSlots = [];
function protectLatex(text) {
  _latexSlots.length = 0;
  // 先保护代码围栏和行内代码，避免其中的 $ \( \[ 被误匹配
  const _codeSlots = [];
  // 代码围栏 ```...```
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    const id = _codeSlots.length;
    _codeSlots.push(m);
    return `\x00CODE:${id}\x00`;
  });
  // 行内代码 `...`
  text = text.replace(/`[^`\n]+`/g, (m) => {
    const id = _codeSlots.length;
    _codeSlots.push(m);
    return `\x00CODE:${id}\x00`;
  });
  // 块级 \[...\]
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => {
    const id = _latexSlots.length;
    _latexSlots.push({ expr: expr.trim(), display: true });
    return `<!--LATEX:${id}-->`;
  });
  // 块级 $$...$$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    const id = _latexSlots.length;
    _latexSlots.push({ expr: expr.trim(), display: true });
    return `<!--LATEX:${id}-->`;
  });
  // 行内 \(...\)
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => {
    const id = _latexSlots.length;
    _latexSlots.push({ expr: expr.trim(), display: false });
    return `<!--LATEX:${id}-->`;
  });
  // 行内 $...$（不贪婪，排除 $$ 和转义）
  text = text.replace(/(?<!\\)\$([^\n$]+?)\$/g, (_, expr) => {
    const id = _latexSlots.length;
    _latexSlots.push({ expr: expr.trim(), display: false });
    return `<!--LATEX:${id}-->`;
  });
  // 恢复代码占位符
  text = text.replace(/\x00CODE:(\d+)\x00/g, (_, i) => _codeSlots[Number(i)]);
  return text;
}
function restoreLatex(html) {
  if (!_latexSlots.length) return html;
  return html.replace(/<!--LATEX:(\d+)-->/g, (_, i) => {
    const slot = _latexSlots[Number(i)];
    if (!slot) return '';
    if (typeof katex === 'undefined') {
      return slot.display ? `<div class="katex-block">${escapeHtml(slot.expr)}</div>`
                          : `<span class="katex-inline">${escapeHtml(slot.expr)}</span>`;
    }
    try {
      const rendered = katex.renderToString(slot.expr, { displayMode: slot.display, throwOnError: false });
      return slot.display ? `<div class="katex-block">${rendered}</div>`
                          : `<span class="katex-inline">${rendered}</span>`;
    } catch (_) { return escapeHtml(slot.expr); }
  });
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return escapeHtml(text).replace(/\n/g, '<br>');
  try {
    const protected_ = protectLatex(String(text || ''));
    let html = sanitizeMarkdown(marked.parse(protected_));
    html = restoreLatex(html);
    // TUI 风格代码块：包装 pre>code 为 .code-block 容器 + 语言头
    html = html.replace(/<pre><code\b(?:\s+class="language-([^"]*)")?[^>]*>([\s\S]*?)<\/code><\/pre>/g,
      (_, lang, body) => {
        const label = lang || 'code';
        return `<div class="code-block"><div class="code-block-head"><span class="code-block-lang">${escapeHtml(label)}</span><button class="code-block-copy" aria-label="Copy code">\u29C9</button></div><pre><code class="language-${escapeHtml(label)}">${body}</code></pre></div>`;
      });
    return html;
  } catch (_) { return escapeHtml(text); }
}
function extractLastTurnForCopy(text) {
  const src = String(text || '');
  // 与 renderAssistant 同款分隔正则；取最后一个 mark 之后的 body
  const turnRe = /\**LLM Running \(Turn (\d+)\) \.\.\.\**/g;
  let lastEnd = 0, mm;
  while ((mm = turnRe.exec(src)) !== null) lastEnd = mm.index + mm[0].length;
  let body = src.slice(lastEnd);
  // 去掉模型在最后一轮开头的 <summary>...</summary>
  body = body.replace(/<summary>[\s\S]*?<\/summary>\s*/i, '');
  return body.trim();
}
function renderAssistant(text) {
  const src = String(text || '');
  // 1) 按 "LLM Running (Turn N)..." 标记切分多轮；N 从原文捕获，无硬编码文案
  const turnRe = /\**LLM Running \(Turn (\d+)\) \.\.\.\**/g;
  const marks = [];
  let mm;
  while ((mm = turnRe.exec(src)) !== null) {
    marks.push({ idx: mm.index, end: mm.index + mm[0].length, n: mm[1] });
  }
  const segs = [];
  if (marks.length === 0) {
    segs.push({ n: null, body: src });
  } else {
    if (marks[0].idx > 0) segs.push({ n: null, body: src.slice(0, marks[0].idx) });
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].end;
      const stop = (i + 1 < marks.length) ? marks[i + 1].idx : src.length;
      segs.push({ n: marks[i].n, body: src.slice(start, stop) });
    }
  }
  // 2) 块级折叠：占位符使用 HTML 注释，避免与正文 F\d+ 冲突
  const folds = [];
  const asks = [];
  const stash = (label, body, cls) => { folds.push({ label, body, cls: cls || '' }); return `\n\n§§FOLD:${folds.length - 1}§§\n\n`; };
  const stashAsk = (data) => { asks.push(data); return `\n\n§§ASK:${asks.length - 1}§§\n\n`; };
  const foldBlocks = (body) => {
    let s = body;
    // thinking: 兼容 <thinking> XML 与 <details>...</details>（未来扩展）
    s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, m => stash(t('fold.thinking'), m.replace(/<\/?thinking>/gi, ''), 'fold-thinking'));
    // ask_user：渲染为提问卡片（必须在通用工具规则之前匹配）
    s = s.replace(/🛠️ Tool: `ask_user`[^\n]*\n````text\n([\s\S]*?)\n````/g,
                  (m, json) => {
                    const data = parseAskUserJson(json);
                    if (data && normalizeAskUserData(data)) return stashAsk(data);
                    return stash(`${t('fold.tool')}: ask_user`, json, 'fold-tool');
                  });
    // 工具调用：agent_loop 实际格式 = "🛠️ Tool: `name`  📥 args:\n````text\n{json}\n````"
    s = s.replace(/🛠️ Tool: `([^`]+)`[^\n]*\n````text\n([\s\S]*?)\n````/g,
                  (_, name, json) => stash(`${t('fold.tool')}: ${name}`, json, 'fold-tool'));
    // 工具结果：5 反引号围栏
    s = s.replace(/`{5}\n([\s\S]*?)\n`{5}/g, (_, body) => stash(t('fold.toolResult'), body, 'fold-result'));
    // 兼容旧 XML 标记（保险）
    s = s.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, m => stash(t('fold.tool'), m, 'fold-tool'));
    s = s.replace(/<function_results>[\s\S]*?<\/function_results>/gi, m => stash(t('fold.toolResult'), m, 'fold-result'));
    // 模型在回复开头自带 <summary>...</summary>（非 <details> 子元素），转为弱化样式块
    s = s.replace(/<summary>([\s\S]*?)<\/summary>/gi, (_, inner) => `<div class="turn-summary">${inner}</div>`);
    return renderMarkdown(s);
  };
  // 3) 拼装：历史轮包 details 默认折叠，最后一轮平铺
  const turnLabel = (n) => t('fold.turn').replace('{n}', n);
  // 从原始 seg.body 中抽出该轮首个 <summary>...</summary> 文本，作为折叠头副标题
  // fallback: 若无 <summary> 标签，提取该轮调用的工具名列表
  const extractTurnSummary = (raw) => {
    const m = /<summary>([\s\S]*?)<\/summary>/i.exec(raw || '');
    if (m) return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // fallback: 提取工具名
    const tools = [];
    const toolRe = /🛠️\s*Tool:\s*`([^`]+)`/g;
    let tm;
    while ((tm = toolRe.exec(raw || '')) !== null) {
      if (!tools.includes(tm[1])) tools.push(tm[1]);
    }
    if (tools.length) return tools.join(', ');
    return '';
  };
  const parts = segs.map((seg, i) => {
    const isLast = (i === segs.length - 1);
    if (seg.n == null) return foldBlocks(seg.body);
    const sum = extractTurnSummary(seg.body);
    // Strip the <summary> tag from body to avoid duplication with head
    const bodyForRender = sum
      ? seg.body.replace(/<summary>[\s\S]*?<\/summary>\s*/i, '')
      : seg.body;
    const inner = foldBlocks(bodyForRender);
    const head = sum
      ? `${escapeHtml(turnLabel(seg.n))}：<span class="turn-head-sum">${escapeHtml(sum)}</span>`
      : escapeHtml(turnLabel(seg.n));
    if (isLast) return `<div class="turn-summary">${head}</div>${inner}`;
    return `<details class="fold fold-turn"><summary>${head}</summary>${inner}</details>`;
  });
  // 4) 还原块级占位符
  return parts.join('')
    .replace(/(?:<p>\s*)?§§ASK:(\d+)§§(?:\s*<\/p>)?/g, (_, i) => renderAskUserNotice(asks[Number(i)]))
    .replace(/(?:<p>\s*)?§§FOLD:(\d+)§§(?:\s*<\/p>)?/g, (_, i) => {
      const f = folds[Number(i)];
      return `<details class="fold ${f.cls}"><summary>${escapeHtml(f.label)}</summary><pre class="fold-pre">${escapeHtml(f.body)}</pre></details>`;
    });
}

function parseAskUserJson(raw) {
  if (raw == null) return null;
  const txt = String(raw).trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (_) {}
  try {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < txt.length; i++) {
      const c = txt[i];
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"') { inStr = !inStr; out += c; continue; }
      if (inStr) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else if (c.charCodeAt(0) < 0x20) out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
        else out += c;
      } else out += c;
    }
    return JSON.parse(out);
  } catch (_) {}
  return null;
}

function normalizeAskUserData(data) {
  const raw = data || {};
  const question = String(raw.question || '').trim();
  if (!question) return null;
  const cs = raw.candidates || [];
  const candidates = Array.isArray(cs)
    ? cs.map(x => String(x == null ? '' : x)).filter(x => x.trim())
    : [];
  return { question, candidates };
}

/** 格式化 ask_user 题干：编号与正文同行；无空行时在 2./3. 前分段 */
function formatAskUserQuestion(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  // 「1.\n正文」→「1. 正文」
  s = s.replace(/^(\d+[.、:：)])\s*\n+\s*/gm, '$1 ');
  s = s.replace(/(\n)(\d+[.、:：)])\s*\n+\s*/g, '$1$2 ');
  s = s.replace(/(\n|^)(问题\s*\d+\s*[:：.、)]?)\s*\n+\s*/gi, '$1$2 ');
  // 题与题之间：尚无空行时，仅在 2./3. 前插入空行（不动 1. 与题干）
  if (!/\n\s*\n/.test(s)) {
    s = s.replace(/(\S)\s+(?=问题\s*[2-9]\d*\s*[:：.、)]?\s*)/gi, '$1\n\n');
    s = s.replace(/(\S)\s+(?=[2-9]\d*[.、:：)]\s+\S)/g, '$1\n\n');
  }
  return boldAskQuestionLines(s);
}

function boldAskQuestionLines(text) {
  return String(text || '').split('\n').map(line => {
    const t = line.trim();
    if (!t || /^\*\*.+\*\*$/.test(t)) return line;
    if (/^\d+[.、:：)]\s+\S/.test(t)) return '**' + t + '**';
    if (/^问题\s*\d+/i.test(t)) return '**' + t + '**';
    if (/[？?]\s*$/.test(t) && !/^[A-Da-d][.)]\s/.test(t)) return '**' + t + '**';
    return line;
  }).join('\n');
}

function markAskOptionHtml(html) {
  let out = String(html || '');
  out = out.replace(/<p>([^<]*[A-Da-d][.)]\s[^<]*)<\/p>/gi, '<p class="ask-option-line">$1</p>');
  out = out.replace(/(<br\s*\/?>)\s*([A-Da-d][.)]\s[^<]+)/gi, '<span class="ask-option-line">$2</span>');
  return out;
}

/** 预览模式：true = 始终显示 candidates；false = 题干已含选项/多题时不重复渲染底部列表 */
const ASK_USER_ALWAYS_SHOW_CANDIDATES = false;

/** 题干已含选项/多题，或 candidates 无法与题干对应时，不再重复渲染底部列表 */
function shouldShowAskCandidates(item) {
  if (!item || !item.candidates.length) return false;
  if (ASK_USER_ALWAYS_SHOW_CANDIDATES) return true;
  const q = item.question;
  if (/两个问题|多个问题|两道|两题/.test(q)) return false;
  if ((q.match(/问题\s*\d/gi) || []).length >= 2) return false;
  if ((q.match(/^[ \t]*\d+[.、:：)]\s+/gm) || []).length >= 2) return false;
  if ((q.match(/^[ \t]*[A-Da-d][.)]\s/mg) || []).length >= 2) return false;
  const comboN = item.candidates.filter(c => /\d+[A-Da-d]\s*\+\s*\d+[A-Da-d]/i.test(c)).length;
  if (comboN >= Math.max(1, Math.ceil(item.candidates.length * 0.5))) return false;
  // 题干里有多道问句，却把全部选项平铺在 candidates → 无法区分归属，不展示
  const qMarks = (q.match(/[？?]/g) || []).length;
  if (qMarks >= 2 && item.candidates.length > 4) return false;
  return true;
}

const ASK_USER_TOOL_RE = /🛠️ Tool: `ask_user`[^\n]*\n````text\n([\s\S]*?)\n````/;

function renderAskUserNotice(data) {
  const item = normalizeAskUserData(data);
  if (!item) return '';
  // 单题与多题统一处理：多题的选项本就内联在题干里；单题的选项放在 candidates 里，
  // 这里把它折叠进题干，按同样的 A./B./C. 内联方式渲染，不再单独画一个编号列表。
  const question = foldAskCandidates(item);
  const qHtml = markAskOptionHtml(renderMarkdown(formatAskUserQuestion(question)));
  return `<div class="ask-user-notice" data-ask-user="1">
    <div class="ask-user-banner">
      <span class="ask-user-banner-text">${escapeHtml(t('ask.banner'))}</span>
      <span class="ask-user-banner-sep" aria-hidden="true">·</span>
      <span class="ask-user-banner-hint">${escapeHtml(t('ask.replyHint'))}</span>
    </div>
    ${qHtml ? `<div class="ask-user-body md">${qHtml}</div>` : ''}
  </div>`;
}

/** 单题的 candidates 折叠进题干（统一成 A./B./C. 内联选项）；多题或无法对应时原样返回题干 */
function foldAskCandidates(item) {
  if (!shouldShowAskCandidates(item)) return item.question;
  const opts = item.candidates.map((c, j) => {
    const label = String(c).replace(/^\s*(?:[A-Za-z]|\d{1,2})\s*[.)、:：]\s*/, '').trim();
    return `${String.fromCharCode(65 + j)}. ${label}`;
  }).join('\n');
  // 用单换行（而非空行）拼进题干，让题干+选项渲染成同一个 <p>，每个选项都跟在 <br> 后面 —
  // 与多题内联选项走完全一致的 .ask-option-line 缩进，避免首项 A 贴左边、B/C/D 缩进的错位。
  return item.question.replace(/\s+$/, '') + '\n' + opts;
}

function askUserPlaceholder(item) {
  // 单题与多题统一：都用自由作答提示，不再针对单题单独显示「输入 1/2/3 选择」
  return t('ask.placeholderOpen');
}

function getPendingAskUser(sess) {
  if (!sess || rt(sess).busy) return null;
  const msgs = sess.messages || [];
  let lastAskIdx = -1;
  let askData = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue;
    const m = ASK_USER_TOOL_RE.exec(msgs[i].content || '');
    if (m) {
      lastAskIdx = i;
      askData = normalizeAskUserData(parseAskUserJson(m[1]));
      break;
    }
  }
  if (!askData) return null;
  const replied = msgs.slice(lastAskIdx + 1).some(m => m.role === 'user');
  return replied ? null : askData;
}

function syncAskUserUi() {
  const sess = activeSess();
  const pending = sess ? getPendingAskUser(sess) : null;
  const notices = [...document.querySelectorAll('.ask-user-notice')];
  notices.forEach((el, i) => {
    const isLast = i === notices.length - 1;
    el.classList.toggle('is-active', !!pending && isLast);
    el.classList.toggle('is-answered', !pending || !isLast);
  });
  if (inputEl) inputEl.setAttribute('data-ph', pending ? askUserPlaceholder(pending) : t('composer.placeholder'));  // contenteditable 用 data-ph（无 placeholder 属性）
  if (composerEl) composerEl.classList.toggle('is-awaiting-answer', !!pending);
}

/* ═══════════════ 渲染后增强 (PR移植) ═══════════════ */
/* ───────────── 统一复制 SVG Icon ───────────── */
// Phosphor 图标助手：把 window.gaIcon(name) 包一层，给动态渲染的 UI 用，与静态 [data-ga-icon] 保持一致
const GA_ICON = (name, className = '') => (typeof window.gaIcon === 'function' ? window.gaIcon(name, className) : '');
const SVG_COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const SVG_CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function postRenderEnhance(containerEl) {
  if (!containerEl) return;
  // 代码高亮 + 复制按钮（.code-block 容器已自带头部复制按钮，跳过）
  containerEl.querySelectorAll('pre code').forEach(block => {
    if (typeof hljs !== 'undefined') hljs.highlightElement(block);
    if (block.closest('.code-block')) return; // TUI 风格容器已有复制按钮
    if (!block.parentElement.querySelector('.code-copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn'; btn.innerHTML = SVG_COPY_ICON;
      btn.title = t('act.copy');
      btn.onclick = () => {
        navigator.clipboard.writeText(block.textContent).then(() => {
          btn.innerHTML = SVG_CHECK_ICON; setTimeout(() => btn.innerHTML = SVG_COPY_ICON, 1500);
        });
      };
      block.parentElement.style.position = 'relative';
      block.parentElement.appendChild(btn);
    }
  });
  // TUI 代码块头部复制按钮绑定
  containerEl.querySelectorAll('.code-block-copy').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.onclick = () => {
      const code = btn.closest('.code-block').querySelector('code');
      if (!code) return;
      navigator.clipboard.writeText(code.textContent.trim()).then(() => {
        btn.textContent = '\u2713';
        setTimeout(() => { btn.textContent = '\u29C9'; }, 1500);
      });
    };
  });
  // KaTeX 复制按钮
  containerEl.querySelectorAll('.katex-block').forEach(el => {
    if (el.querySelector('.latex-copy-btn')) return;
    const src = el.querySelector('annotation[encoding="application/x-tex"]');
    if (!src) return;
    const btn = document.createElement('button');
    btn.className = 'latex-copy-btn'; btn.textContent = '\u29C9';
    btn.title = t('act.copyTex');
    btn.onclick = () => {
      navigator.clipboard.writeText(src.textContent).then(() => {
        btn.textContent = '\u2713'; setTimeout(() => btn.textContent = '\u29C9', 1500);
      });
    };
    el.style.position = 'relative';
    el.appendChild(btn);
  });
  syncAskUserUi();
}


/* ═══════════════ 状态 ═══════════════ */
const state = {
  sessions: new Map(), activeId: null, bridgeReady: false,
  llmNo: 0, modelProfiles: [], modelName: null,
  runtime: new Map(),
  pendingFiles: [],
  fileSeq: 0,
};
function rt(sess) {
  let r = state.runtime.get(sess.id);
  if (!r) { r = { polling:false, busy:false, lastId:0, seen:new Set(), draftEl:null, draftText:'', taskStartedAt:null, taskEndedAt:null, taskTimerId:null }; state.runtime.set(sess.id, r); }
  return r;
}
const activeSess = () => state.sessions.get(state.activeId) || null;
const isActive = (sess) => sess && sess.id === state.activeId;

function saveSessions() {}
function patchSession(sess, fields) {
  if (!sess.bridgeSessionId) return;
  fetch(`http://${location.hostname}:14168/session/${encodeURIComponent(sess.bridgeSessionId)}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(fields)
  }).catch(() => {});
}
async function loadSessions() {
  try {
    const res = await fetch(`http://${location.hostname}:14168/sessions`);
    const data = await res.json();
    if (!data.sessions) return;
    for (const s of data.sessions) {
      state.sessions.set(s.id, {
        id: s.id, bridgeSessionId: s.id, title: s.title,
        messages: [], untitled: s.untitled ?? true,
        pinned: s.pinned ?? false, lastActiveTs: s.updatedAt || s.createdAt
      });
    }
    // 刷新后固定恢复「上次正在看的会话」（前端持久化的 ga_active），而不是 bridge 的
    // activeSessionId（=最近更新的会话，会随后台会话变动而跳来跳去）。没有有效的已存
    // 会话则置空 → 显示「新会话」空态，由用户自己点选。
    const savedActive = localStorage.getItem('ga_active');
    state.activeId = (savedActive && state.sessions.has(savedActive)) ? savedActive : null;
  } catch (_) {}
}

/* ═══════════════ DOM refs ═══════════════ */
const chatPage   = document.querySelector('.page[data-page="chat"]');
const msgArea    = chatPage.querySelector('.msg-area');
const chatStart  = msgArea.querySelector('.chat-start');
const inputEl    = chatPage.querySelector('.input');
const sendBtn    = document.getElementById('send-btn');
const composerEl = chatPage.querySelector('.composer');
const msgLoading = document.getElementById('msg-loading');
const MIN_MSG_LOADING_MS = 450;
let _submitInFlight = false;
const runToggle  = document.getElementById('run-toggle');
const runLabel   = runToggle.querySelector('.rs-label');
const convListEl = document.querySelector('.conv-list');
const newConvBtn = document.querySelector('.new-conv');
const searchInput = document.querySelector('.search input');
const rpToggle   = document.getElementById('rp-toggle');
const rpResize   = document.getElementById('rp-resize');
const rpPanel    = document.getElementById('rightpanel');
const bodyEl     = document.querySelector('.body');
if (rpToggle) rpToggle.addEventListener('click', () => bodyEl.classList.toggle('rp-collapsed'));

const sbToggle = document.getElementById('sb-toggle');
const sbResize = document.getElementById('sb-resize');
const sbPanel  = document.querySelector('.sidebar');
if (sbToggle) sbToggle.addEventListener('click', () => bodyEl.classList.toggle('sb-collapsed'));

// 通用拖拽：dir=+1 拖动 →clientX 增大就增宽(左侧栏);dir=-1 反之(右侧)
function bindResize(handle, panel, dir, min, max) {
  if (!handle || !panel) return;
  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', (e) => {
    dragging = true; startX = e.clientX; startW = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(max, Math.max(min, startW + dir * (e.clientX - startX)));
    panel.style.width = w + 'px';
    panel.style.flex = '0 0 ' + w + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}
bindResize(rpResize, rpPanel, -1, 160, 400);  // 右栏:cursor 左移 → 增宽
bindResize(sbResize, sbPanel, +1, 180, 360);  // 左栏:cursor 右移 → 增宽
const modelChip  = document.getElementById('model-chip');
const modelNameEl= modelChip ? modelChip.querySelector('.model-name') : null;
// conductor 页面也有一个独立的模型 chip,共用一份模型数据
const collabModelChip   = document.getElementById('collab-model-chip');
const collabModelNameEl = collabModelChip ? collabModelChip.querySelector('.model-name') : null;

let msgsEl = null;
function ensureMsgs() {
  if (!msgsEl) {
    msgsEl = document.createElement('div');
    msgsEl.className = 'msgs';
    msgArea.insertBefore(msgsEl, msgLoading || null);
  }
  return msgsEl;
}
function refreshEmptyState(sess) {
  const has = sess && sess.messages.length > 0;
  msgArea.classList.toggle('has-msgs', !!has);
  if (chatStart) chatStart.style.display = has ? 'none' : '';
  if (msgsEl) msgsEl.style.display = has ? '' : 'none';
}

/* ═══════════════ 消息渲染 ═══════════════ */
function stripAttachPlaceholders(text) {
  return String(text || '').replace(/\[(Image|File)\s+#\d+\]\s*/g, '').trim();
}
// 把消息文本里的 [Image #N]/[File #N] 占位符“按原位置”渲染成内联 chip(显示文件名),其余文本转义+换行,
// 这样消息里能看到附件在文本中的位置(卡片/缩略图照常另外渲染)。lookup(kind,n) 取该附件文件名。
// 同时兜底去掉内联的本地上传路径(历史/conductor 回显)。
function renderMsgTextWithChips(text, lookup) {
  const s = String(text || '').replace(/[^\s]*desktop_uploads[^\s]*\s*/g, '');
  const esc = t2 => escapeHtml(t2).replace(/\n/g, '<br>');
  const re = /\[(Image|File)\s+#(\d+)\]/g;
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    const name = (lookup && lookup(m[1], Number(m[2]))) || (m[1] === 'Image' ? 'image' : 'file');
    out += `<span class="ph-chip" contenteditable="false">${escapeHtml(name)}</span>`;
    last = re.lastIndex;
  }
  out += esc(s.slice(last));
  return out.trim();
}
function fileSubLabel(name) {
  const m = String(name || '').match(/\.([^.]+)$/);
  if (!m) return t('file.kindGeneric');
  const ext = m[1].toLowerCase();
  const docExts = ['pdf', 'doc', 'docx', 'rtf', 'odt', 'pages', 'tex'];
  const sheetExts = ['xls', 'xlsx', 'csv', 'tsv', 'numbers', 'ods'];
  const slideExts = ['ppt', 'pptx', 'key', 'odp'];
  const codeExts = ['py', 'js', 'ts', 'tsx', 'jsx', 'java', 'c', 'cpp', 'h', 'hpp', 'rs', 'go', 'rb', 'php', 'sh', 'html', 'css', 'json', 'yaml', 'yml', 'xml', 'sql', 'md'];
  const archiveExts = ['zip', 'tar', 'gz', 'rar', '7z', 'bz2'];
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'];
  const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'];
  if (docExts.includes(ext)) return t('file.kindDoc');
  if (sheetExts.includes(ext)) return t('file.kindSheet');
  if (slideExts.includes(ext)) return t('file.kindSlide');
  if (codeExts.includes(ext)) return t('file.kindCode') + ' · ' + ext.toUpperCase();
  if (archiveExts.includes(ext)) return t('file.kindArchive');
  if (audioExts.includes(ext)) return t('file.kindAudio');
  if (videoExts.includes(ext)) return t('file.kindVideo');
  return ext.toUpperCase();
}
function msgNode(msg) {
  const el = document.createElement('div');
  el.className = 'msg ' + (msg.role || 'system');
  if (msg.role === 'user') {
    const shown = (typeof msg.display === 'string' && msg.display.length) ? msg.display : msg.content;
    const imgsHtml = (msg.images && msg.images.length)
      ? `<div class="user-imgs">${msg.images.map(im => `<img src="${im.dataUrl || uploadRawUrl(im.path)}" data-path="${escapeHtml(im.path || '')}" alt="">`).join('')}</div>`
      : '';
    const filesHtml = (msg.files && msg.files.length)
      ? `<div class="user-files">${msg.files.map(f => {
          const name = f.name || 'file';
          const sub = fileSubLabel(name);
          return `<div class="file-chip" data-path="${escapeHtml(f.path || '')}" data-name="${escapeHtml(name)}"><span class="fc-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span><span class="fc-meta"><span class="fc-name">${escapeHtml(name)}</span><span class="fc-sub">${escapeHtml(sub)}</span></span></div>`;
        }).join('')}</div>`
      : '';
    const chipText = renderMsgTextWithChips(shown, (kind, n) => {
      const hit = (kind === 'Image' ? (msg.images || []) : (msg.files || [])).find(x => x.id === 'f-' + n);
      return hit && (hit.name || '');
    });
    const textHtml = chipText ? `<div class="bubble">${chipText}</div>` : '';
    el.innerHTML = `<div class="user-stack">${filesHtml}${imgsHtml}${textHtml}</div>`;
  }
  else if (msg.role === 'assistant') {
    const body = msg.stopped ? (msg.content + '\n\n_[' + t('status.stopped') + ']_') : msg.content;
    el.innerHTML = `<div class="bubble md">${renderAssistant(body)}</div>`;
    postRenderEnhance(el.querySelector('.bubble'));
  }
  else if (msg.role === 'error') el.innerHTML = `<div class="bubble err">${escapeHtml(msg.content)}</div>`;
  else el.innerHTML = `<div class="bubble sys">${escapeHtml(msg.content)}</div>`;
  if (msg.role === 'user' || msg.role === 'assistant') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'bubble-copy-btn';
    copyBtn.title = t('act.copy');
    copyBtn.innerHTML = SVG_COPY_ICON;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = (msg.role === 'user')
        ? stripAttachPlaceholders((typeof msg.display === 'string' && msg.display.length) ? msg.display : (msg.content || ''))
        : extractLastTurnForCopy(msg.content || '');
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML = SVG_CHECK_ICON;
        setTimeout(() => { copyBtn.innerHTML = SVG_COPY_ICON; }, 1500);
      });
    });
    el.appendChild(copyBtn);
  }
  return el;
}
function renderAllMessages(sess) {
  const box = ensureMsgs(); box.innerHTML = '';
  for (const m of sess.messages) box.appendChild(msgNode(m));
  syncAskUserUi();
  // badge 恢复在 pollSession finally 中执行（此时 messages 已通过异步加载填充）
  refreshEmptyState(sess); scrollBottom(true);
}
// 遍历消息对，用 ts 差值恢复 badge；对运行中任务恢复 taskStartedAt
function restoreElapsedBadges(sess, box) {
  const msgs = sess.messages;
  if (!msgs || !msgs.length) return;
  const nodes = box.querySelectorAll('.msg');
  let lastUserTs = null;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'user') {
      lastUserTs = msgs[i].ts ? msgs[i].ts * 1000 : null; // 无 ts 则重置
    } else if (msgs[i].role === 'assistant') {
      if (lastUserTs && msgs[i].ts) {
        const elapsed = msgs[i].ts * 1000 - lastUserTs;
        if (elapsed > 0 && nodes[i]) {
          ensureTaskElapsedBadge(nodes[i], lastUserTs, msgs[i].ts * 1000);
        }
      }
      lastUserTs = null;
    }
  }
  // 运行中任务：最后一条是 user 且 session busy，恢复实时计时
  if (lastUserTs && rt(sess).busy) {
    const r = rt(sess);
    r.taskStartedAt = lastUserTs;
    r.taskEndedAt = null;
  }
}
function appendMessage(sess, msg) {
  if (!isActive(sess)) return;
  const el = msgNode(msg);
  ensureMsgs().appendChild(el);
  if (msg.role === 'assistant') {
    const r = rt(sess);
    if (r.taskStartedAt) {
      ensureTaskElapsedBadge(el, r.taskStartedAt, r.taskEndedAt || Date.now());
      r.taskStartedAt = null; r.taskEndedAt = null;
    }
  }
  refreshEmptyState(sess); scrollBottom(true);
  if (msg.role === 'assistant' || msg.role === 'user') syncAskUserUi();
}
function isNearBottom(threshold = 80) {
  return msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight < threshold;
}
function scrollBottom(force) {
  if (force || isNearBottom()) {
    requestAnimationFrame(() => { msgArea.scrollTop = msgArea.scrollHeight; });
  }
}
/* ═══════════════ 打字机效果 (PR移植) ═══════════════ */
const TW_SPEED = 12;  // 每 tick 显示字符数
const TW_INTERVAL = 30; // ms

function renderDraft(sess) {
  const r = rt(sess);
  if (!isActive(sess)) return;
  const box = ensureMsgs();
  if (!r.draftEl || r.draftEl.parentNode !== box) {
    r.draftEl = document.createElement('div'); r.draftEl.className = 'msg assistant'; box.appendChild(r.draftEl);
    // 正在计时则立即挂载 badge，避免等 1s tick 后才出现导致跳动
    if (r.taskStartedAt) ensureTaskElapsedBadge(r.draftEl, r.taskStartedAt, null);
  }
  if (!r.twState) r.twState = { shown: 0, timer: null };
  const tw = r.twState;
  if (!tw.timer) {
    tw.timer = setInterval(() => {
      const cur = r.draftText || '';
      if (tw.shown >= cur.length) {
        clearInterval(tw.timer); tw.timer = null;
        return;
      }
      tw.shown = Math.min(tw.shown + TW_SPEED, cur.length);
      const visible = cur.slice(0, tw.shown);
      rewriteDraftBubble(r, visible);
    }, TW_INTERVAL);
  }
  const visible = (r.draftText || '').slice(0, tw.shown);
  rewriteDraftBubble(r, visible);
  refreshEmptyState(sess);
}

// 重写打字机气泡：先记 near + 保存 <details> open 态 + badge；innerHTML 替换后恢复；仅当原先贴底才滚
function rewriteDraftBubble(r, visible) {
  const wasNear = isNearBottom();
  const openIdx = [];
  // 保存 badge（会被 innerHTML 覆盖）
  const oldBadge = r.draftEl ? r.draftEl.querySelector(':scope > .task-elapsed') : null;
  const badgeText = oldBadge ? oldBadge.textContent : null;
  if (r.draftEl) {
    r.draftEl.querySelectorAll('details').forEach((d, i) => { if (d.open) openIdx.push(i); });
  }
  r.draftEl.innerHTML = `<div class="bubble md">${renderAssistant(visible)}<span class="cursor"></span></div>`;
  postRenderEnhance(r.draftEl.querySelector('.bubble'));
  const dets = r.draftEl.querySelectorAll('details');
  openIdx.forEach(i => { if (dets[i]) dets[i].open = true; });
  // 恢复 badge
  if (badgeText) {
    const badge = document.createElement('div');
    badge.className = 'task-elapsed';
    badge.textContent = badgeText;
    badge.dataset.live = '1';
    r.draftEl.prepend(badge);
  }
  if (wasNear) scrollBottom(true);
}

function flushTypewriter(sess) {
  const r = rt(sess);
  if (r.twState) {
    if (r.twState.timer) clearInterval(r.twState.timer);
    r.twState = null;
  }
}

/* ═══════════════ 运行状态 ═══════════════ */
function statusLabel() {
  const s = activeSess();
  if (s && rt(s).busy) return t('status.running');
  return state.bridgeReady ? t('status.ready') : t('status.disconnected');
}
function refreshStatusLabel() { runLabel.textContent = statusLabel(); }

/* ═══════════════ 消息计时 ═══════════════ */
function formatTaskElapsed(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  const sec = Math.round(v / 1000);
  if (sec < 60) return t('timing.elapsed').replace('{t}', `${Math.max(1, sec)}s`);
  const min = Math.floor(sec / 60), s = sec % 60;
  if (min < 60) return t('timing.elapsed').replace('{t}', `${min}m ${s}s`);
  const hr = Math.floor(min / 60), m = min % 60;
  return t('timing.elapsed').replace('{t}', `${hr}h ${m}m`);
}

function ensureTaskElapsedBadge(wrap, startedAt, endedAt) {
  if (!wrap || !startedAt) return null;
  let badge = wrap.querySelector(':scope > .task-elapsed');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'task-elapsed';
    wrap.prepend(badge);
  }
  const elapsed = (endedAt || Date.now()) - startedAt;
  badge.textContent = formatTaskElapsed(elapsed);
  badge.dataset.live = endedAt ? '' : '1';
  return badge;
}

function startTaskTimer(sess) {
  const r = rt(sess);
  if (r.taskStartedAt) return;  // 已在计时，不重置
  // 优先从消息时间戳恢复（刷新后持久化）
  const msgs = sess.messages;
  let restored = 0;
  if (msgs && msgs.length) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' && msgs[i].ts) { restored = msgs[i].ts * 1000; break; }
    }
  }
  r.taskStartedAt = restored || Date.now();
  r.taskEndedAt = null;
  if (r.taskTimerId) clearInterval(r.taskTimerId);
  r.taskTimerId = setInterval(() => {
    if (!r.taskStartedAt) return;
    const el = r.draftEl || document.querySelector('.msg-list .msg.assistant:last-child');
    if (el) ensureTaskElapsedBadge(el, r.taskStartedAt, null);
    // 更新左上角状态栏显示实时耗时
    if (isActive(sess)) {
      const elapsed = Date.now() - r.taskStartedAt;
      runLabel.textContent = formatTaskElapsed(elapsed);
    }
  }, 1000);
}

function stopTaskTimer(sess) {
  const r = rt(sess);
  if (r.taskTimerId) { clearInterval(r.taskTimerId); r.taskTimerId = null; }
  if (!r.taskStartedAt) return;
  r.taskEndedAt = Date.now();
}

function setBusy(sess, busy) {
  const r = rt(sess); r.busy = busy;
  if (busy) startTaskTimer(sess); else stopTaskTimer(sess);
  if (!isActive(sess)) return;
  runToggle.classList.toggle('busy', busy);
  if (busy) {
    const elapsed = Date.now() - (r.taskStartedAt || Date.now());
    runLabel.textContent = formatTaskElapsed(elapsed);
  } else {
    runLabel.textContent = state.bridgeReady ? t('status.ready') : t('status.disconnected');
  }
  if (sendBtn) {
    sendBtn.classList.toggle('is-stop', busy);
    sendBtn.setAttribute('aria-label', busy ? t('act.stop') : t('act.send'));
    sendBtn.title = busy ? t('act.stop') : '';
  }
}
// run-toggle 现为纯状态展示组件：运行中转红，不再响应点击（停止改由发送键的录制键承担）

/* ═══════════════ 会话 ═══════════════ */
function isUntitled(x) { return !x || /^(new chat|新对话|新会话)$/i.test(String(x).trim()); }
function sortedSessions() {
  // display order: pinned first, then most-recently-active. [0] is the topmost.
  return [...state.sessions.values()].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.lastActiveTs || 0) - (a.lastActiveTs || 0);
  });
}
function renderSessionList() {
  convListEl.innerHTML = '';
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
  const all = sortedSessions();
  const filtered = query
    ? all.filter(s => {
        const title = displayTitle(s).toLowerCase();
        const hasMsg = s.messages && s.messages.some(m => (m.text || '').toLowerCase().includes(query));
        return title.includes(query) || hasMsg;
      })
    : all;
  if (filtered.length === 0) {
    const e = document.createElement('div');
    e.className = 'conv-empty'; e.textContent = t('conv.emptyList');
    convListEl.appendChild(e); return;
  }
  for (const sess of filtered) {
    const r = state.runtime.get(sess.id);
    const busy = !!(r && r.busy);
    const item = document.createElement('div');
    item.className = 'conv-item' + (currentPage === 'chat' && sess.id === state.activeId ? ' active' : '') + (busy ? '' : ' idle');
    item.dataset.id = sess.id;
    const pinSvg = sess.pinned ? GA_ICON('pushPinSimple', 'ci-pin') : '';
    item.innerHTML =
      `<span class="ci-dot"></span><div class="ci-main">` +
      `<div class="ci-title">${pinSvg}${escapeHtml(displayTitle(sess))}</div>` +
      `<div class="ci-meta">${busy ? t('status.running') : t('status.idle')}</div></div>` +
      `<button class="ci-more" title="${escapeHtml(t('common.more'))}">${GA_ICON('dotsThreeVertical')}</button>`;
    convListEl.appendChild(item);
  }
}
if (searchInput) searchInput.addEventListener('input', () => renderSessionList());
async function ensureBridgeSession(sess) {
  if (sess.bridgeSessionId) return sess.bridgeSessionId;
  const res = await window.ga.rpc('session/new', { cwd: '', mcp_servers: [] });
  if (res?.error) throw new Error(res.error.message || res.error);
  sess.bridgeSessionId = res.sessionId || res.result?.sessionId;
  return sess.bridgeSessionId;
}
// 仿 TUI(continue_cmd.py 的 _preview_text 思路):sess.title 只在用户手动 rename 时被填,
// 平时为空;sidebar 显示名实时从消息派生 —— 优先取最后一段 assistant 输出里的 <summary>...</summary>,
// 其次用首条用户消息纯文本,都没有时回退到 t('conv.defaultTitle')。
function isAutoTitle(x) {
  const s = String(x || '').trim();
  if (!s) return true;
  if (/^(new chat|新对话|新会话)$/i.test(s)) return true;
  if (/^agent-\d+$/i.test(s)) return true;  // 兼容上一轮误存的 agent-N
  return false;
}
function displayTitle(sess) {
  if (sess && sess.title && !isAutoTitle(sess.title)) return sess.title;
  const msgs = (sess && sess.messages) || [];
  // 1) 优先:最后一段 assistant 文本里的 <summary>...</summary>
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant') continue;
    const txt = typeof m.content === 'string' ? m.content : '';
    const sm = /<summary>([\s\S]*?)<\/summary>/i.exec(txt);
    if (sm && sm[1].trim()) {
      const line = sm[1].trim().split('\n')[0].trim();
      if (line) return line.length > 60 ? line.slice(0, 60) + '…' : line;
    }
  }
  // 2) 兜底:首条用户消息纯文本(去附件占位符)
  for (const m of msgs) {
    if (!m || m.role !== 'user') continue;
    const raw = typeof m.content === 'string' ? m.content : (m.display || '');
    const clean = stripAttachPlaceholders(raw).trim();
    if (clean) return clean.length > 40 ? clean.slice(0, 40) + '…' : clean;
  }
  return t('conv.defaultTitle');
}
async function newSession() {
  const localId = 'local-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const sess = { id: localId, bridgeSessionId: null, title: '', messages: [], untitled: true, lastActiveTs: Date.now() };
  state.sessions.set(localId, sess);
  try {
    await ensureBridgeSession(sess);
    state.sessions.delete(localId);
    sess.id = sess.bridgeSessionId;
    state.sessions.set(sess.id, sess);
  } catch (e) { showError(t('err.newSession') + ': ' + (e.message || e)); }
  setActiveSession(sess.id);
  saveSessions();
  renderSessionList();
}
function setActiveSession(id) {
  state.activeId = id;
  if (id) localStorage.setItem('ga_active', id);  // 持久化当前会话，刷新后固定恢复它
  const sess = state.sessions.get(id);
  if (!sess) return;
  if (msgsEl) msgsEl.innerHTML = '';
  rt(sess).draftEl = null;
  renderAllMessages(sess);
  setBusy(sess, rt(sess).busy);
  renderSessionList();
  if (sess.bridgeSessionId && !sess.messages.length && state.bridgeReady) {
    pollSession(sess);
  }
}
async function closeSession(id) {
  const sess = state.sessions.get(id);
  if (sess && sess.bridgeSessionId) {
    try { await window.ga.rpc('session/cancel', { sessionId: sess.bridgeSessionId }); } catch (_) {}
    fetch(`http://${location.hostname}:14168/session/${sess.bridgeSessionId}`, { method: 'DELETE' }).catch(() => {});
  }
  state.sessions.delete(id); state.runtime.delete(id);
  if (state.activeId === id) {
    const next = (sortedSessions()[0] || {}).id || null;  // 切到列表最靠上的会话
    if (next) setActiveSession(next);
    else { state.activeId = null; localStorage.removeItem('ga_active'); if (msgsEl) msgsEl.innerHTML = ''; refreshEmptyState(null); refreshStatusLabel(); }
  }
  saveSessions();
  renderSessionList();
}

const convMenu = document.getElementById('conv-menu');
let menuTargetId = null;
convListEl.addEventListener('click', (e) => {
  const more = e.target.closest('.ci-more');
  if (more) {
    e.stopPropagation();
    menuTargetId = more.closest('.conv-item').dataset.id;
    // 根据当前会话置顶状态切菜单文案:置顶 / 取消置顶
    const tgt = state.sessions.get(menuTargetId);
    const pinSpan = convMenu.querySelector('[data-act="pin"] [data-i18n]');
    if (pinSpan) {
      const k = tgt && tgt.pinned ? 'ctx.unpin' : 'ctx.pin';
      pinSpan.setAttribute('data-i18n', k);
      pinSpan.textContent = t(k);
    }
    convMenu.hidden = false;
    const rect = more.getBoundingClientRect();
    convMenu.style.top = (rect.bottom + 4) + 'px';
    convMenu.style.left = (rect.right - convMenu.offsetWidth) + 'px';
    return;
  }
  const it = e.target.closest('.conv-item');
  if (it && it.dataset.id) {
    setActiveSession(it.dataset.id);
    const chatNav = nav.querySelector('.nav-item[data-page="chat"]');
    if (chatNav && !chatNav.classList.contains('active')) chatNav.click();
  }
});
convMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const act = e.target.closest('.ctx-item')?.dataset.act;
  const sess = menuTargetId && state.sessions.get(menuTargetId);
  if (sess && act === 'pin') {
    if (sess.pinned) {
      sess.pinned = false;       // 取消置顶 + 放到 pinned 之后、其它 unpinned 之前(unpinned 区域顶部)
      const others = [...state.sessions.values()].filter(s => s.id !== sess.id);
      const m = new Map();
      for (const s of others) if (s.pinned) m.set(s.id, s);  // 先所有仍 pinned 的
      m.set(sess.id, sess);                                   // 再本会话(刚 unpinned)
      for (const s of others) if (!s.pinned) m.set(s.id, s);  // 再其它 unpinned
      state.sessions = m;
    } else {
      sess.pinned = true;        // 置顶 + 移到列表顶
      const m = new Map(); m.set(sess.id, sess);
      for (const [k, v] of state.sessions) if (k !== sess.id) m.set(k, v);
      state.sessions = m;
    }
    saveSessions();
    patchSession(sess, { pinned: sess.pinned });
    renderSessionList();
  } else if (sess && act === 'rename') {
    convMenu.hidden = true;
    const item = convListEl.querySelector(`.conv-item[data-id="${sess.id}"]`);
    if (!item) return;
    const titleEl = item.querySelector('.ci-title');
    if (!titleEl) return;
    const oldTitle = sess.title || '';
    const inp = document.createElement('input');
    inp.className = 'ci-rename-input';
    inp.maxLength = 50;
    inp.value = oldTitle;
    titleEl.replaceWith(inp);
    bindToastLimit(inp);
    inp.focus();
    inp.select();
    const finish = (save) => {
      if (inp._done) return;
      inp._done = true;
      const val = inp.value.trim();
      if (save && val && val !== oldTitle) {
        sess.title = val;
        sess.untitled = false;
        saveSessions();
        patchSession(sess, { title: val, untitled: false });
        const history = tokLoadHistory();
        const sid = sess.bridgeSessionId || sess.id;
        let changed = false;
        history.forEach(h => { if (h.sessionId === sid) { h.title = val; changed = true; } });
        if (changed) tokSaveHistory(history);
      }
      renderSessionList();
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
    return;
  } else if (sess && act === 'del') {
    closeSession(sess.id);
  }
  convMenu.hidden = true;
});
document.addEventListener('click', () => { convMenu.hidden = true; });
newConvBtn.addEventListener('click', (e) => { e.preventDefault(); newSession(); });

/* ═══════════════ 轮询 + 流式 ═══════════════ */
function normalize(m) {
  const o = { id: Number(m.id || 0), role: m.role || 'system', content: m.content || '' };
  if (typeof m.display === 'string' && m.display.length) o.display = m.display;
  if (m.stopped) o.stopped = true;
  if (m.images) o.images = m.images;
  if (m.files) o.files = m.files;
  if (m.ts) o.ts = m.ts;
  return o;
}
function upsert(sess, raw, partial) {
  const m = normalize(raw); const r = rt(sess);
  if (partial && m.role === 'assistant') { r.draftText = m.content; if (isActive(sess)) renderDraft(sess); return; }
  if (!m.id || r.seen.has(m.id)) return;
  r.seen.add(m.id); r.lastId = Math.max(r.lastId, m.id);
  if (m.role === 'assistant' && r.draftEl) { flushTypewriter(sess); r.draftEl.remove(); r.draftEl = null; r.draftText = ''; }
  sess.messages.push(m); appendMessage(sess, m);
  saveSessions();
}
async function pollSession(sess) {
  const r = rt(sess);
  if (r.polling) return;
  r.polling = true;
  try {
    do {
      const res = await window.ga.pollSession(sess.bridgeSessionId || sess.id, r.lastId || 0);
      if (res?.error) throw new Error(res.error.message || res.error);
      const result = res.result || res;
      for (const msg of (result.messages || [])) upsert(sess, msg, false);
      if (result.partial) upsert(sess, result.partial, true);
      const busy = result.status === 'running' || !!result.partial;
      setBusy(sess, busy);
      if (busy) await new Promise(z => setTimeout(z, 500));
      else {
        if (r.draftEl) { r.draftEl.remove(); r.draftEl = null; r.draftText = ''; }
        break;
      }
    } while (true);
  } catch (e) {
    showError(t('err.poll') + ': ' + (e.message || e));
    setBusy(sess, false);
  } finally {
    r.polling = false; renderSessionList();
    // 历史消息已全部加载，恢复已完成任务的耗时 badge
    if (isActive(sess)) {
      restoreElapsedBadges(sess, ensureMsgs());
      syncAskUserUi();
    }
    tokPollBridge();
  }
}

function removeUsedPendingFiles(usedFiles) {
  if (!usedFiles.length) return;
  const usedSids = new Set(usedFiles.map(f => f.sid));
  const touched = new Set(usedFiles.map(f => fileCtx(f)));
  state.pendingFiles = state.pendingFiles.filter(f => !usedSids.has(f.sid));
  touched.forEach(ctx => renderThumbStrip(ctx));
}

function clearDraft(sess) {
  flushTypewriter(sess);
  const r = rt(sess);
  if (r.draftEl) { r.draftEl.remove(); r.draftEl = null; r.draftText = ''; }
}

async function waitSessionIdle(sess, maxMs = 4000) {
  const start = Date.now();
  while (rt(sess).busy && Date.now() - start < maxMs) {
    await new Promise(z => setTimeout(z, 100));
  }
  return !rt(sess).busy;
}

function setMsgLoading(on) {
  if (msgArea) msgArea.classList.toggle('is-loading', !!on);
  if (msgLoading) {
    msgLoading.hidden = !on;
    if (on) scrollBottom();
  }
}

function setComposerLocked(on) {
  if (composerEl) composerEl.classList.toggle('is-locked', !!on);
  if (inputEl) inputEl.contentEditable = on ? 'false' : 'true';  // contenteditable 无 readOnly,改切 contentEditable
  if (sendBtn) {
    sendBtn.disabled = !!on;
    sendBtn.classList.toggle('is-busy', !!on);
    sendBtn.setAttribute('aria-busy', on ? 'true' : 'false');
  }
}

/** stapp.py 同款：运行中再发 → cancel 当前轮次，等 idle 后再提交新 prompt */
async function interruptBeforeSend(sess) {
  if (!rt(sess).busy) return true;
  const t0 = Date.now();
  setMsgLoading(true);
  try {
    clearDraft(sess);
    try {
      const res = await window.ga.rpc('session/cancel', { sessionId: sess.bridgeSessionId || sess.id });
      if (res?.error) throw new Error(res.error.message || res.error);
    } catch (e) {
      showChanToast(t('err.stop') + ': ' + (e.message || e), '', 'err');
      return false;
    }
    showChanToast(t('sys.interruptPrev.hint'), '', 'info');
    const idle = await waitSessionIdle(sess);
    clearDraft(sess);
    if (!idle) {
      showChanToast(t('err.interruptTimeout'), '', 'err');
      return false;
    }
    return true;
  } finally {
    const wait = Math.max(0, MIN_MSG_LOADING_MS - (Date.now() - t0));
    if (wait) await new Promise(r => setTimeout(r, wait));
    setMsgLoading(false);
  }
}

/* ═══════════════ 发送 / 取消 ═══════════════ */
async function sendPrompt(text) {
  text = String(text || '').trim();
  if (!text) return false;
  if (!state.bridgeReady) { showError(t('err.bridge')); return false; }
  if (!state.activeId) { await newSession(); if (!state.activeId) return false; }
  const sess = activeSess(); const r = rt(sess);
  if (r.busy) {
    const interrupted = await interruptBeforeSend(sess);
    if (!interrupted) return false;
  }
  // PLAN/AUTO 现在是预设功能（preset 卡片）一次性发送，不再是常驻 prefix
  const composedPrompt = expandFilePlaceholders(text).trim();
  const usedFiles = collectUsedFiles(text);
  const userMsg = { role: 'user', content: text, ts: Date.now() / 1000 };
  const previewImgs = usedFiles.filter(f => f.isImage).map(f => ({ id: 'f-' + f.sid, name: f.name, path: f.path, dataUrl: f.dataUrl || '' }));
  if (previewImgs.length) userMsg.images = previewImgs;
  const previewFiles = usedFiles.filter(f => !f.isImage).map(f => ({ id: 'f-' + f.sid, name: f.name, path: f.path }));
  if (previewFiles.length) userMsg.files = previewFiles;
  sess.messages.push(userMsg); appendMessage(sess, userMsg);
  sess.lastActiveTs = Date.now();
  // 仿 TUI:不再从首条消息自动改名 —— 标题在 newSession 时已设为 agent-N,
  // 之后只接受用户手动 rename。
  saveSessions();
  setBusy(sess, true);
  try {
    let sid = await ensureBridgeSession(sess);
    try {
      await bridgeFetch(`/session/${encodeURIComponent(sid)}/restore`, { method: 'POST', body: {} });
    } catch (restoreErr) {
      if (/not found/i.test(restoreErr.message || '')) {
        sess.bridgeSessionId = null;
        sid = await ensureBridgeSession(sess);
        state.sessions.delete(sess.id);
        sess.id = sess.bridgeSessionId;
        state.sessions.set(sess.id, sess);
        state.activeId = sess.id;
        localStorage.setItem('ga_active', sess.id);  // 会话 id 因 bridge 重建而变更，同步持久化
      }
    }
    const res = await window.ga.rpc('session/prompt', { sessionId: sid, prompt: composedPrompt, display: text, llmNo: state.llmNo,
      files: previewFiles, imageMetas: previewImgs.map(im => ({ name: im.name, path: im.path })) });
    if (res?.error) throw new Error(res.error.message || res.error);
    removeUsedPendingFiles(usedFiles);
    const uid = Number(res.userMessageId || res.result?.userMessageId || 0);
    if (uid) { r.seen.add(uid); r.lastId = Math.max(r.lastId, uid); }
    pollSession(sess);
    return true;
  } catch (e) {
    const em = { role: 'error', content: e.message || String(e) };
    sess.messages.push(em); appendMessage(sess, em);
    setBusy(sess, false);
    return false;
  }
}
async function cancelPrompt() {
  const sess = activeSess();
  if (!sess || !rt(sess).busy) return false;
  try {
    const res = await window.ga.rpc('session/cancel', { sessionId: sess.bridgeSessionId || sess.id });
    if (res?.error) throw new Error(res.error.message || res.error);
    return true;
  } catch (e) { showError(t('err.stop') + ': ' + (e.message || e)); return false; }
}

/* ═══════════════ 输入区 / slash / 预设 ═══════════════ */
async function submitInput() {
  if (_submitInFlight) return;
  let text = composerText('chat');
  if (!text.trim()) return;
  if (text.trim().startsWith('/')) {
    inputEl.innerHTML = '';
    handleSlash(text.trim());
    return;
  }
  if (text.length > 20000) {
    text = text.slice(0, 20000);
    showToast(t('err.charLimit').replace('{n}', 20000), 'warn');
  }
  _submitInFlight = true;
  setComposerLocked(true);
  try {
    const sent = await sendPrompt(text);
    if (sent) {
      inputEl.innerHTML = '';
    }
  } finally {
    _submitInFlight = false;
    setComposerLocked(false);
    syncAskUserUi();
  }
}
sendBtn.addEventListener('click', (e) => {
  e.preventDefault();
  const sess = activeSess();
  if (sess && rt(sess).busy) { cancelPrompt(); return; }  // 运行中：发送键是录制键 → 纯停止
  submitInput();
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitInput(); }
});
// 输入框的 input/paste 监听统一在 bindComposerUpload(ctx) 里绑(chat + collab 通用)
function showSystem(text) {
  const sess = activeSess(); if (!sess) return;
  const m = { role: 'system', content: text };
  sess.messages.push(m); appendMessage(sess, m);
}
function showError(text) {
  const sess = activeSess();
  if (sess) { const m = { role: 'error', content: text }; sess.messages.push(m); appendMessage(sess, m); }
  else console.error(text);
}
async function handleSlash(cmd) {
  const name = cmd.slice(1).split(/\s+/)[0];
  switch (name) {
    case 'help': showSystem(t('slash.help')); break;
    case 'new': await newSession(); break;
    case 'clear': { const s = activeSess(); if (s) { s.messages = []; renderAllMessages(s); } break; }
    case 'stop': if (await cancelPrompt()) showSystem(t('sys.stopRequested')); break;
    case 'settings': openSettings(); break;
    default: showSystem(t('slash.unknown') + ': /' + name);
  }
}
// 预设卡：按 data-preset 解耦（与翻译后的标题无关）
document.querySelectorAll('.feature-grid').forEach(grid => {
  grid.addEventListener('click', (e) => {
    const xBtn = e.target.closest('.fc-x');
    if (xBtn) {
      e.stopPropagation();
      const kind = xBtn.dataset.removeKind;
      const id = xBtn.dataset.removeId;
      if (kind === 'builtin') hideBuiltinPreset(id);
      else if (kind === 'custom') removeCustomPreset(id);
      return;
    }
    const card = e.target.closest('.fcard');
    if (!card || !grid.contains(card)) return;
    const key = card.dataset.preset;
    if (key === 'add') { closeModals(); openModal('custom-preset-modal'); resetCustomPresetForm(); return; }
    if (card.classList.contains('fcard-custom')) {
      const id = card.dataset.id;
      const cp = state.customPresets.find(p => p.id === id);
      if (cp) { closeModals(); sendPrompt(cp.prompt); }
      return;
    }
    if (!key) { inputEl.focus(); closeModals(); return; }
    const bp = BUILTIN_PRESETS.find(p => p.key === key);
    if (bp?.navigate) { closeModals(); gaGoPage(bp.navigate); window.collabFocus?.(); return; }
    const prompt = I18N[lang]['presetPrompt.' + key] || I18N.zh['presetPrompt.' + key];
    closeModals();
    if (prompt) sendPrompt(prompt);
  });
});

/* ═══════════════ 模型 / 设置 ═══════════════ */
function updateModelChip() {
  const name = state.modelName || '';
  if (modelNameEl) modelNameEl.textContent = name;
  if (collabModelNameEl) collabModelNameEl.textContent = name;
}
async function selectModel(id, name) {
  state.llmNo = id;
  state.modelName = profileLabel(name) || name || null;
  updateModelChip();
  renderSettingsModels();
  await persistUiPrefs();
}
const MODEL_ACT_EDIT = GA_ICON('pencilSimple');
const MODEL_ACT_DEL = GA_ICON('trash');
let editingModelId = null;

function setModelApikeyMode(isAdd) {
  const apikey = document.getElementById('model-apikey-input');
  const apikeyReq = document.querySelector('#model-apikey-label .field-req');
  if (!apikey) return;
  apikey.required = isAdd;
  apikey.dataset.i18nPh = isAdd ? 'model.apikeyPh' : 'model.apikeyKeep';
  if (isAdd) apikey.removeAttribute('data-optional-ph');
  else { apikey.value = ''; apikey.setAttribute('data-optional-ph', ''); }
  if (apikeyReq) apikeyReq.hidden = !isAdd;
}

function openAddModelForm() {
  editingModelId = null;
  const form = document.getElementById('add-model-form');
  const title = document.getElementById('model-form-title');
  const errEl = document.getElementById('add-model-err');
  if (title) title.dataset.i18n = 'modal.addModel';
  if (form) form.reset();
  setModelApikeyMode(true);
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  openModal('add-model-modal');
  applyI18n();
}
async function openEditModelForm(id) {
  editingModelId = id;
  const errEl = document.getElementById('add-model-err');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  try {
    const res = await bridgeFetch(`/model-profiles/${id}`);
    const p = res.profile;
    if (!p) throw new Error(t('err.modelSave'));
    const form = document.getElementById('add-model-form');
    const title = document.getElementById('model-form-title');
    if (title) title.dataset.i18n = 'modal.editModel';
    if (form) {
      form.model.value = p.model || '';
      form.apibase.value = p.apibase || '';
      form.name.value = p.name || '';
      form.max_retries.value = p.max_retries ?? 5;
      form.connect_timeout.value = p.connect_timeout ?? 15;
      form.read_timeout.value = p.read_timeout ?? 300;
      // 编辑模式:按 varName 回填协议分段控件
      const pv = /claude/i.test(p.varName || '') ? 'claude' : 'oai';
      const pr = form.querySelector(`input[name="protocol"][value="${pv}"]`);
      if (pr) pr.checked = true;
    }
    setModelApikeyMode(false);
    openModal('add-model-modal');
    applyI18n();
  } catch (ex) {
    alert(ex.message || t('err.modelSave'));
  }
}
async function deleteModel(id, name) {
  const label = profileLabel(name) || name || ('#' + id);
  if (!confirm(`${t('confirm.modelDelete')}\n${label}`)) return;
  try {
    const res = await bridgeFetch(`/model-profiles/${id}`, { method: 'DELETE', body: {} });
    if (res?.ok === false || res?.error) throw new Error(res.error || t('err.modelDelete'));
    const wasActive = state.llmNo === id;
    const oldNo = state.llmNo;
    state.modelProfiles = normalizeProfiles(res.profiles || []);
    if (wasActive) {
      const p = state.modelProfiles[0];
      if (p) await selectModel(p.id ?? 0, p.name);
      else { state.llmNo = 0; state.modelName = null; updateModelChip(); }
    } else if (oldNo > id) {
      const p = state.modelProfiles[oldNo - 1];
      if (p) await selectModel(p.id ?? (oldNo - 1), p.name);
    }
    renderSettingsModels();
  } catch (ex) {
    const msg = ex.message || '';
    alert(msg.includes('last profile') ? t('err.modelDeleteLast') : (msg || t('err.modelDelete')));
  }
}
function renderSettingsModels() {
  const box = document.getElementById('model-list');
  if (!box) return;
  box.innerHTML = '';
  const list = state.modelProfiles || [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'set-empty'; empty.textContent = t('set.noModels');
    box.appendChild(empty); return;
  }
  for (const p of list) {
    const id = p.id ?? 0;
    const label = profileLabel(p.name) || p.name || ('#' + id);
    const row = document.createElement('label');
    row.className = 'model-row' + (state.llmNo === id ? ' sel' : '');
    row.innerHTML = `<input type="radio" name="model-pick"${state.llmNo === id ? ' checked' : ''}><span class="model-row-name">${escapeHtml(label)}</span><span class="model-row-actions"><button type="button" class="model-act" data-act="edit" title="${escapeHtml(t('common.edit'))}">${MODEL_ACT_EDIT}</button><button type="button" class="model-act model-act-del" data-act="delete" title="${escapeHtml(t('common.delete'))}">${MODEL_ACT_DEL}</button></span>`;
    row.querySelector('[data-act="edit"]').addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); openEditModelForm(id); });
    row.querySelector('[data-act="delete"]').addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); deleteModel(id, p.name); });
    row.addEventListener('click', (e) => {
      if (e.target.closest('.model-row-actions')) return;
      e.preventDefault();
      selectModel(id, p.name);
    });
    box.appendChild(row);
  }
}
function openSettings() {
  openModal('settings-modal');
  renderSettingsModels();
  renderLangList();
  applyTheme(theme, { persist: false });
  applyAppearance(appearance, plainUi, { persist: false });
  applyChatFontSize(chatFontSize, { persist: false });
}
async function loadModelProfiles() {
  try {
    const res = await window.ga.getModelProfiles();
    const list = res?.profiles || res?.result?.profiles || [];
    state.modelProfiles = normalizeProfiles(list);
    const active = state.modelProfiles.find(p => p.active) || state.modelProfiles[0];
    if (active) {
      state.llmNo = active.id ?? 0;
      state.modelName = profileLabel(active.name) || active.name || null;
    }
    updateModelChip();
    renderSettingsModels();
  } catch (_) {}
}
/* ═══════════════ 模型菜单(chat + conductor 共用一份逻辑,各自一个 DOM) ═══════════════ */
const modelMenu       = document.getElementById('model-menu');
const collabModelMenu = document.getElementById('collab-model-menu');
function renderModelMenu(menuEl) {
  if (!menuEl) return;
  const list = state.modelProfiles || [];
  const rows = list.map((p, i) => {
    const no = (p.id ?? i);
    const isActive = (state.llmNo === no) ? ' active' : '';
    return `<div class="ga-menu-item${isActive}" data-llmno="${no}">${escapeHtml(p.name || '')}</div>`;
  });
  menuEl.innerHTML = rows.join('');
  applyI18n();
}
function openModelMenu(chipEl, menuEl) {
  if (!chipEl || !menuEl) return;
  if (typeof convMenu !== 'undefined' && convMenu) convMenu.hidden = true;
  closeAllModelMenus();
  renderModelMenu(menuEl);
  menuEl.hidden = false;
  const chipRect = chipEl.getBoundingClientRect();
  const composer = chipEl.closest('.composer');
  if (composer) {
    const composerRect = composer.getBoundingClientRect();
    menuEl.style.left = (chipRect.left - composerRect.left) + 'px';
    menuEl.style.bottom = (composerRect.bottom - chipRect.top + 4) + 'px';
  }
}
function closeAllModelMenus() {
  if (modelMenu) modelMenu.hidden = true;
  if (collabModelMenu) collabModelMenu.hidden = true;
}
function bindModelMenuItemClick(menuEl) {
  if (!menuEl) return;
  menuEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const item = e.target.closest('.ga-menu-item');
    if (!item) return;
    const no = parseInt(item.dataset.llmno, 10);
    if (Number.isNaN(no)) return;
    const p = (state.modelProfiles || []).find(x => (x.id ?? 0) === no);
    selectModel(no, (p && p.name) || '');
    closeAllModelMenus();
  });
}
bindModelMenuItemClick(modelMenu);
bindModelMenuItemClick(collabModelMenu);
if (modelChip) modelChip.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  openModelMenu(modelChip, modelMenu);
});
if (collabModelChip) collabModelChip.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  openModelMenu(collabModelChip, collabModelMenu);
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#model-menu') || e.target.closest('#model-chip') ||
      e.target.closest('#collab-model-menu') || e.target.closest('#collab-model-chip')) return;
  closeAllModelMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllModelMenus();
});

const themeSwatches = document.getElementById('theme-swatches');
if (themeSwatches) themeSwatches.addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch[data-theme]');
  if (sw) applyTheme(sw.dataset.theme);
});
const appearanceSeg = document.getElementById('appearance-seg');
if (appearanceSeg) appearanceSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.appear-card[data-appearance]');
  if (!btn) return;
  const isLight = btn.dataset.appearance === 'light';
  applyAppearance(btn.dataset.appearance, isLight && plainUi);
});
const plainUiSwitch = document.getElementById('plain-ui-switch');
if (plainUiSwitch) plainUiSwitch.addEventListener('click', () => {
  if (appearance === 'light') applyAppearance('light', !plainUi);
});
async function loadBridgeConfig() {
  try {
    const res = await window.ga.getConfig();
    const cfg = res?.config || {};
    if (LANGS.includes(cfg.lang)) {
      lang = cfg.lang;
      applyI18n();
    }
    if (cfg.theme != null) applyTheme(cfg.theme, { persist: false });
    if (cfg.appearance) applyAppearance(cfg.appearance, !!cfg.plain, { persist: false });
    if (cfg.fontSize != null) applyChatFontSize(cfg.fontSize, { persist: false });
    if (cfg.llmNo != null && state.modelProfiles.length) {
      const p = state.modelProfiles.find(x => (x.id ?? 0) === cfg.llmNo);
      if (p) {
        state.llmNo = cfg.llmNo;
        state.modelName = profileLabel(p.name) || p.name || null;
        updateModelChip();
        renderSettingsModels();
      }
    }
    syncBootCache();
  } catch (_) {}
}

const addModelForm = document.getElementById('add-model-form');
if (addModelForm) addModelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('add-model-err');
  const fd = new FormData(addModelForm);
  const payload = Object.fromEntries(fd.entries());
  const isEdit = editingModelId != null;
  if (!payload.apibase?.trim() || !payload.model?.trim()) {
    if (errEl) { errEl.textContent = t('err.modelRequired'); errEl.hidden = false; }
    return;
  }
  if (!isEdit && !payload.apikey?.trim()) {
    if (errEl) { errEl.textContent = t('err.modelRequired'); errEl.hidden = false; }
    return;
  }
  try {
    const res = isEdit
      ? await bridgeFetch(`/model-profiles/${editingModelId}`, { method: 'PUT', body: payload })
      : await bridgeFetch('/model-profiles', { method: 'POST', body: payload });
    if (res?.ok === false || res?.error) throw new Error(res.error || t('err.modelSave'));
    state.modelProfiles = normalizeProfiles(res.profiles || []);
    const pid = isEdit ? editingModelId : (res.profileId ?? state.modelProfiles.at(-1)?.id ?? 0);
    const p = state.modelProfiles.find(x => (x.id ?? 0) === pid) || state.modelProfiles.at(-1);
    if (p) await selectModel(p.id ?? pid, p.name);
    document.getElementById('add-model-modal').hidden = true;
    addModelForm.reset();
    editingModelId = null;
    if (errEl) errEl.hidden = true;
  } catch (ex) {
    if (errEl) { errEl.textContent = (ex.message || t('err.modelSave')); errEl.hidden = false; }
  }
});

/* ═══════════════ 文件上传（图片+任意文件，tuiapp_v2 模式） ═══════════════ */
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const imgInput = document.getElementById('img-input');
const thumbStrip = document.getElementById('thumb-strip');
const uploadBtn = document.getElementById('upload-btn');
const chatPanel = document.querySelector('main.main');
let activeFileComposer = 'chat';

function fileCtx(f) { return f.ctx || 'chat'; }
function filesForCtx(ctx) { return state.pendingFiles.filter(f => fileCtx(f) === ctx); }

function composerCfg(ctx = activeFileComposer) {
  if (ctx === 'collab') {
    return {
      input: document.getElementById('collab-input'),
      strip: document.getElementById('collab-thumb-strip'),
      uploadBtn: document.getElementById('collab-upload-btn'),
      imgInput: document.getElementById('collab-img-input'),
      dropZone: document.querySelector('.collab-chat'),
    };
  }
  return { input: inputEl, strip: thumbStrip, uploadBtn, imgInput, dropZone: chatPanel };
}

function renderThumbStrip(ctx = activeFileComposer) {
  const cfg = composerCfg(ctx);
  if (!cfg.strip) return;
  const files = filesForCtx(ctx);
  if (files.length === 0) {
    cfg.strip.innerHTML = '';
    cfg.strip.hidden = true;
    return;
  }
  cfg.strip.innerHTML = files.map(f => {
    if (f.isImage && f.dataUrl) {
      return `<div class="thumb" data-sid="${f.sid}"><img src="${f.dataUrl}"><button class="x" data-sid="${f.sid}" data-i18n-title="upload.removeTitle" title="">×</button></div>`;
    }
    const name = f.name || 'file';
    const label = name.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const sub = fileSubLabel(name).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const path = (f.path || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const dataName = name.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    return `<div class="file-chip pending" data-sid="${f.sid}" data-path="${path}" data-name="${dataName}"><span class="fc-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span><span class="fc-meta"><span class="fc-name">${label}</span><span class="fc-sub">${sub}</span></span><button class="x" data-sid="${f.sid}" data-i18n-title="upload.removeTitle" title="">×</button></div>`;
  }).join('');
  cfg.strip.hidden = false;
  applyI18n();
}

// 在 ctx 对应输入框(contenteditable)的光标处插入原子 chip（删不进中间，像 @人）
function insertPlaceholderInComposer(file, ctx = activeFileComposer) {
  const input = composerCfg(ctx).input;
  if (!input) return;
  const chip = document.createElement('span');
  chip.className = 'ph-chip';
  chip.setAttribute('contenteditable', 'false');
  chip.dataset.sid = String(file.sid);
  chip.dataset.kind = file.isImage ? 'image' : 'file';
  chip.textContent = file.name || 'file';
  input.focus();
  const sel = window.getSelection();
  let range;
  if (sel && sel.rangeCount && input.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(chip);
  const sp = document.createTextNode(' ');  // chip 后补一个 nbsp，便于继续打字/定位光标
  chip.after(sp);
  range.setStartAfter(sp); range.collapse(true);
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// 按 sid 从该文件所属 ctx 的输入框移除 chip（连同紧邻空格）
function removePlaceholderFromComposer(file) {
  const input = composerCfg(fileCtx(file)).input;
  if (!input) return;
  const chip = input.querySelector(`.ph-chip[data-sid="${file.sid}"]`);
  if (!chip) return;
  const next = chip.nextSibling;
  if (next && next.nodeType === 3) next.nodeValue = next.nodeValue.replace(/^[\s ]/, '');
  chip.remove();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// 读取 ctx 输入框内容为纯文本：chip → [Image #N]/[File #N]，<br>/<div> → 换行
function composerText(ctx = activeFileComposer) {
  const input = composerCfg(ctx).input;
  if (!input) return '';
  const ser = (node, first) => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    if (node.classList && node.classList.contains('ph-chip')) {
      const kind = node.dataset.kind === 'image' ? 'Image' : 'File';
      return `[${kind} #${node.dataset.sid}]`;
    }
    if (node.tagName === 'BR') return '\n';
    let inner = '';
    node.childNodes.forEach(c => { inner += ser(c, false); });
    return (first ? '' : '\n') + inner;  // DIV/P 视为换行
  };
  let out = '';
  input.childNodes.forEach((n, i) => { out += ser(n, i === 0); });
  return out.replace(/ /g, ' ');  // nbsp → 普通空格
}

function isImageFile(f) {
  return (f && (f.type || '').startsWith('image/')) || IMG_EXT_RE.test(f?.name || '');
}

function placeholderFor(file) {
  return file.isImage ? `[Image #${file.sid}]` : `[File #${file.sid}]`;
}

function expandFilePlaceholders(text) {
  return text.replace(/\[(Image|File) #(\d+)\]/g, (m, kind, n) => {
    const f = state.pendingFiles.find(x => x.sid === Number(n));
    return (f && f.path) ? f.path : '';  // #3 悬空占位符(无对应文件)→ 删掉,不把垃圾发给 agent
  });
}

function collectUsedFiles(text) {
  const used = [];
  text.replace(/\[(Image|File) #(\d+)\]/g, (m, kind, n) => {
    const f = state.pendingFiles.find(x => x.sid === Number(n));
    if (f) used.push(f);
    return m;
  });
  return used;
}

// ── 附件占位符健壮性 ─────────────────────────────────────────────
// 统一移除一个待发附件:出列 + (可选)抹占位符 + 重绘 + 删 bridge 上的文件
function removePendingFile(sid, { stripPlaceholder = false } = {}) {
  const idx = state.pendingFiles.findIndex(f => f.sid === sid);
  if (idx < 0) return;
  const removed = state.pendingFiles.splice(idx, 1)[0];
  if (stripPlaceholder) removePlaceholderFromComposer(removed);
  renderThumbStrip(fileCtx(removed));
  if (removed.path) {
    fetch(`http://${location.hostname}:14168/upload`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: removed.path }),
    }).catch(() => {});
  }
}
// #1 对账:DOM 里 chip 没了(被原子删除/退格整块删)→ 同步移除附件 + 删磁盘文件
function reconcilePendingFiles(ctx = activeFileComposer) {
  const input = composerCfg(ctx).input;
  if (!input) return;
  const present = new Set([...input.querySelectorAll('.ph-chip[data-sid]')].map(c => Number(c.dataset.sid)));
  for (const f of filesForCtx(ctx).filter(x => !present.has(x.sid))) {
    removePendingFile(f.sid, { stripPlaceholder: false });
  }
}

async function uploadOne(name, dataUrl, sid) {
  const res = await fetch(`http://${location.hostname}:14168/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dataUrl, sid: sid || '' }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'upload failed');
  return j.path;
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  let skipped = false;
  let emptyHit = false;
  const accepted = [];
  for (const f of files) {
    if (!f || f.size === 0) { emptyHit = true; continue; }
    if (f.size > MAX_UPLOAD_BYTES) { skipped = true; continue; }
    if (state.pendingFiles.length + accepted.length >= MAX_UPLOAD_FILES) { skipped = true; break; }
    accepted.push(f);
  }
  if (emptyHit) showChanToast(t('upload.empty'), '', 'err');
  if (accepted.length === 0) {
    if (skipped) showChanToast(t('upload.tooLarge'), '', 'err');
    return;
  }
  const ctx = activeFileComposer;
  let uploadSid = '';
  if (ctx === 'collab') {
    uploadSid = 'collab';
  } else {
    let upSess = activeSess();
    if (!upSess) { await newSession(); upSess = activeSess(); }
    if (upSess && !upSess.bridgeSessionId) { try { await ensureBridgeSession(upSess); } catch (_) {} }
    uploadSid = (upSess && upSess.bridgeSessionId) || '';
  }
  for (const f of accepted) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      });
      const path = await uploadOne(f.name || 'file', dataUrl, uploadSid);
      state.fileSeq += 1;
      const sid = state.fileSeq;
      const isImage = isImageFile(f);
      const entry = {
        sid, name: f.name || 'file', isImage, path,
        dataUrl: isImage ? dataUrl : '',
        ctx,
      };
      state.pendingFiles.push(entry);
      insertPlaceholderInComposer(entry, ctx);
      renderThumbStrip(ctx);
    } catch (e) {
      showChanToast(t('upload.failed'), e.message || String(e), 'err');
    }
  }
  if (skipped) showChanToast(t('upload.tooLarge'), '', 'err');
}

function handleThumbStripClick(e, ctx) {
  const x = e.target.closest('.x');
  if (x) {
    const sid = Number(x.dataset.sid);
    const idx = state.pendingFiles.findIndex(f => f.sid === sid && fileCtx(f) === ctx);
    if (idx >= 0) {
      const removed = state.pendingFiles[idx];
      state.pendingFiles.splice(idx, 1);
      removePlaceholderFromComposer(removed);
      renderThumbStrip(ctx);
      if (removed.path) {
        fetch(`http://${location.hostname}:14168/upload`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: removed.path }),
        }).catch(() => {});
      }
    }
    return;
  }
  const fileChip = e.target.closest('.file-chip.pending');
  if (fileChip) {
    const path = fileChip.getAttribute('data-path');
    const name = fileChip.getAttribute('data-name');
    if (path) openUploadFile(path, name);
    return;
  }
  const img = e.target.closest('img');
  if (img && img.src) openLightbox(img.src);
}

function bindComposerUpload(ctx) {
  const cfg = composerCfg(ctx);
  if (!cfg.uploadBtn || cfg.uploadBtn.dataset.bound) return;
  cfg.uploadBtn.dataset.bound = '1';
  cfg.uploadBtn.addEventListener('click', (e) => {
    e.preventDefault();
    activeFileComposer = ctx;
    cfg.imgInput?.click();
  });
  cfg.imgInput?.addEventListener('change', () => {
    activeFileComposer = ctx;
    addFiles(cfg.imgInput.files);
    cfg.imgInput.value = '';
  });
  cfg.strip?.addEventListener('click', (e) => handleThumbStripClick(e, ctx));
  cfg.input?.addEventListener('paste', (e) => {
    activeFileComposer = ctx;
    const cd = e.clipboardData || window.clipboardData;
    const items = cd && cd.items;
    const files = [];
    if (items) for (const it of items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
    if (files.length) { e.preventDefault(); addFiles(files); return; }
    // 富文本粘贴 → 强制纯文本（contenteditable 默认会粘 HTML，会污染输入框）
    e.preventDefault();
    const text = cd ? cd.getData('text/plain').replace(/\r\n/g, '\n') : '';
    if (!text) return;
    // Hard-limit: only insert what fits within maxLen
    const maxLen = 20000;
    const curLen = cfg.input.textContent.length;
    const sel = window.getSelection();
    const selLen = (sel.rangeCount && cfg.input.contains(sel.anchorNode)) ? sel.toString().length : 0;
    const remaining = maxLen - curLen + selLen;
    if (remaining <= 0) { showChanToast(t('err.charLimit').replace('{n}', maxLen), '', 'err'); return; }
    const insert = text.slice(0, remaining);
    document.execCommand('insertText', false, insert);
    if (text.length > remaining) showChanToast(t('err.charLimit').replace('{n}', maxLen), '', 'err');
  });
  cfg.input?.addEventListener('input', () => {
    activeFileComposer = ctx;
    // 内容清空后浏览器可能残留 <br>，抹掉以便 :empty 占位提示生效
    if (!cfg.input.textContent.trim() && !cfg.input.querySelector('.ph-chip')) cfg.input.innerHTML = '';
    reconcilePendingFiles(ctx);  // chip 被删 → 同步清理附件 + 删磁盘文件
  });
  const zone = cfg.dropZone;
  if (!zone || zone.dataset.dropBound) return;
  zone.dataset.dropBound = '1';
  let dragDepth = 0;
  const hasFiles = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  };
  zone.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    activeFileComposer = ctx;
    dragDepth += 1;
    zone.classList.add('dragover');
    zone.dataset.dropHint = t('upload.dropHint');
  });
  zone.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    activeFileComposer = ctx;
    e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    zone.classList.remove('dragover');
    activeFileComposer = ctx;
    addFiles(e.dataTransfer.files);
  });
}

bindComposerUpload('chat');
bindComposerUpload('collab');

Object.assign(window, {
  gaSetActiveFileComposer: ctx => { activeFileComposer = ctx === 'collab' ? 'collab' : 'chat'; },
  gaExpandFilePlaceholders: expandFilePlaceholders,
  gaRenderMsgChips: renderMsgTextWithChips,
  gaCollectUsedFiles: collectUsedFiles,
  gaComposerText: composerText,
  gaClearUsedPendingFiles: text => removeUsedPendingFiles(collectUsedFiles(text)),
  gaFileSubLabel: fileSubLabel,
});

if (chatPanel) {
  const blockFileDrop = e => {
    const types = e.dataTransfer?.types;
    if (!types) return;
    for (let i = 0; i < types.length; i += 1) if (types[i] === 'Files') { e.preventDefault(); return; }
  };
  window.addEventListener('dragover', blockFileDrop);
  window.addEventListener('drop', blockFileDrop);
}

/* ═══════════════ bridge 事件 ═══════════════ */
window.ga.onBridgeReady(async () => {
  state.bridgeReady = true;
  if (!state.activeId) { refreshStatusLabel(); refreshEmptyState(null); }
  await loadModelProfiles();
  await loadBridgeConfig();
  if (document.querySelector('.page[data-page="channels"].active')) renderChannelList(gaServiceStore.list());
  const sess = activeSess();
  if (sess && sess.bridgeSessionId && !sess.messages.length) await pollSession(sess);
  delete document.documentElement.dataset.bootHasSessions;
  if (sess) refreshEmptyState(sess);
});
setTimeout(() => { delete document.documentElement.dataset.bootHasSessions; }, 3000);
window.ga.onBridgeNotification((msg) => {
  if (msg && msg.type === 'session-state') {
    for (const sess of state.sessions.values()) {
      if (sess.bridgeSessionId === msg.sessionId) {
        if (msg.status === 'running' || msg.state === 'running') pollSession(sess);
        if (msg.state === 'idle' || msg.status === 'idle') tokPollBridge();
        renderSessionList();
        break;
      }
    }
  }
});
window.ga.onBridgeError((err) => { console.warn('[bridge error]', err); });
window.ga.onBridgeClosed(() => { state.bridgeReady = false; runLabel.textContent = t('status.disconnected'); });

/* ═══════════════ Token 统计页 ═══════════════ */
const tokTbody = document.getElementById('tok-tbody');
const tokPager = document.getElementById('tok-pager');
const tokSince = document.getElementById('tok-since');
const tokUntil = document.getElementById('tok-until');
const tokTotalN = document.getElementById('tok-total-n');
const tokTodayN = document.getElementById('tok-today-n');
const tokCostN = document.getElementById('tok-cost-n');
const TOK_PER_PAGE = 15;
let _tokPage = 0;
let _tokHistory = [];
let _tokLastSnap = {};

// Model price table: $/M tokens [input, output]
const MODEL_PRICES = {
  'gpt-5.4':[2.50,15],'gpt-5':[1.25,10],'gpt-5-mini':[0.25,2],'gpt-4o':[2.50,10],'gpt-4o-mini':[0.15,0.60],
  'gpt-4.1':[2,8],'gpt-4.1-mini':[0.40,1.60],'gpt-4.1-nano':[0.10,0.40],'o4-mini':[1.10,4.40],
  'claude-opus-4-7':[5,25],'claude-opus-4-6':[5,25],'claude-sonnet-4-6':[3,15],'claude-sonnet-4-5':[3,15],'claude-haiku-4-5':[1,5],
  'deepseek-v4':[0.14,0.28],'deepseek-v4-pro':[0.55,2.19],'deepseek-chat':[0.14,0.28],'deepseek-reasoner':[0.55,2.19],
  'glm-5.1':[0.50,0.50],'minimax-m2.7':[0.50,0.50],'kimi-for-coding':[0.50,2],
};
const CNY_RATE = 7.2;
function estCost(inp, out, model, cacheRead, cacheCreate) {
  let p = [3,15];
  if (model) { const m = model.toLowerCase().replace(/\[.*\]/,''); p = MODEL_PRICES[m] || Object.entries(MODEL_PRICES).find(([k])=>m.includes(k))?.[1] || p; }
  const isClaudeOrDS = model && /claude|deepseek/i.test(model);
  const cacheReadRate = isClaudeOrDS ? 0.1 : 0.5;
  const cacheWriteRate = isClaudeOrDS ? 1.25 : 1.0;
  const cost = (inp*p[0] + out*p[1] + (cacheRead||0)*p[0]*cacheReadRate + (cacheCreate||0)*p[0]*cacheWriteRate) / 1e6 * CNY_RATE;
  return cost.toFixed(2);
}
function fmtTok(n) { return n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n); }
function fmtTime(ts) { return new Date(ts*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
function modelPriceTip(model) {
  if (!model) return '';
  const m = model.toLowerCase().replace(/\[.*\]/,'');
  const entry = MODEL_PRICES[m] || Object.entries(MODEL_PRICES).find(([k])=>m.includes(k))?.[1];
  const known = !!entry;
  const p = entry || [3,15];
  const isClaudeOrDS = /claude|deepseek/i.test(m);
  const cacheReadRate = isClaudeOrDS ? 0.1 : 0.5;
  const cacheWriteRate = isClaudeOrDS ? 1.25 : 1.0;
  const lines = [];
  if (!known) lines.push(t('tok.pricingUnknown'));
  lines.push(t('tok.priceInput') + p[0] + ' /M tokens');
  lines.push(t('tok.priceOutput') + p[1] + ' /M tokens');
  lines.push(t('tok.priceCacheW') + (p[0] * cacheWriteRate).toFixed(2) + ' /M tokens');
  lines.push(t('tok.priceCacheR') + (p[0] * cacheReadRate).toFixed(2) + ' /M tokens');
  return lines.join('\n');
}

function tokLoadHistory() { return _tokHistory; }
function tokSaveHistory(h) {
  _tokHistory = h;
  fetch(`http://${location.hostname}:14168/token-history`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({history:h, snap:_tokLastSnap, conductorHist:_condHist, conductorLast:_condLast})
  }).catch(()=>{});
}

let _tokPolling = false;
async function tokPollBridge() {
  if (_tokPolling) return;
  _tokPolling = true;
  try {
    if (!_tokHistory.length) {
      const stored = await bridgeFetch('/token-history');
      if (stored.history?.length) _tokHistory = stored.history;
      if (stored.snap) _tokLastSnap = stored.snap;
      if (stored.conductorHist) _condHist = stored.conductorHist;
      if (stored.conductorLast) _condLast = stored.conductorLast;
    }
    const data = await bridgeFetch('/token-stats');
    const history = tokLoadHistory();
    for (const r of (data.records||[])) {
      const key = r.thread;
      const sid = key.replace('GA-','');
      const sess = [...state.sessions.values()].find(s=>s.bridgeSessionId===sid);
      if (sess && rt(sess).busy) continue;
      const prev = _tokLastSnap[key] || {input:0,output:0,cacheCreate:0,cacheRead:0};
      let di = r.input-prev.input, do_ = r.output-prev.output, dc = r.cacheCreate-prev.cacheCreate, dr = r.cacheRead-prev.cacheRead;
      if (di<0||do_<0||dc<0||dr<0) { di = r.input; do_ = r.output; dc = r.cacheCreate; dr = r.cacheRead; }
      if (di>0||do_>0||dc>0||dr>0) {
        const title = sess ? displayTitle(sess) : sid;
        history.push({sessionId:sid, title:title, input:di, output:do_, cacheCreate:dc, cacheRead:dr, model:r.model||'', ts:Date.now()/1000});
        if(sess?.title) history.forEach(h=>{if(h.sessionId===sid&&(!h.title||h.title===sid))h.title=sess.title;});
      }
      _tokLastSnap[key] = {input:r.input, output:r.output, cacheCreate:r.cacheCreate, cacheRead:r.cacheRead};
    }
    tokSaveHistory(history);
  } catch(_) {}
  _tokPolling = false;
}

function tokGetFiltered() {
  let records = tokLoadHistory();
  const parseD = v => v ? new Date(v.replace(/\s+/,'T')).getTime()/1000 : 0;
  const since = parseD(tokSince?.value);
  const until = parseD(tokUntil?.value);
  if (since) records = records.filter(r=>r.ts>=since);
  if (until) records = records.filter(r=>r.ts<=until);
  return records;
}

function tokRenderStats(filtered, all) {
  let total=0, cost=0;
  filtered.forEach(r=>{total+=(r.input||0)+(r.output||0); cost+=parseFloat(estCost(r.input||0,r.output||0,r.model,r.cacheRead||0,r.cacheCreate||0));});
  if(tokTotalN) tokTotalN.textContent=fmtTok(total);
  if(tokCostN) tokCostN.textContent='¥ '+cost.toFixed(1);
  const todayStart=new Date(); todayStart.setHours(0,0,0,0); const todayTs=todayStart.getTime()/1000;
  let todayT=0; all.filter(r=>r.ts>=todayTs).forEach(r=>{todayT+=(r.input||0)+(r.output||0);});
  if(tokTodayN) tokTodayN.textContent=fmtTok(todayT);
}

function tokRenderTable(records) {
  if(!tokTbody) return;
  const bySession=new Map();
  for(const r of records){
    const k=r.sessionId||'?';
    const ss= r._conductor ? null : [...state.sessions.values()].find(s=>s.bridgeSessionId===k);
    let title = ss ? displayTitle(ss) : (r.title||k);
    const deleted = r._conductor ? !!r._killed : !ss;
    if(!bySession.has(k)) bySession.set(k,{title:title,deleted:deleted,input:0,output:0,cacheCreate:0,cacheRead:0,lastTs:0,prompts:[]});
    const s=bySession.get(k); s.input+=r.input||0; s.output+=r.output||0; s.cacheCreate+=r.cacheCreate||0; s.cacheRead+=r.cacheRead||0;
    if(r.ts>s.lastTs){s.lastTs=r.ts; s.title=title;} s.prompts.push(r);
  }
  tokTbody.innerHTML='';
  if(bySession.size===0){tokTbody.innerHTML=`<tr><td colspan="6" style="color:var(--muted)">${t('tok.noData')}</td></tr>`;if(tokPager)tokPager.innerHTML='';return;}
  const sorted=[...bySession.values()].sort((a,b)=>b.lastTs-a.lastTs);
  const totalPages=Math.ceil(sorted.length/TOK_PER_PAGE);
  if(_tokPage>=totalPages)_tokPage=totalPages-1;
  const pageItems=sorted.slice(_tokPage*TOK_PER_PAGE,(_tokPage+1)*TOK_PER_PAGE);
  for(const s of pageItems){
    let sc=0; s.prompts.forEach(p=>{sc+=parseFloat(estCost(p.input||0,p.output||0,p.model,p.cacheRead||0,p.cacheCreate||0));});
    const tr=document.createElement('tr'); tr.className='tok-row-session';
    tr.innerHTML=`<td>${escapeHtml(s.title)}${s.deleted?'<span class="tok-deleted">'+t('tok.deleted')+'</span>':''}</td><td>${fmtTok(s.input)}</td><td>${fmtTok(s.output)}</td><td>${fmtTok(s.cacheCreate)}</td><td>${fmtTok(s.cacheRead)}</td><td>¥${sc.toFixed(2)}</td>`;
    tokTbody.appendChild(tr);
    const details=[]; s.prompts.sort((a,b)=>b.ts-a.ts);
    for(const p of s.prompts){
      const dr=document.createElement('tr'); dr.className='tok-detail'; dr.hidden=true;
      const modelHtml = p.model ? ` · <span class="tok-model-tip" data-tip="${escapeHtml(modelPriceTip(p.model))}">${escapeHtml(p.model)}</span>` : '';
      dr.innerHTML=`<td>${fmtTime(p.ts)}${modelHtml}</td><td>${fmtTok(p.input||0)}</td><td>${fmtTok(p.output||0)}</td><td>${fmtTok(p.cacheCreate||0)}</td><td>${fmtTok(p.cacheRead||0)}</td><td>¥${estCost(p.input||0,p.output||0,p.model,p.cacheRead||0,p.cacheCreate||0)}</td>`;
      tokTbody.appendChild(dr); details.push(dr);
    }
    tr.addEventListener('click',()=>{const o=tr.classList.toggle('open');details.forEach(d=>d.hidden=!o);});
  }
  if(tokPager){tokPager.innerHTML='';if(totalPages>1)for(let i=0;i<totalPages;i++){const b=document.createElement('button');b.textContent=i+1;if(i===_tokPage)b.className='active';b.addEventListener('click',()=>{_tokPage=i;tokRenderTable(records);});tokPager.appendChild(b);}}
}

async function loadTokenPage(){await tokPollBridge();const f=tokGetFiltered();const all=tokLoadHistory();tokRenderStats(f,all);tokRenderTable(f);await tokRenderConductorRow();}

let _conductorRowGen = 0;
const _COND_HIST_KEY = 'conductor_token_hist';
const _COND_LAST_KEY = 'conductor_token_last';
const _condZero = {input:0,output:0,cacheCreate:0,cacheRead:0,cost:0};
let _condHist = null, _condLast = null;
function _condLoadHist() { return _condHist || {..._condZero}; }
function _condLoadLast() { return _condLast; }
function _condSave(hist, last) {
  _condHist = hist; _condLast = last;
  fetch(`http://${location.hostname}:14168/token-history`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({history:_tokHistory, snap:_tokLastSnap, conductorHist:hist, conductorLast:last})
  }).catch(()=>{});
}

async function tokRenderConductorRow() {
  if (!tokTbody) return;
  const gen = ++_conductorRowGen;
  tokTbody.querySelectorAll('.tok-row-conductor').forEach(el => el.remove());
  let curIn = 0, curOut = 0, curCc = 0, curCr = 0, curCost = 0;
  try {
    const data = await (await fetch(`http://${location.hostname}:8900/token-stats`)).json();
    if (gen !== _conductorRowGen) return;
    tokTbody.querySelectorAll('.tok-row-conductor').forEach(el => el.remove());
    const recs = (data.records || []).filter(r => r.thread === 'conductor-agent' || r.thread.startsWith('subagent-'));
    for (const r of recs) {
      curIn += r.input || 0; curOut += r.output || 0; curCc += r.cacheCreate || 0; curCr += r.cacheRead || 0;
      curCost += parseFloat(estCost(r.input || 0, r.output || 0, r.model || '', r.cacheRead || 0, r.cacheCreate || 0));
    }
  } catch (_) {}
  if (gen !== _conductorRowGen) return;
  // Detect conductor restart: if current totals < last seen, accumulate last into history
  const hist = _condLoadHist();
  const last = _condLoadLast();
  if (last && (curIn < last.input || curOut < last.output)) {
    hist.input += last.input; hist.output += last.output; hist.cacheCreate += last.cacheCreate; hist.cacheRead += last.cacheRead; hist.cost += last.cost;
  }
  const newLast = (curIn > 0 || curOut > 0) ? {input:curIn, output:curOut, cacheCreate:curCc, cacheRead:curCr, cost:curCost} : last;
  _condSave(hist, newLast);
  const tip = 'Conductor 消耗的 token 不计入累计 token 中';
  // Row 1: historical total
  const tr1 = document.createElement('tr'); tr1.className = 'tok-row-session tok-row-conductor'; tr1.title = tip;
  const hIn = hist.input + curIn, hOut = hist.output + curOut, hCc = hist.cacheCreate + curCc, hCr = hist.cacheRead + curCr, hCost = hist.cost + curCost;
  tr1.innerHTML = `<td>🎛 Conductor 累计</td><td>${fmtTok(hIn)}</td><td>${fmtTok(hOut)}</td><td>${fmtTok(hCc)}</td><td>${fmtTok(hCr)}</td><td>¥${hCost.toFixed(2)}</td>`;
  // Row 2: current session
  const tr2 = document.createElement('tr'); tr2.className = 'tok-row-session tok-row-conductor'; tr2.title = tip;
  tr2.innerHTML = `<td>🎛 Conductor 本次</td><td>${fmtTok(curIn)}</td><td>${fmtTok(curOut)}</td><td>${fmtTok(curCc)}</td><td>${fmtTok(curCr)}</td><td>¥${curCost.toFixed(2)}</td>`;
  tokTbody.insertBefore(tr2, tokTbody.firstChild);
  tokTbody.insertBefore(tr1, tokTbody.firstChild);
}

/* ─── Conductor token tab (disabled — pending time tracking) ─── */
/*
let _tokTab = 'all';
const tokTabs = document.getElementById('tok-tabs');
if (tokTabs) tokTabs.addEventListener('click', e => {
  const btn = e.target.closest('.tok-tab');
  if (!btn || btn.classList.contains('active')) return;
  tokTabs.querySelectorAll('.tok-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _tokTab = btn.dataset.tab;
  _tokPage = 0;
  if (_tokTab === 'conductor') loadConductorTokens();
  else loadTokenPage();
});

async function loadConductorTokens() {
  try {
    const data = await (await fetch(`http://${location.hostname}:8900/token-stats`)).json();
    const titles = data.titles || {};
    const killedSet = new Set(data.killed || []);
    const records = (data.records || []).filter(r => r.thread === 'conductor-agent' || r.thread.startsWith('subagent-')).map(r => {
      let title = 'Conductor';
      if (r.thread.startsWith('subagent-')) {
        const prompt = titles[r.thread] || '';
        title = prompt ? (prompt.length > 30 ? prompt.slice(0, 30) + '…' : prompt) : 'Sub ' + r.thread.replace('subagent-', '');
      }
      return { sessionId: r.thread, title, input: r.input || 0, output: r.output || 0, cacheCreate: r.cacheCreate || 0, cacheRead: r.cacheRead || 0, model: r.model || '', ts: Date.now() / 1000, _conductor: true, _killed: killedSet.has(r.thread) };
    });
    tokRenderStats(records, records);
    tokRenderTable(records);
  } catch (_) {
    if (tokTbody) tokTbody.innerHTML = `<tr><td colspan="6" style="color:var(--muted)">无法连接 Conductor (8900)</td></tr>`;
  }
}
*/

/* Flatpickr 初始化 */
const _fpOpts = { enableTime:true, time_24hr:true, dateFormat:'Y-m-d  H:i', locale:window.flatpickr?.l10ns?.[document.documentElement.lang==='en'?'default':'zh']||'default', allowInput:false, onChange(){ _tokPage=0; loadTokenPage(); } };
const fpSince = tokSince ? flatpickr(tokSince, _fpOpts) : null;
const fpUntil = tokUntil ? flatpickr(tokUntil, _fpOpts) : null;
const tokResetBtn=document.getElementById('tok-reset');
if(tokResetBtn)tokResetBtn.addEventListener('click',()=>{if(fpSince)fpSince.clear();if(fpUntil)fpUntil.clear();_tokPage=0;loadTokenPage();});
nav.addEventListener('click',(e)=>{const item=e.target.closest('.nav-item');if(item&&item.dataset.page==='token')loadTokenPage();if(item&&item.dataset.page==='channels')renderChannelList(gaServiceStore.list());if(item&&item.dataset.page==='status')loadStatusPanel();});
/* ═══════════════ 自定义预设 ═══════════════ */
const CP_KEY = 'ga_custom_presets';
const HB_KEY = 'ga_hidden_builtins';

const BUILTIN_PRESETS = [
  { key: 'butler', titleKey: 'preset.butler.t', descKey: 'preset.butler.d', navigate: 'collab',
    iconSvg: '<svg class="fc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
  { key: 'plan',   titleKey: 'preset.plan.t',   descKey: 'preset.plan.d',   promptKey: 'presetPrompt.plan',
    iconSvg: '<svg class="fc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/><circle cx="4" cy="6" r="1.5"/><circle cx="4" cy="12" r="1.5"/><circle cx="4" cy="18" r="1.5"/></svg>' },
  { key: 'goal',    titleKey: 'preset.goal.t',    descKey: 'preset.goal.d',    promptKey: 'presetPrompt.goal',
    iconSvg: '<svg class="fc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/></svg>' },
  { key: 'explore', titleKey: 'preset.explore.t', descKey: 'preset.explore.d', promptKey: 'presetPrompt.explore',
    iconSvg: '<svg class="fc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polygon points="16.2 7.8 14.1 14.1 7.8 16.2 9.9 9.9 16.2 7.8"/></svg>' },
  { key: 'hive',    titleKey: 'preset.hive.t',    descKey: 'preset.hive.d',    promptKey: 'presetPrompt.hive',
    iconSvg: '<svg class="fc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 21 7 21 17 12 22 3 17 3 7"/><polygon points="12 8 16 10.3 16 14.7 12 17 8 14.7 8 10.3"/></svg>' },
  { key: 'review',  titleKey: 'preset.review.t',  descKey: 'preset.review.d',  promptKey: 'presetPrompt.review',
    iconSvg: '<svg class="fc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' },
  { key: 'mine',    titleKey: 'preset.mine.t',    descKey: 'preset.mine.d',    promptKey: 'presetPrompt.mine',
    iconSvg: '<svg class="fc-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' },
];
const ADD_ICON_SVG = GA_ICON('plus', 'fc-ic');

state.customPresets = [];
state.hiddenBuiltins = new Set();

function loadCustomPresets() {
  try {
    const raw = localStorage.getItem(CP_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    state.customPresets = Array.isArray(arr) ? arr.filter(p => p && p.id && p.title && p.prompt) : [];
  } catch { state.customPresets = []; }
}
function saveCustomPresets() {
  localStorage.setItem(CP_KEY, JSON.stringify(state.customPresets));
}
function loadHiddenBuiltins() {
  try {
    const raw = localStorage.getItem(HB_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    state.hiddenBuiltins = new Set(Array.isArray(arr) ? arr.filter(k => typeof k === 'string') : []);
  } catch { state.hiddenBuiltins = new Set(); }
}
function saveHiddenBuiltins() {
  localStorage.setItem(HB_KEY, JSON.stringify([...state.hiddenBuiltins]));
}

function makeCardEl({ kind, dataAttrs, iconSvg, titleText, descText, removable }) {
  const card = document.createElement('div');
  card.className = 'fcard ' + kind;
  for (const [k, v] of Object.entries(dataAttrs || {})) card.dataset[k] = v;
  card.innerHTML = iconSvg;
  if (removable) {
    const x = document.createElement('button');
    x.className = 'fc-x';
    x.type = 'button';
    x.dataset.removeKind = kind === 'fcard-builtin' ? 'builtin' : 'custom';
    x.dataset.removeId = dataAttrs?.id || dataAttrs?.preset || '';
    x.dataset.i18nTitle = 'customPreset.removeTitle';
    x.title = t('customPreset.removeTitle');
    x.textContent = '×';
    card.appendChild(x);
  }
  const titleEl = document.createElement('div');
  titleEl.className = 'fc-t';
  titleEl.textContent = titleText;
  card.appendChild(titleEl);
  const descEl = document.createElement('div');
  descEl.className = 'fc-d';
  descEl.textContent = descText;
  card.appendChild(descEl);
  return card;
}

function renderAllPresets() {
  document.querySelectorAll('.feature-grid').forEach(grid => {
    grid.innerHTML = '';
    for (const bp of BUILTIN_PRESETS) {
      if (state.hiddenBuiltins.has(bp.key)) continue;
      grid.appendChild(makeCardEl({
        kind: 'fcard-builtin',
        dataAttrs: { preset: bp.key },
        iconSvg: bp.iconSvg,
        titleText: t(bp.titleKey),
        descText: t(bp.descKey),
        removable: true,
      }));
    }
    for (const cp of state.customPresets) {
      grid.appendChild(makeCardEl({
        kind: 'fcard-custom',
        dataAttrs: { id: cp.id },
        iconSvg: ADD_ICON_SVG,
        titleText: cp.title,
        descText: cp.prompt,
        removable: true,
      }));
    }
    const addCard = makeCardEl({
      kind: 'add',
      dataAttrs: { preset: 'add' },
      iconSvg: ADD_ICON_SVG,
      titleText: t('preset.add.t'),
      descText: t('preset.add.d'),
      removable: false,
    });
    grid.appendChild(addCard);
  });
  updateRestoreBtnVisibility();
}

function addCustomPreset(title, prompt) {
  const id = 'cp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  state.customPresets.push({ id, title, prompt });
  saveCustomPresets();
  renderAllPresets();
}
function removeCustomPreset(id) {
  const idx = state.customPresets.findIndex(p => p.id === id);
  if (idx < 0) return;
  state.customPresets.splice(idx, 1);
  saveCustomPresets();
  renderAllPresets();
}
function hideBuiltinPreset(key) {
  if (!BUILTIN_PRESETS.some(bp => bp.key === key)) return;
  state.hiddenBuiltins.add(key);
  saveHiddenBuiltins();
  renderAllPresets();
}
function restoreBuiltinPresets() {
  state.hiddenBuiltins.clear();
  saveHiddenBuiltins();
  renderAllPresets();
}
function updateRestoreBtnVisibility() {
  const btn = document.getElementById('preset-restore-btn');
  if (!btn) return;
  btn.hidden = state.hiddenBuiltins.size === 0;
}

const cpModal = document.getElementById('custom-preset-modal');
const cpTitleInput = document.getElementById('cp-title');
const cpPromptInput = document.getElementById('cp-prompt');
const cpSaveBtn = document.getElementById('cp-save');
const cpError = document.getElementById('cp-error');
function resetCustomPresetForm() {
  if (cpTitleInput) cpTitleInput.value = '';
  if (cpPromptInput) cpPromptInput.value = '';
  if (cpError) { cpError.hidden = true; cpError.textContent = ''; }
  setTimeout(() => { if (cpTitleInput) cpTitleInput.focus(); }, 0);
}
if (cpSaveBtn) cpSaveBtn.addEventListener('click', () => {
  const title = (cpTitleInput?.value || '').trim();
  const prompt = (cpPromptInput?.value || '').trim();
  if (!title || !prompt) {
    if (cpError) { cpError.textContent = t('customPreset.empty'); cpError.hidden = false; }
    return;
  }
  addCustomPreset(title, prompt);
  if (cpModal) cpModal.hidden = true;
});

const restoreBtn = document.getElementById('preset-restore-btn');
if (restoreBtn) restoreBtn.addEventListener('click', () => { restoreBuiltinPresets(); });


/* ═══════════════ 图片预览 lightbox ═══════════════ */
const lightbox    = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
function openLightbox(src) {
  if (!lightbox || !lightboxImg || !src) return;
  lightboxImg.src = src;
  lightbox.hidden = false;
}
function closeLightbox() {
  if (!lightbox || !lightboxImg) return;
  lightbox.hidden = true;
  lightboxImg.src = '';
}
if (lightbox) {
  lightbox.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeLightbox();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lightbox && !lightbox.hidden) closeLightbox();
});
if (msgArea) {
  msgArea.addEventListener('click', (e) => {
    const img = e.target.closest('.user-imgs img');
    if (img && img.src) { openLightbox(img.src); return; }
    const fileChip = e.target.closest('.user-files .file-chip');
    if (fileChip) {
      const path = fileChip.getAttribute('data-path');
      const name = fileChip.getAttribute('data-name');
      if (path) openUploadFile(path, name);
    }
  });
}

function uploadRawUrl(path, download) {
  return `http://${location.hostname}:14168/upload/raw?path=${encodeURIComponent(path || '')}${download ? '&download=1' : ''}`;
}
function bridgeIsLocal() {
  return location.hostname === '127.0.0.1' || location.hostname === 'localhost';
}
async function openUploadFile(path, name) {
  // 远程访问：浏览器无法调起 bridge 那台/本机的系统程序，降级为下载到本机
  if (!bridgeIsLocal()) {
    const a = document.createElement('a');
    a.href = uploadRawUrl(path, true);
    a.download = name || '';
    document.body.appendChild(a); a.click(); a.remove();
    return;
  }
  // 本地：bridge 与你同机，调系统默认程序打开 / 在文件夹显示
  const mode = isPreviewableByName(name || path) ? 'open' : 'reveal';
  try {
    const res = await fetch(`http://${location.hostname}:14168/path/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'upload', path, mode }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'open failed');
  } catch (e) {
    showChanToast(t('file.openFailed'), e.message || String(e), 'err');
  }
}

const PREVIEWABLE_EXTS = new Set([
  'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff',
  'txt', 'md', 'log', 'json', 'yaml', 'yml', 'xml', 'csv', 'tsv', 'ini', 'toml', 'env', 'rtf',
  'py', 'js', 'ts', 'tsx', 'jsx', 'java', 'c', 'cpp', 'h', 'hpp', 'rs', 'go', 'rb', 'php', 'sh', 'bash', 'zsh', 'fish', 'lua', 'pl', 'r', 'scala', 'kt', 'swift',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'sql',
  'doc', 'docx', 'pages', 'odt',
  'xls', 'xlsx', 'numbers', 'ods',
  'ppt', 'pptx', 'key', 'odp',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv',
]);
function isPreviewableByName(name) {
  const m = String(name || '').match(/\.([^./\\]+)$/);
  if (!m) return false;
  return PREVIEWABLE_EXTS.has(m[1].toLowerCase());
}

/* ═══════════════ 消息通道（复用 gaServiceStore + WS 同步） ═══════════════ */
const CHAN_ICON = GA_ICON('chatTeardropText', 'lr-ic');
const CHAN_FILE_LABELS = {
  'qqapp.py': 'ch.qq',
  'wechatapp.py': 'ch.wechat',
  'wecomapp.py': 'ch.wecom',
  'dingtalkapp.py': 'ch.dingtalk',
  'tgapp.py': 'ch.telegram',
  'dcapp.py': 'ch.discord',
  'fsapp.py': 'ch.lark',
};
const chanListEl = document.getElementById('chan-list');
const chanEmptyEl = document.getElementById('chan-empty');
const chanLogModal = document.getElementById('chan-log-modal');
const chanLogPre = document.getElementById('chan-log-pre');
const chanLogTitle = document.getElementById('chan-log-title');
const chanConfigModal = document.getElementById('chan-config-modal');
const chanConfigTitle = document.getElementById('chan-config-title');
const chanConfigEditor = document.getElementById('chan-config-editor');
const chanConfigSave = document.getElementById('chan-config-save');
let _chanLogId = null;
let _chanBusy = false;
let _chanToastTimer = null;

function getToastRoot() {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.className = 'toast-root';
    root.setAttribute('aria-live', 'polite');
    document.body.appendChild(root);
  }
  return root;
}

function showChanToast(title, detail, kind) {
  if (!title) return;
  const root = getToastRoot();
  if (_chanToastTimer) clearTimeout(_chanToastTimer);
  root.innerHTML = '';
  const el = document.createElement('div');
  el.className = `toast toast-${kind === 'err' ? 'err' : kind === 'info' ? 'info' : 'ok'}`;
  const tEl = document.createElement('span');
  tEl.className = 'toast-title';
  tEl.textContent = title;
  el.appendChild(tEl);
  if (detail) {
    const dEl = document.createElement('span');
    dEl.className = 'toast-detail';
    dEl.textContent = detail;
    el.appendChild(dEl);
  }
  root.appendChild(el);
  const show = () => el.classList.add('show');
  requestAnimationFrame(show);
  setTimeout(show, 16);
  _chanToastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

/* ── Input length validation ── */
(function initInputLimits() {
  let _toastTimer = null;

  function limitToast(maxLen) {
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      const msg = t('err.charLimit').replace('{n}', maxLen);
      showChanToast(msg, '', 'err');
    }, 300);
  }

  // Toast-based: for elements with maxLength attribute (input/textarea)
  function bindToastLimit(el) {
    if (!el || !el.maxLength || el.maxLength < 0) return;
    el.addEventListener('input', () => {
      if (el.value.length >= el.maxLength) limitToast(el.maxLength);
    });
  }

  // Toast-based: for contenteditable elements (no native maxLength)
  // Note: we only warn on input, not hard-truncate, because truncating innerHTML
  // would destroy embedded chips, cursor position, and break IME composition.
  // Actual truncation happens at send time in submitInput().
  function bindContentEditableLimit(el, maxLen) {
    if (!el) return;
    let composing = false;
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', () => {
      composing = false;
      trimExcess();
    });
    // Layer 1: block non-IME input when at capacity
    el.addEventListener('beforeinput', (e) => {
      if (composing) return; // let IME through, trim after compositionend
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') return;
      if (e.inputType && e.inputType.startsWith('delete')) return;
      if (el.textContent.length >= maxLen) {
        e.preventDefault();
        limitToast(maxLen);
      }
    });
    // Layer 2: after IME commits, trim excess from last text node
    function trimExcess() {
      const cur = el.textContent.length;
      if (cur <= maxLen) return;
      const excess = cur - maxLen;
      // Walk text nodes in reverse to trim from the end (skip chip internals)
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      if (!textNodes.length) return;
      let toRemove = excess;
      for (let i = textNodes.length - 1; i >= 0 && toRemove > 0; i--) {
        const node = textNodes[i];
        if (node.nodeValue.length <= toRemove) {
          toRemove -= node.nodeValue.length;
          node.nodeValue = '';
        } else {
          node.nodeValue = node.nodeValue.slice(0, node.nodeValue.length - toRemove);
          toRemove = 0;
        }
      }
      limitToast(maxLen);
    }
  }

  // Per-field inline hint: creates a small red span right after the input
  function bindFieldInlineLimit(el) {
    if (!el || !el.maxLength || el.maxLength < 0) return;
    const hint = document.createElement('span');
    hint.className = 'field-limit-hint';
    hint.style.cssText = 'color:var(--err,#dc2626);font-size:.75rem;display:none;margin-top:2px';
    // Insert hint right after the input element
    el.insertAdjacentElement('afterend', hint);
    el.addEventListener('input', () => {
      if (el.value.length >= el.maxLength) {
        hint.textContent = t('err.charLimit').replace('{n}', el.maxLength);
        hint.style.display = 'block';
      } else {
        hint.style.display = 'none';
      }
    });
  }

  window.bindFieldInlineLimit = bindFieldInlineLimit;
  window.bindToastLimit = bindToastLimit;

  // Number field: clamp to max on blur, no red text; block non-integer chars
  function bindNumberClamp(el) {
    if (!el || !el.max) return;
    const max = Number(el.max);
    if (!max) return;
    // Block all non-digit keys (allow navigation/editing keys)
    el.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // allow shortcuts
      if (['Backspace','Delete','Tab','ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      if (e.key.length === 1 && !/[0-9]/.test(e.key)) e.preventDefault();
    });
    el.addEventListener('input', () => {
      // Strip non-digit chars (IME can bypass keydown)
      const cleaned = el.value.replace(/[^0-9]/g, '');
      if (cleaned !== el.value) el.value = cleaned;
      const v = Number(el.value);
      if (el.value !== '' && v > max) el.value = max;
    });
  }

  // Shared inline error group (for preset form)
  function createInlineGroup(errEl) {
    const tracked = new Set();
    function check(el) {
      if (el.value.length >= el.maxLength) {
        tracked.add(el);
      } else {
        tracked.delete(el);
      }
      if (tracked.size > 0) {
        errEl.textContent = t('err.charLimit').replace('{n}', el.maxLength);
        errEl.hidden = false;
      } else {
        errEl.hidden = true;
      }
    }
    return {
      addText(el) {
        if (!el || !el.maxLength || el.maxLength < 0) return;
        el.addEventListener('input', () => check(el));
      }
    };
  }

  // Wait for DOM ready
  function setup() {
    // Contenteditable inputs (chat + collab)
    const chatInput = document.querySelector('.input[contenteditable][data-i18n-ph="composer.placeholder"]');
    const collabInput = document.getElementById('collab-input');
    bindContentEditableLimit(chatInput, 20000);
    bindContentEditableLimit(collabInput, 20000);

    // Toast targets (standard inputs/textareas with maxLength)
    const searchInput = document.querySelector('.search input');
    const mykeyEditor = document.getElementById('chan-config-editor');
    [searchInput, mykeyEditor].forEach(bindToastLimit);

    // Model form: per-field inline hints
    const form = document.getElementById('add-model-form');
    if (form) {
      ['model', 'apikey', 'apibase', 'name'].forEach(name => {
        bindFieldInlineLimit(form.querySelector(`[name="${name}"]`));
      });
      ['max_retries', 'connect_timeout', 'read_timeout'].forEach(name => {
        bindNumberClamp(form.querySelector(`[name="${name}"]`));
      });
    }

    // Preset form: shared inline error (user confirmed OK)
    const cpErr = document.getElementById('cp-error');
    if (cpErr) {
      const group = createInlineGroup(cpErr);
      group.addText(document.getElementById('cp-title'));
      group.addText(document.getElementById('cp-prompt'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();

function channelDisplayName(ch) {
  const file = (ch.name || ch.id || '').split('/').pop();
  const key = CHAN_FILE_LABELS[file];
  return key ? t(key) : (ch.name || ch.id || '');
}
function channelStatusClass(status) {
  if (status === 'running') return 'on';
  if (status === 'error') return 'err';
  return 'off';
}
function channelStatusLabel(status) {
  const map = {
    running: 'st.running', offline: 'st.offline', error: 'st.error',
    starting: 'st.starting', stopping: 'st.stopping',
  };
  return t(map[status] || 'st.offline');
}
function channelErrorMessage(code) {
  const map = { not_configured: 'err.channelNotConfigured' };
  return t(map[code] || code || 'err.channelStart');
}
function channelToastDetail(e) {
  const svc = e.data && e.data.service;
  if (svc && svc.lastError) return svc.lastError;
  const code = e.data && e.data.error;
  return channelErrorMessage(code || e.message);
}
function renderChannelList(channels) {
  if (!chanListEl) return;
  const rows = (channels || []).filter((ch) => (ch.id || '').startsWith('frontends/'));
  chanListEl.innerHTML = '';
  if (chanEmptyEl) chanEmptyEl.hidden = rows.length > 0;
  for (const ch of rows) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.dataset.channelId = ch.id;
    const stClass = channelStatusClass(ch.status || 'offline');
    const running = !!ch.running;
    row.innerHTML = `
      ${CHAN_ICON}
      <div class="chan-meta">
        <b class="chan-name"></b>
        <span class="kv chan-path"></span>
      </div>
      <span class="lr-st ${stClass} chan-status"></span>
      <span class="grow"></span>
      <button type="button" class="link-btn link sm" data-act="configure"></button>
      <button type="button" class="link-btn link sm" data-act="logs"></button>
      <button type="button" class="sw-mini${running ? ' on' : ''}" data-act="toggle" aria-pressed="${running}"><i></i></button>`;
    row.querySelector('.chan-name').textContent = channelDisplayName(ch);
    row.querySelector('.chan-path').textContent = ch.name || ch.id;
    row.querySelector('.chan-status').textContent = channelStatusLabel(ch.status || 'offline');
    row.querySelector('[data-act="configure"]').textContent = t('act.configure');
    row.querySelector('[data-act="logs"]').textContent = t('act.logs');
    chanListEl.appendChild(row);
  }
}
async function toggleChannel(id, running, toggleEl) {
  if (_chanBusy) return;
  _chanBusy = true;
  if (toggleEl) toggleEl.disabled = true;
  const label = channelDisplayName(gaServiceStore.get(id) || { id });
  try {
    if (running) {
      await window.ga.stopService(id);
      showChanToast(t('sys.channelStopped') + ' · ' + label, '', 'ok');
    } else {
      const res = await window.ga.startService(id);
      if (res && res.service && res.service.status === 'error') {
        throw Object.assign(new Error(res.service.lastError || 'start_failed'), { data: res });
      }
      showChanToast(t('sys.channelStarted') + ' · ' + label, '', 'ok');
    }
  } catch (e) {
    showChanToast(
      (running ? t('err.channelStop') : t('err.channelStart')) + ' · ' + label,
      channelToastDetail(e),
      'err'
    );
  } finally {
    _chanBusy = false;
    if (toggleEl) toggleEl.disabled = false;
  }
}
async function openChannelLogs(id) {
  if (!chanLogModal || !chanLogPre) return;
  _chanLogId = id;
  const ch = gaServiceStore.get(id) || { id };
  const titleName = id === '__bridge__' ? (ch.name || 'bridge') : statusDisplayName(ch);
  if (chanLogTitle) chanLogTitle.textContent = t('modal.channelLogs') + ' · ' + titleName;
  chanLogPre.textContent = t('ch.loading');
  openModal('chan-log-modal');
  try {
    const res = await window.ga.getServiceLogs(id, 200);
    const lines = res.lines || [];
    chanLogPre.textContent = lines.length ? lines.join('\n') : t('ch.logEmpty');
  } catch (e) {
    chanLogPre.textContent = t('err.channelLoad') + ': ' + (e.message || e);
  }
}
async function openChannelMykey(channelId) {
  if (!chanConfigModal || !chanConfigEditor) return;
  const ch = gaServiceStore.get(channelId) || { id: channelId };
  if (chanConfigTitle) {
    chanConfigTitle.textContent = t('modal.mykeyConfig') + (channelId ? ' · ' + channelDisplayName(ch) : '');
  }
  chanConfigEditor.value = t('ch.loading');
  chanConfigEditor.disabled = true;
  if (chanConfigSave) chanConfigSave.disabled = true;
  openModal('chan-config-modal');
  try {
    const res = await window.ga.getMykeyContent();
    chanConfigEditor.value = res.content || '';
  } catch (e) {
    chanConfigEditor.value = t('err.channelLoad') + ': ' + (e.message || e);
  } finally {
    chanConfigEditor.disabled = false;
    if (chanConfigSave) chanConfigSave.disabled = false;
    chanConfigEditor.focus();
  }
}
async function saveChannelMykey() {
  if (!chanConfigEditor || !chanConfigSave) return;
  chanConfigSave.disabled = true;
  try {
    await window.ga.saveMykeyContent(chanConfigEditor.value);
    showChanToast(t('sys.configSaved'), '', 'ok');
    chanConfigModal.hidden = true;
  } catch (e) {
    showChanToast(t('err.channelLoad'), e.message || String(e), 'err');
  } finally {
    chanConfigSave.disabled = false;
  }
}
if (chanConfigSave) {
  chanConfigSave.addEventListener('click', saveChannelMykey);
}

/* ═══════════════ 状态面板（复用 ServiceManager + 启停/日志） ═══════════════ */
const statusListEl = document.getElementById('status-list');

function statusDisplayName(s) {
  if (!s) return '';
  if (s.id === '__bridge__') return s.name || 'bridge';
  if (s.id === 'reflect/scheduler.py') return t('proc.scheduler');
  return channelDisplayName(s);
}
function fmtPid(pid) { return pid ? `PID ${pid}` : '—'; }
function fmtRes(s) {
  const cpu = s.cpuPct != null ? `${s.cpuPct}%` : '—';
  const mem = s.memMb != null ? `${s.memMb}MB` : '—';
  return `${cpu} / ${mem}`;
}

function renderStatusPanel(services) {
  if (!statusListEl) return;
  statusListEl.innerHTML = '';
  for (const s of services || []) {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.dataset.serviceId = s.id;
    const stClass = channelStatusClass(s.status || 'offline');
    const running = !!s.running;
    const managed = s.managed !== false;
    let acts = `<button type="button" class="link-btn link sm" data-act="logs"></button>`;
    if (managed) {
      if (running) acts += `<button type="button" class="link-btn link sm" data-act="restart"></button>`;
      acts += `<button type="button" class="sw-mini${running ? ' on' : ''}" data-act="toggle" aria-pressed="${running}"><i></i></button>`;
    }
    row.innerHTML = `
      <b class="st-name"></b>
      <span class="lr-st ${stClass} st-status"></span>
      <span class="kv st-pid"></span>
      <span class="kv st-res"></span>
      <span class="grow"></span>
      ${acts}`;
    row.querySelector('.st-name').textContent = statusDisplayName(s);
    row.querySelector('.st-status').textContent = channelStatusLabel(s.status || 'offline');
    row.querySelector('.st-pid').textContent = fmtPid(s.pid);
    row.querySelector('.st-res').textContent = fmtRes(s);
    const logBtn = row.querySelector('[data-act="logs"]');
    if (logBtn) logBtn.textContent = t('act.logs');
    const rstBtn = row.querySelector('[data-act="restart"]');
    if (rstBtn) rstBtn.textContent = t('act.restart');
    statusListEl.appendChild(row);
  }
}

async function loadStatusPanel() {
  if (!statusListEl) return;
  const res = await window.ga.getServicePanel();
  renderStatusPanel(res.services || []);
}

async function restartService(id) {
  const label = statusDisplayName(gaServiceStore.get(id) || { id });
  await window.ga.stopService(id);
  const res = await window.ga.startService(id);
  if (res && res.service && res.service.status === 'error') {
    throw Object.assign(new Error(res.service.lastError || 'start_failed'), { data: res });
  }
  showChanToast(t('act.restart') + ' · ' + label, '', 'ok');
}

if (statusListEl) {
  statusListEl.addEventListener('click', async (e) => {
    const row = e.target.closest('.list-row');
    if (!row) return;
    const id = row.dataset.serviceId;
    const actEl = e.target.closest('[data-act]');
    if (!actEl || !id) return;
    const act = actEl.dataset.act;
    if (act === 'logs') {
      openChannelLogs(id);
      return;
    }
    if (act === 'restart') {
      if (_chanBusy) return;
      _chanBusy = true;
      try {
        await restartService(id);
        await loadStatusPanel();
      } catch (err) {
        showChanToast(t('act.restart') + ' · ' + statusDisplayName({ id }), err.message || String(err), 'err');
      } finally {
        _chanBusy = false;
      }
      return;
    }
    if (act === 'toggle') {
      if (actEl.disabled || _chanBusy) return;
      const running = actEl.classList.contains('on');
      await toggleChannel(id, running, actEl);
      if (document.querySelector('.page[data-page="status"].active')) loadStatusPanel();
    }
  });
}

gaServiceStore.onServices((list) => {
  if (document.querySelector('.page[data-page="channels"].active')) renderChannelList(list);
  if (document.querySelector('.page[data-page="status"].active')) loadStatusPanel();
});
if (chanListEl) {
  chanListEl.addEventListener('click', async (e) => {
    const row = e.target.closest('.list-row');
    if (!row) return;
    const id = row.dataset.channelId;
    const actEl = e.target.closest('[data-act]');
    if (!actEl || !id) return;
    const act = actEl.dataset.act;
    if (act === 'logs') {
      openChannelLogs(id);
      return;
    }
    if (act === 'configure') {
      openChannelMykey(id);
      return;
    }
    if (act === 'toggle') {
      if (actEl.disabled || _chanBusy) return;
      const running = actEl.classList.contains('on');
      await toggleChannel(id, running, actEl);
    }
  });
}

/* ═══════════════ 启动 ═══════════════ */
(async () => {
await loadSessions();
applyAppearance(appearance, plainUi, { persist: false });
applyTheme(theme, { persist: false });
initChatFontStepper();
applyChatFontSize(chatFontSize, { persist: false });
syncHljsTheme();
applyI18n();
updateModelChip();
renderSessionList();
loadCustomPresets();
loadHiddenBuiltins();
renderAllPresets();
if (state.activeId) setActiveSession(state.activeId);
else refreshEmptyState(null);
runLabel.textContent = t('status.connecting');
window.ga.startBridge && window.ga.startBridge();
})();

/* Conductor 页 — 直连 Conductor WS，不走 bridge session */
(function () {
  'use strict';
  const wsUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:8900/ws`;
  const FAIL_MAX = 5, RECON_BASE = 1200, RECON_MAX = 30000;
  const $ = id => document.getElementById(id);
  const t = k => (window.gaT && window.gaT(k)) || k;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const md = s => { try { return typeof marked !== 'undefined' ? marked.parse(s || '') : esc(s); } catch { return esc(s); } };
  const stripAttach = text => String(text || '')
    .replace(/\[(Image|File)\s+#\d+\]\s*/g, '')
    .replace(/[^\s]*desktop_uploads[^\s]*\s*/g, '')  // 兜底:去掉内联的本地上传路径,避免历史/回显消息把全路径甩出来
    .trim();
  const FC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  const ST_ICONS = {
    running: '<span class="collab-st-ic collab-st-ic--spin" aria-hidden="true"></span>',
    reported: '<span class="collab-st-ic collab-st-ic--ok" aria-hidden="true">✓</span>',
    paused: '<span class="collab-st-ic collab-st-ic--pause" aria-hidden="true">⏸</span>',
    failed: '<span class="collab-st-ic collab-st-ic--warn" aria-hidden="true">!</span>',
    terminated: '<span class="collab-st-ic collab-st-ic--off" aria-hidden="true">×</span>',
  };
  const ST_KEYS = { running: 'collab.stRunning', reported: 'collab.stReported', paused: 'collab.stPaused', failed: 'collab.stFailed', terminated: 'collab.stTerminated' };
  const CHIP_KEYS = ['collab.chipProgress', 'collab.chipPause', 'collab.chipSummary'];

  const S = {
    everConnected: false, reconnecting: false, serviceAvailable: false,
    messages: [], workers: [], runningCount: 0,
    conductorTyping: false, failCount: 0,
    historyReady: false, reconnectAt: 0, progressOpen: false,
  };
  let ws, connectTimer, reconnectTick, titleSeq = 0, wsGen = 0, localSeq = 0;
  const titleSeen = new Map();

  let draftEl = null;

  const scrollMsgs = () => { const a = $('collab-msgs'); if (a) a.scrollTop = a.scrollHeight; };
  const showDraft = () => S.conductorTyping && S.serviceAvailable && S.historyReady && S.messages.length > 0;

  function clearDraft() {
    if (draftEl) { draftEl.remove(); draftEl = null; }
  }

  function syncDraft() {
    const list = $('collab-msg-list');
    if (!list || list.hidden || !showDraft()) return clearDraft();
    if (!draftEl) draftEl = document.createElement('div');
    draftEl.className = 'msg system collab-msg-enter';
    draftEl.setAttribute('aria-label', t('collab.typing'));
    draftEl.innerHTML = '<div class="bubble sys"><span class="collab-wait-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>';
    list.appendChild(draftEl);
    requestAnimationFrame(scrollMsgs);
  }

  function relTime(ts) {
    if (!ts) return '';
    const ms = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(ts);
    if (!ms || Number.isNaN(ms)) return '';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 10) return t('collab.timeJust');
    if (sec < 60) return t('collab.timeSec').replace('{n}', sec);
    const min = Math.floor(sec / 60);
    if (min < 60) return t('collab.timeMin').replace('{n}', min);
    const hr = Math.floor(min / 60);
    return hr < 24 ? t('collab.timeHr').replace('{n}', hr) : t('collab.timeDay').replace('{n}', Math.floor(hr / 24));
  }

  function mapStatus(status, reply) {
    const r = (reply || '').trim();
    if (status === 'running') return 'running';
    if (status === 'failed') return 'failed';
    if (status === 'aborted') return 'terminated';
    if (status === 'stopped') return r ? 'reported' : 'paused';
    return 'paused';
  }

  function normalizeWorker(raw) {
    if (!titleSeen.has(raw.id)) titleSeen.set(raw.id, ++titleSeq);
    const ui = mapStatus(raw.status, raw.reply);
    let title = String(raw.prompt ?? '').replace(/^[\s请帮我麻烦]+/u, '').trim();
    if (!title) title = t('collab.taskFallback').replace('{n}', titleSeen.get(raw.id));
    else {
      title = (title.split(/[\n。！？.!?]/)[0] || '').trim();
      if (title.length > 18) title = title.slice(0, 18) + '…';
    }
    const reply = String(raw.reply || '').replace(/\s+/g, ' ').trim();
    let summary = reply ? (reply.length > 80 ? reply.slice(0, 80) + '…' : reply) : t(ui === 'running' ? 'collab.summaryRunning' : 'collab.summaryWait');
    return { id: raw.id, title, status: ui, summary, fullReply: raw.reply || '', updatedAt: raw.updated_at };
  }

  function syncProgressToggle() {
    const btn = $('collab-progress-toggle'), body = $('collab-body');
    if (!btn || !body) return;
    const split = body.classList.contains('collab-body--split');
    btn.hidden = !split;
    body.classList.toggle('collab-progress-open', split && S.progressOpen);
  }

  function setConnUi() {
    const off = $('collab-offline'), recon = $('collab-reconnect'), inp = $('collab-input'), btn = $('collab-send');
    const avail = S.serviceAvailable;
    const trying = !avail && !S.everConnected && S.failCount < FAIL_MAX;
    if (off) off.hidden = avail || S.reconnecting || trying;
    if (recon) {
      recon.hidden = !S.reconnecting;
      recon.textContent = S.reconnecting && S.reconnectAt > Date.now()
        ? t('collab.reconnect') + ' ' + t('collab.reconnectIn').replace('{n}', Math.ceil((S.reconnectAt - Date.now()) / 1000))
        : t('collab.reconnect');
    }
    if (inp) inp.contentEditable = avail ? 'true' : 'false';  // div 无 .disabled，改切 contentEditable
    if (btn) btn.disabled = !avail;
    syncDraft();
    syncProgressToggle();
  }

  let cardMenu = null;
  function hideCardMenu() { if (cardMenu) { cardMenu.remove(); cardMenu = null; } }
  function showCardMenu(x, y, sid) {
    hideCardMenu();
    cardMenu = document.createElement('div');
    cardMenu.className = 'ctx-menu';
    cardMenu.style.left = x + 'px';
    cardMenu.style.top = y + 'px';
    cardMenu.innerHTML = `<div class="ctx-item danger">${GA_ICON('trash')}${esc(t('ctx.del'))}</div>`;
    cardMenu.querySelector('.ctx-item').onclick = (e) => {
      e.stopPropagation();
      fetch(`http://${location.hostname}:8900/subagent/${sid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'kill' }) });
      hideCardMenu();
    };
    document.body.appendChild(cardMenu);
    setTimeout(() => document.addEventListener('mousedown', (e) => { if (!cardMenu?.contains(e.target)) hideCardMenu(); }, { once: true }), 0);
  }

  let drawerEl = null;
  function closeWorkerDrawer() { if (drawerEl) { drawerEl.remove(); drawerEl = null; } }
  function openWorkerDrawer(w) {
    closeWorkerDrawer();
    drawerEl = document.createElement('div');
    drawerEl.className = 'collab-drawer-wrap';
    drawerEl.innerHTML = `<div class="collab-drawer-backdrop"></div><aside class="collab-drawer"><div class="collab-drawer-head"><span class="collab-drawer-title">${esc(w.title)}</span><button class="modal-x collab-drawer-close">${GA_ICON('x')}</button></div><div class="collab-drawer-body">${md(w.fullReply || t('collab.summaryWait'))}</div></aside>`;
    drawerEl.querySelector('.collab-drawer-backdrop').onclick = closeWorkerDrawer;
    drawerEl.querySelector('.collab-drawer-close').onclick = closeWorkerDrawer;
    document.body.appendChild(drawerEl);
  }

  function renderWorkers() {
    const box = $('collab-workers'), empty = $('collab-progress-empty');
    if (!box) return;
    if (empty) empty.hidden = S.workers.length > 0;
    box.innerHTML = S.workers.map(w => `
      <article class="collab-card collab-card--${w.status}" data-sid="${esc(w.id)}">
        <div class="collab-card-st">${ST_ICONS[w.status] || ''}<span class="collab-dot"></span>${esc(t(ST_KEYS[w.status] || 'collab.stPaused'))}${w.updatedAt ? `<span class="collab-card-time">${esc(relTime(w.updatedAt))}</span>` : ''}</div>
        <div class="collab-card-title">${esc(w.title)}</div>
        <div class="collab-card-sum">${esc(w.summary)}</div>
      </article>`).join('');
    box.querySelectorAll('.collab-card').forEach(el => {
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        showCardMenu(e.clientX, e.clientY, el.dataset.sid);
      });
      el.addEventListener('click', () => {
        const w = S.workers.find(w => w.id === el.dataset.sid);
        if (w) openWorkerDrawer(w);
      });
    });
    const running = S.workers.filter(w => w.status === 'running').length;
    S.runningCount = running;
    document.dispatchEvent(new CustomEvent('collab:running-count', { detail: { count: running } }));
    const sticky = $('collab-sticky');
    if (sticky) { sticky.hidden = !running; sticky.textContent = t('collab.sticky').replace('{n}', running); }
    const stats = $('collab-progress-stats');
    if (stats) {
      const has = S.workers.length > 0;
      stats.hidden = !has;
      if (has) stats.textContent = t('collab.progressStats')
        .replace('{running}', running)
        .replace('{done}', S.workers.filter(w => w.status === 'reported').length)
        .replace('{issue}', S.workers.filter(w => w.status === 'failed' || w.status === 'terminated').length);
    }
  }

  function renderUserMsg(item) {
    const sub = n => (window.gaFileSubLabel && window.gaFileSubLabel(n)) || n;
    const imgs = (item.images || []).map(im => `<img src="${esc(im.dataUrl || '')}" alt="">`).join('');
    const files = (item.files || []).map(f => {
      const name = f.name || 'file';
      return `<div class="file-chip" data-path="${esc(f.path || '')}" data-name="${esc(name)}"><span class="fc-icon">${FC_SVG}</span><span class="fc-meta"><span class="fc-name">${esc(name)}</span><span class="fc-sub">${esc(sub(name))}</span></span></div>`;
    }).join('');
    const chipText = window.gaRenderMsgChips
      ? window.gaRenderMsgChips(item.msg, (kind, n) => {
          const hit = (kind === 'Image' ? (item.images || []) : (item.files || [])).find(x => x.sid === n);
          return hit && (hit.name || '');
        })
      : esc(stripAttach(item.msg));
    const text = chipText ? `<div class="bubble">${chipText}</div>` : '';
    return `<div class="msg user collab-msg-enter"><div class="user-stack">${files ? `<div class="user-files">${files}</div>` : ''}${imgs ? `<div class="user-imgs">${imgs}</div>` : ''}${text}</div></div>`;
  }

  function renderMsg(item) {
    if (item.role === 'user') return renderUserMsg(item);
    if (item.role === 'conductor') return `<div class="msg assistant collab-msg-enter"><div class="bubble md">${md(item.msg)}</div></div>`;
    return `<div class="msg system collab-msg-enter"><div class="bubble sys">${esc(item.msg)}</div></div>`;
  }

  function syncLayout() {
    const body = $('collab-body');
    if (!body) return;
    body.classList.toggle('collab-body--split', S.historyReady && S.messages.length > 0);
    syncProgressToggle();
  }

  function syncMessages() {
    const area = $('collab-msgs'), welcome = $('collab-welcome'), list = $('collab-msg-list'), head = $('collab-chat-head');
    if (!area || !list) return;
    if (!S.historyReady) {
      area.classList.remove('has-msgs');
      if (welcome) welcome.hidden = true;
      if (head) head.hidden = true;
      list.hidden = true;
      return syncLayout();
    }
    const has = S.messages.length > 0;
    area.classList.toggle('has-msgs', has);
    if (welcome) welcome.hidden = has;
    if (head) head.hidden = !has;
    list.hidden = !has;
    list.innerHTML = S.messages.map(renderMsg).join('');
    syncDraft();
    scrollMsgs();
    syncLayout();
  }

  function pushMsg(item) {
    if (item.id && S.messages.some(m => m.id === item.id)) return;
    if (item.role === 'user') {
      const plain = stripAttach(item.msg);
      const expand = window.gaExpandFilePlaceholders;
      for (let i = S.messages.length - 1; i >= 0; i--) {
        const m = S.messages[i];
        // 服务端回显的 msg 是 expand(本地文本)（附件被展开成了本地路径），和本地乐观消息其实是同一条。
        // 命中后保留本地那条的干净显示（占位符 msg + 结构化 files/images 卡片），只补服务端 id/ts，
        // 丢弃带路径的回显文本 —— 既去重、又不丢卡片、不外露本地路径，与 chat 显示一致。
        if (m._local && m.role === 'user' &&
            (stripAttach(m.msg) === plain || m.msg === item.msg || (expand && expand(m.msg) === item.msg))) {
          m.id = item.id || m.id;
          if (item.ts != null) m.ts = item.ts;
          if (item.read != null) m.read = item.read;
          m._local = false;
          syncMessages();
          setConnUi();
          return;
        }
      }
    }
    S.messages.push(item);
    if (item.role === 'conductor') S.conductorTyping = false;
    syncMessages();
    setConnUi();
  }

  function setWorkers(rawList) {
    S.workers = (rawList || []).map(normalizeWorker);
    renderWorkers();
    syncLayout();
  }

  function onWsData(data, gen) {
    if (gen !== wsGen) return;
    if (data.type === 'hello') {
      S.historyReady = true;
      S.messages = (data.chat || []).map(raw => ({ id: raw.id, role: raw.role || 'system', msg: raw.msg || '', ts: raw.ts, read: raw.read, files: raw.files || [], images: raw.images || [] }));
      S.conductorTyping = !!data.running;
      setWorkers(data.subagents || []);
      syncMessages();
      setConnUi();
    } else if (data.type === 'subagents') setWorkers(data.items || []);
    else if (data.type === 'chat') pushMsg({ id: data.item.id, role: data.item.role || 'system', msg: data.item.msg || '', ts: data.item.ts, read: data.item.read, files: data.item.files || [], images: data.item.images || [] });
  }

  function resetWs() {
    wsGen++;
    if (!ws) return;
    const old = ws;
    ws = null;
    old.onopen = old.onclose = old.onerror = old.onmessage = null;
    try { old.close(); } catch {}
  }

  function scheduleReconnect() {
    clearTimeout(connectTimer);
    clearInterval(reconnectTick);
    if (!S.everConnected && S.failCount >= FAIL_MAX) {
      S.reconnecting = false;
      return setConnUi();
    }
    const delay = Math.min(RECON_MAX, RECON_BASE * Math.pow(2, Math.max(0, S.failCount - 1)));
    S.reconnectAt = Date.now() + delay;
    S.reconnecting = S.everConnected;
    setConnUi();
    reconnectTick = setInterval(() => { if (!S.reconnecting) clearInterval(reconnectTick); else setConnUi(); }, 500);
    connectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(connectTimer);
    clearInterval(reconnectTick);
    const gen = ++wsGen;
    setConnUi();
    let sock;
    try { sock = new WebSocket(wsUrl()); } catch (e) {
      if (gen !== wsGen) return;
      S.failCount++;
      return scheduleReconnect();
    }
    ws = sock;
    sock.onopen = () => {
      if (gen !== wsGen) return;
      S.everConnected = true;
      S.serviceAvailable = true;
      S.reconnecting = false;
      S.failCount = 0;
      setConnUi();
    };
    sock.onclose = (ev) => {
      if (gen !== wsGen) return;
      S.serviceAvailable = false;
      if (S.everConnected) S.reconnecting = true;
      else S.failCount++;
      setConnUi();
      scheduleReconnect();
    };
    sock.onerror = () => {};
    sock.onmessage = ev => {
      if (gen !== wsGen) return;
      try { onWsData(JSON.parse(ev.data), gen); } catch {}
    };
  }

  function sendText(rawText) {
    const text = (rawText || '').trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return false;
    const expand = window.gaExpandFilePlaceholders || (s => s);
    const collect = window.gaCollectUsedFiles || (() => []);
    const clearUsed = window.gaClearUsedPendingFiles || (() => {});
    const used = collect(text);
    const images = [], files = [];
    for (const f of used) (f.isImage ? images : files).push(f.isImage ? { path: f.path, dataUrl: f.dataUrl, name: f.name, sid: f.sid } : { path: f.path, name: f.name, sid: f.sid });
    S.messages.push({ id: `_local_${++localSeq}`, _local: true, role: 'user', msg: text, ts: Date.now() / 1000, images, files });
    S.conductorTyping = true;
    syncMessages();
    ws.send(JSON.stringify({ msg: expand(text), files, images }));
    clearUsed(text);
    const inp = $('collab-input');
    if (inp && window.gaComposerText && window.gaComposerText('collab').trim() === text) inp.innerHTML = '';
    setConnUi();
    return true;
  }

  function buildChips() {
    const box = $('collab-chips');
    if (box) box.innerHTML = CHIP_KEYS.map(k => `<button type="button" class="chip sm collab-chip" data-text-key="${k}">${esc(t(k))}</button>`).join('');
  }

  $('collab-send')?.addEventListener('click', () => sendText(window.gaComposerText ? window.gaComposerText('collab') : ''));
  $('collab-retry')?.addEventListener('click', () => { S.failCount = 0; S.reconnecting = false; resetWs(); connect(); });
  $('collab-input')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendText(window.gaComposerText ? window.gaComposerText('collab') : ''); } });
  $('collab-chips')?.addEventListener('click', e => { const k = e.target.closest('.collab-chip')?.dataset.textKey; if (k) sendText(t(k)); });
  $('collab-progress-toggle')?.addEventListener('click', () => { S.progressOpen = !S.progressOpen; syncProgressToggle(); });
  document.querySelector('[data-page="collab"]')?.addEventListener('click', e => {
    if (!S.progressOpen || e.target.closest('.collab-progress') || e.target.closest('#collab-progress-toggle')) return;
    S.progressOpen = false;
    syncProgressToggle();
  });

  window.collabInit = () => {
    window.gaSetActiveFileComposer?.('collab');
    buildChips();
    syncMessages();
    setConnUi();
    renderWorkers();
    connect();
  };
  window.collabFocus = () => $('collab-input')?.focus();
  window.collabRetranslate = () => { buildChips(); renderWorkers(); syncMessages(); setConnUi(); };
})();
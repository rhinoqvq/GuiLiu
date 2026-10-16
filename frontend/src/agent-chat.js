import { createChatHistory, validChatMessage, validSessionId, historySendBlocked } from './agent-history.js';
import { CHART_TYPES, createSseParser, emptyCanvas, reduceCanvas, renderableCanvas, validateEvent } from './agent-protocol.js';
import { extractVisualPayloads, visualMessage, visualPanelsFromPayload } from './utils.js';
import { agentText } from './agent-copy.js';

const id = (prefix) => prefix + '_' + crypto.randomUUID();
const stamp = () => new Date().toISOString();
export const agentCacheKey = (base) => 'abk-agent-session-v1:' + encodeURIComponent(String(base).replace(/\/+$/, ''));

export function structuredPrompt(body) {
  return [body.message, 'Reply in ' + ({ zh: 'Simplified Chinese', ja: 'Japanese', en: 'English' }[body.language] || 'English') + '.',
    'Page context is a query hint, not verified data. Explicit dates and currency in the user question take precedence. Query real data with the registered tools; use show_chart for visual output, not JSON code blocks. Never mix native currencies. If an account filter is unsupported, say so instead of implying it was applied.',
    JSON.stringify(body.context)].join('\n\n');
}

export function createAgentChat({ state, api, storage = localStorage, changed, onCanvas, onReply = () => {}, notify, legacyPrompt, context }) {
  let key = '';
  let service = '';
  let sessionId = '';
  let pending = null;
  let active = false;
  let preferredTransport = 'auto';
  let storageWarned = false;
  let flushTimer;
  let draftTimer;
  let historyStore;
  const getSessionMeta = sid => {
    try { return JSON.parse(storage.getItem(key + ':server-meta:' + sid)); }
    catch { return null; }
  };
  const cacheSessionMeta = (meta, source = service, renamed = false) => {
    try {
      const prefix = agentCacheKey(source);
      storage.setItem(prefix + ':server-meta:' + meta.session_id, JSON.stringify(meta));
      if (renamed) storage.removeItem(prefix + ':title:' + meta.session_id);
    } catch { /* A confirmed server update must not fail because its optional cache is full. */ }
  };
  const text = (key) => agentText(state.settings.language, key);
  const presentReply = (answer) => {
    try { onReply(answer); } catch { /* A visual effect must not turn a successful task into a retry. */ }
  };
  const persist = () => {
    clearTimeout(flushTimer);
    clearTimeout(draftTimer);
    if (!key) return;
    const messages = state.agentMessages.filter(validChatMessage);
    try {
      storage.setItem(key + ':selection', JSON.stringify({ sessionId, isNew: state.agentHistory?.isNew === true }));
      storage.setItem(key + ':draft:' + sessionId, state.agentDraft || '');
      const snapshot = JSON.stringify({ version: 1, sessionId, messages,
        canvas: state.agentCanvas, canvasAt: state.agentCanvasAt, draft: state.agentDraft || '', pending,
        isNew: state.agentHistory?.isNew === true, legacyVisuals: state.agentVisuals, removal: state.agentHistory?.removal || null });
      storage.setItem(key, snapshot);
      storage.setItem(key + ':session:' + sessionId, snapshot);
    } catch {
      if (!storageWarned) { notify(text('storage'), 'error'); storageWarned = true; }
    }
  };
  const emit = (immediate = false) => {
    changed();
    clearTimeout(flushTimer);
    if (immediate) persist(); else flushTimer = setTimeout(persist, 250);
  };
  const switchService = () => {
    const nextKey = agentCacheKey(state.settings.agentPath);
    if (nextKey === key || active) return;
    const first = !key;
    if (key) persist();
    key = nextKey; service = state.settings.agentPath; pending = null; preferredTransport = 'auto';
    let stored;
    try { stored = JSON.parse(storage.getItem(key)); } catch { /* Start a fresh session if storage is damaged. */ }
    try {
      const selection = JSON.parse(storage.getItem(key + ':selection'));
      if (validSessionId(selection?.sessionId) && selection.sessionId !== stored?.sessionId) {
        stored = { ...JSON.parse(storage.getItem(key + ':session:' + selection.sessionId)), version: 1, ...selection };
      }
    } catch { /* Old versions store the selection in the main cache. */ }
    sessionId = stored?.version === 1 && /^[A-Za-z0-9_-]{1,80}$/.test(stored.sessionId) ? stored.sessionId : id('session');
    state.agentMessages = (Array.isArray(stored?.messages) ? stored.messages : first ? state.agentMessages : []).filter(validChatMessage);
    state.agentCanvas = emptyCanvas(); state.agentCanvasAt = null;
    state.agentVisuals = []; state.agentNotice = ''; state.agentDraft = typeof stored?.draft === 'string' ? stored.draft.slice(0, 20000) : '';
    try { state.agentDraft = storage.getItem(key + ':draft:' + sessionId) ?? state.agentDraft; } catch { /* Cache is optional. */ }
    if (stored?.canvasAt) {
      try {
        state.agentCanvas = stored.canvas?.charts?.length ? reduceCanvas(emptyCanvas(), stored.canvas) : emptyCanvas();
        state.agentCanvasAt = stored.canvasAt;
        state.agentVisuals = Array.isArray(stored.legacyVisuals) ? stored.legacyVisuals.slice(0, 8) : [];
      } catch { state.agentNotice = text('invalidCanvas'); }
    }
    for (const message of state.agentMessages) {
      if (!message.canvas) continue;
      try { message.canvas = message.canvas.charts?.length ? reduceCanvas(emptyCanvas(), message.canvas) : emptyCanvas(); }
      catch { delete message.canvas; }
    }
    if (stored?.pending?.body?.session_id === sessionId && state.agentMessages.some((message) => message.requestId === stored.pending.body.request_id)) {
      pending = stored.pending;
      if (pending.status === 'running') pending.status = 'interrupted';
      if (pending.status === 'interrupted') {
        const message = answerMessage();
        message.errorKey = pending.mode === 'stream' ? 'interrupted' : 'nonResumable'; message.transport = pending.mode; message.retryable = true;
      }
    }
    state.agentLoading = false;
    historyStore?.reset({ hadSelection: validSessionId(stored?.sessionId), isNew: stored?.isNew === true, removal: stored?.removal });
  };
  const answerMessage = () => {
    let message = state.agentMessages.find((item) => item.role === 'assistant' && item.requestId === pending.body.request_id);
    if (!message) {
      message = { id: pending.messageId || id('assistant'), role: 'assistant', content: '', timestamp: stamp(), requestId: pending.body.request_id };
      state.agentMessages.push(message);
    }
    return message;
  };
  const acceptCanvas = (canvas, auto = false) => {
    if (!canvas) return;
    try {
      const next = reduceCanvas(state.agentCanvas, canvas);
      if (next !== state.agentCanvas) {
        state.agentCanvas = next; state.agentCanvasAt = stamp(); state.agentVisuals = []; state.agentNotice = '';
        answerMessage().canvas = structuredClone(next);
        emit(true);
        if (auto && renderableCanvas(next) && !pending.presented) {
          pending.presented = true;
          onCanvas(pending.body);
        }
      }
    } catch { state.agentNotice = text('invalidCanvas'); emit(); }
  };
  const finalResult = (result, serverAssigned = false) => {
    if (!result || result.schema_version !== 1 || result.session_id !== sessionId || (!serverAssigned && result.request_id !== pending.body.request_id)
      || typeof result.request_id !== 'string' || !result.request_id || result.request_id.length > 120
      || typeof result.message_id !== 'string' || !result.message_id || result.message_id.length > 120
      || !Number.isSafeInteger(result.turn_id) || result.turn_id < 0 || !Number.isFinite(Date.parse(result.created_at))
      || typeof result.answer !== 'string' || result.answer.length > 200000 || (!serverAssigned && pending.messageId && result.message_id !== pending.messageId)) throw new Error(text('invalidReply'));
    const answer = answerMessage();
    if (serverAssigned) {
      pending.serverRequestId = result.request_id;
      pending.messageId = result.message_id; pending.turnId = result.turn_id;
      answer.serverRequestId = result.request_id; answer.turnId = result.turn_id; answer.id = result.message_id;
      answer.timestamp = result.created_at;
    }
    answer.content = result.answer;
    answer.retryable = false; delete answer.errorKey;
    if (pending.mode !== 'stream') presentReply(answer);
    acceptCanvas(result.canvas, serverAssigned);
    pending.status = 'complete';
  };
  const receive = (frame) => {
    if (!['turn.started', 'canvas.updated', 'assistant.message', 'turn.completed', 'turn.failed'].includes(frame.event)) return;
    const event = JSON.parse(frame.data);
    if (!validateEvent(event, pending.body)) return;
    if (frame.id && frame.id !== event.event_id) throw new Error(text('invalidReply'));
    if (event.sequence <= pending.sequence) return;
    if (pending.messageId && (event.message_id !== pending.messageId || event.turn_id !== pending.turnId)) throw new Error(text('invalidReply'));
    if (pending.status !== 'running') return;
    pending.messageId = event.message_id; pending.turnId = event.turn_id;
    answerMessage().id = event.message_id;
    if (frame.event === 'canvas.updated') {
      const presentation = event.payload.presentation;
      acceptCanvas(event.payload.canvas, !pending.resuming && presentation?.target === 'agent_workspace' && presentation.reason === 'chart_tool');
    } else if (frame.event === 'assistant.message') {
      const answer = answerMessage();
      const content = event.payload.content ?? event.payload.answer ?? event.payload.text;
      if (typeof event.payload.delta === 'string') answer.content += event.payload.delta;
      else if (typeof content === 'string') answer.content = content;
      else throw new Error(text('invalidReply'));
      if (answer.content.length > 200000) throw new Error(text('invalidReply'));
    } else if (frame.event === 'turn.completed') {
      finalResult(event.payload.result || event.payload);
    } else if (frame.event === 'turn.failed') {
      pending.status = 'failed';
      const answer = answerMessage(); answer.errorKey = 'failed'; answer.retryable = false;
      // Only display the public error field, never tool output or a stack trace.
      const error = event.payload.error;
      answer.publicError = typeof error === 'string' ? error.slice(0, 1000) : typeof error?.message === 'string' ? error.message.slice(0, 1000) : '';
    }
    pending.sequence = event.sequence;
    emit(pending.status !== 'running');
  };
  const deliverText = (result) => {
    const raw = typeof result === 'string' ? result : result?.answer ?? result?.message ?? result?.text ?? result?.content;
    if (typeof raw !== 'string') throw new Error(text('invalidReply'));
    const payloads = extractVisualPayloads(raw);
    const panels = payloads.flatMap(visualPanelsFromPayload).slice(0, 8);
    const answer = answerMessage();
    answer.content = visualMessage(raw, payloads) || text('complete');
    delete answer.errorKey; answer.retryable = false;
    presentReply(answer);
    if (panels.length) {
      state.agentVisuals = panels; state.agentCanvas = emptyCanvas(); state.agentCanvasAt = stamp();
      answer.legacyVisuals = panels;
      if (!pending.presented) { pending.presented = true; onCanvas(pending.body); }
    }
    pending.status = 'complete';
  };
  const runLegacy = async () => {
    pending.mode = 'legacy'; persist();
    const response = await api.sendAgent(pending.legacyPrompt, sessionId, pending.service, pending.body.message);
    acceptSession(response);
    const result = response && Object.prototype.hasOwnProperty.call(response, 'result') ? response.result : response;
    if (result?.schema_version === 1) finalResult(result, true); else deliverText(result);
  };
  const runStructured = async (signal) => {
    pending.mode = 'structured'; preferredTransport = 'structured'; persist();
    const response = await api.sendStructuredAgent(structuredPrompt(pending.body), sessionId, pending.service, signal, pending.body.message);
    acceptSession(response);
    const result = response && Object.prototype.hasOwnProperty.call(response, 'result') ? response.result : response;
    if (result?.schema_version === 1) finalResult(result, true); else deliverText(result);
  };
  const acceptSession = (response) => {
    if (!response?.session_id) return;
    if (!validSessionId(response.session_id)) throw new Error(text('invalidReply'));
    sessionId = response.session_id; pending.body.session_id = sessionId;
    state.agentHistory.sessionId = sessionId;
  };
  // While the reply is pending, ask the Agent once a second what it is doing, for the status line.
  const watchSteps = () => {
    if (typeof api.chatActivity !== 'function') return () => {};
    let busy = false, stopped = false;
    const poll = async () => {
      if (stopped || busy || !sessionId) return;
      busy = true;
      try {
        const step = (await api.chatActivity(sessionId, undefined, pending.service))?.result;
        if (!stopped) { state.agentStep = ['thinking', 'tool'].includes(step?.phase) ? step : null; changed(); }
      } catch (error) {
        if (error?.status === 404) stopped = true;   // an older Agent without the activity endpoint
      } finally { busy = false; }
    };
    const timer = setInterval(poll, 1000);
    return () => { stopped = true; clearInterval(timer); state.agentStep = null; };
  };
  const run = async () => {
    active = true; state.agentLoading = true; pending.status = 'running';
    const answer = answerMessage(); delete answer.errorKey; delete answer.publicError; answer.retryable = false;
    emit(true);
    const stopSteps = watchSteps();
    let reader;
    const abort = new AbortController();
    let idle = setTimeout(() => abort.abort(), pending.mode === 'stream' ? 90000 : 300000);
    const heartbeat = () => { clearTimeout(idle); idle = setTimeout(() => abort.abort(), 90000); };
    try {
      if (pending.mode === 'auto') {
        pending.mode = typeof api.discoverAgentTransport === 'function' ? await api.discoverAgentTransport(abort.signal, pending.service) : 'stream';
        preferredTransport = pending.mode;
        if (pending.mode === 'stream') heartbeat();
        persist();
      }
      if (pending.mode === 'legacy') await runLegacy();
      else if (pending.mode === 'structured') await runStructured(abort.signal);
      else {
        const response = await api.openAgentStream({ ...pending.body, resume_after_sequence: pending.sequence || null }, abort.signal, pending.service);
        if ([404, 405, 501].includes(response.status) && !pending.sequence && !pending.resuming) {
          await response.body?.cancel(); clearTimeout(idle);
          idle = setTimeout(() => abort.abort(), 300000);
          await runStructured(abort.signal);
        } else {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error(text('invalidReply'));
          reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8', { fatal: true });
          const parser = createSseParser(receive);
          while (pending.status === 'running') {
            const { done, value } = await reader.read();
            heartbeat();
            if (done) { parser.push(decoder.decode()); parser.finish(); break; }
            parser.push(decoder.decode(value, { stream: true }));
          }
          if (pending.status === 'running') throw new Error(text('interrupted'));
        }
      }
    } catch (error) {
      pending.status = 'interrupted';
      const answer = answerMessage(); answer.errorKey = pending.mode === 'stream' ? 'interrupted' : 'nonResumable'; answer.retryable = true; answer.transport = pending.mode;
      answer.publicError = String(error.message || '').slice(0, 1000);
      if (error.status === 409 && /waiting.*insight reply|reply endpoint/i.test(answer.publicError)) {
        state.agentHistory.remoteWaiting = true;
        pending.status = 'waiting_reply'; answer.retryable = false; answer.errorKey = 'waitingUser';
      }
    } finally {
      clearTimeout(idle);
      stopSteps();
      try { await reader?.cancel(); } catch { /* A disconnected stream is already closed. */ }
      active = false; state.agentLoading = false; emit(true);
      if (agentCacheKey(state.settings.agentPath) !== key) { switchService(); emit(); void historyStore.open(); }
      else await historyStore.reconcile();
    }
  };
  const send = async (message) => {
    if (active || historySendBlocked(state) || !message.trim()) return;
    switchService();
    historyStore.sent();
    const requestId = id('req');
    const prompt = legacyPrompt(message);
    state.agentMessages.forEach((item) => { item.retryable = false; });
    pending = { body: { session_id: sessionId, request_id: requestId, message, language: state.settings.language,
      context: structuredClone(context()), capabilities: { canvas_version: 1, chart_types: [...CHART_TYPES] } },
      sequence: 0, mode: preferredTransport, status: 'running', presented: false, resuming: false, legacyPrompt: prompt, service: state.settings.agentPath };
    state.agentDraft = '';
    state.agentMessages.push({ id: id('user'), role: 'user', content: message, timestamp: stamp(), requestId });
    return run();
  };
  const retry = async (messageId) => {
    if (!active && agentCacheKey(state.settings.agentPath) !== key) { switchService(); emit(); return; }
    if (active || historySendBlocked(state) || !pending || pending.status !== 'interrupted') return;
    const answer = state.agentMessages.find((item) => item.id === messageId);
    if (answer?.requestId !== pending.body.request_id) return;
    historyStore.sent();
    pending.resuming = pending.mode === 'stream';
    return run();
  };
  const clear = () => {
    if (active || state.agentHistory.removal?.pending || state.agentHistory.rename?.saving) return false;
    persist();
    pending = null; sessionId = id('session'); state.agentMessages = []; state.agentVisuals = [];
    state.agentCanvas = emptyCanvas(); state.agentCanvasAt = null; state.agentNotice = ''; state.agentDraft = '';
    historyStore.reset({ isNew: true, keepList: true }); emit(true); return true;
  };
  const history = (messageId) => {
    if (active) return;
    const message = state.agentMessages.find((item) => item.id === messageId);
    if (!message) return;
    if (message.canvas) state.agentCanvas = structuredClone(message.canvas);
    else state.agentCanvas = emptyCanvas();
    state.agentVisuals = message.legacyVisuals || []; state.agentCanvasAt = message.timestamp; emit(true);
  };
  const activate = (nextSession) => {
    sessionId = nextSession; pending = null;
    let stored;
    try { stored = JSON.parse(storage.getItem(key + ':session:' + sessionId)); } catch { /* Cache is optional. */ }
    state.agentMessages = (Array.isArray(stored?.messages) ? stored.messages : []).filter(validChatMessage);
    state.agentDraft = typeof stored?.draft === 'string' ? stored.draft : '';
    try { state.agentDraft = storage.getItem(key + ':draft:' + sessionId) ?? state.agentDraft; } catch { /* Cache is optional. */ }
    state.agentCanvas = emptyCanvas(); state.agentCanvasAt = null; state.agentVisuals = []; state.agentNotice = '';
    if (stored?.canvasAt) {
      try {
        state.agentCanvas = stored.canvas?.charts?.length ? reduceCanvas(emptyCanvas(), stored.canvas) : emptyCanvas();
        state.agentCanvasAt = stored.canvasAt;
        state.agentVisuals = Array.isArray(stored.legacyVisuals) ? stored.legacyVisuals : [];
      } catch { state.agentNotice = text('invalidCanvas'); }
    }
  };
  const forget = (deletedId, deletedService) => {
    const deletedKey = agentCacheKey(deletedService), wasCurrent = deletedKey === key && deletedId === sessionId;
    if (wasCurrent) {
      clearTimeout(flushTimer); clearTimeout(draftTimer);
      pending = null; sessionId = id('session'); state.agentMessages = []; state.agentVisuals = [];
      state.agentCanvas = emptyCanvas(); state.agentCanvasAt = null; state.agentNotice = ''; state.agentDraft = '';
    }
    try {
      storage.removeItem(deletedKey + ':session:' + deletedId);
      storage.removeItem(deletedKey + ':draft:' + deletedId);
      storage.removeItem(deletedKey + ':title:' + deletedId);
      storage.removeItem(deletedKey + ':server-meta:' + deletedId);
      for (const suffix of ['', ':selection']) {
        const cacheKey = deletedKey + suffix;
        let cached;
        try { cached = JSON.parse(storage.getItem(cacheKey)); } catch { continue; }
        if (cached?.sessionId === deletedId) storage.removeItem(cacheKey);
        else if (cached?.removal?.sessionId === deletedId) { cached.removal = null; storage.setItem(cacheKey, JSON.stringify(cached)); }
      }
    } catch { notify(text('storage'), 'error'); }
    return wasCurrent;
  };
  historyStore = createChatHistory({ state, api, getSession: () => sessionId, getService: () => service,
    getPending: () => pending, getSessionMeta, cacheSessionMeta, isSending: () => active, activate, forget, persist, changed });
  switchService();
  return { send, retry, clear, history, persist, switchService, sessions: historyStore,
    saveDraft() {
      clearTimeout(draftTimer);
      const draftKey = key + ':draft:' + sessionId, value = state.agentDraft || '';
      draftTimer = setTimeout(() => { try { storage.setItem(draftKey, value); } catch { /* Full cache persistence reports storage errors. */ } }, 250);
    },
    get pending() { return pending; }, get sessionId() { return sessionId; } };
}

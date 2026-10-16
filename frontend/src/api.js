import { DEFAULT_SETTINGS } from "./config.js";
import { normalizeServiceBase } from "./utils.js";

export class ApiClient {
  constructor(settingsProvider) {
    this.settingsProvider = settingsProvider;
  }

  settings() {
    return {
      ...DEFAULT_SETTINGS,
      ...(typeof this.settingsProvider === "function" ? this.settingsProvider() : {}),
    };
  }

  backendBase() {
    const configured = normalizeServiceBase(this.settings().backendPath, DEFAULT_SETTINGS.backendPath);
    return /^https?:\/\//i.test(configured) ? "/backend" : configured;
  }

  agentBase() {
    const configured = normalizeServiceBase(this.settings().agentPath, DEFAULT_SETTINGS.agentPath);
    return /^https?:\/\//i.test(configured) ? "/agent" : configured;
  }

  async request(path, { expectedStatus, ...options } = {}) {
    const headers = new Headers(options.headers || {});
    const settings = this.settings();
    const backend = normalizeServiceBase(settings.backendPath, DEFAULT_SETTINGS.backendPath);
    const agent = normalizeServiceBase(settings.agentPath, DEFAULT_SETTINGS.agentPath);

    if (String(path).startsWith("/backend") && /^https?:\/\//i.test(backend)) {
      headers.set("x-target-base", backend);
    }
    if (String(path).startsWith("/agent") && /^https?:\/\//i.test(agent)) {
      headers.set("x-target-base", agent);
    }

    const response = await fetch(path, {
      ...options,
      headers,
    });
    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { success: false, result: raw, status_code: response.status };
    }

    if (!response.ok) {
      const detail = Array.isArray(data.detail) ? data.detail.map((item) => (item.loc || []).join('.') + ': ' + item.msg).join('; ') : data.detail;
      const error = new Error(data.error || detail || response.status + " " + response.statusText);
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    if (data && typeof data === "object" && data.success === false) {
      const error = new Error(data.error || "Request failed (" + (data.status_code || response.status) + ")");
      error.status = Number(data.status_code || response.status);
      error.payload = data;
      throw error;
    }
    if (expectedStatus != null && response.status !== expectedStatus) {
      const error = new Error('Unexpected response status');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  shutdownServices(backendPath = this.settings().backendPath, { signal } = {}) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    const deadline = AbortSignal.timeout(15000);
    return client.request(client.backendBase() + '/system/shutdown', {
      method: 'POST', expectedStatus: 202,
      headers: { 'Content-Type': 'application/json', 'X-Guiliu-Control': 'shutdown' },
      body: JSON.stringify({ confirm: true }),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  }

  listDeals() {
    return this.request(this.backendBase() + "/DB/dealing-data");
  }

  updateUserProfile(change, { signal } = {}) {
    return this.request(this.backendBase() + '/user/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  }

  getUserProfile({ signal } = {}) {
    return this.request(this.backendBase() + '/user/profile', { cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  }


  getFullMailImport(backendPath = this.settings().backendPath, { signal } = {}) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    const deadline = AbortSignal.timeout(15000);
    return client.request(client.backendBase() + '/mail-imports/full', { cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  }

  startFullMailImport(backendPath = this.settings().backendPath, { signal } = {}) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    const deadline = AbortSignal.timeout(15000);
    return client.request(client.backendBase() + '/mail-imports/full', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  }

  cancelFullMailImport(backendPath = this.settings().backendPath, { signal } = {}) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    const deadline = AbortSignal.timeout(15000);
    return client.request(client.backendBase() + '/mail-imports/full/cancel', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  }

  getUpdateStatus(refresh = false, backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/system/update' + (refresh ? '?refresh=true' : ''),
      { cache: 'no-store', signal: AbortSignal.timeout(25000) });
  }

  startUpdate(version, backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/system/update', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }), signal: AbortSignal.timeout(25000) });
  }

  restartForUpdate(backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/system/update/restart', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
  }

  getSetupMailboxes(backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/initialization/mailboxes', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  }

  // Settings → Mailboxes: connect (or renew) one mailbox, confirm the banks a new one brought, and manage its job.
  connectSetupMailbox(data, backendPath = this.settings().backendPath) {
    return this.setupMailboxAction('/connect', data, backendPath, 60000);
  }

  confirmSetupMailbox(confirmations, backendPath = this.settings().backendPath) {
    return this.setupMailboxAction('/confirm', { confirmations }, backendPath, 60000);
  }

  retrySetupMailbox(backendPath = this.settings().backendPath) { return this.setupMailboxAction('/retry', {}, backendPath); }
  cancelSetupMailbox(backendPath = this.settings().backendPath) { return this.setupMailboxAction('/cancel', {}, backendPath, 45000); }
  dismissSetupMailbox(backendPath = this.settings().backendPath) { return this.setupMailboxAction('/dismiss', {}, backendPath); }

  setupMailboxAction(path, body, backendPath, timeout = 15000) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/initialization/mailboxes' + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  }

  startFirstMailImport(backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/mail-imports/full/first', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
  }

  getRuntimeSettings(backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/settings/runtime', { signal: AbortSignal.timeout(15000) });
  }

  patchRuntimeSettings(body, backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/settings/runtime', { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  }

  getRuntimeSettings(backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/settings/runtime', { signal: AbortSignal.timeout(15000) });
  }

  patchRuntimeSettings(body, backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.request(client.backendBase() + '/settings/runtime', { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  }

  importRequest(path, options = {}) {
    const { timeout = 30000, signal, ...rest } = options;
    const deadline = AbortSignal.timeout(timeout);
    return this.request(this.backendBase() + '/imports' + path, { ...rest, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  }

  listImportPresets(options) { return this.importRequest('/presets', options); }
  getImportPreset(id, options) { return this.importRequest('/presets/' + encodeURIComponent(id), options); }
  saveImportPreset(preset, options) {
    return this.importRequest('/presets', { ...options, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preset) });
  }
  createImportPreview(body, options) { return this.importRequest('/preview', { timeout: 120000, ...options, method: 'POST', body }); }
  getImport(id, options) { return this.importRequest('/' + encodeURIComponent(id), options); }
  getImportRows(id, parameters = {}, options) {
    const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== '' && value != null));
    return this.importRequest('/' + encodeURIComponent(id) + '/rows?' + query, options);
  }
  mapImport(id, body, options) {
    return this.importRequest('/' + encodeURIComponent(id) + '/mapping', { timeout: 120000, ...options, method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  editImportRows(id, body, options) {
    return this.importRequest('/' + encodeURIComponent(id) + '/rows', { ...options, method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  commitImport(id, body, key, options) {
    return this.importRequest('/' + encodeURIComponent(id) + '/commit', { timeout: 120000, ...options, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  }

  getDeal(id) {
    return this.request(this.backendBase() + "/DB/dealing-data/" + encodeURIComponent(id));
  }

  createDeal(payload, operationId) {
    return this.request(this.backendBase() + "/DB/dealing-data", {
      method: "POST",
      headers: { "content-type": "application/json", ...(operationId ? { 'Idempotency-Key': operationId } : {}) },
      body: JSON.stringify(payload),
    });
  }

  updateDeal(id, payload, correctionMode = false, operationId) {
    const route = correctionMode ? "/DBForforntend/dealing-data/" : "/DB/dealing-data/";
    return this.request(this.backendBase() + route + encodeURIComponent(id), {
      method: "PUT",
      headers: { "content-type": "application/json", ...(operationId ? { 'Idempotency-Key': operationId } : {}) },
      body: JSON.stringify(payload),
    });
  }

  deleteDeal(id, operationId) {
    return this.request(this.backendBase() + "/DB/dealing-data/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: operationId ? { 'Idempotency-Key': operationId } : {},
    });
  }

  matchDeals(payload) {
    return this.request(this.backendBase() + "/DB/dealing-data/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  listAdrResults() {
    return this.request(this.backendBase() + "/DB/ADRresults");
  }

  updateAdrResult(dealId, itemId, payload) {
    return this.request(this.backendBase() + "/DB/ADRresults/" + encodeURIComponent(dealId) + "/" + encodeURIComponent(itemId), {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
  }

  deleteAdrResult(dealId, itemId) {
    return this.request(this.backendBase() + "/DB/ADRresults/" + encodeURIComponent(dealId) + "/" + encodeURIComponent(itemId), { method: "DELETE" });
  }

  getAdrResults(id) {
    return this.request(
      this.backendBase() + "/DB/ADRresults/DealingNumber/" + encodeURIComponent(id),
    );
  }

  runAdr(payload) {
    return this.request(this.agentBase() + "/adr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  listOcrResults() {
    return this.request(this.backendBase() + "/OCR/results");
  }

  getOcrResult(msgid) {
    return this.request(this.backendBase() + "/OCR/results/msgid/" + encodeURIComponent(msgid));
  }

  uploadOcr(file, promptInput) {
    const body = new FormData();
    body.append("promptInput", promptInput || "Extract all receipt text and line items.");
    body.append("file", file);
    return this.request(this.agentBase() + "/OCR_request", {
      method: "POST",
      body,
    });
  }

  judgeOcrIntent(payload) {
    return this.request(this.agentBase() + "/ocr-intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  listShops() {
    return this.request(this.backendBase() + "/DB/ShopName");
  }

  searchShops(payload) {
    return this.request(this.backendBase() + "/DB/ShopName/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  createShop(payload) {
    return this.request(this.backendBase() + "/DB/ShopName", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  updateShop(key, payload) {
    return this.request(this.backendBase() + "/DB/ShopName/" + encodeURIComponent(key), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  deleteShop(key) {
    return this.request(this.backendBase() + "/DB/ShopName/" + encodeURIComponent(key), {
      method: "DELETE",
    });
  }

  listUnknownShops() {
    return this.request(this.backendBase() + "/DB/UnknownShopName");
  }

  searchUnknownShops(payload) {
    return this.request(this.backendBase() + "/DB/UnknownShopName/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  updateUnknownShop(titleValue, payload) {
    return this.request(
      this.backendBase() + "/DB/UnknownShopName/" + encodeURIComponent(titleValue),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  deleteUnknownShop(titleValue) {
    return this.request(
      this.backendBase() + "/DB/UnknownShopName/" + encodeURIComponent(titleValue),
      { method: "DELETE" },
    );
  }

  listPrompts() {
    return this.request(this.agentBase() + "/prompts?language=" + encodeURIComponent(this.settings().language || 'zh'));
  }

  agentInformationRequest(path, options = {}) {
    const { signal, timeout = 15000, ...rest } = options;
    const deadline = AbortSignal.timeout(timeout);
    return this.request(this.agentBase() + path, { cache: 'no-store', ...rest,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  }
  listAutomations(options) { return this.agentInformationRequest('/automations', options); }
  getAutomation(id, options) { return this.agentInformationRequest('/automations/' + encodeURIComponent(id), options); }
  createAutomation(config, options) {
    return this.agentInformationRequest('/automations', { timeout: 120000, ...options, method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  }
  updateAutomation(id, changes, options) {
    return this.agentInformationRequest('/automations/' + encodeURIComponent(id), { ...options, method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
  }
  deleteAutomation(id, options) {
    return this.agentInformationRequest('/automations/' + encodeURIComponent(id), { ...options, method: 'DELETE' });
  }
  runAutomation(id, key, options) {
    return this.agentInformationRequest('/automations/' + encodeURIComponent(id) + '/run', { ...options, method: 'POST',
      headers: { 'Idempotency-Key': key } });
  }
  listAutomationRuns(id, parameters = {}, options) {
    return this.agentInformationRequest('/automations/' + encodeURIComponent(id) + '/runs?' + new URLSearchParams(parameters), options);
  }
  getAutomationRun(id, options) { return this.agentInformationRequest('/automation-runs/' + encodeURIComponent(id), options); }
  listAgentInsights(parameters = {}, options) {
    const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== '' && value != null));
    return this.agentInformationRequest('/insights?' + query, options);
  }
  getAgentInsight(id, options) { return this.agentInformationRequest('/insights/' + encodeURIComponent(id), options); }
  setAgentInsightRead(id, isRead, options) {
    return this.agentInformationRequest('/insights/' + encodeURIComponent(id), { ...options, method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_read: isRead }) });
  }
  setAgentInsightConfirmed(id, confirmed, options) {
    return this.agentInformationRequest('/insights/' + encodeURIComponent(id), { ...options, method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed }) });
  }
  replyAgentInsight(id, message, key, options) {
    return this.agentInformationRequest('/insights/' + encodeURIComponent(id) + '/reply', { timeout: 1800000, ...options, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ message }) });
  }

  getPrompt(name) {
    return this.request(this.agentBase() + "/prompts/" + encodeURIComponent(name) + '?language=' + encodeURIComponent(this.settings().language || 'zh'));
  }

  updatePrompt(name, payload, language = this.settings().language) {
    return this.request(this.agentBase() + "/prompts/" + encodeURIComponent(name) + '?language=' + encodeURIComponent(language || 'zh'), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  chatHistoryRequest(path, parameters = {}, signal, agentPath) {
    if (agentPath && agentPath !== this.settings().agentPath) return new ApiClient(() => ({ ...this.settings(), agentPath })).chatHistoryRequest(path, parameters, signal);
    const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value != null));
    const timeout = AbortSignal.timeout(20000);
    return this.request(this.agentBase() + '/chat/sessions' + path + '?' + query, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  listChatSessions(parameters, signal, agentPath) { return this.chatHistoryRequest('', parameters, signal, agentPath); }
  getChatHistory(sessionId, parameters, signal, agentPath) {
    return this.chatHistoryRequest('/' + encodeURIComponent(sessionId) + '/history', parameters, signal, agentPath);
  }
  // What the session's running turn is doing now: idle, thinking, or the tool it runs.
  chatActivity(sessionId, signal, agentPath) {
    return this.chatHistoryRequest('/' + encodeURIComponent(sessionId) + '/activity', {}, signal, agentPath);
  }

  deleteChatSession(sessionId, agentPath) {
    if (agentPath && agentPath !== this.settings().agentPath) return new ApiClient(() => ({ ...this.settings(), agentPath })).deleteChatSession(sessionId);
    return this.request(this.agentBase() + '/chat/sessions/' + encodeURIComponent(sessionId), {
      method: 'DELETE', signal: AbortSignal.timeout(20000),
    });
  }

  renameChatSession(sessionId, title, agentPath) {
    if (agentPath && agentPath !== this.settings().agentPath) return new ApiClient(() => ({ ...this.settings(), agentPath })).renameChatSession(sessionId, title);
    return this.request(this.agentBase() + '/chat/sessions/' + encodeURIComponent(sessionId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(20000),
    });
  }

  sendAgent(prompt, sessionId, agentPath, userMessage) {
    if (agentPath && agentPath !== this.settings().agentPath) return new ApiClient(() => ({ ...this.settings(), agentPath })).sendAgent(prompt, sessionId, undefined, userMessage);
    return this.request(this.agentBase() + "/user?" + new URLSearchParams({ prompt, language: this.settings().language || 'zh', ...(sessionId ? { session_id: sessionId } : {}), ...(userMessage != null ? { user_message: userMessage } : {}) }), {
      method: "POST",
    });
  }

  openAgentStream(body, signal, agentPath) {
    if (agentPath && agentPath !== this.settings().agentPath) return new ApiClient(() => ({ ...this.settings(), agentPath })).openAgentStream(body, signal);
    const configured = normalizeServiceBase(this.settings().agentPath, DEFAULT_SETTINGS.agentPath);
    return fetch(this.agentBase() + '/user/stream', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream',
        ...(/^https?:\/\//i.test(configured) ? { 'x-target-base': configured } : {}) },
      body: JSON.stringify(body),
    });
  }

  sendStructuredAgent(prompt, sessionId, agentPath, signal, userMessage) {
    if (agentPath && agentPath !== this.settings().agentPath) return new ApiClient(() => ({ ...this.settings(), agentPath })).sendStructuredAgent(prompt, sessionId, undefined, signal, userMessage);
    return this.request(this.agentBase() + '/user?' + new URLSearchParams({ prompt, language: this.settings().language || 'zh', session_id: sessionId, response_format: 'structured', ...(userMessage != null ? { user_message: userMessage } : {}) }), {
      method: 'POST', signal,
    });
  }

  async discoverAgentTransport(signal, agentPath) {
    if (agentPath && agentPath !== this.settings().agentPath) return new ApiClient(() => ({ ...this.settings(), agentPath })).discoverAgentTransport(signal);
    try {
      const timeout = AbortSignal.timeout(5000);
      const spec = await this.request(this.agentBase() + '/openapi.json', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (spec.paths?.['/agent/user/stream']?.post) return 'stream';
      const parameters = spec.paths?.['/agent/user']?.post?.parameters;
      if (Array.isArray(parameters)) return parameters.some((item) => item.name === 'response_format') ? 'structured' : 'legacy';
    } catch { /* A hidden OpenAPI document is not proof that the chat endpoint is unsupported. */ }
    return 'structured';
  }

  assetQuery(path, parameters = {}) {
    const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return this.request(this.backendBase() + path + (query.size ? '?' + query : ''), { signal: AbortSignal.timeout(30000) });
  }

  assetWrite(path, method, payload, operationId) {
    return this.request(this.backendBase() + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(operationId ? { 'Idempotency-Key': operationId } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  }

  listAccounts() { return this.assetQuery('/DB/accounts'); }
  getAccount(id) { return this.assetQuery('/DB/accounts/' + encodeURIComponent(id)); }
  createAccount(payload, key) { return this.assetWrite('/DB/accounts', 'POST', payload, key); }
  updateAccount(id, payload, key) { return this.assetWrite('/DB/accounts/' + encodeURIComponent(id), 'PUT', payload, key); }
  calibrateAccount(id, payload, key) { return this.assetWrite('/DB/accounts/' + encodeURIComponent(id) + '/calibrate', 'POST', payload, key); }
  accountChanges(id, query) { return this.assetQuery('/DB/accounts/' + encodeURIComponent(id) + '/changes', query); }
  listIncome(query) { return this.assetQuery('/DB/income', query); }
  createIncome(payload, key) { return this.assetWrite('/DB/income', 'POST', payload, key); }
  updateIncome(id, payload, key) { return this.assetWrite('/DB/income/' + encodeURIComponent(id), 'PUT', payload, key); }
  deleteIncome(id, key) { return this.assetWrite('/DB/income/' + encodeURIComponent(id), 'DELETE', undefined, key); }
  setRepaymentPlan(id, payload, key) { return this.assetWrite('/DB/accounts/' + encodeURIComponent(id) + '/repayment-plan', 'PUT', payload, key); }
  deleteRepaymentPlan(id, key) { return this.assetWrite('/DB/accounts/' + encodeURIComponent(id) + '/repayment-plan', 'DELETE', undefined, key); }
  assetsOverview(currency) { return this.assetQuery('/DB/assets/overview', { primary_currency: currency }); }
  assetsHistory(query) { return this.assetQuery('/DB/assets/history', query); }
  assetsSettings() { return this.assetQuery('/DB/assets/settings'); }
  saveAssetsSettings(currency, backendPath = this.settings().backendPath) {
    const client = new ApiClient(() => ({ ...this.settings(), backendPath }));
    return client.assetWrite('/DB/assets/settings', 'PUT', { primary_currency: currency });
  }
  unlinkedDealings(query) { return this.assetQuery('/DB/assets/unlinked-dealings', query); }
  linkDealing(id, payload, key) { return this.assetWrite('/DB/assets/dealings/' + encodeURIComponent(id) + '/link', 'POST', payload, key); }

  async checkBackend() {
    await this.listDeals();
    return true;
  }

  async checkAgent() {
    const health = await this.request(this.agentBase() + "/health", {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (health?.success !== true || health.result?.status !== "online") {
      throw new Error(health?.error || "Agent health check failed");
    }
    return true;
  }
}

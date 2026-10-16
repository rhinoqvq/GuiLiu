import { ApiClient } from "./api.js";
import { createRuntimeSettingsController } from './runtime-settings-controller.js';
import { createMailboxSettingsController, watchGmailAuthorization, watchMailboxJob } from './mailbox-settings.js';
import { createUpdateController } from './update-settings.js';
import { pageTitle } from './build-info.js';
import { createUserProfileController } from './user-profile.js';
import { createFullMailImportController } from './full-mail-import-controller.js';
import { createSystemShutdownController } from './system-shutdown.js';
import { createSettingsSaveController, patchSettingsSave, settingsFormDirty } from './settings-save.js';
import { createAgentInformationState } from './agent-information-model.js';
import { createAgentInformationController } from './agent-information-controller.js';
import { createPlansState } from './plans-model.js';
import { createPlansController } from './plans-controller.js';
import { createImportState } from './import-model.js';
import { createImportController } from './import-controller.js';
import { createAgentHealthMonitor } from './agent-health.js';
import { applyFinanceColors } from './finance-colors.js';
import { readTheme, applyTheme } from './theme.js';
import { createCategoryFilterMenu } from './category-filter-menu.js';
import { createScrollDock } from './scroll-dock.js';
import { createAiStarfield } from './ai-starfield.js';
import { localizeMarkup, captureLanguagePosition } from './language-view.js';
import { DEFAULT_RATES, DEFAULT_SETTINGS, ROUTE_ALIASES, ROUTES, STORAGE, normalizePrimaryCurrency } from "./config.js";
import { LANGUAGES, localeFor, t } from "./i18n.js";
import { activeTransactionFilters, createMemo, equalData, filterTransactions, reconcileDeals, transactionIndex, transactionPeriodRange } from './ledger-model.js';
import { patchTransactionView, primeTransactionView, patchAdrRow, patchTransactionCategoryIcons, patchCategoryIconPicker } from './transaction-view.js';
import { normalizeCategoryIcons, withCategoryIconPreference, categoryIconText, setCategoryIconPickerScope, normalizeCategoryIconScope,
  categoryIconDraft, updateCategoryIconDraft } from './category-icons.js';
import { patchAssetsView, primeAssetsView } from './assets-view.js';
import { ASSET_PERIODS, createAssetState, findAssetAccount, assetsData, assetCurrency, operationKey, decimalAmount } from './assets-model.js';
import { createAssetsController } from './assets-controller.js';
import { agentPanel, appShell, modalMarkup, routeView, searchResults, toastMarkup, transactionEditActions, refreshOverviewTransactions } from "./views.js";
import { createAgentChat } from './agent-chat.js';
import { historySendBlocked, sessionTitle } from './agent-history.js';
import { historyText } from './agent-history-view.js';
import { patchAgentView, captureAgentPosition, restoreAgentPosition, disposeAgentMotion, queueAgentReply, retainAgentContent } from './agent-ui.js';
import { transitionAgentWorkspace } from './agent-transition.js';
import { agentTransitionActive, refreshAgentPresentation } from './agent-presentation.js';
import { syncSidebar, toggleSidebar, closeMobileSidebar } from './sidebar-motion.js';
import { pageChartMotion } from './page-chart-motion.js';
import { pageEntryMotion } from './page-entry-motion.js';
import { createChartHover } from './agent-chart-hover.js';
import { transactionAmountHint } from './transaction-amount.js';
import { captureOverviewChart, mountOverviewChart, patchOverviewChart, refreshOverviewCalendar, refreshOverviewTrend } from './overview-chart.js';
import { mountOverviewAssets, patchOverviewAssets } from './overview-assets.js';
import { agentText, agentQuestions } from './agent-copy.js';
import { animateMiniPanel, disposeInterfaceMotion, patchTransient, revealAdrRows } from './ui-motion.js';
import {
  amountToJpy,
  clamp,
  comparisonByGroup,
  contextRange,
  dailySeries,
  dateInputValue,
  dealHasAdr,
  dealInRange,
  dealUpdatePayload,
  detectDuplicateGroups,
  engelCoefficient,
  extractVisualPayloads,
  formatDateTime,
  formatAmount,
  formatJpy,
  groupSpend,
  hourlySeries,
  isUnclassified,
  monthlySeries,
  normalizeDeal,
  normalizeServiceBase,
  numberOfDays,
  previousRange,
  comparablePreviousRange,
  normalizeChatHistory,
  toDate,
  totalJpy,
  uniqueStrings,
  visualMessage,
  visualPanelsFromPayload,
} from "./utils.js";

const root = document.querySelector("#app");
document.title = pageTitle();
const amountHover = createChartHover(root, { selector: '[data-money-tip]',
  getContent: mark => transactionAmountHint({ state, language: state.settings.language }, mark.dataset.moneyAmount, mark.dataset.moneyCurrency) });
const categoryFilterMenu = createCategoryFilterMenu();
const scrollDock = createScrollDock({ getState: () => state, onToggleAgent: toggleAgent,
  onAgentVisibility: visible => agentChat.sessions.setVisible(visible && !document.hidden) });
// Particles and twinkling stars inside the AI glass; re-attaches itself whenever the shell is re-rendered.
createAiStarfield({ root }).start();

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn("Local state could not be saved:", error);
    return false;
  }
}

function readEditHistory() {
  const legacy = readJson(STORAGE.editHistory, {});
  const history = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy : {};
  const prefix = STORAGE.editHistory + '.';
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) history[key.slice(prefix.length)] = readJson(key, []);
  }
  return history;
}

function migratedSettings() {
  const legacy = readJson(STORAGE.legacySettings, {});
  const current = readJson(STORAGE.settings, {});
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(legacy && typeof legacy === "object" ? legacy : {}),
    ...(current && typeof current === "object" ? current : {}),
  };
  settings.contextCurrency = normalizePrimaryCurrency(settings.contextCurrency);
  settings.financialColorsReversed = settings.financialColorsReversed === true;
  return settings;
}

function routeFromHash() {
  const raw = String(location.hash || "#overview").replace(/^#\/?/, "").split(/[?&]/)[0] || "overview";
  const route = ROUTE_ALIASES[raw] || raw;
  return ROUTES.includes(route) ? route : "overview";
}

function setFromArray(value) {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

const state = {
  theme: readTheme(),
  route: routeFromHash(),
  settings: migratedSettings(),
  deals: [],
  importData: createImportState(),
  rates: { ...DEFAULT_RATES, ...readJson(STORAGE.exchangeRates, {}) },
  status: { backend: "idle", agent: "idle" },
  // Set when /auth/client.js runs: the paired local proxy decides the service addresses.
  serviceAddresses: globalThis.guiliuAuth ? { backend: '', agent: '' } : null,
  syncing: false,
  initialized: false,
  lastError: "",
  syncUpdatedAt: "",
  globalSearch: "",
  assetPreview: { account: 'all', period: '6m', kind: 'all', query: '', sort: 'value-desc' },
  assets: createAssetState(),
  transactionFilters: {
    shop: "",
    mainCategory: "",
    subCategory: "",
    startDate: "",
    endDate: "",
    period: "",
    account: "",
  },
  transactionSort: { field: "time", direction: "desc" },
  transactionScrollReset: 0,
  filtersOpen: false,
  correctionMode: false,
  selectedDeals: new Set(),
  dealDrafts: new Map(),
  categoryIcons: normalizeCategoryIcons(readJson(STORAGE.categoryIcons, {})),
  categoryIconScope: normalizeCategoryIconScope(readJson(STORAGE.categoryIconScope, 'transaction')),
  adrByDeal: {},
  adrLoading: {},
  collapsedAdrDeals: new Set(),
  adrSyncError: '',
  agentInformation: createAgentInformationState(),
  plans: createPlansState(),
  reviewDismissed: setFromArray(readJson(STORAGE.reviewDismissed, [])),
  shops: [],
  unknownShops: [],
  goals: Array.isArray(readJson(STORAGE.goals, [])) ? readJson(STORAGE.goals, []) : [],
  selectedGoalId: "",
  scenarioContribution: 0,
  activity: Array.isArray(readJson(STORAGE.activity, [])) ? readJson(STORAGE.activity, []) : [],
  agentMessages: normalizeChatHistory(readJson(STORAGE.chat, readJson(STORAGE.chatBackup, []))),
  agentVisuals: Array.isArray(readJson(STORAGE.visuals, [])) ? readJson(STORAGE.visuals, []).slice(0, 12) : [],
  agentLoading: false,
  agentStep: null,
  agentDraft: '',
  agentAutoSuppressed: false,
  agentReturnRoute: 'overview',
  selectedContextDeal: null,
  promptList: [],
  promptDetail: null,
  promptSelectedName: "",
  promptLoading: false,
  systemTab: "shop",
  systemShopRows: [],
  systemUnknownRows: [],
  systemSelected: { shop: new Set(), unknown: new Set() },
  systemSearch: {
    shop: { key: "", ShopName: "", MainCategory: "", SubCategory: "" },
    unknown: { TitleValue: "" },
  },
  editHistory: readEditHistory(),
  ocrResults: [],
  ocrLoaded: false,
  modal: null,
  toast: null,
};

if (!state.selectedGoalId && state.goals.length) {
  state.selectedGoalId = String((state.goals.find((goal) => goal.primary) || state.goals[0]).id);
}

const api = new ApiClient(() => state.settings);
// A new avatar or ID shows at once on the user's messages in the chat as well.
const userProfile = createUserProfileController({ state, api, context: currentContext, root, onChange: () => renderAgent() });
const systemShutdown = createSystemShutdownController({ state, api, context: currentContext,
  source: () => normalizeServiceBase(state.settings.backendPath, DEFAULT_SETTINGS.backendPath), beforeExit: saveState,
  blocked: () => {
    if (state.settingsSaving || state.runtimeSettings?.saving) return 'busy';
    const form = document.querySelector('[data-settings-form]');
    return state.dealDrafts.size || form && settingsFormDirty(form, state) ? 'dirty' : '';
  } });
const runtimeSettings = createRuntimeSettingsController({ state, api, context: currentContext,
  source: () => normalizeServiceBase(state.settings.backendPath, DEFAULT_SETTINGS.backendPath) });
// Outside Settings, a mailbox being added still reports when it needs the user.
const mailboxWatch = watchMailboxJob({ api, notify, language: () => state.settings.language, start: false });
// A Gmail authorization Google revoked (after a Google password change, say) is reported once and kept in the sidebar.
const gmailWatch = watchGmailAuthorization({ state, api, notify, context: currentContext,
  // An open Settings page shows Gmail's row change from connected to lost (or back) without leaving it.
  onChange: () => { if (state.route === 'settings') void mailboxSettings.load(); } });
const mailboxSettings = createMailboxSettingsController({ state, api, context: currentContext, onJobStarted: () => mailboxWatch.check(),
  source: () => normalizeServiceBase(state.settings.backendPath, DEFAULT_SETTINGS.backendPath) });
const updateSettings = createUpdateController({ state, api, context: currentContext,
  source: () => normalizeServiceBase(state.settings.backendPath, DEFAULT_SETTINGS.backendPath) });
const fullMailImport = createFullMailImportController({ state, api, context: currentContext,
  source: () => normalizeServiceBase(state.settings.backendPath, DEFAULT_SETTINGS.backendPath),
  afterSettled: async backendPath => {
    if (normalizeServiceBase(state.settings.backendPath, DEFAULT_SETTINGS.backendPath) !== backendPath) return;
    const results = await Promise.allSettled([refreshDeals({ render: false, force: true }), assetController.afterWrite()]);
    if (results.some(item => item.status === 'rejected') || results[1].value === false || state.status.backend === 'fail') throw new Error('refreshFailed');
  } });
const settingsSave = createSettingsSaveController({ state, runtimeSettings,
  saveCurrency: (currency, backendPath) => assetController.saveCurrency(currency, backendPath),
  saveLanguage: (language, backendPath) => syncAgentLanguage(language, backendPath),
  persist: settings => writeJson(STORAGE.settings, settings),
  changed: () => { patchSettingsSave(document, currentContext()); runtimeSettings.patch(); } });
const agentInformation = createAgentInformationController({ state, api, context: currentContext,
  changed: patchShellData, navigate, openDeal: deal => openModal('deal-detail', deal),
  onReplySettled: async (item, source) => {
    if (normalizeServiceBase(state.settings.agentPath, DEFAULT_SETTINGS.agentPath) !== source) return;
    if (item.session_id === agentChat.sessionId && !state.agentLoading) await agentChat.sessions.refresh();
  } });
const plansController = createPlansController({ state, api, context: currentContext,
  afterAssetsWrite: () => assetController.afterWrite(),
  changed: () => pageChartMotion.sync(state.route, document.querySelector('#main-view')) });
const importController = createImportController({ state, api, context: currentContext,
  source: () => normalizeServiceBase(api.settings().backendPath, DEFAULT_SETTINGS.backendPath),
  openIncome: (id, normalized) => assetController.openIncome(id, normalized),
  afterCommit: async () => {
    const results = await Promise.allSettled([refreshDeals({ render: true, force: true }), assetController.afterWrite()]);
    if (results.some(item => item.status === 'rejected') || results[1].value === false || state.status.backend === 'fail') throw new Error('refreshFailed');
    state.importData.accounts = state.assets.accounts;
  },
});
const agentHealth = createAgentHealthMonitor({ api, state, onChange: patchShellData });
const agentChat = createAgentChat({ state, api, changed: renderAgent, onCanvas: autoOpenAgentWorkspace, onReply: queueAgentReply,
  notify, legacyPrompt: buildAgentPrompt, context: agentRequestContext });
const assetController = createAssetsController({ api, state, context: currentContext, render: renderMain, renderModal, openModal, closeModal,
  renderOverview: () => {
    const main = document.querySelector('#main-view');
    if (patchOverviewAssets(currentContext(), main)) pageChartMotion.sync(state.route, main);
  },
  notify, refreshDeals, findDeal, persistSettings: () => writeJson(STORAGE.settings, state.settings) });
const dealOperations = new Map();
let toastTimer = 0;
let filterTimer = 0;
let dragSelection = null;
let dealEditEpoch = 0;
let dealEditIntent = 0;
let pendingDealRender = false;
let assetModalTrigger = null;
let categoryIconTrigger = null;
const dealEditorNodes = new Map();
const categoryDatalistVersions = new WeakMap();
const memo = createMemo();

function tx(key, variables) {
  return t(state.settings.language, key, variables);
}

function unpack(value) {
  let result = value && typeof value === "object" && "result" in value ? value.result : value;
  for (let index = 0; index < 2 && typeof result === "string"; index += 1) {
    try {
      result = JSON.parse(result);
    } catch {
      break;
    }
  }
  return result;
}

function rowsFrom(value) {
  const result = unpack(value);
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.items)) return result.items;
  return [];
}

function normalizeUnknownRows(rows) {
  const seen = new Set();
  const output = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = row && typeof row === "object" ? row.TitleValue ?? row.title_value : row;
    if (value === null || value === undefined) continue;
    const title = String(value).trim();
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    output.push({ TitleValue: title });
  }
  return output;
}

function normalizeShopRows(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const key = String(row?.key ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contextDealsForRange(range) {
  return state.deals.filter((deal) => {
    if (!dealInRange(deal, range)) return false;
    return state.settings.contextAccount === "all" || String(deal.AccountNumber) === String(state.settings.contextAccount);
  });
}

function filteredDeals() {
  const index = memo('transactionIndex', [state.deals, state.rates], () => transactionIndex(state.deals, state.rates));
  return memo('filteredDeals', [index, ...Object.values(state.transactionFilters), ...Object.values(state.transactionSort)],
    () => filterTransactions(index, state.transactionFilters, state.transactionSort));
}

function reviewGroups() {
  const missing = state.deals.filter(isUnclassified).map((deal) => ({
    id: "missing-" + deal.DealingNumber,
    type: "missing",
    deal,
  }));
  const duplicates = memo('duplicates', [state.deals], () => detectDuplicateGroups(state.deals)).map((deals) => ({
    id: "duplicate-" + deals.map((deal) => deal.DealingNumber).join("-"),
    type: "duplicate",
    deals,
  }));
  const unknown = normalizeUnknownRows(state.unknownShops).slice(0, 100).map((row) => ({
    id: "unknown-" + row.TitleValue,
    type: "unknown",
    title: row.TitleValue,
  }));
  const failures = state.ocrResults
    .filter((row) => row?.success === false || row?.error || String(row?.status || "").toLowerCase() === "failed")
    .map((row, index) => ({
      id: "failure-" + (row.msgid || row.MsgID || index),
      type: "failure",
      title: row.msgid || row.MsgID || "OCR",
      detail: row.error || row.status || "Processing failed",
    }));
  const visible = (items) => items.filter((item) => !state.reviewDismissed.has(item.id));
  const groups = {
    missing: visible(missing),
    duplicates: visible(duplicates),
    unknown: visible(unknown),
    failures: visible(failures),
  };
  groups.total = groups.missing.length + groups.duplicates.length + groups.unknown.length + groups.failures.length;
  return groups;
}

function summaryFor(currentDeals, previousDeals, currentRange, drivers) {
  const currentTotal = totalJpy(currentDeals, state.rates);
  const previousTotal = totalJpy(previousDeals, state.rates);
  const delta = currentTotal - previousTotal;
  const ratio = previousTotal > 0 ? delta / previousTotal : 0;
  const topDriver = drivers[0]?.label || "—";
  let titleKey = "overviewTitleOnTrack";
  if (ratio > 0.05) titleKey = "overviewTitleUp";
  else if (ratio < -0.05) titleKey = "overviewTitleDown";
  let brief = tx("overviewBriefNoCompare", { count: currentDeals.length });
  if (previousTotal > 0 && delta > 500) brief = tx("overviewBriefUp", { delta: formatJpy(Math.abs(delta), state.settings.language), driver: topDriver });
  else if (previousTotal > 0 && delta < -500) brief = tx("overviewBriefDown", { delta: formatJpy(Math.abs(delta), state.settings.language), driver: topDriver });
  else if (previousTotal > 0) brief = tx("overviewBriefFlat");
  const dayCount = numberOfDays(currentRange, currentDeals);
  return {
    currentTotal,
    previousTotal,
    delta,
    previousCount: previousDeals.length,
    dailyAverage: currentTotal / dayCount,
    engelCoefficient: engelCoefficient(contextDealsForRange(previousRange('month')), state.rates),
    todayTotal: totalJpy(contextDealsForRange(contextRange('today')), state.rates),
    deltaPercentText: previousTotal > 0 ? (ratio * 100).toLocaleString(localeFor(state.settings.language), { maximumFractionDigits: 1, signDisplay: "always" }) + "%" : "—",
    titleKey,
    title: tx(titleKey),
    brief,
    chartTitle: state.settings.contextRange === "month" ? tx("monthComparison") : tx("currentPeriod") + " / " + tx("previousPeriod"),
    rangeLabel: tx(state.settings.contextRange === "today" ? "today" : state.settings.contextRange === "month" ? "thisMonth" : state.settings.contextRange === "7d" ? "last7Days" : state.settings.contextRange === "30d" ? "last30Days" : "allTime"),
  };
}

function plannedGoalRatio(goal) {
  if (!goal) return 0;
  const start = toDate(goal.createdAt) || new Date();
  const deadline = toDate(goal.deadline);
  if (!deadline || deadline <= start) return 0;
  return clamp((Date.now() - start.getTime()) / (deadline.getTime() - start.getTime()), 0, 1);
}

function currentContext() {
  const range = contextRange(state.settings.contextRange);
  const previous = previousRange(state.settings.contextRange);
  const comparison = comparablePreviousRange(state.settings.contextRange);
  const rangeDeps = [state.deals, state.settings.contextRange, state.settings.contextAccount, dateInputValue(new Date())];
  const moneyDeps = [state.rates, state.settings.language];
  const primaryGoal = state.goals.find((goal) => goal.primary) || state.goals[0] || null;
  if (!state.selectedGoalId && primaryGoal) state.selectedGoalId = String(primaryGoal.id);
  const shopSearch = state.systemSearch.shop;
  const unknownSearch = state.systemSearch.unknown;
  const filterShopRows = () => state.systemShopRows.filter((row) => {
    return (!shopSearch.key || String(row.key || "").toLowerCase().includes(shopSearch.key.toLowerCase())) &&
      (!shopSearch.ShopName || String(row.ShopName || "").toLowerCase().includes(shopSearch.ShopName.toLowerCase())) &&
      (!shopSearch.MainCategory || String(row.MainCategory || "").toLowerCase().includes(shopSearch.MainCategory.toLowerCase())) &&
      (!shopSearch.SubCategory || String(row.SubCategory || "").toLowerCase().includes(shopSearch.SubCategory.toLowerCase()));
  });
  const filterUnknownRows = () => state.systemUnknownRows.filter((row) => {
    return !unknownSearch.TitleValue || String(row.TitleValue || "").toLowerCase().includes(unknownSearch.TitleValue.toLowerCase());
  });
  const activeFilterCount = activeTransactionFilters(state.transactionFilters).length;
  return {
    state,
    language: state.settings.language,
    t: tx,
    get accounts() { return memo('accounts', [state.deals, state.assets.accounts], () => uniqueStrings([...state.deals.map((deal) => deal.AccountNumber), ...state.assets.accounts.map((account) => account.account_number)])); },
    get currentDeals() { return memo('currentDeals', rangeDeps, () => contextDealsForRange(range)); },
    get previousDeals() { return memo('previousDeals', rangeDeps, () => previous.start ? contextDealsForRange(previous) : []); },
    get comparisonDeals() { return memo('comparisonDeals', rangeDeps, () => comparison.start ? contextDealsForRange(comparison) : []); },
    get dailyCurrent() { return memo('dailyCurrent', [...rangeDeps, ...moneyDeps], () => state.settings.contextRange === 'today'
      ? hourlySeries(this.currentDeals, range, state.rates) : dailySeries(this.currentDeals, range, state.rates)); },
    get dailyPrevious() { return memo('dailyPrevious', [...rangeDeps, ...moneyDeps], () => previous.start
      ? (state.settings.contextRange === 'today' ? hourlySeries(this.previousDeals, previous, state.rates) : dailySeries(this.previousDeals, previous, state.rates)) : []); },
    get summary() { return memo('summary', [...rangeDeps, ...moneyDeps], () => summaryFor(this.currentDeals, this.comparisonDeals, range, this.categoryComparison)); },
    get categoryComparison() { return memo('categoryComparison', [...rangeDeps, ...moneyDeps], () => comparisonByGroup(this.currentDeals, this.comparisonDeals, (deal) => deal.MainCategory || tx('missingClassification'), state.rates)); },
    get merchantTotals() { return memo('merchantTotals', [...rangeDeps, ...moneyDeps], () => groupSpend(this.currentDeals, (deal) => deal.ShopName || '—', state.rates)); },
    get monthlyTotals() { return memo('monthlyTotals', [state.deals, state.settings.contextAccount, ...moneyDeps], () => monthlySeries(contextDealsForRange(contextRange('all')), state.rates, 60)); },
    get monthlyAverage() { const rows = this.monthlyTotals; return rows.length ? rows.reduce((sum, item) => sum + item.value, 0) / rows.length : 0; },
    get reviewGroups() { return memo('reviewGroups', [state.deals, state.unknownShops, state.ocrResults, state.reviewDismissed.size], reviewGroups); },
    primaryGoal,
    goalPlannedRatio: plannedGoalRatio(primaryGoal),
    get filteredDeals() { return filteredDeals(); },
    get filteredTotal() { return memo('filteredTotal', [this.filteredDeals, ...moneyDeps], () => totalJpy(this.filteredDeals, state.rates)); },
    get filteredCategories() { return memo('filteredCategories', [this.filteredDeals, ...moneyDeps], () => groupSpend(this.filteredDeals, (deal) => deal.MainCategory || tx('missingClassification'), state.rates)); },
    activeFilterCount: String(activeFilterCount),
    get categoryOptions() { return memo('categoryOptions', [state.deals], () => uniqueStrings(state.deals.map((deal) => deal.MainCategory))); },
    get subcategoryOptions() { return memo('subcategoryOptions', [state.deals], () => uniqueStrings(state.deals.map((deal) => deal.SubCategory))); },
    get filteredShopRows() { return memo('filteredShopRows', [state.systemShopRows, ...Object.values(shopSearch)], filterShopRows); },
    get filteredUnknownRows() { return memo('filteredUnknownRows', [state.systemUnknownRows, ...Object.values(unknownSearch)], filterUnknownRows); },
  };
}

function renderApp({ animateAgentCharts = false } = {}) {
  amountHover.clearWithin(root);
  const overviewPosition = captureOverviewChart(root);
  const agentPosition = captureAgentPosition();
  scrollDock.beforeRender();
  const restoreAgentContent = retainAgentContent();
  activeAgentResizeCleanup?.();
  categoryFilterMenu.close();
  applyFinanceColors(state.settings.financialColorsReversed);
  applyTheme(state.theme, state.settings.language);
  disposeAgentMotion();
  disposeInterfaceMotion();
  agentChat.switchService();
  runtimeSettings.activate();
  mailboxSettings.activate();
  updateSettings.activate();
  userProfile.activate();
  fullMailImport.activate();
  document.documentElement.lang = state.settings.language === "ja" ? "ja" : state.settings.language === "en" ? "en" : "zh-CN";
  root.innerHTML = appShell(currentContext());
  restoreAgentContent();
  syncSidebar();
  renderedModal = state.modal;
  primeTransactionView(currentContext(), restoreDealDraftEditors);
  primeAssetsView(currentContext());
  importController.mount();
  agentInformation.mount();
  plansController.mount();
  runtimeSettings.mount();
  mailboxSettings.mount();
  updateSettings.mount();
  userProfile.mount();
  fullMailImport.mount();
  systemShutdown.patch();
  restoreDealDraftEditors();
  pendingDealRender = false;
  patchAgentView(currentContext(), { animateCharts: animateAgentCharts });
  restoreAgentPosition(agentPosition);
  scrollDock.mount(state.route);
  mountOverviewChart(root, overviewPosition, currentContext());
  mountOverviewAssets(currentContext(), root);
  pageChartMotion.sync(state.route, document.querySelector('#main-view'));
  pageEntryMotion.sync(state.route, document.querySelector('#main-view'));
  refreshAgentPresentation();
}

function captureFocus() {
  const element = document.activeElement;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return null;
  const key = element.dataset.filter || element.name || (element.hasAttribute("data-global-search") ? "global-search" : "");
  if (!key) return null;
  return {
    key,
    start: typeof element.selectionStart === "number" ? element.selectionStart : null,
    end: typeof element.selectionEnd === "number" ? element.selectionEnd : null,
  };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const selectors = [
    '[data-filter="' + CSS.escape(snapshot.key) + '"]',
    '[name="' + CSS.escape(snapshot.key) + '"]',
    snapshot.key === "global-search" ? "[data-global-search]" : "",
  ].filter(Boolean).join(",");
  const element = document.querySelector(selectors);
  if (!element) return;
  element.focus();
  if (snapshot.start !== null && typeof element.setSelectionRange === "function") {
    element.setSelectionRange(snapshot.start, snapshot.end);
  }
}

function renderMain(options = {}) {
  amountHover.clearWithin(root);
  const main = document.querySelector("#main-view");
  if (!main) {
    renderApp();
    return;
  }
  const snapshot = options.preserveFocus ? captureFocus() : null;
  const oldScroll = main.scrollTop;
  const overviewPosition = captureOverviewChart(main);
  const ctx = currentContext();
  if (state.route === 'settings') {
    const currency = main.querySelector('[data-settings-form] [name="contextCurrency"]');
    const initial = currency && [...currency.options].find(option => option.defaultSelected)?.value;
    if (currency && currency.value === initial && currency.value !== state.settings.contextCurrency) {
      for (const option of currency.options) option.defaultSelected = option.value === state.settings.contextCurrency;
      currency.value = state.settings.contextCurrency;
    }
    const backendDot = main.querySelector('.connection-results > span:first-child .status-dot');
    if (backendDot) backendDot.className = 'status-dot is-' + state.status.backend;
  }
  const patched = (state.route === 'agent' && patchAgentView(ctx)) || patchTransactionView(ctx) || patchAssetsView(ctx) || importController.patch() || agentInformation.patch() || plansController.patch() || runtimeSettings.patch();
  if (!patched) {
    categoryFilterMenu.close();
    main.innerHTML = routeView(ctx);
    primeTransactionView(ctx, restoreDealDraftEditors);
    primeAssetsView(ctx);
    importController.mount();
    agentInformation.mount();
    plansController.mount();
    runtimeSettings.mount();
  }
  mailboxSettings.mount();
  updateSettings.mount();
  userProfile.mount();
  fullMailImport.mount();
  systemShutdown.patch();
  restoreDealDraftEditors();
  if (!patched) main.scrollTop = oldScroll;
  restoreFocus(snapshot);
  categoryFilterMenu.sync();
  mountOverviewChart(main, overviewPosition, ctx);
  mountOverviewAssets(ctx, main);
  scrollDock.sync();
  pendingDealRender = false;
  if (state.route === 'agent') patchAgentView(ctx);
  pageChartMotion.sync(state.route, main);
  pageEntryMotion.sync(state.route, main);
}

function patchShellData() {
  const ctx = currentContext();
  document.querySelectorAll('[data-agent-health]').forEach((dot) => {
    dot.className = 'status-dot is-' + state.status.agent;
    dot.title = state.agentHealthError || ('Agent: ' + tx(state.status.agent === 'ok' ? 'active' : state.status.agent === 'checking' ? 'syncing' : 'offline'));
    dot.setAttribute('aria-label', dot.title);
  });
  document.querySelectorAll('[data-agent-health-label]').forEach((label) => {
    label.textContent = tx(state.status.agent === 'ok' ? 'active' : state.status.agent === 'checking' ? 'syncing' : 'unavailable');
  });
  const syncing = Boolean(state.syncing || state.refreshing);
  document.querySelectorAll('[data-refresh]').forEach((button) => {
    button.disabled = syncing;
    button.setAttribute('aria-busy', String(syncing));
    if (button.matches('[data-sidebar-refresh]')) {
      const label = tx(syncing ? 'syncing' : 'refreshSync');
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  });
  const reviewBadge = document.querySelector('[data-dock-review-count]');
  if (reviewBadge) {
    const count = state.agentInformation.unreadCount || 0;
    reviewBadge.dataset.count = String(count);
    reviewBadge.textContent = count > 99 ? '99+' : String(count);
    reviewBadge.hidden = !count;
  }
  const accounts = document.querySelector('[data-context-account]');
  const values = [...new Set(['all', ...ctx.accounts.map(String), state.settings.contextAccount].filter(Boolean))];
  if (accounts && (accounts.options.length !== values.length || values.some((value, index) => String(value) !== accounts.options[index]?.value))) {
    accounts.replaceChildren(...values.map((value) => new Option(value === 'all' ? tx('allAccounts') : '#' + value, value)));
    accounts.value = state.settings.contextAccount;
  }
  scrollDock.sync();
}

let agentRenderFrame = 0;
function renderAgent() {
  if (agentRenderFrame) return;
  agentRenderFrame = requestAnimationFrame(() => {
    agentRenderFrame = 0;
    patchAgentView(currentContext(), { animateCharts: true });
    scrollDock.sync();
  });
}

let renderedModal = null;
function renderModal() {
  const modalRoot = document.querySelector("#modal-root");
  if (modalRoot) amountHover.clearWithin(modalRoot);
  patchTransient(modalRoot, modalMarkup(currentContext()), 'modal', renderedModal !== state.modal);
  renderedModal = state.modal;
}

function renderToast() {
  const region = document.querySelector(".toast-region");
  patchTransient(region, toastMarkup({ state }), 'toast');
}

function notify(message, type = "info") {
  state.toast = { message: String(message), type };
  renderToast();
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    renderToast();
  }, 3600);
}

function saveState() {
  agentChat.persist();
  writeJson(STORAGE.settings, state.settings);
  writeJson(STORAGE.goals, state.goals);
  writeJson(STORAGE.activity, state.activity.slice(0, 100));
  writeJson(STORAGE.reviewDismissed, [...state.reviewDismissed]);
  writeJson(STORAGE.visuals, state.agentVisuals.slice(0, 12));
  writeJson(STORAGE.exchangeRates, state.rates);
}

function addActivity(title, detail, type = "local") {
  state.activity.unshift({
    id: "activity-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toISOString(),
    title,
    detail,
    type,
  });
  state.activity = state.activity.slice(0, 100);
  writeJson(STORAGE.activity, state.activity);
}

function activeTextEntry() {
  if (state.dealDrafts.size) return true;
  const element = document.activeElement;
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable;
}

function scrollAgentToEnd() {
  const scrolls = document.querySelectorAll(".agent-panel-scroll, .agent-report-stream");
  for (const element of scrolls) element.scrollTop = element.scrollHeight;
}

function groupAdrRows(rows, allowedIds) {
  const grouped = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.DealingNumber ?? row?.dealing_number ?? "");
    if (!id || (allowedIds && !allowedIds.has(id))) continue;
    if (!grouped[id]) grouped[id] = [];
    grouped[id].push(row);
  }
  for (const rowsForDeal of Object.values(grouped)) {
    rowsForDeal.sort((left, right) => Number(left.SubDealingNumber || 0) - Number(right.SubDealingNumber || 0));
  }
  return grouped;
}

async function loadAdrForDeals(deals) {
  const ids = uniqueStrings(deals.filter(dealHasAdr).map((deal) => deal.DealingNumber));
  const allowed = new Set(ids.map(String));
  if (!ids.length) return {};
  const grouped = groupAdrRows(rowsFrom(await api.listAdrResults()), allowed);
  for (const id of ids) if (!grouped[id]) grouped[id] = [];
  return grouped;
}

async function refreshDeals(options = {}) {
  if (state.dealDrafts.size) return false;
  if (state.syncing && !options.force) return false;
  const editEpoch = dealEditEpoch;
  const backendPath = normalizeServiceBase(state.settings.backendPath, DEFAULT_SETTINGS.backendPath);
  const sameBackend = () => normalizeServiceBase(state.settings.backendPath, DEFAULT_SETTINGS.backendPath) === backendPath;
  state.syncing = true;
  try {
    const rows = rowsFrom(await api.listDeals()).map(normalizeDeal);
    if (!sameBackend() || state.dealDrafts.size || editEpoch !== dealEditEpoch) return false;
    const snapshot = reconcileDeals(state.deals, rows);
    const changed = snapshot.changed;
    // ADR rows can change without any change to their parent transaction.
    let loadedAdr = {};
    let adrSyncError = '';
    try {
      loadedAdr = await loadAdrForDeals(rows);
    } catch (error) {
      adrSyncError = error.message;
      console.warn('ADR sync failed:', error);
    }
    const adrByDeal = {};
    let adrChanged = false;
    for (const deal of rows) {
      const id = String(deal.DealingNumber);
      if (!dealHasAdr(deal)) continue;
      const old = state.adrByDeal[id];
      const next = loadedAdr[id] ?? old;
      if (next !== undefined) adrByDeal[id] = equalData(old, next) ? old : next;
      if (adrByDeal[id] !== old) adrChanged = true;
    }
    if (Object.keys(state.adrByDeal).some((id) => !Object.hasOwn(adrByDeal, id))) adrChanged = true;
    if (!sameBackend() || state.dealDrafts.size || editEpoch !== dealEditEpoch) return false;
    const adrErrorChanged = state.adrSyncError !== adrSyncError;
    state.deals = snapshot.rows;
    if (adrChanged) state.adrByDeal = adrByDeal;
    state.adrSyncError = adrSyncError;
    if (changed || adrChanged || adrErrorChanged) pendingDealRender = true;
    const ids = new Set(rows.map((deal) => String(deal.DealingNumber)));
    for (const id of state.selectedDeals) if (!ids.has(id)) state.selectedDeals.delete(id);
    for (const id of state.collapsedAdrDeals) if (!ids.has(id)) state.collapsedAdrDeals.delete(id);
    state.status.backend = "ok";
    state.lastError = "";
    state.syncUpdatedAt = new Date().toISOString();
    if (pendingDealRender && options.render !== false && !activeTextEntry()) renderMain();
    return changed || adrChanged || adrErrorChanged;
  } catch (error) {
    if (!sameBackend()) return false;
    state.status.backend = "fail";
    state.lastError = error.message;
    if (options.notify) notify(error.message, "error");
    return false;
  } finally {
    state.syncing = false;
    patchShellData();
  }
}

async function refreshReferenceData(options = {}) {
  const results = await Promise.allSettled([api.listShops(), api.listUnknownShops()]);
  if (results[0].status === "fulfilled") {
    state.shops = normalizeShopRows(rowsFrom(results[0].value));
    state.systemShopRows = state.shops;
  }
  if (results[1].status === "fulfilled") {
    state.unknownShops = normalizeUnknownRows(rowsFrom(results[1].value));
    state.systemUnknownRows = state.unknownShops;
  }
  if (options.render) renderMain();
}

async function checkServices(render = true) {
  state.status.backend = "checking";
  if (render) patchShellData();
  const checks = await Promise.allSettled([api.checkBackend(), agentHealth.check({ force: true })]);
  state.status.backend = checks[0].status === "fulfilled" ? "ok" : "fail";
  if (checks[0].status === "rejected") state.lastError = checks[0].reason?.message || String(checks[0].reason);
  if (render) patchShellData();
  return checks;
}

async function refreshExchangeRates() {
  const sources = [
    {
      url: "https://open.er-api.com/v6/latest/CNY",
      value: (data) => Number(data?.rates?.JPY),
      usd: (data) => Number(data?.rates?.JPY) / Number(data?.rates?.USD),
      date: (data) => data?.time_last_update_utc,
    },
    {
      url: "https://api.frankfurter.app/latest?from=CNY&to=JPY,USD",
      value: (data) => Number(data?.rates?.JPY),
      usd: (data) => Number(data?.rates?.JPY) / Number(data?.rates?.USD),
      date: (data) => data?.date,
    },
  ];
  for (const source of sources) {
    try {
      const response = await fetch(source.url, { cache: "no-store" });
      if (!response.ok) continue;
      const data = await response.json();
      const rate = source.value(data);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      // Both quotes come from one CNY-based answer: yen per yuan, and yen per dollar from the same moment.
      const usd = source.usd(data);
      state.rates = { JPY: 1, RMB: rate, CNY: rate, USD: Number.isFinite(usd) && usd > 0 ? usd : DEFAULT_RATES.USD,
        updatedAt: source.date(data) || new Date().toISOString(), source: source.url };
      writeJson(STORAGE.exchangeRates, state.rates);
      if (!activeTextEntry()) renderMain();
      return rate;
    } catch (error) {
      console.warn("Exchange-rate source failed:", error);
    }
  }
  return state.rates.RMB;
}

async function refreshEverything(options = {}) {
  void userProfile.refresh();
  if (state.dealDrafts.size) {
    if (options.notify) notify(tx('finishTransactionEdits'));
    return;
  }
  const editEpoch = dealEditEpoch;
  await Promise.allSettled([
    agentHealth.check({ force: true }),
    refreshDeals({ render: false, notify: options.notify }),
    refreshReferenceData(),
    assetController.refresh({ force: true }),
    agentInformation.refresh(),
    plansController.refresh(),
  ]);
  if (state.dealDrafts.size || editEpoch !== dealEditEpoch) return;
  if (state.initialized) {
    renderMain();
    patchShellData();
  } else renderApp();
}

async function initialize() {
  assetController.restore();
  renderApp();
  void loadServiceAddresses();
  void agentChat.sessions.open();
  void agentHealth.check();
  await Promise.allSettled([assetController.loadSettings(), refreshEverything()]);
  state.initialized = true;
  refreshExchangeRates();
  void startFirstMailImport();
  updateSettings.watch();
  gmailWatch.watch();
  void remindAboutMailbox();
}

// A mailbox being added in Settings may be waiting for the user's confirmation.
async function remindAboutMailbox() {
  try {
    await mailboxWatch.check();
  } catch (error) {
    console.warn('Mailbox check failed:', error);
  }
}


// The first visit after setup imports the whole mailbox once. The Backend decides, so reloads and other tabs never
// start it twice, and an import cut short by closing the app resumes on the next visit. While setup is still indexing
// the rest of the mailbox the Backend asks to wait, and this page asks again every minute.
const FIRST_MAIL_IMPORT_RETRY_MS = 60000;
async function startFirstMailImport() {
  try {
    const payload = await api.startFirstMailImport();
    if (payload?.result?.started) notify(tx('firstMailImportStarted'));
    else if (payload?.result?.waiting) window.setTimeout(() => void startFirstMailImport(), FIRST_MAIL_IMPORT_RETRY_MS);
  } catch (error) {
    console.warn('First mail import check failed:', error);
  }
}

async function loadServiceAddresses() {
  const services = (await globalThis.guiliuAuth?.session().catch(() => null))?.services;
  if (!state.serviceAddresses || !services) return;
  state.serviceAddresses = { backend: String(services.backend || ''), agent: String(services.agent || '') };
  document.querySelectorAll('[data-service-address]').forEach(node => {
    node.textContent = state.serviceAddresses[node.dataset.serviceAddress] || '…';
  });
}

function refreshOverviewDay() {
  if (document.hidden || state.route !== 'overview') return;
  const main = document.querySelector('#main-view');
  const ctx = currentContext();
  refreshOverviewTransactions(ctx, main);
  const trendChanged = refreshOverviewTrend(ctx, main);
  const calendarChanged = refreshOverviewCalendar(ctx, main);
  if (trendChanged || calendarChanged) pageChartMotion.sync(state.route, main);
}

function scheduleAutoSync() {
  window.setTimeout(async () => {
    refreshOverviewDay();
    if (!document.hidden) void agentHealth.check();
    if (!document.hidden && !activeTextEntry()) {
      await Promise.allSettled([refreshDeals({ render: true }), assetController.poll()]);
    }
    scheduleAutoSync();
  }, Math.max(3000, Number(state.settings.autoSyncMs || DEFAULT_SETTINGS.autoSyncMs)));
}

function navigate(route) {
  const resolved = ROUTE_ALIASES[route] || route;
  const safeRoute = ROUTES.includes(resolved) ? resolved : "overview";
  if ((safeRoute === "dev-prompts" || safeRoute === "dev-system") && !state.settings.developerMode) {
    location.hash = "settings";
    return;
  }
  if (location.hash !== "#" + safeRoute) location.hash = safeRoute;
  else {
    state.route = safeRoute;
    renderApp();
    loadRouteData(safeRoute);
  }
}

async function loadRouteData(route) {
  if (route === 'assets' || route === 'overview') await Promise.allSettled([assetController.loadSettings(), assetController.refresh()]);
  if (route === 'settings') await assetController.loadSettings();
  if (route === "dev-prompts" && !state.promptList.length) await loadPrompts();
  if (route === "dev-system") await refreshReferenceData({ render: true });
}

function openModal(type, data = null) {
  if (type.startsWith('asset-') && !state.modal?.type.startsWith('asset-')) assetModalTrigger = document.activeElement;
  state.modal = { type, data };
  if (type === 'category-icon') state.modal.iconDraft = categoryIconDraft(data, state.categoryIcons, state.categoryIconScope === 'category');
  renderModal();
  const opening = state.modal;
  requestAnimationFrame(() => {
    if (state.modal === opening) (document.querySelector("#modal-root [autofocus]") ||
      document.querySelector('.asset-preview-modal .modal-close'))?.focus({ preventScroll: true });
  });
}

function patchOpenCategoryIconPicker() {
  if (state.modal?.type !== 'category-icon') return;
  if (!state.modal.iconDraftDirty) {
    state.modal.iconDraft = categoryIconDraft(state.modal.data, state.categoryIcons, state.categoryIconScope === 'category');
  }
  patchCategoryIconPicker(document.querySelector('.category-icon-modal'), state.modal.data, state.categoryIcons,
    state.settings.language, state.categoryIconScope === 'category', state.modal.iconDraft);
}

function closeModal() {
  if (document.querySelector('[data-assets-form][data-saving]')) return;
  const wasAssetPreview = state.modal?.type.startsWith('asset-');
  const wasCategoryPicker = state.modal?.type === 'category-icon';
  state.modal = null;
  renderModal();
  if (wasAssetPreview) {
    if (assetModalTrigger?.isConnected) assetModalTrigger.focus({ preventScroll: true });
    assetModalTrigger = null;
  }
  if (wasCategoryPicker) {
    const trigger = categoryIconTrigger?.isConnected ? categoryIconTrigger : document.querySelector('[data-pick-category-icon="' +
      CSS.escape(categoryIconTrigger?.dataset.pickCategoryIcon || '') + '"]');
    trigger?.focus({ preventScroll: true });
    categoryIconTrigger = null;
  }
}

function dealIndex() {
  return memo('dealIndex', [state.deals], () => new Map(state.deals.map((deal) => [String(deal.DealingNumber), deal])));
}

// The dock search hands its text to the transactions merchant search.
function searchTransactions(query) {
  state.transactionFilters.shop = query;
  state.transactionScrollReset += 1;
  navigate("transactions");
}

// Results follow the dock search field as you type. Only the list is replaced, so the field keeps focus and any
// input method state; the dock panel then refits to the new height.
function patchGlobalSearch(input) {
  const wrap = input.closest(".global-search-wrap");
  if (!wrap) return;
  wrap.querySelector(".search-popover")?.remove();
  if (String(state.globalSearch || "").trim()) {
    wrap.insertAdjacentHTML("beforeend", searchResults({ state, language: state.settings.language, t: tx }));
  }
  scrollDock.sync();
}

document.addEventListener("compositionend", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.matches("[data-global-search]")) {
    state.globalSearch = event.target.value;
    patchGlobalSearch(event.target);
  }
});

function findDeal(id) {
  return dealIndex().get(String(id));
}

// Drafts are keyed by bill number, or adr:<bill>:<item> for an item line under a bill.
const isAdrDraft = id => String(id).startsWith('adr:');
function findAdrItem(id) {
  const [, deal, item] = String(id).split(':');
  const row = (state.adrByDeal[deal] || []).find(entry => String(entry.SubDealingNumber) === item);
  return row ? { deal: findDeal(deal), row } : null;
}
const findEditable = id => isAdrDraft(id) ? findAdrItem(id)?.row : findDeal(id);
const draftRow = (id, root = document) => root.querySelector(isAdrDraft(id)
  ? '[data-adr-draft-row="' + CSS.escape(String(id)) + '"]' : '[data-deal-row="' + CSS.escape(String(id)) + '"]');

function replaceDeal(id, changes) {
  state.deals = state.deals.map((deal) => String(deal.DealingNumber) === String(id) ? { ...deal, ...changes } : deal);
}

async function deleteDeal(id, ask = true, syncAssets = true) {
  const deal = findDeal(id);
  if (!deal) return;
  if (ask && !window.confirm(tx("delete") + " #" + id + "?")) return;
  const scope = 'delete:' + id;
  await api.deleteDeal(id, operationKey(dealOperations, scope, { id }));
  dealOperations.delete(scope);
  if (syncAssets) assetController.afterWrite();
  state.deals = state.deals.filter((item) => String(item.DealingNumber) !== String(id));
  delete state.adrByDeal[String(id)];
  state.collapsedAdrDeals.delete(String(id));
  state.selectedDeals.delete(String(id));
  addActivity(tx("delete"), "#" + id + " " + (deal.ShopName || ""), "ledger");
}

async function deleteSelectedDeals() {
  const ids = [...state.selectedDeals];
  if (!ids.length || !window.confirm(tx("deleteSelected") + " (" + ids.length + ")?")) return;
  try {
    for (const id of ids) await deleteDeal(id, false, false);
    renderMain();
    notify(tx("deleted") + " " + ids.length, "success");
  } catch (error) {
    notify(error.message, "error");
    await refreshDeals({ render: true });
  } finally {
    assetController.afterWrite();
  }
}

function toggleAdrDetails(id) {
  id = String(id);
  const row = document.querySelector('[data-deal-row="' + CSS.escape(id) + '"]');
  const button = row?.querySelector('[data-toggle-adr]');
  if (!button) return;
  if (state.collapsedAdrDeals.has(id)) state.collapsedAdrDeals.delete(id);
  else state.collapsedAdrDeals.add(id);
  renderAdrForDeal(id);
  if (!state.collapsedAdrDeals.has(id)) revealAdrRows([...document.querySelectorAll('[data-adr-row-for="' + CSS.escape(id) + '"]')]);
}

function renderAdrForDeal(id) {
  id = String(id);
  const deal = findDeal(id);
  const row = document.querySelector('[data-deal-row="' + CSS.escape(id) + '"]');
  if (!deal || !row) return;
  patchAdrRow({ state, language: state.settings.language, t: tx }, deal, row);
}

function dismissReview(id) {
  state.reviewDismissed.add(String(id));
  writeJson(STORAGE.reviewDismissed, [...state.reviewDismissed]);
  renderMain();
}

async function loadPrompts() {
  state.promptLoading = true;
  renderMain();
  try {
    state.promptList = rowsFrom(await api.listPrompts());
    if (!state.promptSelectedName && state.promptList.length) await selectPrompt(state.promptList[0].name, false);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    state.promptLoading = false;
    renderMain();
  }
}

async function selectPrompt(name, renderLoading = true) {
  state.promptSelectedName = String(name);
  state.promptDetail = null;
  state.promptLoading = true;
  if (renderLoading) renderMain();
  try {
    const result = unpack(await api.getPrompt(name));
    const meta = state.promptList.find((prompt) => prompt.name === name) || {};
    state.promptDetail = { ...meta, ...(result && typeof result === "object" ? result : {}) };
  } catch (error) {
    notify(error.message, "error");
  } finally {
    state.promptLoading = false;
    if (renderLoading) renderMain();
  }
}

function toggleSelection(table, key, checked) {
  const selected = state.systemSelected[table];
  if (checked) selected.add(String(key));
  else selected.delete(String(key));
}

function visibleSystemKeys(table) {
  const ctx = currentContext();
  return table === "shop"
    ? ctx.filteredShopRows.map((row) => String(row.key || "")).filter(Boolean)
    : ctx.filteredUnknownRows.map((row) => String(row.TitleValue || "")).filter(Boolean);
}

async function deleteSystemRow(table, key, ask = true) {
  if (!key) return;
  if (ask && !window.confirm(tx("delete") + " " + key + "?")) return;
  if (table === "shop") {
    await api.deleteShop(key);
    state.systemShopRows = state.systemShopRows.filter((row) => String(row.key) !== String(key));
    state.shops = state.systemShopRows;
  } else {
    await api.deleteUnknownShop(key);
    state.systemUnknownRows = state.systemUnknownRows.filter((row) => String(row.TitleValue) !== String(key));
    state.unknownShops = state.systemUnknownRows;
  }
  state.systemSelected[table].delete(String(key));
}

async function deleteSelectedSystemRows(table) {
  const keys = [...state.systemSelected[table]];
  if (!keys.length || !window.confirm(tx("deleteSelected") + " (" + keys.length + ")?")) return;
  try {
    for (const key of keys) await deleteSystemRow(table, key, false);
    renderMain();
    notify(tx("deleted") + " " + keys.length, "success");
    await refreshReferenceData({ render: true });
  } catch (error) {
    notify(error.message, "error");
    await refreshReferenceData({ render: true });
  }
}

function toggleAgent() {
  if (state.route === 'agent') {
    if (routeFromHash() !== 'agent') return;
    state.agentAutoSuppressed = true;
    state.settings.agentOpen = false;
    writeJson(STORAGE.settings, state.settings);
    navigate(state.agentReturnRoute || 'overview');
    return;
  }
  scrollDock.beforeAgentToggle();
  if (state.agentLoading) state.agentAutoSuppressed = true;
  state.settings.agentOpen = !state.settings.agentOpen;
  writeJson(STORAGE.settings, state.settings);
  const shell = document.querySelector('.app-shell');
  const panel = document.querySelector('#agent-panel');
  if (!shell || !panel) { renderApp(); return; }
  const opening = state.settings.agentOpen;
  animateMiniPanel(panel, opening, () => scrollDock.sync(), () => {
    scrollDock.close(false, false);
    shell.classList.toggle('agent-open', opening);
    scrollDock.sync();
  });
  renderAgent();
}

let languageSync = Promise.resolve();
function syncAgentLanguage(language, backendPath = state.settings.backendPath) {
  // Serialize quick switches so an older save cannot win over the latest selection.
  languageSync = languageSync.catch(() => {}).then(() => api.patchRuntimeSettings({ ui: { language } }, backendPath));
  return languageSync;
}

function setLanguage(language) {
  if (!LANGUAGES.includes(language) || language === state.settings.language) return;
  state.settings.language = language;
  writeJson(STORAGE.settings, state.settings);
  void syncAgentLanguage(language).catch(error => notify(tx('settingsSaveRuntimeFailed') + ': ' + error.message, 'error'));
  const shell = root.querySelector('.app-shell');
  if (!shell) { renderApp(); return; }
  pageEntryMotion.finish();
  categoryFilterMenu.close();
  scrollDock.relocalize(() => {
    const restorePosition = captureLanguagePosition(shell);
    const agentPosition = captureAgentPosition();
    const ctx = currentContext();
    document.documentElement.lang = ctx.language === 'zh' ? 'zh-CN' : ctx.language;
    localizeMarkup(shell, appShell(ctx));
    patchOverviewChart(ctx, shell);
    patchOverviewAssets(ctx, shell);
    runtimeSettings.patch();
    mailboxSettings.mount();
    updateSettings.mount();
    userProfile.mount();
    fullMailImport.mount();
    systemShutdown.patch();
    const languageSelect = shell.querySelector('select[name="language"]');
    if (languageSelect) languageSelect.value = ctx.language;
    patchTransactionView(ctx);
    for (const [id, draft] of state.dealDrafts) {
      const row = draftRow(id, shell);
      localizeMarkup(row?.querySelector('[data-deal-edit-actions]'), transactionEditActions(ctx, id, draft.saving));
    }
    primeAssetsView(ctx);
    importController.relocalize();
    agentInformation.paint();
    plansController.paint();
    patchAgentView(ctx, { animateCharts: false });
    restoreAgentPosition(agentPosition);
    pageChartMotion.sync(state.route, shell.querySelector('#main-view'), { animate: false });
    restorePosition();
  });
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const editIntent = ++dealEditIntent;
  const draftId = state.dealDrafts.keys().next().value;
  if (draftId && !target.closest('[data-draft-id], [data-save-deal-draft], [data-cancel-deal-draft]')) {
    const link = target.closest('a[href]');
    if (link) event.preventDefault();
    // A newer click supersedes a queued cell switch while the same save is pending.
    if (!await saveDealDraft(draftId) || editIntent !== dealEditIntent) return;
    if (link) { window.location.href = link.href; return; }
  }
  if (target.closest('[data-agent-title-cancel]')) { agentChat.sessions.cancelRename(); return; }
  if (target.closest('[data-agent-title-save]')) { await agentChat.sessions.commitRename(); return; }
  if (state.agentHistory?.rename && !target.closest('[data-agent-session-editor]')) {
    const history = state.agentHistory;
    if (!await agentChat.sessions.commitRename() || state.agentHistory !== history) return;
  }
  const renameSession = target.closest('[data-agent-rename-session]');
  if (renameSession && !renameSession.disabled) {
    agentChat.sessions.beginRename(renameSession.dataset.agentRenameSession, historyText(state.settings.language, 'new'), renameSession.dataset.agentRenamePlace);
    return;
  }
  if (state.agentHistory?.open && !target.closest('[data-agent-session-toolbar], [data-agent-list-retry]')) {
    state.agentHistory.open = false; renderAgent();
  }
  if (target.closest('[data-agent-sessions-toggle]')) {
    state.agentHistory.open = !state.agentHistory.open; renderAgent();
    if (state.agentHistory.open) void agentChat.sessions.list();
    return;
  }
  const session = target.closest('[data-agent-select-session]');
  if (session) { await agentChat.sessions.select(session.dataset.agentSelectSession); return; }
  const deleteSession = target.closest('[data-agent-delete-session]');
  if (deleteSession && !deleteSession.disabled) {
    const item = state.agentHistory.sessions.find(item => item.session_id === deleteSession.dataset.agentDeleteSession);
    if (item && window.confirm(sessionTitle(state.agentHistory, item.session_id, item.title) + '\n\n' + historyText(state.settings.language, 'deleteConfirm'))) await agentChat.sessions.remove(item.session_id);
    return;
  }
  if (target.closest('[data-agent-delete-retry]')) { await agentChat.sessions.remove(state.agentHistory.removal?.sessionId); return; }
  if (target.closest('[data-agent-delete-dismiss]')) { agentChat.sessions.dismissRemoval(); return; }
  if (target.closest('[data-agent-new-session]')) { agentChat.clear(); return; }
  if (target.closest('[data-agent-list-retry]')) { void agentChat.sessions.open(); return; }
  if (target.closest('[data-agent-sessions-more]')) { void agentChat.sessions.list({ more: true }); return; }
  if (target.closest('[data-agent-history-retry]')) { void agentChat.sessions.refresh(); return; }
  const waitingReply = target.closest('[data-agent-open-waiting]');
  if (waitingReply) { void agentInformation.openWaiting({ sessionId: waitingReply.dataset.agentOpenWaiting }); return; }
  if (target.closest('[data-agent-load-earlier]')) { void agentChat.sessions.loadMore(); return; }
  const pickIcon = target.closest('[data-pick-category-icon]');
  if (pickIcon) {
    const deal = findDeal(pickIcon.dataset.pickCategoryIcon);
    if (deal) {
      categoryIconTrigger = pickIcon;
      openModal('category-icon', deal);
    }
    return;
  }
  const iconScope = target.closest('[data-category-icon-scope]');
  if (iconScope && state.modal?.type === 'category-icon') {
    const selection = { modal: state.modal, categoryIconScope: state.categoryIconScope };
    if (!iconScope.disabled && setCategoryIconPickerScope(selection, iconScope.dataset.categoryIconScope)) {
      if (selection.categoryIconScope !== state.categoryIconScope && !writeJson(STORAGE.categoryIconScope, selection.categoryIconScope)) {
        notify(categoryIconText(state.settings.language, 'failed'), 'error');
        return;
      }
      state.categoryIconScope = selection.categoryIconScope;
      patchOpenCategoryIconPicker();
    }
    return;
  }
  const iconChoice = target.closest('[data-category-icon-value]');
  if (iconChoice && state.modal?.type === 'category-icon') {
    if (updateCategoryIconDraft(state.modal, 'icon', iconChoice.dataset.categoryIconValue || null)) patchOpenCategoryIconPicker();
    return;
  }
  const iconColor = target.closest('[data-category-icon-color]');
  if (iconColor && state.modal?.type === 'category-icon') {
    if (updateCategoryIconDraft(state.modal, 'tone', iconColor.dataset.categoryIconColor || null)) patchOpenCategoryIconPicker();
    return;
  }
  if (target.closest('[data-apply-category-icon]') && state.modal?.type === 'category-icon') {
    const draft = state.modal.iconDraft;
    if (!draft) return;
    const next = withCategoryIconPreference(state.categoryIcons, state.modal.data, draft.icon,
      { syncCategory: state.categoryIconScope === 'category', deals: state.deals, tone: draft.tone });
    if (!writeJson(STORAGE.categoryIcons, next)) {
      notify(categoryIconText(state.settings.language, 'failed'), 'error');
      return;
    }
    state.categoryIcons = next;
    patchTransactionCategoryIcons(currentContext());
    closeModal();
    notify(categoryIconText(state.settings.language, 'saved'), 'success');
    return;
  }
  if (target.closest('[data-settings-discard]')) {
    // The save bar's one way back: the runtime draft and the form fields return to what is saved.
    if (state.settingsSaving) return;
    runtimeSettings.discard();
    settingsSave.clearNotice();
    renderMain();
    return;
  }
  if (target.closest('[data-assets-open], [data-assets-changes-more], [data-assets-refresh], [data-assets-revoke], [data-assets-deal], [data-assets-display-currency]')) {
    await assetController.click(target);
    return;
  }

  const saveDraft = target.closest('[data-save-deal-draft]');
  if (saveDraft) {
    await saveDealDraft(saveDraft.dataset.saveDealDraft);
    return;
  }
  const cancelDraft = target.closest('[data-cancel-deal-draft]');
  if (cancelDraft) {
    cancelDealDraft(cancelDraft.dataset.cancelDealDraft);
    return;
  }
  if (target.matches(".modal-backdrop[data-close-modal]") || target.closest("button[data-close-modal]")) {
    closeModal();
    return;
  }
  if (target.closest("[data-modal-sheet]")) event.stopPropagation();

  if (target.closest("[data-search-all]")) {
    searchTransactions(String(state.globalSearch || "").trim());
    return;
  }
  const routeButton = target.closest("[data-route-button], [data-search-route]");
  if (routeButton) {
    navigate(routeButton.dataset.routeButton || routeButton.dataset.searchRoute);
    return;
  }
  if (target.closest("[data-toggle-sidebar]")) {
    toggleSidebar(() => {
      state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
      writeJson(STORAGE.settings, state.settings);
      document.querySelector('.app-shell')?.classList.toggle('sidebar-collapsed', state.settings.sidebarCollapsed);
    });
    return;
  }
  if (target.closest("[data-toggle-agent], [data-dock-pin-agent]")) {
    toggleAgent();
    return;
  }
  if (target.closest("[data-refresh]")) {
    if (state.refreshing || state.syncing) return;
    if (state.dealDrafts.size) {
      notify(tx('finishTransactionEdits'));
      return;
    }
    state.refreshing = true; patchShellData();
    try {
      await refreshEverything({ notify: true });
      notify(tx(state.status.backend === 'ok' ? 'synced' : 'offline'), state.status.backend === 'ok' ? 'success' : 'error');
    } finally { state.refreshing = false; patchShellData(); }
    return;
  }
  if (target.closest("[data-test-services]")) {
    await checkServices(true);
    notify(state.status.backend === "ok" && state.status.agent === "ok" ? tx("synced") : tx("offline"), state.status.backend === "ok" ? "success" : "error");
    return;
  }
  const open = target.closest("[data-open-modal]");
  if (open) {
    openModal(open.dataset.openModal, null);
    return;
  }
  const assetPeriod = target.closest('[data-asset-period]');
  if (assetPeriod && ASSET_PERIODS.includes(assetPeriod.dataset.assetPeriod)) {
    state.assetPreview.period = assetPeriod.dataset.assetPeriod;
    renderMain();
    await assetController.refresh();
    return;
  }
  const assetKind = target.closest('[data-asset-kind]');
  if (assetKind) {
    state.assetPreview.kind = assetKind.dataset.assetKind;
    renderMain();
    return;
  }
  if (target.closest('[data-asset-clear]')) {
    state.assetPreview.kind = 'all';
    state.assetPreview.query = '';
    renderMain();
    return;
  }
  const assetDetail = target.closest('[data-asset-detail], [data-asset-edit]');
  if (assetDetail) {
    const id = assetDetail.dataset.assetDetail || assetDetail.dataset.assetEdit;
    if (findAssetAccount(state, id)) openModal(assetDetail.hasAttribute('data-asset-edit') ? 'asset-account' : 'asset-detail', { id });
    return;
  }
  if (target.closest('[data-asset-history]')) {
    openModal('asset-history');
    return;
  }
  const openDeal = target.closest("[data-open-deal], [data-search-deal]");
  if (openDeal) {
    const id = openDeal.dataset.openDeal || openDeal.dataset.searchDeal;
    const deal = findDeal(id);
    if (deal) openModal("deal-detail", deal);
    return;
  }
  const editModalDeal = target.closest("[data-edit-modal-deal]");
  if (editModalDeal) {
    const deal = findDeal(editModalDeal.dataset.editModalDeal);
    if (deal) openModal("transaction", deal);
    return;
  }
  const period = target.closest('[data-transaction-period]');
  if (period) {
    const value = period.dataset.transactionPeriod;
    // Custom starts from the range shown so far; a preset leaves the custom dates for later.
    if (value === 'custom' && !state.transactionFilters.startDate && !state.transactionFilters.endDate) {
      const range = transactionPeriodRange(state.transactionFilters);
      state.transactionFilters.startDate = range.start ? dateInputValue(range.start) : '';
      state.transactionFilters.endDate = range.end ? dateInputValue(range.end) : '';
    }
    state.transactionFilters.period = value;
    if (!value) { state.transactionFilters.startDate = ''; state.transactionFilters.endDate = ''; }
    state.transactionScrollReset += 1;
    renderMain({ preserveFocus: true });
    return;
  }
  const clearOne = target.closest('[data-clear-filter]');
  if (clearOne) {
    const key = clearOne.dataset.clearFilter;
    for (const name of key === 'period' ? ['period', 'startDate', 'endDate'] : [key]) state.transactionFilters[name] = '';
    state.transactionScrollReset += 1;
    renderMain({ preserveFocus: true });
    return;
  }
  if (target.closest("[data-toggle-filters]")) {
    state.filtersOpen = !state.filtersOpen;
    renderMain();
    return;
  }
  if (target.closest("[data-clear-filters]")) {
    for (const key of Object.keys(state.transactionFilters)) state.transactionFilters[key] = "";
    state.transactionScrollReset += 1;
    renderMain();
    return;
  }
  const sort = target.closest("[data-sort-deals]");
  if (sort) {
    const field = sort.dataset.sortDeals;
    state.transactionSort.direction = state.transactionSort.field === field && state.transactionSort.direction === "desc" ? "asc" : "desc";
    state.transactionSort.field = field;
    state.transactionScrollReset += 1;
    renderMain();
    return;
  }
  if (target.closest("[data-delete-selected-deals]")) {
    await deleteSelectedDeals();
    return;
  }
  const deleteItem = target.closest("[data-delete-adr]");
  if (deleteItem) {
    try {
      if (await deleteAdrItem(deleteItem.dataset.deleteAdr)) { renderMain(); notify(tx("deleted"), "success"); }
    } catch (error) {
      notify(error.message, "error");
    }
    return;
  }
  const deleteButton = target.closest("[data-delete-deal]");
  if (deleteButton) {
    try {
      await deleteDeal(deleteButton.dataset.deleteDeal);
      renderMain();
      notify(tx("deleted"), "success");
    } catch (error) {
      notify(error.message, "error");
    }
    return;
  }
  const adrDisclosure = target.closest('[data-toggle-adr]');
  if (adrDisclosure) {
    toggleAdrDetails(adrDisclosure.dataset.toggleAdr);
    return;
  }
  const editDealButton = target.closest("[data-edit-deal]");
  if (editDealButton) {
    startDealInlineEdit(editDealButton);
    return;
  }
  const dealRow = target.closest('[data-deal-row]');
  if (dealRow && !target.closest('button, a, input, select, textarea, label, [contenteditable], [role="button"]') &&
      !event.ctrlKey && !event.metaKey && !event.shiftKey && window.getSelection()?.isCollapsed !== false) {
    toggleAdrDetails(dealRow.dataset.dealRow);
    return;
  }
  const dismiss = target.closest("[data-dismiss-review]");
  if (dismiss) {
    dismissReview(dismiss.dataset.dismissReview);
    return;
  }
  const mapMerchant = target.closest("[data-map-merchant]");
  if (mapMerchant) {
    openModal("merchant-map", mapMerchant.dataset.mapMerchant);
    return;
  }
  const selectGoalButton = target.closest("[data-select-goal]");
  if (selectGoalButton) {
    state.selectedGoalId = selectGoalButton.dataset.selectGoal;
    renderMain();
    return;
  }
  const editGoalButton = target.closest("[data-edit-goal]");
  if (editGoalButton) {
    openModal("goal", state.goals.find((goal) => String(goal.id) === editGoalButton.dataset.editGoal));
    return;
  }
  const deleteGoalButton = target.closest("[data-delete-goal]");
  if (deleteGoalButton) {
    if (window.confirm(tx("delete") + "?")) {
      state.goals = state.goals.filter((goal) => String(goal.id) !== deleteGoalButton.dataset.deleteGoal);
      state.selectedGoalId = state.goals[0] ? String(state.goals[0].id) : "";
      writeJson(STORAGE.goals, state.goals);
      renderMain();
    }
    return;
  }
  const primaryGoal = target.closest("[data-primary-goal]");
  if (primaryGoal) {
    state.goals = state.goals.map((goal) => ({ ...goal, primary: String(goal.id) === primaryGoal.dataset.primaryGoal }));
    writeJson(STORAGE.goals, state.goals);
    renderMain();
    return;
  }
  if (target.closest("[data-clear-agent-deal]")) {
    state.selectedContextDeal = null;
    renderAgent();
    return;
  }
  const question = target.closest('[data-agent-question]');
  if (question) {
    const message = agentQuestions(state.settings.language)[Number(question.dataset.agentQuestion)];
    if (message && !state.agentLoading) await sendAgentMessage(message);
    return;
  }
  const retry = target.closest("[data-retry-message]");
  if (retry) {
    if (agentChat.pending?.mode === 'stream' || window.confirm(agentText(state.settings.language, 'legacyWarning'))) agentChat.retry(retry.dataset.retryMessage);
    return;
  }
  if (target.closest('[data-agent-back]')) {
    state.agentAutoSuppressed = true;
    navigate(state.agentReturnRoute || 'overview');
    return;
  }
  if (target.closest('[data-open-agent-workspace]')) {
    navigate('agent');
    return;
  }
  const analysis = target.closest('[data-agent-history]');
  if (analysis) {
    if (state.dealDrafts.size || state.modal) { notify(agentText(state.settings.language, 'available')); return; }
    agentChat.history(analysis.dataset.agentHistory);
    openAgentWorkspace(false);
    return;
  }
  if (target.closest("[data-refresh-prompts]")) {
    await loadPrompts();
    return;
  }
  const promptButton = target.closest("[data-select-prompt]");
  if (promptButton) {
    await selectPrompt(promptButton.dataset.selectPrompt);
    return;
  }
  const systemTab = target.closest("[data-system-tab]");
  if (systemTab) {
    state.systemTab = systemTab.dataset.systemTab;
    renderMain();
    return;
  }
  if (target.closest("[data-reset-system-search]")) {
    state.systemSearch[state.systemTab] = state.systemTab === "shop"
      ? { key: "", ShopName: "", MainCategory: "", SubCategory: "" }
      : { TitleValue: "" };
    state.systemSelected[state.systemTab].clear();
    renderMain();
    return;
  }
  const editSystem = target.closest("[data-edit-system]");
  if (editSystem) {
    startSystemInlineEdit(editSystem);
    return;
  }
  const deleteSystem = target.closest("[data-delete-system]");
  if (deleteSystem) {
    try {
      await deleteSystemRow(deleteSystem.dataset.deleteSystem, deleteSystem.dataset.key);
      renderMain();
      notify(tx("deleted"), "success");
      await refreshReferenceData({ render: true });
    } catch (error) {
      notify(error.message, "error");
    }
    return;
  }
  const deleteSystemSelected = target.closest("[data-delete-system-selected]");
  if (deleteSystemSelected) {
    await deleteSelectedSystemRows(deleteSystemSelected.dataset.deleteSystemSelected);
    return;
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.matches('[data-assets-form]')) {
    event.preventDefault();
    await assetController.submit(form);
    return;
  }
  if (form.matches('[data-assets-changes-filter]')) {
    event.preventDefault();
    await assetController.filterChanges(form);
    return;
  }

  if (form.matches("[data-agent-form]")) {
    event.preventDefault();
    if (historySendBlocked(state)) return;
    const input = form.querySelector("[data-agent-input]");
    const message = String(input?.value || "").trim();
    if (message) {
      input.value = "";
      await sendAgentMessage(message, false);
    }
    return;
  }

  if (form.matches("[data-create-transaction]")) {
    event.preventDefault();
    if (form.dataset.saving) return;
    const data = new FormData(form);
    // The time field shows minutes only. Left at the prefilled "now", the bill keeps the second the form opened,
    // so a bill entered right after an account's opening balance (recorded to the second) still counts.
    const time = form.elements.isotime;
    const openedNow = form.dataset.openedAt && time && time.value === time.defaultValue;
    const payload = {
      shop_name: String(data.get("shop_name") || "").trim(),
      price: Number(data.get("price") || 0),
      CurrencyTypeNumber: Number(data.get("CurrencyTypeNumber") || 101),
      isotime: openedNow ? form.dataset.openedAt : new Date(String(data.get("isotime") || new Date())).toISOString(),
      main_category: String(data.get("main_category") || "").trim(),
      sub_category: String(data.get("sub_category") || "").trim(),
      AccountNumber: String(data.get("AccountNumber") || "").trim(),
    };
    const editId = form.dataset.editId;
    try {
      const settled = String(data.get('settled_amount') || '').trim();
      if (settled) {
        const account = findAssetAccount(state, payload.AccountNumber);
        if (!account) throw new Error(tx('assetNoAccount'));
        payload.settled_amount = decimalAmount(settled, account.currency, { nonnegative: true });
      }
      const key = operationKey(dealOperations, form, { payload, editId, correctionMode: state.correctionMode });
      form.dataset.saving = 'true';
      form.querySelector('[type="submit"]').disabled = true;
      const response = editId ? await api.updateDeal(editId, payload, state.correctionMode, key) : await api.createDeal(payload, key);
      dealOperations.delete(form);
      closeModal();
      await refreshDeals({ render: true });
      addActivity(editId ? tx("edit") : tx("created"), payload.shop_name, "ledger");
      assetController.balanceFeedback(response, editId ? tx('saved') : tx('created'));
    } catch (error) {
      notify(error.message === 'assetInvalidAmount' ? tx(error.message) : error.message, "error");
    } finally {
      delete form.dataset.saving;
      form.querySelector('[type="submit"]').disabled = false;
    }
    return;
  }

  if (form.matches("[data-goal-form]")) {
    event.preventDefault();
    const data = new FormData(form);
    const id = String(data.get("id") || "goal-" + Date.now());
    const existing = state.goals.find((goal) => String(goal.id) === id);
    const goal = {
      id,
      name: String(data.get("name") || "").trim(),
      targetAmount: Number(data.get("targetAmount") || 0),
      currentAmount: Number(data.get("currentAmount") || 0),
      monthlyContribution: Number(data.get("monthlyContribution") || 0),
      deadline: String(data.get("deadline") || ""),
      primary: data.get("primary") === "on",
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    if (goal.primary) state.goals = state.goals.map((item) => ({ ...item, primary: false }));
    const index = state.goals.findIndex((item) => String(item.id) === id);
    if (index >= 0) state.goals[index] = goal;
    else state.goals.push(goal);
    if (!state.goals.some((item) => item.primary)) goal.primary = true;
    state.selectedGoalId = id;
    writeJson(STORAGE.goals, state.goals);
    closeModal();
    renderMain();
    notify(tx("saved"), "success");
    return;
  }

  if (form.matches("[data-merchant-map-form]")) {
    event.preventDefault();
    const data = new FormData(form);
    const unknown = String(data.get("unknown") || "").trim();
    const payload = {
      key: String(data.get("key") || "").trim(),
      ShopName: String(data.get("ShopName") || "").trim(),
      MainCategory: String(data.get("MainCategory") || "").trim(),
      SubCategory: String(data.get("SubCategory") || "").trim(),
    };
    try {
      await api.createShop(payload);
      if (unknown) await api.deleteUnknownShop(unknown);
      closeModal();
      await refreshReferenceData({ render: true });
      notify(tx("saved"), "success");
    } catch (error) {
      notify(error.message, "error");
    }
    return;
  }

  if (form.matches("[data-settings-form]")) {
    event.preventDefault();
    if (state.settingsSaving) return;
    const previousSettings = state.settings;
    const data = new FormData(form);
    // Address fields are absent when the paired proxy fixes the services; keep the stored values then.
    const address = (name) => data.has(name) ? normalizeServiceBase(String(data.get(name) || ''), DEFAULT_SETTINGS[name]) : previousSettings[name];
    const saved = await settingsSave.save({
      backendPath: address('backendPath'),
      agentPath: address('agentPath'),
      language: LANGUAGES.includes(String(data.get("language"))) ? String(data.get("language")) : "zh",
      contextCurrency: normalizePrimaryCurrency(data.get('contextCurrency')),
      autoSyncMs: Math.max(3000, Number(data.get("autoSyncMs") || DEFAULT_SETTINGS.autoSyncMs)),
      developerMode: data.get("developerMode") === "on",
      financialColorsReversed: data.get("financialColorsReversed") === "on",
    });
    if (!saved) {
      const invalid = form.querySelector('[aria-invalid="true"]');
      const group = invalid?.closest('details'); if (group) group.open = true;
      invalid?.focus();
      return;
    }
    const scrollTop = document.querySelector('#main-view')?.scrollTop || 0;
    if (previousSettings.backendPath !== state.settings.backendPath || previousSettings.agentPath !== state.settings.agentPath
      || previousSettings.developerMode !== state.settings.developerMode) renderApp();
    else patchShellData();
    const main = document.querySelector('#main-view'); if (main) main.scrollTop = scrollTop;
    await refreshEverything();
    return;
  }

  if (form.matches("[data-prompt-form]")) {
    event.preventDefault();
    if (!state.promptSelectedName) return;
    const data = new FormData(form);
    const payload = {
      description: String(data.get("description") || "").trim(),
      model: String(data.get("model") || "").trim(),
      prompt: String(data.get("prompt") || ""),
      input_variables: String(data.get("input_variables") || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
    };
    try {
      const result = unpack(await api.updatePrompt(state.promptSelectedName, payload, state.promptDetail?.language || state.settings.language));
      const meta = state.promptList.find((item) => item.name === state.promptSelectedName) || {};
      state.promptDetail = { ...meta, ...payload, ...(result && typeof result === "object" ? result : {}) };
      state.promptList = state.promptList.map((item) => item.name === state.promptSelectedName ? { ...item, description: payload.description, model: payload.model } : item);
      renderMain();
      notify(tx("promptSaved"), "success");
    } catch (error) {
      notify((tx("promptSaveFailed") === "promptSaveFailed" ? "Prompt save failed" : tx("promptSaveFailed")) + ": " + error.message, "error");
    }
    return;
  }

  if (form.matches("[data-system-search]")) {
    event.preventDefault();
    const data = new FormData(form);
    const targetSearch = state.systemSearch[state.systemTab];
    for (const key of Object.keys(targetSearch)) targetSearch[key] = String(data.get(key) || "").trim();
    state.systemSelected[state.systemTab].clear();
    renderMain();
    return;
  }

});

// `toggle` does not bubble; capture it so a re-render keeps the technical settings fold as the user left it.
document.addEventListener('toggle', (event) => {
  if (event.target instanceof HTMLDetailsElement && event.target.matches('[data-settings-fold]')) state.settingsFold = event.target.open;
}, true);

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.closest('[data-settings-form]')) { settingsSave.clearNotice(); patchSettingsSave(document, currentContext()); }
  if (target.matches('[data-settings-language]')) {
    setLanguage(target.value);
    return;
  }
  if (target.matches('select[data-filter]')) {
    state.transactionFilters[target.dataset.filter] = target.value;
    state.transactionScrollReset += 1;
    renderMain({ preserveFocus: true });
    return;
  }
  if (target.matches('[data-theme-select]')) {
    state.theme = applyTheme(target.type === 'checkbox' ? (target.checked ? 'dark' : 'light') : target.value, state.settings.language);
    writeJson(STORAGE.theme, state.theme);
    return;
  }
  if (target.matches('[data-assets-form="account"] [name="account_type"]')) {
    target.form.querySelector('[data-asset-credit-field]').hidden = target.value !== 'credit';
    // A new credit account asks for what is owed instead of a balance.
    target.form.querySelector('[data-asset-balance-label]')?.toggleAttribute('hidden', target.value === 'credit');
    target.form.querySelector('[data-asset-debt-label]')?.toggleAttribute('hidden', target.value !== 'credit');
    return;
  }
  if (target.matches('[data-finance-colors]')) {
    state.settings.financialColorsReversed = target.checked;
    applyFinanceColors(target.checked);
    writeJson(STORAGE.settings, state.settings);
    return;
  }
  if (target.matches('[data-asset-account]')) {
    if (target.value !== 'all' && !findAssetAccount(state, target.value)) return;
    state.assetPreview.account = target.value;
    renderMain();
    assetController.refresh();
    return;
  }
  if (target.matches('[data-asset-sort]')) {
    state.assetPreview.sort = target.value;
    renderMain();
    return;
  }
  if (target.matches("[data-context-account]")) {
    if (state.settings.contextAccount === target.value) return;
    state.settings.contextAccount = target.value;
    writeJson(STORAGE.settings, state.settings);
    if (state.route !== 'settings') renderMain();
    renderAgent();
    return;
  }
  if (target.matches("[data-context-range]")) {
    if (state.settings.contextRange === target.value) return;
    state.settings.contextRange = target.value;
    writeJson(STORAGE.settings, state.settings);
    if (state.route !== 'settings') renderMain();
    renderAgent();
    return;
  }
  if (target.matches("[data-correction-mode]")) {
    state.correctionMode = target.checked;
    return;
  }
  if (target.matches("[data-select-deal]")) {
    if (target.checked) state.selectedDeals.add(String(target.dataset.selectDeal));
    else state.selectedDeals.delete(String(target.dataset.selectDeal));
    renderMain();
    return;
  }
  if (target.matches("[data-select-all-deals]")) {
    state.selectedDeals = target.checked ? new Set(filteredDeals().map((deal) => String(deal.DealingNumber))) : new Set();
    renderMain();
    return;
  }
  if (target.matches("[data-system-select]")) {
    toggleSelection(target.dataset.systemSelect, target.value, target.checked);
    renderMain();
    return;
  }
  if (target.matches("[data-system-select-all]")) {
    const table = target.dataset.systemSelectAll;
    state.systemSelected[table] = target.checked ? new Set(visibleSystemKeys(table)) : new Set();
    renderMain();
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.closest('[data-settings-form]')) { settingsSave.clearNotice(); patchSettingsSave(document, currentContext()); }
  if (target.matches('[data-asset-query]')) {
    state.assetPreview.query = target.value;
    renderMain();
    return;
  }
  if (target.matches("[data-global-search]")) {
    state.globalSearch = target.value;
    // Pinyin or kana still being composed is not a query yet; compositionend patches the results.
    if (!event.isComposing) patchGlobalSearch(target);
    return;
  }
  if (target.matches("[data-filter]")) {
    state.transactionFilters[target.dataset.filter] = target.value;
    if (['startDate', 'endDate'].includes(target.dataset.filter)) state.transactionFilters.period = 'custom';
    state.transactionScrollReset += 1;
    clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => renderMain({ preserveFocus: true }), 160);
    return;
  }
  if (target.matches("[data-goal-scenario]")) {
    state.scenarioContribution = Number(target.value || 0);
    const output = document.querySelector("[data-goal-scenario-value]");
    if (output) output.textContent = formatJpy(state.scenarioContribution, state.settings.language);
    return;
  }
  if (target.matches("[data-agent-input]")) {
    state.agentDraft = target.value;
    agentChat.saveDraft();
    return;
  }
  if (target.matches('[data-agent-title-input]')) { agentChat.sessions.editTitle(target.value); return; }
});

document.addEventListener('scroll', event => {
  const target = event.target;
  if (target instanceof Element && target.matches('.agent-panel-scroll, .agent-report-stream') && target.scrollTop < 64
    && state.agentHistory?.hasMore && !state.agentHistory.error && !state.agentHistory.scrollMode && !document.hidden) {
    void agentChat.sessions.loadMore();
  }
}, { capture: true, passive: true });

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('[data-agent-session-editor]')) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); agentChat.sessions.cancelRename(); return; }
    if (event.key === 'Enter' && target.matches('[data-agent-title-input]')) { event.preventDefault(); agentChat.sessions.commitRename(); return; }
  }
  if (event.key === 'Escape' && state.agentHistory?.open) { state.agentHistory.open = false; renderAgent(); }
  if (event.key === 'Tab' && (state.modal?.type.startsWith('asset-') || state.modal?.type === 'category-icon')) {
    const modal = document.querySelector('.asset-preview-modal, .category-icon-modal');
    if (!modal) return;
    const controls = [...modal.querySelectorAll('button:not(:disabled), input, select, textarea, [tabindex="0"]')]
      .filter((control) => control.tabIndex >= 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && (target === first || !modal.contains(target))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (target === last || !modal.contains(target))) {
      event.preventDefault();
      first?.focus();
    }
  }
  if (state.modal?.type === 'category-icon' && target.closest('[data-category-icon-scope]') &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const buttons = [...document.querySelectorAll('.category-icon-modal [data-category-icon-scope]:not(:disabled)')];
    const index = buttons.indexOf(target.closest('[data-category-icon-scope]'));
    if (index >= 0) {
      const offset = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + offset + buttons.length) % buttons.length;
      buttons[next].click();
      buttons[next].focus({ preventScroll: true });
    }
    return;
  }
  if (state.modal?.type === 'category-icon' && target.closest('[data-category-icon-color]') &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const buttons = [...document.querySelectorAll('.category-icon-modal [data-category-icon-color]')];
    const index = buttons.indexOf(target.closest('[data-category-icon-color]'));
    if (index >= 0) {
      const offset = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + offset + buttons.length) % buttons.length;
      buttons[next].click();
      buttons[next].focus({ preventScroll: true });
    }
    return;
  }
  if (state.modal?.type === 'category-icon' && target.closest('.category-icon-grid') &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    const buttons = [...document.querySelectorAll('.category-icon-grid button')];
    const index = buttons.indexOf(target.closest('button'));
    if (index >= 0) {
      event.preventDefault();
      const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 }[event.key];
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : clamp(index + offset, 0, buttons.length - 1);
      buttons[next]?.focus();
    }
    return;
  }
  if (target.matches('[data-agent-workspace-resizer]') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    state.settings.agentWorkspaceSplit = clamp(Number(state.settings.agentWorkspaceSplit || 62) + (event.key === 'ArrowLeft' ? -2 : 2), 42, 72);
    target.closest('.agent-workspace-grid').style.setProperty('--workspace-split', state.settings.agentWorkspaceSplit + '%');
    writeJson(STORAGE.settings, state.settings);
    return;
  }
  if (target.matches("[data-agent-input]") && event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    target.closest("form")?.requestSubmit();
    return;
  }
  if (target.matches("[data-global-search]") && event.key === "Enter") {
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const query = String(target.value || "").trim();
    const deal = findDeal(query.replace(/^#/, ''));
    if (deal) openModal("deal-detail", deal);
    else searchTransactions(query);
    return;
  }
  // Arrow keys move from the search field through its results and back.
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && target.closest(".global-search-wrap")) {
    const wrap = target.closest(".global-search-wrap"), field = wrap.querySelector("[data-global-search]");
    const items = [field, ...wrap.querySelectorAll(".search-popover button")];
    const next = items[items.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
    if (next && items.length > 1) { event.preventDefault(); next.focus(); }
    return;
  }
  if (event.key === "Escape" && state.modal) closeModal();
});

let activeAgentResizeCleanup;
function trackAgentResize(event, move, className) {
  activeAgentResizeCleanup?.();
  const handle = event.target.closest('[data-agent-resizer], [data-agent-workspace-resizer]');
  event.preventDefault();
  const finish = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    document.removeEventListener('visibilitychange', finish);
    window.removeEventListener('blur', finish);
    handle?.removeEventListener('lostpointercapture', finish);
    document.body.classList.remove(className);
    if (activeAgentResizeCleanup === finish) activeAgentResizeCleanup = null;
    if (handle?.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    writeJson(STORAGE.settings, state.settings);
    scrollDock.sync();
  };
  activeAgentResizeCleanup = finish;
  document.body.classList.add(className);
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
  document.addEventListener('visibilitychange', finish);
  window.addEventListener('blur', finish);
  handle?.addEventListener('lostpointercapture', finish);
  handle?.setPointerCapture?.(event.pointerId);
}

document.addEventListener("pointerdown", (event) => {
  const checkbox = event.target instanceof Element ? event.target.closest("[data-system-select]") : null;
  if (!checkbox || event.button !== 0) return;
  event.preventDefault();
  const table = checkbox.dataset.systemSelect;
  const checked = !state.systemSelected[table].has(String(checkbox.value));
  dragSelection = { table, checked };
  toggleSelection(table, checkbox.value, checked);
  checkbox.checked = checked;
  document.body.classList.add("is-drag-selecting");
});

document.addEventListener("pointerover", (event) => {
  if (!dragSelection) return;
  const checkbox = event.target instanceof Element ? event.target.closest("[data-system-select]") : null;
  if (!checkbox || checkbox.dataset.systemSelect !== dragSelection.table) return;
  toggleSelection(dragSelection.table, checkbox.value, dragSelection.checked);
  checkbox.checked = dragSelection.checked;
});

document.addEventListener("pointerup", () => {
  if (!dragSelection) return;
  dragSelection = null;
  document.body.classList.remove("is-drag-selecting");
  renderMain();
});

function startDealInlineEdit(button) {
  const id = String(button.dataset.editDeal);
  const field = button.dataset.field;
  const deal = findEditable(id);
  if (!deal || !field) return;
  if (!document.querySelector('[data-edit-deal="' + CSS.escape(id) + '"][data-field="' + CSS.escape(field) + '"]')) return;
  let draft = state.dealDrafts.get(id);
  if (state.dealDrafts.size && (!draft || !(field in draft.values))) return;
  if (draft?.saving) return;
  if (!draft) {
    draft = { values: {}, initialValues: {}, saving: false };
    state.dealDrafts.set(id, draft);
    dealEditEpoch += 1;
  }
  if (!(field in draft.values)) {
    const value = field === 'ProductName' ? deal.ProductName || deal.ShopName || '' : deal[field] ?? '';
    if (field === 'ISOtime') {
      const date = toDate(value);
      draft.values[field] = date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
    } else draft.values[field] = String(value);
    draft.initialValues[field] = draft.values[field];
  }
  const input = mountDealDraftField(id, field, draft);
  updateDealDraftUi();
  input?.focus();
  input?.select?.();
}

function mountDealDraftField(id, field, draft) {
  const key = id + ':' + field;
  const mounted = dealEditorNodes.get(key);
  if (mounted?.input.isConnected) return mounted.input;
  const row = draftRow(id);
  const button = row?.querySelector('[data-edit-deal][data-field="' + CSS.escape(field) + '"]');
  if (!button) return null;
  amountHover.clearWithin(button);
  const input = document.createElement("input");
  input.className = "inline-editor";
  input.dataset.inlineField = field;
  input.dataset.draftId = id;
  input.setAttribute('aria-label', tx({ ShopName: 'merchant', ProductName: 'productName', Quantity: 'quantity', price: 'amount', ISOtime: 'date',
    MainCategory: 'mainCategory', SubCategory: 'subCategory' }[field] || field));
  if (field === "price") {
    input.type = "number";
    input.step = "0.01";
    input.required = true;
  } else if (field === "Quantity") {
    input.type = "number";
    input.step = "any";
    input.min = "0";
  } else if (field === "ProductName") {
    input.type = "text";
    input.required = true;
    input.maxLength = 200;
  } else if (field === "ISOtime") {
    input.type = "datetime-local";
    input.required = true;
  } else {
    input.type = "text";
    if (field === "MainCategory" || field === "SubCategory") {
      // The shared suggestion menu (as in the filters); a new name typed here is kept as typed.
      const listId = "inline-" + field.toLowerCase() + "-options";
      Object.assign(input.dataset, { categoryList: listId, categoryEntry: 'free' });
      for (const [key, value] of [['role', 'combobox'], ['aria-autocomplete', 'list'], ['aria-haspopup', 'listbox'], ['aria-expanded', 'false'], ['autocomplete', 'off']]) input.setAttribute(key, value);
      let list = document.getElementById(listId);
      if (!list) {
        list = document.createElement("datalist");
        list.id = listId;
        document.body.append(list);
      }
      const ctx = currentContext();
      const values = field === 'MainCategory' ? ctx.categoryOptions : ctx.subcategoryOptions;
      if (categoryDatalistVersions.get(list) !== values) {
        list.replaceChildren(...values.map((value) => new Option(value, value)));
        categoryDatalistVersions.set(list, values);
      }
    }
  }
  input.value = draft.values[field];
  input.disabled = draft.saving;
  const wrapper = document.createElement('span');
  wrapper.className = 'deal-field-editor';
  wrapper.append(input);
  button.replaceWith(wrapper);
  dealEditorNodes.set(key, { id, field, button, input, wrapper });
  input.addEventListener('input', () => { if (!draft.saving) draft.values[field] = input.value; });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void saveDealDraft(id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelDealDraft(id);
    } else if (event.key === 'Tab') {
      // Let native keyboard focus advance before saving; Cancel must not save.
      setTimeout(() => {
        if (state.dealDrafts.get(id) !== draft || document.activeElement === input ||
            document.activeElement?.closest('[data-cancel-deal-draft], [data-save-deal-draft]')) return;
        void saveDealDraft(id);
      }, 0);
    }
  });
  return input;
}

function updateDealDraftUi() {
  const ctx = { state, language: state.settings.language, t: tx };
  const bulkDelete = document.querySelector('[data-delete-selected-deals]');
  if (bulkDelete) bulkDelete.disabled = state.dealDrafts.size > 0;
  for (const [id, draft] of state.dealDrafts) {
    const row = draftRow(id);
    if (!row) continue;
    row.classList.add('has-draft');
    const actions = row.querySelector('.row-actions');
    actions.querySelector('[data-deal-edit-actions]')?.remove();
    for (const child of actions.children) child.hidden = true;
    actions.insertAdjacentHTML('beforeend', transactionEditActions(ctx, id, draft.saving));
    for (const input of row.querySelectorAll('[data-draft-id]')) input.disabled = draft.saving;
  }
}

function restoreDealDraftEditors() {
  for (const [key, node] of dealEditorNodes) if (!node.wrapper.isConnected) dealEditorNodes.delete(key);
  for (const [id, draft] of state.dealDrafts) {
    for (const field of Object.keys(draft.values)) mountDealDraftField(id, field, draft);
  }
  updateDealDraftUi();
}

function cancelDealDraft(id) {
  id = String(id);
  if (state.dealDrafts.get(id)?.saving) return;
  state.dealDrafts.delete(id);
  dealEditEpoch += 1;
  const deal = findEditable(id);
  for (const [key, node] of dealEditorNodes) {
    if (node.id !== id) continue;
    // An item line's buttons keep their own markup (label and value); a save re-renders them anyway.
    if (deal && !isAdrDraft(id)) {
      node.button.textContent = inlineDealDisplay(deal, node.field);
      node.button.classList.toggle('is-missing', node.field === 'MainCategory' && !String(deal.MainCategory || '').trim());
    }
    node.wrapper.replaceWith(node.button);
    dealEditorNodes.delete(key);
  }
  const row = draftRow(id);
  if (row) {
    row.classList.remove('has-draft');
    const actions = row.querySelector('.row-actions');
    actions.querySelector('[data-deal-edit-actions]')?.remove();
    for (const child of actions.children) child.hidden = false;
  }
  updateDealDraftUi();
}

async function saveDealDraft(id) {
  id = String(id);
  if (isAdrDraft(id)) return saveAdrDraft(id);
  const draft = state.dealDrafts.get(id);
  const deal = findDeal(id);
  if (!draft || !deal) return false;
  if (draft.savePromise) return draft.savePromise;
  if (draft.saving) return false;
  const changes = {};
  for (const [field, raw] of Object.entries(draft.values)) {
    if (raw === draft.initialValues[field]) continue;
    const input = dealEditorNodes.get(id + ':' + field)?.input;
    const after = field === 'price' ? Number(raw) : field === 'ISOtime' ? toDate(raw)?.toISOString() : raw;
    if ((field === 'price' && (!raw.trim() || !Number.isFinite(after))) || (field === 'ISOtime' && !after) ||
        (input?.isConnected && !input.checkValidity())) {
      input?.reportValidity();
      notify(tx('invalidEditValue'), 'error');
      return false;
    }
    const before = field === 'ISOtime' ? toDate(deal[field])?.toISOString() : deal[field];
    if (String(after) !== String(before ?? '')) changes[field] = after;
  }
  if (!Object.keys(changes).length) {
    cancelDealDraft(id);
    return true;
  }
  draft.saving = true;
  dealEditEpoch += 1;
  const correctionMode = state.correctionMode;
  updateDealDraftUi();
  draft.savePromise = (async () => {
    try {
      const payload = dealUpdatePayload(deal, changes);
      const key = operationKey(dealOperations, 'edit:' + id, { payload, correctionMode });
      const response = await api.updateDeal(id, payload, correctionMode, key);
      dealOperations.delete('edit:' + id);
      const history = state.editHistory[id] || (state.editHistory[id] = []);
      for (const [field, after] of Object.entries(changes)) {
        history.unshift({ field, before: String(deal[field] ?? ''), after: String(after), timestamp: new Date().toISOString() });
      }
      replaceDeal(id, changes);
      writeJson(STORAGE.editHistory + '.' + id, history);
      draft.saving = false;
      cancelDealDraft(id);
      renderMain();
      patchShellData();
      assetController.balanceFeedback(response, tx('saved'));
      return true;
    } catch (error) {
      draft.saving = false;
      updateDealDraftUi();
      notify(error.message, 'error');
      document.querySelector('[data-draft-id="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true });
      return false;
    }
  })().finally(() => { draft.savePromise = null; });
  return draft.savePromise;
}

// The full item line the Backend expects, with the user's changes on top of the saved values.
function adrItemPayload(deal, row, changes) {
  return {
    DealingNumber: Number(deal.DealingNumber), SubDealingNumber: Number(row.SubDealingNumber),
    CurrencyTypeNumber: Number(row.CurrencyTypeNumber ?? deal.CurrencyTypeNumber), ShopName: String(row.ShopName ?? deal.ShopName ?? ''),
    ProductName: String(row.ProductName || row.ShopName || ''), Quantity: row.Quantity ?? null, ISOtime: String(row.ISOtime || deal.ISOtime || ''),
    MainCategory: String(row.MainCategory ?? ''), SubCategory: String(row.SubCategory ?? ''), DetailCategory: String(row.DetailCategory ?? ''),
    AccountNumber: row.AccountNumber ?? deal.AccountNumber ?? null, price: Number(row.price), msgid: row.msgid ?? null,
    ...changes,
  };
}

async function saveAdrDraft(id) {
  const draft = state.dealDrafts.get(id), item = findAdrItem(id);
  if (!draft || !item?.deal) return false;
  if (draft.savePromise) return draft.savePromise;
  if (draft.saving) return false;
  const { deal, row } = item, changes = {};
  for (const [field, raw] of Object.entries(draft.values)) {
    if (raw === draft.initialValues[field]) continue;
    const input = dealEditorNodes.get(id + ':' + field)?.input;
    const text = String(raw).trim();
    const after = field === 'price' ? Number(text) : field === 'Quantity' ? (text === '' ? null : Number(text)) : text;
    // A name is required (automatic enrichment relies on it); amounts must be numbers; a quantity may be left empty.
    if ((field === 'price' && (!text || !Number.isFinite(after))) || (field === 'Quantity' && after !== null && !(Number.isFinite(after) && after >= 0)) ||
        (field === 'ProductName' && !text) || (input?.isConnected && !input.checkValidity())) {
      input?.reportValidity();
      notify(tx('invalidEditValue'), 'error');
      return false;
    }
    const before = field === 'ProductName' ? row.ProductName || row.ShopName : row[field];
    if (String(after ?? '') !== String(before ?? '')) changes[field] = after;
  }
  if (!Object.keys(changes).length) { cancelDealDraft(id); return true; }
  draft.saving = true;
  dealEditEpoch += 1;
  updateDealDraftUi();
  draft.savePromise = (async () => {
    try {
      await api.updateAdrResult(deal.DealingNumber, row.SubDealingNumber, adrItemPayload(deal, row, changes));
      const key = String(deal.DealingNumber);
      state.adrByDeal = { ...state.adrByDeal, [key]: (state.adrByDeal[key] || []).map(entry => entry === row ? { ...entry, ...changes } : entry) };
      addActivity(tx('saved'), '#' + key + ' ' + (changes.ProductName || row.ProductName || row.ShopName || ''), 'ledger');
      draft.saving = false;
      cancelDealDraft(id);
      renderMain();
      notify(tx('saved'), 'success');
      return true;
    } catch (error) {
      draft.saving = false;
      updateDealDraftUi();
      notify(error.message, 'error');
      document.querySelector('[data-draft-id="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true });
      return false;
    }
  })().finally(() => { draft.savePromise = null; });
  return draft.savePromise;
}

async function deleteAdrItem(id) {
  const item = findAdrItem(id);
  if (!item?.deal || state.dealDrafts.size) return false;
  const name = item.row.ProductName || item.row.ShopName || '';
  if (!window.confirm(tx('deleteItemConfirm', { name }))) return false;
  await api.deleteAdrResult(item.deal.DealingNumber, item.row.SubDealingNumber);
  const key = String(item.deal.DealingNumber);
  state.adrByDeal = { ...state.adrByDeal, [key]: (state.adrByDeal[key] || []).filter(entry => entry !== item.row) };
  addActivity(tx('delete'), '#' + key + ' ' + name, 'ledger');
  return true;
}

function inlineDealDisplay(deal, field) {
  if (field === "price") return formatAmount(deal.price, deal.CurrencyTypeNumber, state.settings.language);
  if (field === "ISOtime") return formatDateTime(deal.ISOtime, state.settings.language);
  return String(deal[field] || "—");
}

function startSystemInlineEdit(button) {
  if (button.classList.contains("is-editing")) return;
  const table = button.dataset.editSystem;
  const key = button.dataset.key;
  const field = button.dataset.field;
  const row = table === "shop"
    ? state.systemShopRows.find((item) => String(item.key) === String(key))
    : state.systemUnknownRows.find((item) => String(item.TitleValue) === String(key));
  if (!row) return;
  const before = String(row[field] ?? "");
  const input = document.createElement("input");
  input.className = "inline-editor";
  input.value = before;
  button.classList.add("is-editing");
  button.textContent = "";
  button.append(input);
  input.focus();
  input.select();
  let finished = false;
  const restore = () => {
    finished = true;
    button.classList.remove("is-editing");
    button.textContent = before || "—";
  };
  const commit = async () => {
    if (finished) return;
    finished = true;
    const after = input.value.trim();
    if (!after || after === before) {
      restore();
      return;
    }
    input.disabled = true;
    try {
      if (table === "unknown") {
        await api.updateUnknownShop(key, { new_TitleValue: after });
      } else {
        const payload = {
          key: field === "key" ? after : String(row.key || ""),
          ShopName: field === "ShopName" ? after : String(row.ShopName || ""),
          MainCategory: field === "MainCategory" ? after : String(row.MainCategory || ""),
          SubCategory: field === "SubCategory" ? after : String(row.SubCategory || ""),
        };
        await api.updateShop(key, payload);
      }
      await refreshReferenceData();
      renderMain();
      notify(tx("saved"), "success");
    } catch (error) {
      restore();
      notify(error.message, "error");
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      restore();
    }
  });
  input.addEventListener("blur", commit, { once: true });
}

function agentContextPayload() {
  if (state.route === 'assets') {
    const data = assetsData(state);
    return { scope: { page: 'assets', account: state.assetPreview.account, display_currency: data.currency, timezone: 'Asia/Tokyo' },
      data_status: state.assets.error ? 'stale_or_unavailable' : data.overview ? 'backend_account_balances' : 'unavailable',
      assets: data.overview ? { summary: data.summary, complete: data.complete, accounts: data.accounts, as_of: data.overview.as_of, fx: data.overview.fx } : null,
      holdings: null, note: 'Null balances are unknown, not zero. Net worth changes are not necessarily income.' };
  }
  const ctx = currentContext();
  return {
    scope: {
      page: state.route,
      range: state.settings.contextRange,
      account: state.settings.contextAccount,
      display_currency: "JPY",
      cny_to_jpy: Number(state.rates.RMB || DEFAULT_RATES.RMB),
    },
    summary: {
      current_total_jpy: Math.round(ctx.summary.currentTotal),
      previous_total_jpy: Math.round(ctx.summary.previousTotal),
      delta_jpy: Math.round(ctx.summary.delta),
      daily_average_jpy: Math.round(ctx.summary.dailyAverage),
      transaction_count: ctx.currentDeals.length,
    },
    categories: groupSpend(ctx.currentDeals, (deal) => deal.MainCategory || tx("missingClassification"), state.rates).slice(0, 12),
    daily_spend: ctx.dailyCurrent,
    selected_transaction: state.selectedContextDeal,
    evidence_transactions: ctx.currentDeals
      .slice()
      .sort((left, right) => amountToJpy(right.price, right.CurrencyTypeNumber, state.rates) - amountToJpy(left.price, left.CurrencyTypeNumber, state.rates))
      .slice(0, 20)
      .map((deal) => ({
        id: deal.DealingNumber,
        merchant: deal.ShopName,
        amount_jpy: Math.round(amountToJpy(deal.price, deal.CurrencyTypeNumber, state.rates)),
        original_amount: deal.price,
        currency: deal.CurrencyTypeNumber,
        date: deal.ISOtime,
        main_category: deal.MainCategory,
        sub_category: deal.SubCategory,
      })),
  };
}

function buildAgentPrompt(message) {
  const languageName = state.settings.language === "ja" ? "Japanese" : state.settings.language === "en" ? "English" : "Simplified Chinese";
  const recentConversation = state.agentMessages.slice(-8).map((item) => ({ role: item.role, content: item.content }));
  return [
    "You are the financial analysis Agent inside AutoBookkeeping.",
    "Answer naturally in " + languageName + ". Lead with the conclusion, distinguish verified facts from inference, and cite transaction IDs when useful.",
    "Do not shame the user and do not recommend individual investment trades.",
    "When a chart materially improves the answer, append exactly one fenced block labelled abk_visual. Choose the chart type yourself and include only the necessary panels.",
    "Visual schema:",
    '{"abk_visual":true,"message":"the complete natural-language answer","panels":[{"type":"line|bar|pie|table","title":"title","subtitle":"optional","data":[{"label":"label","value":123}]}]}',
    "For comparison tables, data may be objects and columns may be [{key,label,format:'jpy'}]. Do not output placeholder charts and do not repeat the same information in multiple charts.",
    "Current trusted frontend context:",
    JSON.stringify(agentContextPayload()),
    "Recent conversation:",
    JSON.stringify(recentConversation),
    "User request:",
    message,
  ].join("\n\n");
}

function agentRequestContext() {
  const sourcePage = state.route === 'agent' ? state.agentReturnRoute : state.route;
  const range = contextRange(state.settings.contextRange);
  const filters = state.transactionFilters;
  // On the transactions page the period of its filter bar is the context range.
  const filtered = sourcePage === 'transactions' ? transactionPeriodRange(filters) : { start: null, end: null };
  const start = filtered.start || range.start;
  const end = filtered.end ? new Date(filtered.end.getTime()) : range.end;
  if (end) end.setTime(end.getTime() + 1);
  const filteredAccount = sourcePage === 'transactions' && filters.account && filters.account !== 'none' ? filters.account : '';
  const account = sourcePage === 'assets' ? state.assetPreview.account : filteredAccount || state.settings.contextAccount;
  return {
    page: sourcePage, account_number: account === 'all' ? null : account,
    currency: assetCurrency(state.settings.contextCurrency),
    start_time: start ? start.toISOString() : null, end_time: end ? end.toISOString() : null,
  };
}

function openAgentWorkspace(animate = true) {
  if (state.route === 'agent') return;
  state.agentReturnRoute = state.route;
  history.pushState(null, '', '#agent');
  state.route = 'agent';
  transitionAgentWorkspace(() => renderApp({ animateAgentCharts: animate }));
}

function autoOpenAgentWorkspace(body) {
  if (state.route === 'agent') return;
  const focused = document.activeElement;
  const editing = focused instanceof Element && !focused.matches('[data-agent-input]') &&
    (focused.matches('input,textarea,select') || focused.isContentEditable);
  if (state.agentAutoSuppressed || state.route !== body.context.page || document.hidden || state.modal || state.dealDrafts.size || editing) {
    notify(agentText(state.settings.language, 'available'));
    return;
  }
  openAgentWorkspace(true);
}

async function sendAgentMessage(message) {
  if (state.agentLoading) return;
  state.agentAutoSuppressed = false;
  return agentChat.send(message);
}

document.addEventListener("pointerdown", (event) => {
  const workspaceResizer = event.target instanceof Element
    ? event.target.closest("[data-agent-workspace-resizer]")
    : null;
  if (workspaceResizer && event.button === 0) {
    event.preventDefault();
    const grid = workspaceResizer.closest(".agent-workspace-grid");
    const move = (moveEvent) => {
      if (!grid) return;
      const rect = grid.getBoundingClientRect();
      const percentage = clamp(((moveEvent.clientX - rect.left) / rect.width) * 100, 42, 72);
      state.settings.agentWorkspaceSplit = Math.round(percentage * 10) / 10;
      grid.style.setProperty("--workspace-split", state.settings.agentWorkspaceSplit + "%");
    };
    trackAgentResize(event, move, 'is-resizing-agent-workspace');
    return;
  }

  const resizer = event.target instanceof Element ? event.target.closest("[data-agent-resizer]") : null;
  if (!resizer || event.button !== 0) return;
  event.preventDefault();
  const shell = document.querySelector(".app-shell");
  const move = (moveEvent) => {
    const width = clamp(window.innerWidth - moveEvent.clientX, 300, 640);
    state.settings.agentWidth = width;
    shell?.style.setProperty("--agent-width", width + "px");
  };
  trackAgentResize(event, move, 'is-resizing-agent');
});

window.addEventListener('storage', (event) => {
  if (event.storageArea === localStorage && (event.key === STORAGE.theme || event.key === null)) {
    state.theme = applyTheme(readTheme(), state.settings.language);
  }
  if (event.storageArea !== localStorage || (event.key !== STORAGE.categoryIconScope && event.key !== null)) return;
  state.categoryIconScope = normalizeCategoryIconScope(readJson(STORAGE.categoryIconScope, 'transaction'));
  patchOpenCategoryIconPicker();
});

window.addEventListener("hashchange", async () => {
  const nextRoute = routeFromHash();
  if (nextRoute !== state.route && state.dealDrafts.size) {
    const requestedHash = window.location.hash;
    const saved = await saveDealDraft(state.dealDrafts.keys().next().value);
    if (window.location.hash !== requestedHash) return;
    if (!saved) {
      history.replaceState(null, '', '#' + state.route);
      return;
    }
  }
  const enteringAgent = nextRoute === 'agent' && state.route !== 'agent';
  const leavingAgent = state.route === 'agent' && nextRoute !== 'agent';
  if (state.modal?.type === 'category-icon' && nextRoute !== state.route) closeModal();
  if (state.agentLoading && nextRoute !== state.route) state.agentAutoSuppressed = true;
  if (enteringAgent) state.agentReturnRoute = state.route;
  if (leavingAgent && state.settings.agentOpen !== false) {
    state.settings.agentOpen = false;
    writeJson(STORAGE.settings, state.settings);
  }
  state.route = nextRoute;
  if ((state.route === "dev-prompts" || state.route === "dev-system") && !state.settings.developerMode) state.route = "settings";
  if (state.route !== 'settings') mailboxSettings.leave();
  if (state.route !== 'settings') updateSettings.leave();
  if (state.route !== 'settings') fullMailImport.leave();
  if (state.route !== 'settings') systemShutdown.leave();
  state.globalSearch = "";
  closeMobileSidebar();
  if (enteringAgent) transitionAgentWorkspace(() => renderApp({ animateAgentCharts: true }));
  else if (leavingAgent || agentTransitionActive()) transitionAgentWorkspace(() => renderApp(), { toToolbar: !state.settings.agentOpen });
  else renderApp();
  loadRouteData(state.route);
});

window.addEventListener("visibilitychange", () => {
  refreshOverviewDay();
  if (document.hidden) agentChat.sessions.setVisible(false);
  else scrollDock.sync();
  if (!document.hidden) refreshDeals({ render: true });
});

window.addEventListener("beforeunload", saveState);
window.addEventListener('focus', () => void userProfile.refresh());
window.addEventListener('pagehide', () => userProfile.stop());
window.addEventListener('pageshow', () => void userProfile.refresh());
window.addEventListener('pagehide', () => { mailboxSettings.leave(); updateSettings.stop(); gmailWatch.stop(); });
window.addEventListener('pageshow', event => { if (event.persisted) { mailboxSettings.mount(); updateSettings.mount(); updateSettings.watch(); gmailWatch.watch(); } });
window.addEventListener('pagehide', () => fullMailImport.leave());
window.addEventListener('pagehide', () => systemShutdown.leave());
window.addEventListener('pageshow', event => { if (event.persisted) fullMailImport.mount(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) fullMailImport.leave();
  else fullMailImport.mount();
});
window.addEventListener('beforeunload', (event) => {
  if (state.dealDrafts.size) {
    event.preventDefault();
    event.returnValue = '';
  }
});

initialize();
void syncAgentLanguage(state.settings.language).catch(error => notify(tx('settingsSaveRuntimeFailed') + ': ' + error.message, 'error'));
scheduleAutoSync();

import { profileName, profilePicture } from './user-profile.js';
import { escapeHtml as html, escapeAttr as attr, simpleRichText, formatDateTime } from './utils.js';
import { agentText, agentQuestions } from './agent-copy.js';
import { activityLabel } from './agent-activity.js';
import { patchCanvas } from './agent-canvas.js';
import { createReplyMotion } from './agent-reply-motion.js';
import { disposeAgentMotion as stopAgentMotion } from './agent-motion.js';
import { disposeChartHover } from './agent-chart-hover.js';
import { syncChatNavigation, disposeChatNavigation, chatFollowsLatest, setChatFollowLatest } from './agent-chat-navigation.js';
import { patchHistoryControls, historyText, historySendBlocked } from './agent-history-view.js';
export function disposeAgentMotion() { stopAgentMotion(); disposeChartHover(); disposeChatNavigation(); }

const contentKeys = new WeakMap();
let statusContext;
const replyPreference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
const replyMotion = createReplyMotion({ reducedMotion: () => Boolean(replyPreference?.matches), onStatus: patchAgentStatus });
export const queueAgentReply = (message) => replyMotion.queue(message);
replyPreference?.addEventListener('change', () => { if (replyPreference.matches) replyMotion.finish(); });
globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.hidden) replyMotion.finish(); });

function patchAgentStatus() {
  if (!statusContext) return;
  const { state, language } = statusContext;
  const loading = document.querySelector('[data-agent-loading]');
  if (!loading) return;
  const phase = replyMotion.active ? 'revealingReply' : state.agentLoading
    ? state.agentMessages.at(-1)?.content ? 'receivingReply' : 'waitingReply' : '';
  loading.hidden = !phase;
  const label = loading.querySelector('[data-agent-status-text]');
  // While nothing has arrived yet, say what the Agent is doing (thinking, or which tool) when it has told us.
  const content = (phase === 'waitingReply' && activityLabel(language, state.agentStep)) || (phase ? agentText(language, phase) : '');
  if (label && label.textContent !== content) label.textContent = content;
}

export function patchAgentView(ctx, options = {}) {
  const { state, language } = ctx;
  statusContext = ctx;
  replyMotion.sync(state.agentMessages);
  const container = document.querySelector('[data-agent-messages]');
  if (!container) return false;
  const scroll = container.closest('.agent-panel-scroll, .agent-report-stream');
  const mode = state.agentHistory?.scrollMode;
  const follow = mode === 'latest' || (mode !== 'prepend' && chatFollowsLatest(scroll));
  const anchor = mode === 'prepend' && scroll ? [...container.querySelectorAll(':scope > [data-agent-message]')]
    .find(node => node.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top) : null;
  const anchorTop = anchor?.getBoundingClientRect().top;
  patchHistoryControls(ctx);
  const previous = new Map([...container.querySelectorAll(':scope > [data-agent-message]')].map((node) => [node.dataset.agentMessage, node]));
  let revealingNode;
  let preceding = null;
  for (const message of state.agentMessages) {
    let node = previous.get(message.id);
    if (!node) { node = document.createElement('article'); node.dataset.agentMessage = message.id; container.append(node); }
    previous.delete(message.id);
    const expected = preceding ? preceding.nextElementSibling : container.firstElementChild;
    if (expected !== node) container.insertBefore(node, expected);
    preceding = node;
    if (message === replyMotion.message) revealingNode = node;
    const profile = state.userProfile, me = profileName(profile), picture = profilePicture(profile);
    const key = [message.role, message.content, message.timestamp, message.errorKey, message.publicError, message.retryable, me, picture,
      Boolean(message.canvas || message.legacyVisuals), language, Boolean(message.canvas || message.legacyVisuals || message.retryable) && state.agentLoading, message.transport, message.status];
    const previousKey = contentKeys.get(node);
    if (previousKey && key.every((value, i) => value === previousKey[i])) continue;
    node.className = message.role === 'user' ? 'user-query' : 'agent-response';
    const isLegacy = ['legacy', 'structured'].includes(message.transport);
    const avatar = message.role === 'user' && picture
      ? '<span class="agent-message-avatar is-user has-picture" role="img" aria-label="' + attr(me || agentText(language, 'you')) + '"><img src="' + attr(picture) +
        '" alt="" width="24" height="24" referrerpolicy="no-referrer" data-profile-image /></span>'
      : message.role === 'user'
      ? '<span class="agent-message-avatar is-user" role="img" aria-label="' + attr(me || agentText(language, 'you')) + '"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="8" r="3.5"></circle><path d="M5 20v-2a7 7 0 0 1 14 0v2"></path></svg></span>'
      : '<span class="agent-message-avatar is-agent" aria-hidden="true"></span>';
    const timestamp = message.role === 'user'
      ? '<time datetime="' + attr(message.timestamp) + '">' + html(formatDateTime(message.timestamp, language)) + '</time>'
      : '';
    node.innerHTML = '<header><span class="agent-message-sender">' + avatar +
      (message.role === 'user' ? (me ? '<span class="agent-message-name">' + html(me) + '</span>' : '') : '<span>' + html(agentText(language, 'assistant')) + '</span>') + '</span>' + timestamp +
      '</header>' + (message.role === 'user' ? '<p>' + html(message.content) + '</p>' : '<div class="agent-prose">' + simpleRichText(message.content) + '</div>') +
      (message.role === 'user' && message.status && message.status !== 'completed' ? '<span class="agent-turn-state" role="status" data-turn-status="' + attr(message.status) + '">' + html(historyText(language, message.status)) + '</span>' : '') +
      (message.errorKey ? '<p class="agent-message-error" role="status">' + html(agentText(language, message.errorKey)) + (message.publicError ? ' ' + html(message.publicError) : '') + '</p>' : '') +
      (message.retryable ? '<button class="button compact" type="button" data-retry-message="' + attr(message.id) + '"' + (state.agentLoading ? ' disabled' : '') + '>' + html(agentText(language, isLegacy ? 'legacyRetry' : 'resume')) + '</button>' : '') +
      (message.canvas || message.legacyVisuals ? '<button class="button compact agent-history-link" type="button" data-agent-history="' + attr(message.id) + '"' + (state.agentLoading ? ' disabled' : '') + '>' + html(agentText(language, 'history')) + '</button>' : '');
    contentKeys.set(node, key);
  }
  previous.forEach((node) => node.remove());
  replyMotion.attach(revealingNode?.querySelector('.agent-prose'), scroll);
  let welcome = container.querySelector('.agent-welcome');
  const suggestions = document.querySelector('.agent-suggestions');
  const suggestionsSlot = document.querySelector('.agent-suggestions-slot');
  const waitingForHistory = state.agentHistory && !state.agentHistory.isNew && (state.agentHistory.loading || state.agentHistory.listLoading
    || state.agentHistory.error || state.agentHistory.listError);
  if (state.agentMessages.length || waitingForHistory) {
    // Move the same controls before removing the empty state; never duplicate their bindings.
    if (suggestions && suggestionsSlot && suggestions.parentElement !== suggestionsSlot) {
      suggestionsSlot.append(suggestions);
    }
    welcome?.remove();
  } else {
    if (!welcome) { welcome = document.createElement('div'); welcome.className = 'agent-welcome'; container.append(welcome); }
    if (welcome.dataset.language !== language) {
      welcome.innerHTML = '<img class="agent-welcome-mark" src="/assets/agent-avatar.svg?v=f9-s4-1" width="48" height="48" alt="" data-brand-theme="dark" /><img class="agent-welcome-mark" src="/assets/app-icon-light.svg?v=f9-s4-1" width="48" height="48" alt="" data-brand-theme="light" />' +
        '<h2>' + html(agentText(language, 'welcome')) + '</h2>';
      welcome.dataset.language = language;
    }
    if (suggestions && suggestions.parentElement !== welcome) welcome.append(suggestions);
  }
  patchAgentStatus();
  const notice = document.querySelector('[data-agent-notice]');
  if (notice) { notice.hidden = !state.agentNotice; notice.textContent = state.agentNotice || ''; }
  const button = document.querySelector('[data-agent-form] button[type="submit"]');
  if (button) button.disabled = historySendBlocked(state);
  const questions = agentQuestions(language);
  document.querySelectorAll('[data-agent-question]').forEach((item) => {
    item.disabled = historySendBlocked(state);
    const question = questions[Number(item.dataset.agentQuestion)];
    const label = item.querySelector('span');
    if (question && label && label.textContent !== question) {
      label.textContent = question;
      item.title = question;
    }
  });
  const input = document.querySelector('[data-agent-input]');
  if (input && document.activeElement !== input && input.value !== (state.agentDraft || '')) input.value = state.agentDraft || '';
  patchCanvas(document.querySelector('[data-agent-canvas]'), state, language, options);
  if (mode === 'prepend' && scroll) {
    setChatFollowLatest(scroll, false);
    if (anchor?.isConnected) scroll.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  } else if (follow && scroll) { setChatFollowLatest(scroll, true); scroll.scrollTop = scroll.scrollHeight; }
  if (state.agentHistory) state.agentHistory.scrollMode = null;
  syncChatNavigation(scroll?.parentElement);
  return state.route === 'agent' && Boolean(document.querySelector('.agent-workspace-page'));
}

export function captureAgentPosition() {
  const input = document.querySelector('[data-agent-input]');
  const scroll = document.querySelector('.agent-panel-scroll, .agent-report-stream');
  return { focused: input && document.activeElement === input, start: input?.selectionStart, end: input?.selectionEnd,
    top: scroll?.scrollTop, follow: chatFollowsLatest(scroll),
    canvasTop: document.querySelector('.agent-evidence-column')?.scrollTop || 0 };
}

export function restoreAgentPosition(snapshot) {
  const input = document.querySelector('[data-agent-input]');
  if (input && snapshot.focused) { input.focus({ preventScroll: true }); input.setSelectionRange(snapshot.start, snapshot.end); }
  const scroll = document.querySelector('.agent-panel-scroll, .agent-report-stream');
  setChatFollowLatest(scroll, snapshot.follow);
  if (scroll) scroll.scrollTop = snapshot.follow ? scroll.scrollHeight : snapshot.top || 0;
  syncChatNavigation(scroll?.parentElement);
  const canvas = document.querySelector('.agent-evidence-column');
  if (canvas) canvas.scrollTop = snapshot.canvasTop;
}

export function retainAgentContent() {
  const scroll = document.querySelector('.app-shell .agent-panel-scroll, .app-shell .agent-report-stream');
  const area = document.querySelector('.app-shell .agent-input-area');
  const language = document.documentElement.lang;
  return () => {
    if (language !== document.documentElement.lang) return;
    const nextScroll = document.querySelector('.app-shell .agent-panel-scroll, .app-shell .agent-report-stream');
    const nextArea = document.querySelector('.app-shell .agent-input-area');
    if (scroll && nextScroll) {
      scroll.className = nextScroll.className;
      scroll.querySelector('[data-agent-messages]')?.classList.toggle('is-workspace', nextScroll.classList.contains('agent-report-stream'));
      nextScroll.replaceWith(scroll);
    }
    if (area && nextArea) {
      area.querySelector('[data-agent-form]')?.classList.toggle('is-workspace', nextArea.querySelector('form')?.classList.contains('is-workspace'));
      nextArea.replaceWith(area);
    }
  };
}

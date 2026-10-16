// What the Agent is doing while a reply is pending, read from GET /agent/chat/sessions/{id}/activity.
// The Agent reports each ReAct step: thinking (a model call) or the tool it runs, by name only.
const TOOLS = {
  zh: {
    build_data_package: '汇总账单数据', read_package_evidence: '查看数据明细', get_dealing_data_api: '查询账单',
    get_dealing_data_by_id_api: '查看单笔账单', create_dealing_data_api: '新建账单', update_dealing_data_api: '修改账单',
    calculate: '计算', web_search: '联网搜索', web_fetch: '读取网页', get_user_profile: '查看个人资料',
    update_user_profile_from_context: '更新个人资料', get_financial_plans: '查看目标', get_financial_plan: '查看目标详情',
    get_automation_tasks: '查看自动任务', create_automation_task: '新建自动任务', get_agent_insights: '查看 Agent 提示',
    publish_agent_insight: '发布 Agent 提示', show_chart: '绘制图表',
  },
  ja: {
    build_data_package: '取引データを集計', read_package_evidence: 'データの明細を確認', get_dealing_data_api: '取引を検索',
    get_dealing_data_by_id_api: '取引を1件確認', create_dealing_data_api: '取引を作成', update_dealing_data_api: '取引を修正',
    calculate: '計算', web_search: 'ウェブ検索', web_fetch: 'ウェブページを読み込み', get_user_profile: 'プロフィールを確認',
    update_user_profile_from_context: 'プロフィールを更新', get_financial_plans: '目標を確認', get_financial_plan: '目標の詳細を確認',
    get_automation_tasks: '自動タスクを確認', create_automation_task: '自動タスクを作成', get_agent_insights: 'Agent 情報を確認',
    publish_agent_insight: 'Agent 情報を作成', show_chart: 'グラフを作成',
  },
  en: {
    build_data_package: 'Summarizing ledger data', read_package_evidence: 'Reading data details', get_dealing_data_api: 'Looking up transactions',
    get_dealing_data_by_id_api: 'Reading a transaction', create_dealing_data_api: 'Creating a transaction', update_dealing_data_api: 'Editing a transaction',
    calculate: 'Calculating', web_search: 'Searching the web', web_fetch: 'Reading a web page', get_user_profile: 'Reading your profile',
    update_user_profile_from_context: 'Updating your profile', get_financial_plans: 'Reading goals', get_financial_plan: 'Reading a goal',
    get_automation_tasks: 'Reading automated tasks', create_automation_task: 'Creating an automated task', get_agent_insights: 'Reading Agent notices',
    publish_agent_insight: 'Publishing an Agent notice', show_chart: 'Drawing a chart',
  },
};
const PHRASES = {
  zh: { thinking: '正在思考', after: (name) => '正在查看返回内容：' + name, tool: (name) => '正在使用工具：' + name },
  ja: { thinking: '考えています', after: (name) => '返ってきた内容を確認中：' + name, tool: (name) => 'ツールを使用中：' + name },
  en: { thinking: 'Thinking', after: (name) => 'Reviewing the result: ' + name, tool: (name) => 'Using a tool: ' + name },
};
const toolName = (value) => typeof value === 'string' && /^[A-Za-z_]\w{0,79}$/.test(value);

export const toolLabel = (language, tool) => (TOOLS[language] || TOOLS.en)[tool] || String(tool);

// One status line, or '' when there is nothing to show (idle, unknown phase, or a malformed answer).
// Local tools finish in milliseconds, so the thinking step right after a tool reads as reviewing that tool's result.
export function activityLabel(language, activity) {
  if (!activity || typeof activity !== 'object') return '';
  const words = PHRASES[language] || PHRASES.en;
  if (activity.phase === 'thinking') {
    const last = Array.isArray(activity.tools) ? activity.tools.at(-1) : null;
    return toolName(last) ? words.after(toolLabel(language, last)) : words.thinking;
  }
  if (activity.phase === 'tool' && toolName(activity.tool)) return words.tool(toolLabel(language, activity.tool));
  return '';
}

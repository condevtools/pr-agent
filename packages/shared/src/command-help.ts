import type { UiLocale } from "@mr-agent/core";

export type HelpTarget = "PR" | "MR";

export function buildHelpMessage(params: {
  target: HelpTarget;
  locale: UiLocale;
  includeImplement?: boolean;
}): string {
  const { target, locale, includeImplement } = params;
  const t = target === "MR" ? "MR" : "PR";
  const issueAndTarget = `Issue + ${t}`;

  if (locale === "zh") {
    const rows = [
      `| \`/ai-review [report\\|comment]\` | 运行 AI 代码评审 | 仅 ${t} |`,
      `| \`/describe [--apply]\` | 生成 ${t} 描述 | 仅 ${t} |`,
      `| \`/ask <问题>\` | 向 AI 提问 | ${issueAndTarget} |`,
      `| \`/checks [问题]\` | 分析 CI 失败 | 仅 ${t} |`,
      `| \`/generate_tests [重点]\` | 生成测试方案 | 仅 ${t} |`,
      `| \`/changelog [--apply] [重点]\` | 生成 Changelog 条目 | 仅 ${t} |`,
      `| \`/improve [重点]\` | 改进建议 | 仅 ${t} |`,
      `| \`/add_doc [重点]\` | 文档建议 | 仅 ${t} |`,
      `| \`/reflect [需求]\` | 需求澄清问题 | 仅 ${t} |`,
      `| \`/similar_issue [关键词]\` | 搜索相似 Issue | ${issueAndTarget} |`,
      `| \`/feedback <up\\|down\\|resolved\\|dismissed> [备注]\` | 反馈评审质量 | ${issueAndTarget} |`,
    ];
    if (includeImplement) {
      rows.push(`| \`/implement\` | 应用评审中的 suggestion 代码建议 | 仅 ${t} |`);
    }
    rows.push(
      `| \`/custom_prompt <指令>\` | 自定义 Prompt 分析 | 仅 ${t} |`,
      `| \`/help_docs <问题>\` | 文档问答 | ${issueAndTarget} |`,
      `| \`/analyze\` | 代码组件分析 | 仅 ${t} |`,
      `| \`/compliance [重点]\` | 合规检查 | 仅 ${t} |`,
      `| \`/improve_component <组件>\` | 组件级改进 | 仅 ${t} |`,
      `| \`/generate_labels\` | 智能标签生成 | 仅 ${t} |`,
      `| \`/similar_code [关键词]\` | 相似代码搜索 | 仅 ${t} |`,
      `| \`/auto_approve\` | 条件自动 Approve | 仅 ${t} |`,
      `| \`/scan_repo_discussions\` | 扫描历史讨论 | 仅 ${t} |`,
    );
    rows.push(
      `| \`/help\` | 显示本帮助 | ${issueAndTarget} |`,
      `| \`/config\` | 显示仓库配置 | ${issueAndTarget} |`,
    );
    return [
      `### 可用命令`,
      "",
      "| 命令 | 说明 | 适用范围 |",
      "|------|------|----------|",
      ...rows,
      "",
      `> 标记 **仅 ${t}** 的命令需要 ${t} 上下文（diff、CI 检查），在 Issue 中不可用。`,
    ].join("\n");
  }

  const rows = [
    `| \`/ai-review [report\\|comment]\` | Run AI code review | ${t} only |`,
    `| \`/describe [--apply]\` | Generate ${t} description | ${t} only |`,
    `| \`/ask <question>\` | Ask AI about the code | ${issueAndTarget} |`,
    `| \`/checks [question]\` | Analyze CI failures | ${t} only |`,
    `| \`/generate_tests [focus]\` | Generate test plan & code | ${t} only |`,
    `| \`/changelog [--apply] [focus]\` | Generate changelog entry | ${t} only |`,
    `| \`/improve [focus]\` | Improvement suggestions | ${t} only |`,
    `| \`/add_doc [focus]\` | Documentation suggestions | ${t} only |`,
    `| \`/reflect [goal]\` | Requirement clarification questions | ${t} only |`,
    `| \`/similar_issue [query]\` | Find similar issues | ${issueAndTarget} |`,
    `| \`/feedback <up\\|down\\|resolved\\|dismissed> [note]\` | Review quality feedback | ${issueAndTarget} |`,
  ];
  if (includeImplement) {
    rows.push(`| \`/implement\` | Apply suggestion blocks from reviews | ${t} only |`);
  }
  rows.push(
    `| \`/custom_prompt <prompt>\` | Custom prompt analysis | ${t} only |`,
    `| \`/help_docs <question>\` | Documentation Q&A | ${issueAndTarget} |`,
    `| \`/analyze\` | Code component analysis | ${t} only |`,
    `| \`/compliance [focus]\` | Compliance check | ${t} only |`,
    `| \`/improve_component <component>\` | Component-level improvements | ${t} only |`,
    `| \`/generate_labels\` | Smart label generation | ${t} only |`,
    `| \`/similar_code [query]\` | Similar code search | ${t} only |`,
    `| \`/auto_approve\` | Conditional auto-approve | ${t} only |`,
    `| \`/scan_repo_discussions\` | Scan historical discussions | ${t} only |`,
  );
  rows.push(
    `| \`/help\` | Show this help | ${issueAndTarget} |`,
    `| \`/config\` | Show repository config | ${issueAndTarget} |`,
  );
  return [
    `### Available Commands`,
    "",
    "| Command | Description | Scope |",
    "|---------|-------------|-------|",
    ...rows,
    "",
    `> Commands marked **${t} only** require ${t} context (diff, CI checks) and are not available in Issue comments.`,
  ].join("\n");
}

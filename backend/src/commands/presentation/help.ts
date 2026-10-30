import type { UiLocale } from "#core";

export type HelpTarget = "PR" | "MR";

export function buildHelpMessage(params: { target: HelpTarget; locale: UiLocale }): string {
  const { target, locale } = params;
  const rows = locale === "zh"
    ? [
        `| \`/ai-review [report\\|comment]\` | 运行 AI 代码评审 | ${target} |`,
        ...(target === "PR" ? [
          "| `/improve [重点]` | 生成改进建议 | PR |",
          "| `/add_doc [重点]` | 生成文档建议 | PR |",
          "| `/improve_component <组件>` | 生成组件级改进建议 | PR |",
        ] : []),
      ]
    : [
        `| \`/ai-review [report\\|comment]\` | Run AI code review | ${target} |`,
        ...(target === "PR" ? [
          "| `/improve [focus]` | Generate improvement suggestions | PR |",
          "| `/add_doc [focus]` | Generate documentation suggestions | PR |",
          "| `/improve_component <component>` | Generate component improvements | PR |",
        ] : []),
      ];
  return [
    locale === "zh" ? "### 可用命令" : "### Available Commands",
    "",
    locale === "zh" ? "| 命令 | 说明 | 范围 |" : "| Command | Description | Scope |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

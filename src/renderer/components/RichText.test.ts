import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseInlineSegments, RichText } from "./RichText";

describe("rich text inline parsing", () => {
  it("projects emphasis, inline code, and HTTPS links without using raw HTML", () => {
    expect(parseInlineSegments("我是 **Grok**，运行 `npm test`，见 https://x.ai/docs")).toEqual([
      { kind: "text", value: "我是 " },
      { kind: "strong", value: "Grok" },
      { kind: "text", value: "，运行 " },
      { kind: "code", value: "npm test" },
      { kind: "text", value: "，见 " },
      { kind: "link", value: "https://x.ai/docs", href: "https://x.ai/docs" },
    ]);
  });

  it("leaves incomplete markdown markers as text", () => {
    expect(parseInlineSegments("未完成 **标记")).toEqual([
      { kind: "text", value: "未完成 **标记" },
    ]);
  });

  it("parses labeled Markdown links while leaving unsafe destinations as text", () => {
    expect(parseInlineSegments("阅读 [Grok 文档](https://x.ai/docs)，忽略 [危险链接](javascript:alert(1)) 和 http://insecure.example.com")).toEqual([
      { kind: "text", value: "阅读 " },
      { kind: "link", value: "Grok 文档", href: "https://x.ai/docs" },
      { kind: "text", value: "，忽略 [危险链接](javascript:alert(1)) 和 http://insecure.example.com" },
    ]);
  });

  it("parses italic and strikethrough spans without consuming incomplete markers", () => {
    expect(parseInlineSegments("*轻量*、_强调_、~~弃用~~、~~未完成")).toEqual([
      { kind: "emphasis", value: "轻量" },
      { kind: "text", value: "、" },
      { kind: "emphasis", value: "强调" },
      { kind: "text", value: "、" },
      { kind: "strike", value: "弃用" },
      { kind: "text", value: "、~~未完成" },
    ]);
  });

  it("does not treat underscores inside identifiers as italic delimiters", () => {
    expect(parseInlineSegments("使用 grok_session_id，而不是 _旧字段_")).toEqual([
      { kind: "text", value: "使用 grok_session_id，而不是 " },
      { kind: "emphasis", value: "旧字段" },
    ]);
  });
});

describe("rich text block rendering", () => {
  it("renders external links as buttons without browser-native navigation targets", () => {
    const html = renderToStaticMarkup(createElement(RichText, {
      text: "[文档](https://x.ai/docs) 或 https://x.ai",
    }));

    expect(html.match(/class="inline-link"/g)).toHaveLength(2);
    expect(html).toContain(">文档</button>");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href=");
  });

  it("escapes raw HTML and does not create remote image elements", () => {
    const html = renderToStaticMarkup(createElement(RichText, {
      text: '<img src="https://example.com/tracker.png"> ![远程图片](https://example.com/image.png)',
    }));

    expect(html).toContain("&lt;img src=&quot;");
    expect(html).not.toContain("<img");
  });

  it("groups consecutive unordered and ordered items into semantic lists", () => {
    const html = renderToStaticMarkup(createElement(RichText, {
      text: "- Alpha\n- Beta\n\n3. Third\n4. Fourth",
    }));

    expect(html.match(/<ul class="prose-list">/g)).toHaveLength(1);
    expect(html).toContain('<ul class="prose-list"><li>Alpha</li><li>Beta</li></ul>');
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain('<ol class="prose-list" start="3"><li>Third</li><li>Fourth</li></ol>');
  });

  it("renders consecutive quote lines and thematic breaks as semantic blocks", () => {
    const html = renderToStaticMarkup(createElement(RichText, {
      text: "> 第一行\n> 第二行带 *强调*\n\n---",
    }));

    expect(html).toContain("<blockquote><p>第一行</p><p>第二行带 <em>强调</em></p></blockquote>");
    expect(html.match(/<blockquote>/g)).toHaveLength(1);
    expect(html).toContain("<hr/>");
  });

  it("keeps an unclosed fenced code block readable through the end of a streamed response", () => {
    const html = renderToStaticMarkup(createElement(RichText, {
      text: "前言\n```ts\nconst answer = 42;\nconsole.log(answer)",
    }));

    expect(html).toContain("<p>前言</p>");
    expect(html).toContain("<span>ts</span>");
    expect(html).toContain("<pre><code>const answer = 42;\nconsole.log(answer)</code></pre>");
    expect(html).not.toContain("<p>```ts</p>");
  });

  it("keeps Markdown soft-wrapped lines inside one semantic paragraph", () => {
    const html = renderToStaticMarkup(createElement(RichText, {
      text: "第一行很长，\n第二行只是同一个段落的软换行。\n\n新的段落。",
    }));

    expect(html).toContain("<p>第一行很长，\n第二行只是同一个段落的软换行。</p>");
    expect(html.match(/<p>/g)).toHaveLength(2);
  });

  it("renders aligned GFM tables without creating raw HTML or navigation targets", () => {
    const html = renderToStaticMarkup(createElement(RichText, {
      text: "| 项目 | 状态 | 说明 |\n| :--- | :---: | ---: |\n| ACP | **稳定** | 209 tests |\n| URL | [安全](https://x.ai) | memory-only |",
    }));

    expect(html).toContain('<table class="prose-table">');
    expect(html).toContain('<th class="is-center">状态</th>');
    expect(html).toContain('<td class="is-right">209 tests</td>');
    expect(html).toContain('<strong>稳定</strong>');
    expect(html).toContain('class="inline-link"');
    expect(html).not.toContain("href=");
  });

  it("renders nested lists and task states as non-interactive semantic content", () => {
    const html = renderToStaticMarkup(createElement(RichText, {
      text: "- [x] 完成 Markdown\n  - [ ] 验证窄屏\n  - 普通子项\n- 下一项",
    }));

    expect(html.match(/<ul class="prose-list">/g)).toHaveLength(2);
    expect(html).toContain('class="task-list-check is-checked"');
    expect(html).toContain('aria-label="未完成"');
    expect(html).toContain("普通子项");
    expect(html).not.toContain('type="checkbox"');
  });
});

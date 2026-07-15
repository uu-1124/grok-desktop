import { useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "./Icons";
import { copyTextToClipboard } from "../lib/clipboard";

interface RichTextProps {
  text: string;
  compact?: boolean;
}

interface TextBlock {
  kind: "text" | "code";
  value: string;
  language?: string;
}

type TableAlignment = "left" | "center" | "right";

interface ParsedTable {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
  nextIndex: number;
}

interface ParsedListItem {
  text: string;
  checked: boolean | null;
  children: ParsedList[];
}

interface ParsedList {
  ordered: boolean;
  start?: number;
  items: ParsedListItem[];
}

interface ParsedListResult {
  list: ParsedList;
  nextIndex: number;
}

interface ListMarker {
  indent: number;
  ordered: boolean;
  order: number | null;
  text: string;
}

export type InlineSegment =
  | { kind: "text" | "strong" | "emphasis" | "strike" | "code"; value: string }
  | { kind: "link"; value: string; href: string };

export function parseInlineSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const token = /(\[([^\]\n]+)\]\((https:\/\/[^\s<>()]+)\)|https:\/\/[^\s<>()]+|`[^`\n]+`|~~[^~\n]+~~|\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}_])__(?![\s_])[^_\n]*?(?<![\s_])__(?![\p{L}\p{N}_])|(?<!\*)\*[^*\n]+\*(?!\*)|(?<![\p{L}\p{N}_])_(?![\s_])[^_\n]*?(?<![\s_])_(?![\p{L}\p{N}_]))/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ kind: "text", value: text.slice(cursor, match.index) });
    }
    const value = match[0];
    if (match[2] !== undefined && match[3] !== undefined) {
      segments.push({ kind: "link", value: match[2], href: match[3] });
    } else if (value.startsWith("http")) {
      segments.push({ kind: "link", value, href: value });
    } else if (value.startsWith("~~")) {
      segments.push({ kind: "strike", value: value.slice(2, -2) });
    } else if (value.startsWith("**") || value.startsWith("__")) {
      segments.push({ kind: "strong", value: value.slice(2, -2) });
    } else if (value.startsWith("*") || value.startsWith("_")) {
      segments.push({ kind: "emphasis", value: value.slice(1, -1) });
    } else {
      segments.push({ kind: "code", value: value.slice(1, -1) });
    }
    cursor = match.index + value.length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", value: text.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", value: text }];
}

function parseBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let proseLines: string[] = [];
  let index = 0;

  const flushProse = () => {
    if (proseLines.length === 0) return;
    blocks.push({ kind: "text", value: proseLines.join("\n") });
    proseLines = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const opening = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = opening?.[1];
    const info = opening?.[2] ?? "";
    if (!marker || (marker.startsWith("`") && info.includes("`"))) {
      proseLines.push(line);
      index += 1;
      continue;
    }

    flushProse();
    const codeLines: string[] = [];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      const closing = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(candidate)?.[1];
      if (closing && closing[0] === marker[0] && closing.length >= marker.length) {
        index += 1;
        break;
      }
      codeLines.push(candidate);
      index += 1;
    }
    blocks.push({ kind: "code", value: codeLines.join("\n"), language: info.trim() });
  }

  flushProse();
  return blocks.length > 0 ? blocks : [{ kind: "text", value: text }];
}

function InlineText({ text }: { text: string }) {
  return <>{parseInlineSegments(text).map((segment, index) => {
    if (segment.kind === "strong") return <strong key={index}>{segment.value}</strong>;
    if (segment.kind === "emphasis") return <em key={index}>{segment.value}</em>;
    if (segment.kind === "strike") return <del key={index}>{segment.value}</del>;
    if (segment.kind === "code") return <code className="inline-code" key={index}>{segment.value}</code>;
    if (segment.kind === "link") {
      return (
        <button
          className="inline-link"
          key={`${segment.href}-${index}`}
          onClick={() => void window.grokDesktop.openInChrome(segment.href).catch(() => undefined)}
          type="button"
        >
          {segment.value}
        </button>
      );
    }
    return segment.value;
  })}</>;
}

function startsStructuredProseBlock(line: string): boolean {
  return /^(#{1,3})\s+(.+)$/.test(line) ||
    /^\s*[-*+]\s+(.+)$/.test(line) ||
    /^\s*\d+[.)]\s+(.+)$/.test(line) ||
    /^\s{0,3}>\s?(.*)$/.test(line) ||
    /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function parseListMarker(line: string): ListMarker | null {
  const match = /^(\s*)([-*+]|(\d+)[.)])\s+(.+)$/.exec(line);
  if (!match) return null;
  const marker = match[2] ?? "";
  return {
    indent: (match[1] ?? "").replace(/\t/g, "    ").length,
    ordered: /^\d/u.test(marker),
    order: match[3] ? Number(match[3]) : null,
    text: match[4] ?? "",
  };
}

function parseTaskItem(text: string): { text: string; checked: boolean | null } {
  const task = /^\[([ xX])\]\s+(.+)$/.exec(text);
  return task
    ? { text: task[2] ?? "", checked: (task[1] ?? " ").toLocaleLowerCase("en-US") === "x" }
    : { text, checked: null };
}

function parseList(lines: readonly string[], startIndex: number): ParsedListResult | null {
  const first = parseListMarker(lines[startIndex] ?? "");
  if (!first) return null;
  const baseIndent = first.indent;
  const ordered = first.ordered;
  const items: ParsedListItem[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const marker = parseListMarker(lines[index] ?? "");
    if (!marker || marker.indent < baseIndent) break;
    if (marker.indent > baseIndent) {
      const parent = items.at(-1);
      const child = parent ? parseList(lines, index) : null;
      if (!parent || !child) break;
      parent.children.push(child.list);
      index = child.nextIndex;
      continue;
    }
    if (marker.ordered !== ordered) break;

    const task = parseTaskItem(marker.text);
    const item: ParsedListItem = {
      text: task.text,
      checked: task.checked,
      children: [],
    };
    items.push(item);
    index += 1;

    while (index < lines.length) {
      const continuation = lines[index] ?? "";
      const nextMarker = parseListMarker(continuation);
      if (!continuation || nextMarker) break;
      const continuationIndent = /^\s*/u.exec(continuation)?.[0].replace(/\t/g, "    ").length ?? 0;
      if (continuationIndent <= baseIndent) break;
      item.text = `${item.text} ${continuation.trim()}`;
      index += 1;
    }
  }

  return {
    list: {
      ordered,
      ...(ordered && first.order !== null ? { start: first.order } : {}),
      items,
    },
    nextIndex: index,
  };
}

function splitTableRow(line: string): string[] {
  let source = line.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|")) source = source.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  let inCode = false;
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") {
      inCode = !inCode;
      current += character;
      continue;
    }
    if (character === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function parseTable(lines: readonly string[], startIndex: number): ParsedTable | null {
  const headerLine = lines[startIndex] ?? "";
  const dividerLine = lines[startIndex + 1] ?? "";
  if (!headerLine.includes("|") || !dividerLine.includes("|")) return null;
  const headers = splitTableRow(headerLine);
  const dividers = splitTableRow(dividerLine);
  if (
    headers.length < 2 ||
    dividers.length !== headers.length ||
    !dividers.every((cell) => /^:?-{3,}:?$/u.test(cell))
  ) {
    return null;
  }

  const alignments = dividers.map<TableAlignment>((cell) =>
    cell.startsWith(":") && cell.endsWith(":")
      ? "center"
      : cell.endsWith(":")
        ? "right"
        : "left"
  );
  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line || !line.includes("|")) break;
    const cells = splitTableRow(line);
    rows.push(headers.map((_, cellIndex) => cells[cellIndex] ?? ""));
    index += 1;
  }
  return { headers, alignments, rows, nextIndex: index };
}

function ListBlock({ list, identity }: { list: ParsedList; identity: string }) {
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <Tag className="prose-list" {...(list.ordered && list.start !== undefined ? { start: list.start } : {})}>
      {list.items.map((item, itemIndex) => (
        <li className={item.checked === null ? undefined : "task-list-item"} key={`${identity}-${itemIndex}`}>
          {item.checked === null
            ? <InlineText text={item.text} />
            : <span className="task-list-row"><span aria-label={item.checked ? "已完成" : "未完成"} className={`task-list-check${item.checked ? " is-checked" : ""}`} role="img">{item.checked && <CheckIcon size={11}/>}</span><span><InlineText text={item.text}/></span></span>}
          {item.children.map((child, childIndex) => <ListBlock identity={`${identity}-${itemIndex}-${childIndex}`} key={`${identity}-${itemIndex}-${childIndex}`} list={child}/>)}
        </li>
      ))}
    </Tag>
  );
}

function TableBlock({ table }: { table: ParsedTable }) {
  return (
    <div className="prose-table-wrap">
      <table className="prose-table">
        <thead><tr>{table.headers.map((header, index) => <th className={`is-${table.alignments[index]}`} key={index}><InlineText text={header}/></th>)}</tr></thead>
        <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td className={`is-${table.alignments[cellIndex]}`} key={cellIndex}><InlineText text={cell}/></td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Prose({ value }: { value: string }) {
  const lines = value.split("\n");
  const content: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const table = parseTable(lines, index);
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const list = parseList(lines, index);
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);

    if (table) {
      content.push(<TableBlock key={index} table={table}/>);
      index = table.nextIndex;
      continue;
    }

    if (heading) {
      const marker = heading[1] ?? "";
      const Tag = marker.length === 1 ? "h2" : marker.length === 2 ? "h3" : "h4";
      content.push(<Tag key={index}><InlineText text={heading[2] ?? ""} /></Tag>);
      index += 1;
      continue;
    }

    if (quote) {
      const quoteStart = index;
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quotedLine = /^\s{0,3}>\s?(.*)$/.exec(lines[index] ?? "");
        if (!quotedLine) break;
        quoteLines.push(quotedLine[1] ?? "");
        index += 1;
      }
      content.push(
        <blockquote key={quoteStart}>
          {quoteLines.map((quotedLine, quoteIndex) => (
            <p key={`${quoteStart}-${quoteIndex}`}><InlineText text={quotedLine} /></p>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      content.push(<hr key={index} />);
      index += 1;
      continue;
    }

    if (list) {
      content.push(<ListBlock identity={`list-${index}`} key={index} list={list.list}/>);
      index = list.nextIndex;
      continue;
    }

    if (!line) {
      const breakStart = index;
      while (index < lines.length && !(lines[index] ?? "")) index += 1;
      content.push(<span className="prose-break" key={breakStart} aria-hidden="true" />);
      continue;
    }

    const paragraphStart = index;
    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? "";
      if (
        !paragraphLine ||
        (paragraphLines.length > 0 && (
          startsStructuredProseBlock(paragraphLine) ||
          parseTable(lines, index) !== null
        ))
      ) break;
      paragraphLines.push(paragraphLine);
      index += 1;
    }
    content.push(<p key={paragraphStart}><InlineText text={paragraphLines.join("\n")} /></p>);
  }

  return (
    <div className="prose-lines">
      {content}
    </div>
  );
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const success = await copyTextToClipboard(code);
    setCopied(success);
    if (success) window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span>{language || "代码"}</span>
        <button aria-label="复制代码" onClick={() => void copy()} type="button">
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export function RichText({ text, compact = false }: RichTextProps) {
  return (
    <div className={`rich-text${compact ? " rich-text--compact" : ""}`}>
      {parseBlocks(text).map((block, index) => block.kind === "code"
        ? <CodeBlock code={block.value} key={index} language={block.language} />
        : <Prose key={index} value={block.value} />)}
    </div>
  );
}

/**
 * Markdown Intermediate Representation
 *
 * Parses markdown into a structured IR (text + style spans + link spans)
 * that can be rendered to any target format (Slack mrkdwn, etc.).
 */
import MarkdownIt from "markdown-it";

export type MarkdownTableMode = "off" | "bullets" | "code";

type ListState = { type: "bullet" | "ordered"; index: number };
type LinkState = { href: string; labelStart: number };
type RenderEnv = { listStack: ListState[] };

type MarkdownToken = {
  type: string;
  content?: string;
  children?: MarkdownToken[];
  attrs?: [string, string][];
  attrGet?: (name: string) => string | null;
};

export type MarkdownStyle = "bold" | "italic" | "strikethrough" | "code" | "code_block" | "spoiler" | "blockquote";

export type MarkdownStyleSpan = { start: number; end: number; style: MarkdownStyle };
export type MarkdownLinkSpan = { start: number; end: number; href: string };
export type MarkdownIR = { text: string; styles: MarkdownStyleSpan[]; links: MarkdownLinkSpan[] };

type OpenStyle = { style: MarkdownStyle; start: number };
type RenderTarget = {
  text: string;
  styles: MarkdownStyleSpan[];
  openStyles: OpenStyle[];
  links: MarkdownLinkSpan[];
  linkStack: LinkState[];
};

type TableCell = { text: string; styles: MarkdownStyleSpan[]; links: MarkdownLinkSpan[] };
type TableState = {
  headers: TableCell[];
  rows: TableCell[][];
  currentRow: TableCell[];
  currentCell: RenderTarget | null;
  inHeader: boolean;
};

type RenderState = RenderTarget & {
  env: RenderEnv;
  headingStyle: "none" | "bold";
  blockquotePrefix: string;
  enableSpoilers: boolean;
  tableMode: MarkdownTableMode;
  table: TableState | null;
};

export type MarkdownParseOptions = {
  linkify?: boolean;
  enableSpoilers?: boolean;
  headingStyle?: "none" | "bold";
  blockquotePrefix?: string;
  autolink?: boolean;
  /** How to render tables (off|bullets|code). Default: code. */
  tableMode?: MarkdownTableMode;
};

function createMarkdownIt(options: MarkdownParseOptions): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: options.linkify ?? true, breaks: false, typographer: false });
  md.enable("strikethrough");
  const tableMode = options.tableMode ?? "code";
  if (tableMode !== "off") {
    md.enable("table");
  } else {
    md.disable("table");
  }
  if (options.autolink === false) md.disable("autolink");
  return md;
}

function getAttr(token: MarkdownToken, name: string): string | null {
  if (token.attrGet) return token.attrGet(name);
  if (token.attrs) {
    for (const [key, value] of token.attrs) {
      if (key === name) return value;
    }
  }
  return null;
}

function initRenderTarget(): RenderTarget {
  return { text: "", styles: [], openStyles: [], links: [], linkStack: [] };
}

function resolveRenderTarget(state: RenderState): RenderTarget {
  return state.table?.currentCell ?? state;
}

function appendText(state: RenderState, value: string) {
  if (!value) return;
  resolveRenderTarget(state).text += value;
}

function openStyle(state: RenderState, style: MarkdownStyle) {
  const target = resolveRenderTarget(state);
  target.openStyles.push({ style, start: target.text.length });
}

function closeStyle(state: RenderState, style: MarkdownStyle) {
  const target = resolveRenderTarget(state);
  for (let i = target.openStyles.length - 1; i >= 0; i--) {
    if (target.openStyles[i]?.style === style) {
      const start = target.openStyles[i].start;
      target.openStyles.splice(i, 1);
      const end = target.text.length;
      if (end > start) target.styles.push({ start, end, style });
      return;
    }
  }
}

function appendParagraphSeparator(state: RenderState) {
  if (state.table) return;
  if (state.env.listStack.length > 0) {
    if (!state.text.endsWith("\n")) {
      state.text += "\n";
    }
    return;
  }
  state.text += "\n\n";
}

function appendListPrefix(state: RenderState) {
  const stack = state.env.listStack;
  const top = stack[stack.length - 1];
  if (!top) return;
  top.index++;
  const indent = " ".repeat(Math.max(0, stack.length - 1));
  const prefix = top.type === "ordered" ? `${top.index}. ` : "• ";
  state.text += `${indent}${prefix}`;
}

function renderInlineCode(state: RenderState, content: string) {
  if (!content) return;
  const target = resolveRenderTarget(state);
  const start = target.text.length;
  target.text += content;
  target.styles.push({ start, end: start + content.length, style: "code" });
}

function renderCodeBlock(state: RenderState, content: string) {
  let code = content ?? "";
  if (!code.endsWith("\n")) code = `${code}\n`;
  const target = resolveRenderTarget(state);
  const start = target.text.length;
  target.text += code;
  target.styles.push({ start, end: start + code.length, style: "code_block" });
  if (state.env.listStack.length === 0) target.text += "\n";
}

function handleLinkClose(state: RenderState) {
  const target = resolveRenderTarget(state);
  const link = target.linkStack.pop();
  if (!link?.href) return;
  const href = link.href.trim();
  if (!href) return;
  target.links.push({ start: link.labelStart, end: target.text.length, href });
}

function initTableState(): TableState {
  return { headers: [], rows: [], currentRow: [], currentCell: null, inHeader: false };
}

function finishTableCell(cell: RenderTarget): TableCell {
  closeRemainingStyles(cell);
  return { text: cell.text, styles: cell.styles, links: cell.links };
}

function trimCell(cell: TableCell): TableCell {
  const text = cell.text;
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start] ?? "")) start++;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
  if (start === 0 && end === text.length) return cell;
  const trimmedText = text.slice(start, end);
  const len = trimmedText.length;
  return {
    text: trimmedText,
    styles: cell.styles.flatMap((s) => {
      const ns = Math.max(0, s.start - start);
      const ne = Math.min(len, s.end - start);
      return ne > ns ? [{ start: ns, end: ne, style: s.style }] : [];
    }),
    links: cell.links.flatMap((l) => {
      const ns = Math.max(0, l.start - start);
      const ne = Math.min(len, l.end - start);
      return ne > ns ? [{ start: ns, end: ne, href: l.href }] : [];
    }),
  };
}

function appendCell(state: RenderState, cell: TableCell) {
  if (!cell.text) return;
  const start = state.text.length;
  state.text += cell.text;
  for (const s of cell.styles) state.styles.push({ start: start + s.start, end: start + s.end, style: s.style });
  for (const l of cell.links) state.links.push({ start: start + l.start, end: start + l.end, href: l.href });
}

function appendCellTextOnly(state: RenderState, cell: TableCell) {
  if (!cell.text) return;
  state.text += cell.text;
  // Do not append styles - this is used for code blocks where inner styles would overlap
}

function renderTableAsCode(state: RenderState) {
  if (!state.table) return;
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((row) => row.map(trimCell));

  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length));
  if (columnCount === 0) return;

  const widths = Array.from({ length: columnCount }, () => 0);
  const updateWidths = (cells: TableCell[]) => {
    for (let i = 0; i < columnCount; i += 1) {
      const cell = cells[i];
      const width = cell?.text.length ?? 0;
      if (widths[i] < width) {
        widths[i] = width;
      }
    }
  };
  updateWidths(headers);
  for (const row of rows) {
    updateWidths(row);
  }

  const codeStart = state.text.length;

  const appendRow = (cells: TableCell[]) => {
    state.text += "|";
    for (let i = 0; i < columnCount; i += 1) {
      state.text += " ";
      const cell = cells[i];
      if (cell) {
        appendCellTextOnly(state, cell);
      }
      const pad = widths[i] - (cell?.text.length ?? 0);
      if (pad > 0) {
        state.text += " ".repeat(pad);
      }
      state.text += " |";
    }
    state.text += "\n";
  };

  const appendDivider = () => {
    state.text += "|";
    for (let i = 0; i < columnCount; i += 1) {
      const dashCount = Math.max(3, widths[i]);
      state.text += ` ${"-".repeat(dashCount)} |`;
    }
    state.text += "\n";
  };

  appendRow(headers);
  appendDivider();
  for (const row of rows) {
    appendRow(row);
  }

  const codeEnd = state.text.length;
  if (codeEnd > codeStart) {
    state.styles.push({ start: codeStart, end: codeEnd, style: "code_block" });
  }
  if (state.env.listStack.length === 0) {
    state.text += "\n";
  }
}

function renderTableAsBullets(state: RenderState) {
  if (!state.table) return;
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((r) => r.map(trimCell));
  if (headers.length === 0 && rows.length === 0) return;

  for (const row of rows) {
    if (row.length === 0) continue;
    const rowLabel = row[0];
    if (rowLabel?.text) {
      const labelStart = state.text.length;
      appendCell(state, rowLabel);
      state.styles.push({ start: labelStart, end: state.text.length, style: "bold" });
      state.text += "\n";
    }
    for (let i = 1; i < row.length; i++) {
      const header = headers[i];
      const value = row[i];
      if (!value?.text) continue;
      state.text += "• ";
      if (header?.text) { appendCell(state, header); state.text += ": "; }
      appendCell(state, value);
      state.text += "\n";
    }
    state.text += "\n";
  }
}

function renderTokens(tokens: MarkdownToken[], state: RenderState): void {
  for (const token of tokens) {
    switch (token.type) {
      case "inline": if (token.children) renderTokens(token.children, state); break;
      case "text": appendText(state, token.content ?? ""); break;
      case "em_open": openStyle(state, "italic"); break;
      case "em_close": closeStyle(state, "italic"); break;
      case "strong_open": openStyle(state, "bold"); break;
      case "strong_close": closeStyle(state, "bold"); break;
      case "s_open": openStyle(state, "strikethrough"); break;
      case "s_close": closeStyle(state, "strikethrough"); break;
      case "code_inline": renderInlineCode(state, token.content ?? ""); break;
      case "link_open": {
        const href = getAttr(token, "href") ?? "";
        const target = resolveRenderTarget(state);
        target.linkStack.push({ href, labelStart: target.text.length });
        break;
      }
      case "link_close": handleLinkClose(state); break;
      case "image": appendText(state, token.content ?? ""); break;
      case "softbreak": case "hardbreak": appendText(state, "\n"); break;
      case "paragraph_close": appendParagraphSeparator(state); break;
      case "heading_open": if (state.headingStyle === "bold") openStyle(state, "bold"); break;
      case "heading_close":
        if (state.headingStyle === "bold") closeStyle(state, "bold");
        appendParagraphSeparator(state);
        break;
      case "blockquote_open":
        if (state.blockquotePrefix) state.text += state.blockquotePrefix;
        openStyle(state, "blockquote");
        break;
      case "blockquote_close": closeStyle(state, "blockquote"); state.text += "\n"; break;
      case "bullet_list_open": state.env.listStack.push({ type: "bullet", index: 0 }); break;
      case "bullet_list_close": state.env.listStack.pop(); break;
      case "ordered_list_open": {
        const start = Number(getAttr(token, "start") ?? "1");
        state.env.listStack.push({ type: "ordered", index: start - 1 });
        break;
      }
      case "ordered_list_close": state.env.listStack.pop(); break;
      case "list_item_open": appendListPrefix(state); break;
      case "list_item_close": state.text += "\n"; break;
      case "code_block": case "fence": renderCodeBlock(state, token.content ?? ""); break;
      case "html_block": case "html_inline": appendText(state, token.content ?? ""); break;
      case "table_open": state.table = initTableState(); break;
      case "table_close":
        if (state.table) {
          if (state.tableMode === "bullets") {
            renderTableAsBullets(state);
          } else if (state.tableMode === "code") {
            renderTableAsCode(state);
          }
        }
        state.table = null;
        break;
      case "thead_open": if (state.table) state.table.inHeader = true; break;
      case "thead_close": if (state.table) state.table.inHeader = false; break;
      case "tbody_open": case "tbody_close": break;
      case "tr_open": if (state.table) state.table.currentRow = []; break;
      case "tr_close":
        if (state.table) {
          if (state.table.inHeader) state.table.headers = state.table.currentRow;
          else state.table.rows.push(state.table.currentRow);
          state.table.currentRow = [];
        }
        break;
      case "th_open": case "td_open":
        if (state.table) state.table.currentCell = initRenderTarget();
        break;
      case "th_close": case "td_close":
        if (state.table?.currentCell) {
          state.table.currentRow.push(finishTableCell(state.table.currentCell));
          state.table.currentCell = null;
        }
        break;
      case "hr": state.text += "\n"; break;
      default: if (token.children) renderTokens(token.children, state); break;
    }
  }
}

function closeRemainingStyles(target: RenderTarget) {
  for (let i = target.openStyles.length - 1; i >= 0; i--) {
    const open = target.openStyles[i];
    const end = target.text.length;
    if (end > open.start) target.styles.push({ start: open.start, end, style: open.style });
  }
  target.openStyles = [];
}

function clampSpans<T extends { start: number; end: number }>(spans: T[], maxLength: number): T[] {
  return spans.flatMap((span) => {
    const s = Math.max(0, Math.min(span.start, maxLength));
    const e = Math.max(s, Math.min(span.end, maxLength));
    return e > s ? [{ ...span, start: s, end: e }] : [];
  });
}

function mergeStyleSpans(spans: MarkdownStyleSpan[]): MarkdownStyleSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end || a.style.localeCompare(b.style));
  const merged: MarkdownStyleSpan[] = [];
  for (const span of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.style === span.style && span.start <= prev.end) {
      prev.end = Math.max(prev.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

export function markdownToIR(markdown: string, options: MarkdownParseOptions = {}): MarkdownIR {
  const env: RenderEnv = { listStack: [] };
  const md = createMarkdownIt(options);
  const tokens = md.parse(markdown ?? "", env as unknown as object);

  const state: RenderState = {
    text: "", styles: [], openStyles: [], links: [], linkStack: [],
    env,
    headingStyle: options.headingStyle ?? "none",
    blockquotePrefix: options.blockquotePrefix ?? "",
    enableSpoilers: options.enableSpoilers ?? false,
    tableMode: options.tableMode ?? "code",
    table: null,
  };

  renderTokens(tokens as MarkdownToken[], state);
  closeRemainingStyles(state);

  const trimmedLength = state.text.trimEnd().length;
  let codeBlockEnd = 0;
  for (const s of state.styles) {
    if (s.style === "code_block" && s.end > codeBlockEnd) codeBlockEnd = s.end;
  }
  const finalLength = Math.max(trimmedLength, codeBlockEnd);
  const finalText = finalLength === state.text.length ? state.text : state.text.slice(0, finalLength);

  return {
    text: finalText,
    styles: mergeStyleSpans(clampSpans(state.styles, finalLength)),
    links: clampSpans(state.links, finalLength),
  };
}

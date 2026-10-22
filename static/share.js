class ShareRenderer {
  constructor() {
    this.shareId = document.body.dataset.shareId;
    this.config = this.readConfig();
    this.data = null;
    this.init();
  }

  async init() {
    try {
      await this.loadShareData();
      this.renderShare();
    } catch (error) {
      console.error('Failed to load share:', error);
      this.showError();
    }
  }

  // Display settings from the server (see src/config.rs)
  readConfig() {
    const defaults = { showCost: false, showTokens: false, directory: 'name', finalAnswersOnly: true, expiresAt: null };
    try {
      return { ...defaults, ...JSON.parse(document.body.dataset.config || '{}') };
    } catch (error) {
      return defaults;
    }
  }

  formatDirectory(directory) {
    if (!directory || this.config.directory === 'none') return '';
    if (this.config.directory === 'full') return directory;
    return directory.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  }

  async loadShareData() {
    const response = await fetch(`/api/share/${encodeURIComponent(this.shareId)}/data`);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Share not found');
      }
      throw new Error('Failed to load share data');
    }

    const rawData = await response.json();
    this.data = this.processShareData(rawData);
  }

  processShareData(rawData) {
    const result = {
      shareId: this.shareId,
      session: null,
      messages: {},
      parts: {},
      diffs: null,
      models: [],
      shareMeta: {},
      sessionStatus: { type: 'idle' }
    };

    for (const item of rawData) {
      switch (item.type) {
        case 'session':
          result.session = item.data;
          break;
        case 'message':
          if (!result.messages[item.data.sessionID]) {
            result.messages[item.data.sessionID] = [];
          }
          result.messages[item.data.sessionID].push(item.data);
          break;
        case 'part':
          if (!result.parts[item.data.messageID]) {
            result.parts[item.data.messageID] = [];
          }
          result.parts[item.data.messageID].push(item.data);
          break;
        case 'session_diff':
          result.diffs = item.data;
          break;
        case 'model':
          result.models.push(item.data);
          break;
        case 'share_meta':
          result.shareMeta = item.data || {};
          break;
      }
    }

    // Sort messages by creation time
    for (const sessionId in result.messages) {
      result.messages[sessionId].sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
    }

    // Part IDs are time-ordered, so sorting by ID restores the original sequence
    for (const messageId in result.parts) {
      result.parts[messageId].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }

    return result;
  }

  // Render message content (parts) to HTML
  getMessageContent(message) {
    if (message.content) {
      return this.renderMarkdown(message.content);
    }

    const parts = this.data.parts[message.id] || [];
    if (parts.length === 0) {
      const role = this.escapeHtml(message.role || 'unknown');
      const model = this.escapeHtml(message.modelID || 'unknown model');
      const finish = this.escapeHtml(message.finish || 'unknown');
      return `<p class="message-empty">${role} message via ${model} (${finish})</p>`;
    }

    let content = '';
    let seenStep = false;

    for (const part of parts) {
      switch (part.type) {
        case 'text':
          if (part.text && part.text.trim()) {
            content += this.renderMarkdown(part.text);
          }
          break;

        case 'reasoning':
          if (part.text && part.text.trim()) {
            content += this.renderReasoning(part.text.trim());
          }
          break;

        case 'tool':
        case 'tool-call':
          if (part.state) {
            content += this.formatToolCall(part.state, part.tool);
          }
          break;

        case 'step-start':
          // Only separate consecutive steps within one assistant turn
          if (seenStep) {
            content += '<hr class="step-divider">';
          }
          seenStep = true;
          break;

        case 'step-finish':
          // Token usage is summarized in the message header
          break;

        case 'file':
          content += `<div class="file-chip">📎 ${this.escapeHtml(part.filename || part.mime || 'file')}</div>`;
          break;

        default:
          // Handle unknown part types
          if (part.text) {
            content += `<div class="part-unknown">`;
            content += `<div class="part-label">${this.escapeHtml(part.type)}</div>`;
            content += this.renderMarkdown(part.text);
            content += `</div>`;
          }
      }
    }

    return content || `<p class="message-empty">No content</p>`;
  }

  renderReasoning(text) {
    const firstLine = text.split('\n').find(line => line.trim()) || '';

    return `
      <details class="reasoning-block">
        <summary class="reasoning-header disclosure">
          <span class="reasoning-title">Thinking</span>
          <span class="reasoning-preview">${this.escapeHtml(firstLine)}</span>
        </summary>
        <div class="reasoning-content">${this.renderMarkdown(text)}</div>
      </details>
    `;
  }

  // Format tool call information
  formatToolCall(state, toolName = null) {
    // The tool type (bash, grep, view, write, read, etc.) should come from the part's tool field
    const tool = toolName ||
                 state.toolType ||
                 state.tool ||
                 state.type ||
                 'unknown';

    // The title is a descriptive description of what this specific call does
    const title = state.title ||
                  state.name ||
                  state.description ||
                  state.metadata?.description ||
                  state.input?.description ||
                  '';

    const status = state.status || 'unknown';
    const isError = status === 'error' || status === 'failed';

    // Generate a unique ID for this tool call
    const toolId = `tool-${Math.random().toString(36).substr(2, 9)}`;
    const hasOutput = state.output && state.output.trim();
    const outputLines = hasOutput ? state.output.trim().split('\n').length : 0;
    const isLongOutput = outputLines > 10;

    const safeStatus = this.escapeHtml(status);
    const duration = state.time?.start && state.time?.end ? state.time.end - state.time.start : null;

    let result = `<details class="tool-call" data-status="${safeStatus}"${isError ? ' open' : ''}>`;
    result += `<summary class="tool-header disclosure">`;
    result += `<span class="tool-name">${this.escapeHtml(tool)}</span>`;
    result += `<span class="tool-title">${title && title !== tool ? this.escapeHtml(title) : ''}</span>`;
    if (duration !== null) {
      result += `<span class="tool-duration">${this.formatDuration(duration)}</span>`;
    }
    result += `<span class="tool-status status-${safeStatus}">${safeStatus}</span>`;
    result += `</summary>`;

    // Tool details section
    result += `<div class="tool-details">`;

    // Add input
    if (state.input) {
      result += `<div class="tool-input">`;
      result += `<div class="tool-label">Input</div>`;
      if (typeof state.input === 'string') {
        result += `<code class="tool-inline-code">${this.escapeHtml(state.input)}</code>`;
      } else if (state.input.command) {
        result += `<div class="tool-command">`;
        result += `<span class="prompt">$</span>`;
        result += `<code>${this.escapeHtml(state.input.command)}</code>`;
        result += `</div>`;
        if (state.input.description && state.input.description !== title) {
          result += `<div class="tool-description">${this.escapeHtml(state.input.description)}</div>`;
        }
      } else {
        result += `<pre class="tool-json"><code>${this.escapeHtml(JSON.stringify(state.input, null, 2))}</code></pre>`;
      }
      result += `</div>`;
    }

    // Add output with collapsible functionality
    if (hasOutput) {
      const outputClass = isLongOutput ? 'tool-output tool-output-collapsible' : 'tool-output';
      const preview = isLongOutput ? state.output.trim().split('\n').slice(0, 5).join('\n') : state.output.trim();
      const fullOutput = state.output.trim();
      const safePreview = this.escapeHtml(preview);
      const safeFullOutput = this.escapeHtml(fullOutput);

      result += `<div class="${outputClass}" id="${toolId}">`;
      result += `<div class="tool-label">Output`;

      if (isLongOutput) {
        result += `<button class="tool-expand-btn" type="button" data-tool-id="${toolId}">`;
        result += `<span class="expand-text">Show all ${outputLines} lines</span>`;
        result += `<span class="collapse-text">Show less</span>`;
        result += `</button>`;
      }

      result += `</div>`;

      if (isLongOutput) {
        result += `<div class="output-preview"><pre><code>${safePreview}</code></pre></div>`;
        result += `<div class="output-full" style="display:none;"><pre><code>${safeFullOutput}</code></pre></div>`;
      } else {
        result += `<pre><code>${safeFullOutput}</code></pre>`;
      }

      result += `</div>`;
    }

    if (state.error) {
      result += `<div class="tool-output tool-error">`;
      result += `<div class="tool-label">Error</div>`;
      result += `<pre><code>${this.escapeHtml(String(state.error).trim())}</code></pre>`;
      result += `</div>`;
    }

    if (state.metadata && state.metadata.exit !== undefined) {
      const exitCode = state.metadata.exit;
      const exitClass = exitCode === 0 ? 'exit-success' : 'exit-error';
      result += `<div class="tool-metadata"><span class="${exitClass}">Exit ${this.escapeHtml(exitCode)}</span></div>`;
    }

    result += `</div>`; // Close tool-details
    result += `</details>`; // Close tool-call

    return result;
  }

  // Minimal Markdown renderer. The text is escaped up front, so the only
  // markup that can reach the DOM is what this renderer emits.
  renderMarkdown(text) {
    const lines = this.escapeHtml(text).replace(/\r\n?/g, '\n').split('\n');
    return this.renderBlocks(lines);
  }

  renderBlocks(lines) {
    const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
    const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
    const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
    const QUOTE_RE = /^\s{0,3}&gt;\s?(.*)$/;
    const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

    const isTableStart = (i) =>
      lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]);
    const startsBlock = (i) =>
      FENCE_RE.test(lines[i]) || HEADING_RE.test(lines[i]) || HR_RE.test(lines[i]) ||
      LIST_RE.test(lines[i]) || QUOTE_RE.test(lines[i]) || isTableStart(i);
    const splitRow = (line) =>
      line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => this.renderInline(cell.trim()));

    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i++;
        continue;
      }

      const fence = line.match(FENCE_RE);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
          code.push(lines[i++]);
        }
        i++; // Skip the closing fence
        const lang = fence[2] ? ` data-lang="${fence[2]}"` : '';
        html.push(`<pre class="md-code"${lang}><code>${code.join('\n')}</code></pre>`);
        continue;
      }

      const heading = line.match(HEADING_RE);
      if (heading) {
        const level = heading[1].length;
        html.push(`<h${level}>${this.renderInline(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      if (HR_RE.test(line)) {
        html.push('<hr>');
        i++;
        continue;
      }

      if (QUOTE_RE.test(line)) {
        const quoted = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          quoted.push(lines[i++].match(QUOTE_RE)[1]);
        }
        html.push(`<blockquote>${this.renderBlocks(quoted)}</blockquote>`);
        continue;
      }

      if (isTableStart(i)) {
        const header = splitRow(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i++]));
        }
        html.push(
          `<div class="md-table-wrap"><table>` +
          `<thead><tr>${header.map(cell => `<th>${cell}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>` +
          `</table></div>`
        );
        continue;
      }

      const listItem = line.match(LIST_RE);
      if (listItem) {
        const indent = listItem[1].length;
        const ordered = /\d/.test(listItem[2]);
        const items = [];

        while (i < lines.length) {
          const current = lines[i];
          const match = current.match(LIST_RE);

          if (match && match[1].length <= indent + 1) {
            items.push({ text: match[3], children: [] });
            i++;
          } else if (!current.trim()) {
            // A blank line only continues the list if more indented or list content follows
            let next = i + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            const nextLine = lines[next] || '';
            const nextIndent = nextLine.match(/^\s*/)[0].length;
            if (next < lines.length && (nextIndent > indent || (LIST_RE.test(nextLine) && nextIndent === indent))) {
              items[items.length - 1].children.push('');
              i++;
            } else {
              break;
            }
          } else if (current.match(/^\s*/)[0].length > indent) {
            items[items.length - 1].children.push(current.replace(new RegExp(`^\\s{0,${indent + 4}}`), ''));
            i++;
          } else {
            break;
          }
        }

        const tag = ordered ? 'ol' : 'ul';
        const start = ordered && parseInt(listItem[2], 10) !== 1 ? ` start="${parseInt(listItem[2], 10)}"` : '';
        const body = items.map(item => {
          const children = item.children.some(child => child.trim()) ? this.renderBlocks(item.children) : '';
          return `<li>${this.renderInline(item.text)}${children}</li>`;
        }).join('');
        html.push(`<${tag}${start}>${body}</${tag}>`);
        continue;
      }

      // Paragraph: consecutive lines until a blank line or another block starts
      const paragraph = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(i)) {
        paragraph.push(lines[i++]);
      }
      html.push(`<p>${paragraph.map(l => this.renderInline(l.trim())).join('<br>')}</p>`);
    }

    return html.join('');
  }

  // Inline formatting on already-escaped text
  renderInline(text) {
    const tokens = [];
    const stash = (html) => `${tokens.push(html) - 1}`;

    let out = text
      .replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (_, ticks, code) => stash(`<code>${code.trim()}</code>`))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
        stash(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`));

    out = out
      .replace(/\*\*(?=\S)(.*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?=\S)(.*?\S)__(?![\w])/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=[^\s_])([^_]*?[^\s_])_(?![_\w])/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)(.*?\S)~~/g, '<del>$1</del>');

    return out.replace(/(\d+)/g, (_, index) => tokens[index]);
  }

  formatNumber(value) {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
  }

  formatCost(cost) {
    const value = Number(cost) || 0;
    if (value >= 0.01) return `$${value.toFixed(2)}`;
    if (value >= 0.0001) return `$${Number(value.toPrecision(2))}`;
    return '<$0.0001';
  }

  formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  }

  getSessionStats(session, sessionMessages) {
    const tokens = session.tokens || sessionMessages.reduce((sum, message) => {
      sum.input += message.tokens?.input || 0;
      sum.output += message.tokens?.output || 0;
      sum.reasoning += message.tokens?.reasoning || 0;
      return sum;
    }, { input: 0, output: 0, reasoning: 0 });

    const cost = session.cost ?? sessionMessages.reduce((sum, message) => sum + (message.cost || 0), 0);

    return { tokens, cost };
  }

  renderShare() {
    const app = document.getElementById('app');
    app.innerHTML = this.generateShareHTML();
    if (this.data.session?.title) {
      document.title = `${this.data.session.title} · Opencode Share`;
    }
    this.attachEventListeners();
  }

  generateShareHTML() {
    const { session, messages, diffs } = this.data;
    if (!session) {
      return this.generateErrorHTML();
    }

    const sessionId = session.id;
    const sessionMessages = messages[sessionId] || [];
    const { tokens, cost } = this.getSessionStats(session, sessionMessages);
    const created = session.time?.created ? new Date(session.time.created) : null;
    const summary = session.summary || {};

    // An assistant message is intermediate when another assistant message
    // follows it before the next user message
    const intermediateIds = new Set(sessionMessages
      .filter((message, index) => message.role !== 'user' && sessionMessages[index + 1] && sessionMessages[index + 1].role !== 'user')
      .map(message => message.id));

    const directory = this.formatDirectory(session.directory);
    const expiresAt = this.config.expiresAt ? new Date(this.config.expiresAt) : null;
    const author = typeof this.data.shareMeta.author === 'string' ? this.data.shareMeta.author.trim() : '';
    const { showTokens, showCost } = this.config;

    const meta = [
      created && `<span>Created <time datetime="${created.toISOString()}">${this.escapeHtml(created.toLocaleDateString([], { dateStyle: 'medium' }))}</time></span>`,
      directory && `<span class="session-directory" title="Project directory">${this.escapeHtml(directory)}</span>`,
      session.version && `<span>opencode v${this.escapeHtml(session.version)}</span>`,
      author && `<span class="session-author">Shared by ${this.escapeHtml(author)}</span>`,
      expiresAt && `<span class="session-expiry">Expires ${this.escapeHtml(expiresAt.toLocaleDateString([], { dateStyle: 'medium' }))}</span>`
    ].filter(Boolean);

    const stats = [
      showTokens && tokens.input && ['Input', this.formatNumber(tokens.input)],
      showTokens && tokens.output && ['Output', this.formatNumber(tokens.output)],
      showTokens && tokens.reasoning && ['Reasoning', this.formatNumber(tokens.reasoning)],
      showCost && cost && ['Cost', this.formatCost(cost)]
    ].filter(Boolean);

    return `
      <div class="share-container">
        <header class="header">
          <div class="header-inner">
            <div class="brand">
              <img src="/static/favicon.svg" alt="" width="20" height="20">
              <span>Opencode Share</span>
            </div>
            <div class="header-actions">
              <code class="share-id" title="Session ID">${this.escapeHtml(sessionId)}</code>
              <button class="copy-link-btn" type="button">Copy link</button>
            </div>
          </div>
        </header>

        <main class="content">
          <section class="session-info">
            <h1 class="session-title">${this.escapeHtml(session.title)}</h1>
            <div class="session-meta">${meta.join('')}</div>
            <div class="session-stats">
              <div class="stat-item">
                <span class="stat-label">Messages</span>
                <span class="stat-value message-count" data-total="${sessionMessages.length}" data-final="${sessionMessages.length - intermediateIds.size}">${sessionMessages.length}</span>
              </div>
              ${stats.map(([label, value]) => `
                <div class="stat-item">
                  <span class="stat-label">${label}</span>
                  <span class="stat-value">${this.escapeHtml(value)}</span>
                </div>
              `).join('')}
              ${summary.files ? `
                <div class="stat-item">
                  <span class="stat-label">Files</span>
                  <span class="stat-value">${this.escapeHtml(summary.files)}</span>
                  <span class="stat-added">+${this.escapeHtml(summary.additions || 0)}</span>
                  <span class="stat-removed">−${this.escapeHtml(summary.deletions || 0)}</span>
                </div>
              ` : ''}
            </div>
          </section>

          ${intermediateIds.size > 0 ? `
            <div class="messages-toolbar">
              <button class="toggle-intermediate" type="button" aria-pressed="false" title="Show only the last assistant message after each user message">
                <span class="toggle-switch" aria-hidden="true"></span>
                Final answers only
              </button>
            </div>
          ` : ''}

          <div class="session-messages">
            ${this.renderMessages(sessionMessages, intermediateIds)}
          </div>
        </main>

        ${diffs && diffs.length > 0 ? `
          <section class="diff-container">
            <h2 class="section-title">${diffs.length} ${diffs.length === 1 ? 'file' : 'files'} changed</h2>
            ${diffs.map(diff => this.renderDiff(diff)).join('')}
          </section>
        ` : ''}
      </div>
    `;
  }

  renderMessages(sessionMessages, intermediateIds) {
    let hiddenCount = 0;

    return sessionMessages.map(message => {
      if (intermediateIds.has(message.id)) {
        hiddenCount++;
        return this.renderMessage(message, true);
      }

      // Placeholder for the intermediate messages before this one, only visible while they are hidden
      const marker = hiddenCount > 0
        ? `<button class="intermediate-marker" type="button">${hiddenCount} intermediate ${hiddenCount === 1 ? 'message' : 'messages'} hidden</button>`
        : '';
      // The last agent message of each turn is its answer
      const isFinal = message.role !== 'user';
      hiddenCount = 0;
      return marker + this.renderMessage(message, false, isFinal);
    }).join('');
  }

  renderMessage(message, isIntermediate = false, isFinal = false) {
    const content = this.getMessageContent(message);
    const role = message.role === 'user' ? 'user' : 'assistant';
    const model = message.modelID || '';
    const tokens = message.tokens || {};

    const meta = [];
    if (model) {
      meta.push(`<span class="message-model">${this.escapeHtml(model)}</span>`);
    }
    if (this.config.showTokens && (tokens.input || tokens.output)) {
      meta.push(`<span class="message-tokens" title="Input / output tokens">${this.formatNumber(tokens.input)} in · ${this.formatNumber(tokens.output)} out</span>`);
    }
    if (this.config.showCost && message.cost) {
      meta.push(`<span class="message-cost">${this.formatCost(message.cost)}</span>`);
    }

    return `
      <article class="message message-${role}${isIntermediate ? ' message-intermediate' : ''}${isFinal ? ' message-final' : ''}">
        <header class="message-header">
          <span class="message-role">${role === 'user' ? 'User' : 'Assistant'}</span>
          <div class="message-meta">${meta.join('')}</div>
        </header>
        <div class="message-content">${content}</div>
      </article>
    `;
  }

  renderDiff(diff) {
    const result = this.formatDiff(diff);
    const diffId = `diff-${Math.random().toString(36).substr(2, 9)}`;

    return `
      <details class="diff-file" data-diff-id="${diffId}" open>
        <summary class="diff-file-name disclosure">
          <span class="diff-file-path">${this.escapeHtml(diff.file)}</span>
          <span class="diff-stats">
            <span class="stat-added">+${result.addedCount}</span>
            <span class="stat-removed">−${result.removedCount}</span>
          </span>
        </summary>
        <div class="diff-split-view">
          <div class="diff-side diff-before">
            <div class="diff-side-header">Before</div>
            <div class="diff-side-content diff-scrollable" id="${diffId}-before">${result.beforeHtml}</div>
          </div>
          <div class="diff-divider"></div>
          <div class="diff-side diff-after">
            <div class="diff-side-header">After</div>
            <div class="diff-side-content diff-scrollable" id="${diffId}-after">${result.afterHtml}</div>
          </div>
        </div>
      </details>
    `;
  }

  formatDiff(diff) {
    let beforeHtml = '';
    let afterHtml = '';
    let addedCount = 0;
    let removedCount = 0;

    const row = (type, lineNumber, line) =>
      `<div class="diff-row ${type}"><div class="diff-line-num">${lineNumber}</div><div class="diff-cell">${line === null ? '' : this.escapeHtml(line)}</div></div>`;

    // Empty before/after means the file was created/deleted
    if (typeof diff.before === 'string' || typeof diff.after === 'string') {
      // Use diff library to compute actual differences
      const diffResult = window.Diff.diffLines(diff.before || '', diff.after || '', {
        newlineIsToken: false,
        ignoreWhitespace: false,
        oneChangePerToken: false
      });

      let beforeLineNumber = 1;
      let afterLineNumber = 1;

      diffResult.forEach(change => {
        const lines = change.value.split('\n');
        // Remove last empty element if exists
        if (lines[lines.length - 1] === '') lines.pop();

        lines.forEach(line => {
          if (change.removed) {
            beforeHtml += row('removed', beforeLineNumber++, line);
            afterHtml += row('empty', '', null);
            removedCount++;
          } else if (change.added) {
            beforeHtml += row('empty', '', null);
            afterHtml += row('added', afterLineNumber++, line);
            addedCount++;
          } else {
            beforeHtml += row('unchanged', beforeLineNumber++, line);
            afterHtml += row('unchanged', afterLineNumber++, line);
          }
        });
      });
    }

    return { beforeHtml, afterHtml, addedCount, removedCount };
  }

  // Escape for both text and attribute contexts (quotes included)
  escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  attachEventListeners() {
    // Add event listeners for tool expand buttons
    const expandButtons = document.querySelectorAll('.tool-expand-btn');
    expandButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        const toolOutput = button.closest('.tool-output');
        if (toolOutput) {
          toolOutput.classList.toggle('expanded');
        }
      });
    });

    const copyButton = document.querySelector('.copy-link-btn');
    if (copyButton) {
      copyButton.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          copyButton.textContent = 'Copied';
        } catch (error) {
          copyButton.textContent = 'Copy failed';
        }
        setTimeout(() => { copyButton.textContent = 'Copy link'; }, 1500);
      });
    }

    const toggleButton = document.querySelector('.toggle-intermediate');
    if (toggleButton) {
      const messageList = document.querySelector('.session-messages');
      const setHidden = (hidden, remember = true) => {
        messageList.classList.toggle('hide-intermediate', hidden);
        toggleButton.setAttribute('aria-pressed', String(hidden));
        const count = document.querySelector('.message-count');
        count.textContent = hidden ? `${count.dataset.final} of ${count.dataset.total}` : count.dataset.total;
        if (!remember) return;
        try {
          localStorage.setItem('hideIntermediate', hidden ? '1' : '0');
        } catch (error) {
          // Storage may be unavailable (private mode); the toggle still works
        }
      };

      // A viewer's own choice wins over the server default
      let initial = this.config.finalAnswersOnly;
      try {
        const stored = localStorage.getItem('hideIntermediate');
        if (stored !== null) initial = stored === '1';
      } catch (error) {
        // Fall back to the server default
      }
      setHidden(initial, false);

      toggleButton.addEventListener('click', () => {
        setHidden(toggleButton.getAttribute('aria-pressed') !== 'true');
      });
      document.querySelectorAll('.intermediate-marker').forEach(marker => {
        marker.addEventListener('click', () => setHidden(false));
      });
    }

    // Add synchronized scrolling for diff views
    const diffScrollables = document.querySelectorAll('.diff-scrollable');
    diffScrollables.forEach(scrollable => {
      scrollable.addEventListener('scroll', (e) => {
        const id = e.target.id;
        const pairedId = id.endsWith('-before') ? id.replace(/-before$/, '-after') : id.replace(/-after$/, '-before');
        const pairedElement = document.getElementById(pairedId);

        if (pairedElement && pairedElement !== e.target) {
          pairedElement.scrollTop = e.target.scrollTop;
          pairedElement.scrollLeft = e.target.scrollLeft;
        }
      });
    });
  }

  showError() {
    document.getElementById('app').style.display = 'none';
    document.getElementById('error-container').style.display = 'flex';
  }

  generateErrorHTML() {
    return `
      <div class="error-content">
        <h1>Share Data Missing</h1>
        <p>The share data is incomplete or corrupted.</p>
        <a href="/">Go Home</a>
      </div>
    `;
  }
}

// Initialize the share renderer when the page loads
document.addEventListener('DOMContentLoaded', () => {
  new ShareRenderer();
});

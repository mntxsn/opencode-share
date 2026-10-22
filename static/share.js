class ShareRenderer {
  constructor() {
    this.shareId = document.body.dataset.shareId;
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
      }
    }

    // Sort messages by creation time
    for (const sessionId in result.messages) {
      result.messages[sessionId].sort((a, b) => a.time.created - b.time.created);
    }

    return result;
  }

  // Extract message content from message data
  getMessageContent(message) {
    // Check if message has content directly or in parts
    if (message.content) {
      return this.escapeHtml(message.content);
    }

    // Get all parts for this message
    const parts = this.data.parts[message.id] || [];
    if (parts.length === 0) {
      // No parts, provide basic message info
      const role = this.escapeHtml(message.role || 'unknown');
      const model = this.escapeHtml(message.modelID || 'unknown model');
      const finish = this.escapeHtml(message.finish || 'unknown');
      return `[${role} message via ${model} - ${finish}]`;
    }
    
    // Process parts to build content
    let content = '';
    
    // Sort parts by time if available, otherwise by type
    const sortedParts = parts.sort((a, b) => {
      if (a.time && b.time) {
        return (a.time.start || a.time.end || 0) - (b.time.start || b.time.end || 0);
      }
      // Fallback: prioritize certain types
      const typeOrder = {
        'step-start': 0,
        'reasoning': 1,
        'text': 2,
        'tool': 3,
        'tool-call': 3,
        'step-finish': 4
      };
      return (typeOrder[a.type] || 99) - (typeOrder[b.type] || 99);
    });
    
    for (const part of sortedParts) {
      switch (part.type) {
        case 'text':
          if (part.text) {
            content += this.escapeHtml(part.text) + '\n\n';
          }
          break;

         case 'reasoning':
           if (part.text && part.text.trim()) {
             const reasoningId = `reasoning-${Math.random().toString(36).substr(2, 9)}`;
             const isLongReasoning = part.text.trim().split('\n').length > 5;
             const safeText = this.escapeHtml(part.text.trim());

             content += `<div class="reasoning-block" id="${reasoningId}">`;
             content += `<div class="reasoning-header">`;
             content += `<span class="reasoning-icon">🤔</span>`;
             content += `<span class="reasoning-title">Thinking Process</span>`;
             if (isLongReasoning) {
               content += `<button class="reasoning-toggle" data-reasoning-id="${reasoningId}">`;
               content += `<span class="show-text">Show details</span>`;
               content += `<span class="hide-text" style="display:none">Hide</span>`;
               content += `</button>`;
             }
             content += `</div>`;

             if (isLongReasoning) {
               content += `<div class="reasoning-content collapsible" style="display:none;">`;
               content += `<pre><code>${safeText}</code></pre>`;
               content += `</div>`;
             } else {
               content += `<div class="reasoning-content">`;
               content += `<pre><code>${safeText}</code></pre>`;
               content += `</div>`;
             }

             content += `</div>`;
           }
           break;

        case 'tool':
        case 'tool-call':
          if (part.state) {
            const toolInfo = this.formatToolCall(part.state, part.tool);
            content += toolInfo;
          }
          break;

        case 'step-start':
          content += `<div class="step-marker step-start">🚀 Step Started</div>\n\n`;
          break;

        case 'step-finish':
          if (part.tokens) {
            const tokenInfo = this.formatTokenUsage(part.tokens);
            content += `<div class="step-marker step-complete">✅ Step Completed ${tokenInfo}</div>\n\n`;
          } else {
            content += `<div class="step-marker step-complete">✅ Step Completed</div>\n\n`;
          }
          break;

         default:
           // Handle unknown part types
           if (part.text) {
             const safeType = this.escapeHtml(part.type);
             const safeText = this.escapeHtml(part.text);
             content += `📝 **${safeType}:**\n${safeText}\n\n`;
           }
       }
     }
    
    return content.trim() || `[${this.escapeHtml(message.role || 'unknown')} message - no content]`;
  }
  
  // Format tool call information with enhanced styling
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

    // Generate a unique ID for this tool call
    const toolId = `tool-${Math.random().toString(36).substr(2, 9)}`;
    const hasOutput = state.output && state.output.trim();
    const outputLines = hasOutput ? state.output.trim().split('\n').length : 0;
    const isLongOutput = outputLines > 10;

    const safeTool = this.escapeHtml(tool);
    const safeTitle = title ? this.escapeHtml(title) : '';
    const safeStatus = this.escapeHtml(status);

    let result = `<div class="tool-call" data-status="${safeStatus}">`;
    result += `<div class="tool-header">`;
    result += `<span class="tool-icon">🔧</span>`;
    result += `<span class="tool-title">${safeTool}${safeTitle ? ` - ${safeTitle}` : ''}</span>`;
    result += `<span class="tool-status status-${safeStatus}">${safeStatus}</span>`;
    result += `</div>`;

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
        if (state.input.description) {
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
        result += `<button class="tool-expand-btn" data-tool-id="${toolId}">`;
        result += `<span class="expand-text">Show full output (${outputLines} lines)</span>`;
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

    // Add metadata (exit code, duration, etc.)
    const metadata = [];
    if (state.metadata && state.metadata.exit !== undefined) {
      const exitCode = state.metadata.exit;
      const exitClass = exitCode === 0 ? 'exit-success' : 'exit-error';
      metadata.push(`<span class="${exitClass}">Exit: ${this.escapeHtml(exitCode)}</span>`);
    }

    if (state.time) {
      const start = state.time.start;
      const end = state.time.end;
      if (start && end) {
        const duration = end - start;
        metadata.push(`<span class="tool-duration">⏱ ${duration}ms</span>`);
      }
    }

    if (metadata.length > 0) {
      result += `<div class="tool-metadata">${metadata.join(' • ')}</div>`;
    }

    result += `</div>`; // Close tool-details
    result += `</div>`; // Close tool-call

    return result;
  }
  
  // Format token usage information
  formatTokenUsage(tokens) {
    const parts = [];
    
    if (tokens.input) parts.push(`📥 Input: ${this.escapeHtml(tokens.input)}`);
    if (tokens.output) parts.push(`📤 Output: ${this.escapeHtml(tokens.output)}`);
    if (tokens.reasoning) parts.push(`🧠 Reasoning: ${this.escapeHtml(tokens.reasoning)}`);

    if (tokens.cache) {
      if (tokens.cache.read) parts.push(`💾 Cache Read: ${this.escapeHtml(tokens.cache.read)}`);
      if (tokens.cache.write) parts.push(`💾 Cache Write: ${this.escapeHtml(tokens.cache.write)}`);
    }

    if (tokens.cost) {
      parts.push(`💰 Cost: $${Number(tokens.cost).toFixed(6)}`);
    }
    
    return parts.length > 0 ? `(${parts.join(', ')})` : '';
  }

  renderShare() {
    const app = document.getElementById('app');
    app.innerHTML = this.generateShareHTML();
    this.attachEventListeners();
  }

  generateShareHTML() {
    const { session, messages, diffs } = this.data;
    if (!session) {
      return this.generateErrorHTML();
    }

    const sessionId = session.id;
    const sessionMessages = messages[sessionId] || [];
    
    // Show all messages, not just user messages
    const allMessages = sessionMessages;

    return `
      <div class="share-container">
        <header class="header">
          <div class="header-left">
            <h1>Opencode Share</h1>
          </div>
        </header>

        <div class="content">
          <div class="session-info">
            <div class="session-title">${this.escapeHtml(session.title)}</div>
            <div class="session-meta">
              <span>v${this.escapeHtml(session.version || '1.0.0')}</span>
              <span>•</span>
              <span>${new Date(session.time.created).toLocaleDateString()}</span>
              ${session.directory ? `<span>•</span><span>${this.escapeHtml(session.directory)}</span>` : ''}
              ${session.summary && session.summary.files ? `<span>•</span><span>${this.escapeHtml(session.summary.files)} files</span>` : ''}
            </div>
          </div>

          <div class="session-stats">
            <div class="stat-item">
              <span class="stat-label">Messages:</span>
              <span class="stat-value">${allMessages.length}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Session:</span>
              <span class="stat-value">${this.escapeHtml(sessionId)}</span>
            </div>
          </div>

          <div class="session-messages">
            ${allMessages.map(message => this.renderMessage(message)).join('')}
          </div>

          ${diffs && diffs.length > 0 ? `
            <div class="diff-container">
              <div class="diff-header">${diffs.length} Files Changed</div>
              ${diffs.map(diff => this.renderDiff(diff)).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  renderMessage(message) {
    const content = this.getMessageContent(message);
    const role = message.role || 'unknown';
    const model = message.modelID || '';
    const timestamp = message.time ? new Date(message.time.created).toLocaleString() : '';
    const tokens = message.tokens || {};

    // Content is already escaped; any markup in it was generated by us (tool calls, reasoning blocks, step markers)
    const hasHtml = content.includes('<div class="');

    return `
      <div class="message">
        <div class="message-header">
          <div class="message-role">${role === 'user' ? '👤 User' : '🤖 Assistant'}</div>
          <div class="message-meta">
            ${model ? `<span class="message-model">${this.escapeHtml(model)}</span>` : ''}
            <span class="message-time">${timestamp}</span>
            ${tokens.input || tokens.output ? `
              <span class="message-tokens">
                ${tokens.input ? `📥 ${this.escapeHtml(tokens.input)}` : ''}
                ${tokens.output ? `📤 ${this.escapeHtml(tokens.output)}` : ''}
              </span>
            ` : ''}
          </div>
        </div>
        <div class="message-content ${hasHtml ? 'has-rich-content' : ''}">${content}</div>
      </div>
    `;
  }

  renderDiff(diff) {
    const result = this.formatDiff(diff);
    const diffId = `diff-${Math.random().toString(36).substr(2, 9)}`;

    return `
      <div class="diff-file" data-diff-id="${diffId}">
        <div class="diff-file-name">
          ${this.escapeHtml(diff.file)}
          <span class="diff-stats">
            +${result.addedCount} -${result.removedCount}
          </span>
        </div>
        <div class="diff-content">
          <div class="diff-split-view">
            <div class="diff-side diff-before">
              <div class="diff-side-header">Before</div>
              <div class="diff-side-content diff-scrollable" id="${diffId}-before">
                ${result.beforeHtml}
              </div>
            </div>
            <div class="diff-divider"></div>
            <div class="diff-side diff-after">
              <div class="diff-side-header">After</div>
              <div class="diff-side-content diff-scrollable" id="${diffId}-after">
                ${result.afterHtml}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  formatDiff(diff) {
    let beforeHtml = '';
    let afterHtml = '';
    let addedCount = 0;
    let removedCount = 0;

    if (diff.before && diff.after) {
      const beforeLines = diff.before.split('\n');
      const afterLines = diff.after.split('\n');

      // Use diff library to compute actual differences
      const diffResult = window.Diff.diffLines(diff.before, diff.after, {
        newlineIsToken: false,
        ignoreWhitespace: false,
        oneChangePerToken: false
      });

      let beforeLineNumber = 1;
      let afterLineNumber = 1;

      diffResult.forEach(change => {
        if (!change.removed && !change.added) {
          // Unchanged lines
          const lines = change.value.split('\n');
          // Remove last empty element if exists
          if (lines[lines.length - 1] === '') lines.pop();

          lines.forEach(line => {
            if (line !== '') {
              beforeHtml += `
                <div class="diff-row unchanged">
                  <div class="diff-line-num">${beforeLineNumber++}</div>
                  <div class="diff-cell">${this.escapeHtml(line)}</div>
                </div>
              `;
              afterHtml += `
                <div class="diff-row unchanged">
                  <div class="diff-line-num">${afterLineNumber++}</div>
                  <div class="diff-cell">${this.escapeHtml(line)}</div>
                </div>
              `;
            }
          });
        } else if (change.removed) {
          // Lines only exist in before (removed)
          const lines = change.value.split('\n');
          if (lines[lines.length - 1] === '') lines.pop();

          lines.forEach(line => {
            if (line !== '') {
              beforeHtml += `
                <div class="diff-row removed">
                  <div class="diff-line-num">${beforeLineNumber++}</div>
                  <div class="diff-cell">${this.escapeHtml(line)}</div>
                </div>
              `;
              afterHtml += `
                <div class="diff-row empty">
                  <div class="diff-line-num"></div>
                  <div class="diff-cell">&nbsp;</div>
                </div>
              `;
              removedCount++;
            }
          });
        } else if (change.added) {
          // Lines only exist in after (added)
          const lines = change.value.split('\n');
          if (lines[lines.length - 1] === '') lines.pop();

          lines.forEach(line => {
            if (line !== '') {
              beforeHtml += `
                <div class="diff-row empty">
                  <div class="diff-line-num"></div>
                  <div class="diff-cell">&nbsp;</div>
                </div>
              `;
              afterHtml += `
                <div class="diff-row added">
                  <div class="diff-line-num">${afterLineNumber++}</div>
                  <div class="diff-cell">${this.escapeHtml(line)}</div>
                </div>
              `;
              addedCount++;
            }
          });
        }
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
    // Add any interactive functionality here
    const messageElements = document.querySelectorAll('.message');
    messageElements.forEach(element => {
      element.addEventListener('click', () => {
        // Handle message selection if needed
      });
    });

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

    // Add event listeners for reasoning toggles (no inline handlers, CSP blocks them)
    const reasoningButtons = document.querySelectorAll('.reasoning-toggle');
    reasoningButtons.forEach(button => {
      button.addEventListener('click', () => toggleReasoning(button.dataset.reasoningId));
    });

    // Add synchronized scrolling for diff views
    const diffScrollables = document.querySelectorAll('.diff-scrollable');
    diffScrollables.forEach(scrollable => {
      scrollable.addEventListener('scroll', (e) => {
        const id = e.target.id;
        const beforeElement = document.getElementById(id.replace('-after', '-before'));
        const afterElement = document.getElementById(id.replace('-before', '-after'));

        // Find the paired element
        const pairedElement = id.includes('-before') ? afterElement : beforeElement;

        if (pairedElement && pairedElement !== e.target) {
          // Sync scroll position
          pairedElement.scrollTop = e.target.scrollTop;
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

// Global function for toggling reasoning blocks
function toggleReasoning(id) {
  const block = document.getElementById(id);
  const button = block.querySelector('.reasoning-toggle');
  const content = block.querySelector('.reasoning-content');
  const showText = button.querySelector('.show-text');
  const hideText = button.querySelector('.hide-text');

  if (content.style.display === 'none') {
    content.style.display = 'block';
    showText.style.display = 'none';
    hideText.style.display = 'inline';
  } else {
    content.style.display = 'none';
    showText.style.display = 'inline';
    hideText.style.display = 'none';
  }
}

// Initialize the share renderer when the page loads
document.addEventListener('DOMContentLoaded', () => {
  new ShareRenderer();
});
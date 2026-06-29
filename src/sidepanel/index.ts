import { getSettings } from '../utils/storage';
import { sendToAFFiNE } from '../utils/affine';
import type { ExtractResult, ExtractError } from '../types';

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; font-size: 14px; color: #333; background: #fafafa; min-height: 100vh; }
  .panel { padding: 16px; }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
  .spinner { text-align: center; padding: 40px 0; color: #888; }
  label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 4px; }
  input[type="text"] { width: 100%; padding: 7px 9px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; margin-bottom: 12px; }
  .meta { font-size: 12px; color: #777; margin-bottom: 12px; }
  .meta span { margin-right: 12px; }
  .nodes { background: #f0f4ff; border-radius: 6px; padding: 10px 12px; font-size: 12px; margin-bottom: 14px; }
  .nodes ul { padding-left: 16px; margin-top: 4px; }
  .workspace-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .workspace-row .ws-label { font-size: 12px; color: #555; flex-shrink: 0; }
  .workspace-row .ws-value { font-size: 12px; color: #333; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-row a { font-size: 12px; color: #0070f3; text-decoration: none; }
  button.save { width: 100%; padding: 10px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; }
  button.save:hover { background: #333; }
  button.save:disabled { background: #999; cursor: not-allowed; }
  .no-config { background: #fff8e1; border-radius: 6px; padding: 12px; font-size: 13px; text-align: center; }
  .no-config a { color: #0070f3; }
  .result { text-align: center; padding: 32px 16px; }
  .result .icon { font-size: 40px; margin-bottom: 12px; }
  .result p { font-size: 13px; color: #555; margin-bottom: 16px; }
  .result a { color: #0070f3; font-size: 13px; }
  .error-msg { color: #c00; font-size: 12px; margin-top: 8px; }
`;

type State =
  | { kind: 'extracting' }
  | { kind: 'preview'; result: ExtractResult; title: string }
  | { kind: 'saving' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

let state: State = { kind: 'extracting' };
let affineUrl = '';
let workspace = '';

function render() {
  const app = document.getElementById('app')!;

  if (state.kind === 'extracting') {
    app.innerHTML = `<style>${STYLES}</style><div class="panel"><h2>AFFiNE Web Clipper</h2><div class="spinner">⟳ 正在分析页面…</div></div>`;
    return;
  }

  if (state.kind === 'saving') {
    app.innerHTML = `<style>${STYLES}</style><div class="panel"><h2>AFFiNE Web Clipper</h2><div class="spinner">⟳ 正在导入 AFFiNE…</div></div>`;
    return;
  }

  if (state.kind === 'success') {
    app.innerHTML = `<style>${STYLES}</style><div class="panel result"><div class="icon">✓</div><p>保存成功！</p></div>`;
    return;
  }

  if (state.kind === 'error') {
    app.innerHTML = `<style>${STYLES}</style><div class="panel result"><div class="icon">✗</div><p class="error-msg">${htmlEscape(state.message)}</p><button class="save" id="retry">重试</button></div>`;
    document.getElementById('retry')?.addEventListener('click', startExtraction);
    return;
  }

  // preview state
  const { result, title } = state;
  const nodeHtml =
    result.specialNodes.length > 0
      ? `<div class="nodes">🖼 检测到 ${result.specialNodes.length} 个特殊节点<ul>${result.specialNodes.map((n) => `<li>${htmlEscape(n.label)}</li>`).join('')}</ul></div>`
      : '';

  const isConfigured = !!affineUrl;

  const wsDisplay = workspace || 'last-open-workspace';
  const workspaceHtml = affineUrl
    ? `<div class="workspace-row"><span class="ws-label">保存到</span><span class="ws-value">${htmlEscape(wsDisplay)}</span><a href="#" id="openSettings">更改</a></div>`
    : `<div class="no-config">未配置 AFFiNE 地址，请先 <a href="#" id="openSettings">打开设置</a></div>`;

  app.innerHTML = `
    <style>${STYLES}</style>
    <div class="panel">
      <h2>AFFiNE Web Clipper</h2>
      <label for="titleInput">标题</label>
      <input type="text" id="titleInput" value="${htmlEscape(title)}" />
      <div class="meta">
        <span>📄 ${result.wordCount} 字</span>
      </div>
      ${nodeHtml}
      ${workspaceHtml}
      ${isConfigured ? `<button class="save" id="saveBtn">保存到 AFFiNE</button>` : ''}
      <div class="error-msg" id="errMsg"></div>
    </div>
  `;

  document.getElementById('openSettings')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('saveBtn')?.addEventListener('click', async () => {
    const editedTitle = (document.getElementById('titleInput') as HTMLInputElement).value.trim();
    state = { kind: 'saving' };
    render();
    try {
      await sendToAFFiNE(document.body, affineUrl, {
        title: editedTitle,
        contentMarkdown: result.markdown,
        // Fall back to AFFiNE's "last-open-workspace" strategy when no ID is configured
        workspace: workspace || 'last-open-workspace',
      });
      state = { kind: 'success' };
    } catch (err) {
      state = { kind: 'error', message: `保存失败：${String(err)}` };
    }
    render();
  });
}

async function sendExtractMessage(tabId: number): Promise<ExtractResult | ExtractError> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT' });
  } catch (err) {
    // Tab was open before extension was installed — content script not yet injected.
    // Inject it programmatically and retry once.
    if (!String(err).includes('Could not establish connection')) throw err;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'EXTRACT' });
  }
}

async function startExtraction() {
  state = { kind: 'extracting' };
  render();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('无法获取当前标签页');

    const response = await sendExtractMessage(tab.id);

    if (response.type === 'EXTRACT_ERROR') {
      state = { kind: 'error', message: response.message };
    } else {
      state = { kind: 'preview', result: response, title: response.title };
    }
  } catch (err) {
    state = { kind: 'error', message: `提取失败：${String(err)}` };
  }
  render();
}

async function init() {
  const settings = await getSettings();
  affineUrl = settings.affineUrl;
  workspace = settings.defaultWorkspace;

  const app = document.getElementById('app')!;
  app.innerHTML = `<style>${STYLES}</style>`;

  await startExtraction();
}

init();

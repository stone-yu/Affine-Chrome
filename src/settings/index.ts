import { getSettings, saveSettings } from '../utils/storage';

const STYLES = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #333; }
  h1 { font-size: 18px; margin-bottom: 24px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  input { display: block; width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
  button { padding: 8px 20px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
  button:hover { background: #333; }
  .saved { color: green; font-size: 13px; margin-left: 12px; display: none; }
`;

async function init() {
  const settings = await getSettings();

  const app = document.getElementById('app')!;
  app.innerHTML = `
    <style>${STYLES}</style>
    <h1>AFFiNE Web Clipper — Settings</h1>
    <label for="affineUrl">AFFiNE Server URL</label>
    <input id="affineUrl" type="url" placeholder="http://localhost:3000" value="${settings.affineUrl}" />
    <label for="workspace">Default Workspace ID</label>
    <input id="workspace" type="text" placeholder="Paste workspace ID from AFFiNE URL" value="${settings.defaultWorkspace}" />
    <button id="save">Save</button>
    <span class="saved" id="savedMsg">✓ Saved</span>
  `;

  document.getElementById('save')!.addEventListener('click', async () => {
    const affineUrl = (document.getElementById('affineUrl') as HTMLInputElement).value.trim().replace(/\/$/, '');
    const defaultWorkspace = (document.getElementById('workspace') as HTMLInputElement).value.trim();
    await saveSettings({ affineUrl, defaultWorkspace });
    const msg = document.getElementById('savedMsg')!;
    msg.style.display = 'inline';
    setTimeout(() => (msg.style.display = 'none'), 2000);
  });
}

init();

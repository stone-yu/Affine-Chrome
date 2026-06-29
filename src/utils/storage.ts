import type { Settings } from '../types';

const DEFAULTS: Settings = {
  affineUrl: 'http://localhost:3000',
  defaultWorkspace: '',
};

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(DEFAULTS);
  return result as Settings;
}

export async function saveSettings(settings: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(settings);
}

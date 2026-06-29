const mockGet = jest.fn();
const mockSet = jest.fn();
(globalThis as any).chrome = {
  storage: { sync: { get: mockGet, set: mockSet } },
};

import { getSettings, saveSettings } from '../../src/utils/storage';

describe('getSettings', () => {
  it('returns defaults when storage is empty', async () => {
    mockGet.mockResolvedValue({ affineUrl: 'http://localhost:3000', defaultWorkspace: '' });
    const s = await getSettings();
    expect(s.affineUrl).toBe('http://localhost:3000');
    expect(s.defaultWorkspace).toBe('');
  });

  it('returns stored values', async () => {
    mockGet.mockResolvedValue({ affineUrl: 'http://myaffine.com', defaultWorkspace: 'ws-123' });
    const s = await getSettings();
    expect(s.affineUrl).toBe('http://myaffine.com');
    expect(s.defaultWorkspace).toBe('ws-123');
  });
});

describe('saveSettings', () => {
  it('calls chrome.storage.sync.set with provided values', async () => {
    mockSet.mockResolvedValue(undefined);
    await saveSettings({ affineUrl: 'http://newaffine.com' });
    expect(mockSet).toHaveBeenCalledWith({ affineUrl: 'http://newaffine.com' });
  });
});

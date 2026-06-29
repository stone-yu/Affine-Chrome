// Mock Chrome extension APIs before importing the module
const mockQuery = jest.fn();
const mockCreate = jest.fn();
const mockOnUpdated = { addListener: jest.fn(), removeListener: jest.fn() };
const mockExecuteScript = jest.fn();
const mockRemove = jest.fn();
const mockUpdate = jest.fn();

(globalThis as any).chrome = {
  tabs: {
    query: mockQuery,
    create: mockCreate,
    onUpdated: mockOnUpdated,
    remove: mockRemove,
    update: mockUpdate,
  },
  scripting: { executeScript: mockExecuteScript },
};

import { sendToAFFiNE } from '../../src/utils/affine';

describe('sendToAFFiNE', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([{ id: 1 }]); // original tab
    mockRemove.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
  });

  function simulateTabLoad(tabId: number) {
    mockOnUpdated.addListener.mockImplementationOnce((fn: Function) => {
      setTimeout(() => fn(tabId, { status: 'complete' }), 10);
    });
  }

  it('rejects immediately when affineUrl is empty', async () => {
    await expect(
      sendToAFFiNE('', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).rejects.toThrow('AFFiNE URL not configured');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('resolves and restores original tab on success', async () => {
    mockCreate.mockResolvedValue({ id: 42 });
    mockExecuteScript.mockResolvedValue([{ result: true }]);
    simulateTabLoad(42);

    await expect(
      sendToAFFiNE('http://localhost:3000', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).resolves.toBeUndefined();

    expect(mockCreate).toHaveBeenCalledWith({
      url: 'http://localhost:3000/clipper/import',
      active: true,
    });
    expect(mockRemove).toHaveBeenCalledWith(42);
    expect(mockUpdate).toHaveBeenCalledWith(1, { active: true }); // restore original
  });

  it('rejects with timeout message and closes tab on failure', async () => {
    mockCreate.mockResolvedValue({ id: 99 });
    mockExecuteScript.mockResolvedValue([{ result: false }]);
    simulateTabLoad(99);

    await expect(
      sendToAFFiNE('http://localhost:3000', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).rejects.toThrow('导入超时');

    expect(mockRemove).toHaveBeenCalledWith(99);
    expect(mockUpdate).toHaveBeenCalledWith(1, { active: true });
  });
});

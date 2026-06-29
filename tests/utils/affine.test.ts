// Mock Chrome extension APIs before importing the module
const mockCreate = jest.fn();
const mockOnUpdated = { addListener: jest.fn(), removeListener: jest.fn() };
const mockExecuteScript = jest.fn();
const mockRemove = jest.fn();

(globalThis as any).chrome = {
  tabs: { create: mockCreate, onUpdated: mockOnUpdated, remove: mockRemove },
  scripting: { executeScript: mockExecuteScript },
};

import { sendToAFFiNE } from '../../src/utils/affine';

describe('sendToAFFiNE', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects immediately when affineUrl is empty', async () => {
    await expect(
      sendToAFFiNE('', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).rejects.toThrow('AFFiNE URL not configured');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('resolves when AFFiNE import succeeds', async () => {
    mockCreate.mockResolvedValue({ id: 123 });
    mockRemove.mockResolvedValue(undefined);
    mockExecuteScript.mockResolvedValue([{ result: true }]);
    // Simulate tab reaching 'complete' status
    mockOnUpdated.addListener.mockImplementationOnce((fn: Function) => {
      setTimeout(() => fn(123, { status: 'complete' }), 10);
    });

    await expect(
      sendToAFFiNE('http://localhost:3000', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).resolves.toBeUndefined();

    expect(mockCreate).toHaveBeenCalledWith({
      url: 'http://localhost:3000/clipper/import',
      active: false,
    });
    expect(mockRemove).toHaveBeenCalledWith(123);
  });

  it('rejects with timeout message when import returns false', async () => {
    mockCreate.mockResolvedValue({ id: 456 });
    mockRemove.mockResolvedValue(undefined);
    mockExecuteScript.mockResolvedValue([{ result: false }]);
    mockOnUpdated.addListener.mockImplementationOnce((fn: Function) => {
      setTimeout(() => fn(456, { status: 'complete' }), 10);
    });

    await expect(
      sendToAFFiNE('http://localhost:3000', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).rejects.toThrow('timeout');

    // Tab must be closed even on failure
    expect(mockRemove).toHaveBeenCalledWith(456);
  });

});

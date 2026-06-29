// Minimal DOM setup
document.body.innerHTML = '<div id="container"></div>';

import { sendToAFFiNE } from '../../src/utils/affine';

describe('sendToAFFiNE', () => {
  it('rejects immediately when affineUrl is empty', async () => {
    const container = document.getElementById('container')!;
    await expect(
      sendToAFFiNE(container, '', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).rejects.toThrow('AFFiNE URL not configured');
  });

  it('resolves when success message is received', async () => {
    const container = document.getElementById('container')!;
    // Simulate AFFiNE success reply 50 ms after iframe "loads"
    const original = document.createElement.bind(document);
    jest.spyOn(document, 'createElement').mockImplementationOnce((tag: string) => {
      if (tag === 'iframe') {
        const iframe = original('iframe') as HTMLIFrameElement;
        // Trigger load + success message after a tick
        setTimeout(() => {
          iframe.dispatchEvent(new Event('load'));
          setTimeout(() => {
            window.dispatchEvent(new MessageEvent('message', {
              data: { type: 'affine-clipper:import:success' },
              origin: 'http://localhost:3000',
            }));
          }, 10);
        }, 10);
        return iframe;
      }
      return original(tag);
    });

    await expect(
      sendToAFFiNE(container, 'http://localhost:3000', { title: 'T', contentMarkdown: 'M', workspace: 'W' })
    ).resolves.toBeUndefined();
  });

  it('rejects after timeout', async () => {
    jest.useFakeTimers();
    const container = document.getElementById('container')!;

    const promise = sendToAFFiNE(
      container,
      'http://localhost:3000',
      { title: 'T', contentMarkdown: 'M', workspace: 'W' }
    );
    jest.advanceTimersByTime(31_000);
    await expect(promise).rejects.toThrow('timeout');
    jest.useRealTimers();
  }, 10_000);
});

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

  it('resolves when success message is received via MessagePort', async () => {
    const container = document.getElementById('container')!;
    const original = document.createElement.bind(document);
    let capturedPort2: MessagePort | null = null;

    jest.spyOn(document, 'createElement').mockImplementationOnce((tag: string) => {
      if (tag === 'iframe') {
        const iframe = original('iframe') as HTMLIFrameElement;
        // Intercept postMessage to capture port2 that was transferred to AFFiNE.
        // contentWindow is a read-only getter so we must use defineProperty.
        const fakeWindow = {
          postMessage: (_msg: unknown, _origin: string, transfer: Transferable[]) => {
            if (transfer?.length > 0) capturedPort2 = transfer[0] as MessagePort;
          },
        };
        Object.defineProperty(iframe, 'contentWindow', { get: () => fakeWindow, configurable: true });
        setTimeout(() => {
          iframe.dispatchEvent(new Event('load'));
          // AFFiNE responds via port2; port1 receives it
          setTimeout(() => capturedPort2?.postMessage({ type: 'affine-clipper:import:success' }), 10);
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

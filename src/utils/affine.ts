export interface AFFiNEPayload {
  title: string;
  contentMarkdown: string;
  workspace: string;
}

const TIMEOUT_MS = 30_000;

export function sendToAFFiNE(
  container: HTMLElement,
  affineUrl: string,
  payload: AFFiNEPayload
): Promise<void> {
  if (!affineUrl) return Promise.reject(new Error('AFFiNE URL not configured'));

  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.src = `${affineUrl}/clipper/import`;
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:none;opacity:0;pointer-events:none;';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      if (new URL(affineUrl).origin !== event.origin) return;
      if (event.data?.type === 'affine-clipper:import:success') {
        cleanup();
        resolve();
      }
    }

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
    }

    window.addEventListener('message', onMessage);

    iframe.addEventListener('load', () => {
      iframe.contentWindow?.postMessage(
        { type: 'affine-clipper:import', payload },
        affineUrl
      );
    });

    container.appendChild(iframe);
  });
}

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

    // AFFiNE's fallback (no port) calls window.postMessage() on its OWN window —
    // which never reaches our side panel. Providing a MessagePort forces AFFiNE to
    // use port.postMessage() instead, which delivers directly to us via port1.
    const channel = new MessageChannel();

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      channel.port1.close();
      iframe.remove();
    }

    channel.port1.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'affine-clipper:import:success') {
        cleanup();
        resolve();
      }
    };

    iframe.addEventListener('load', () => {
      // Transfer port2 to AFFiNE so it replies via that port
      iframe.contentWindow?.postMessage(
        { type: 'affine-clipper:import', payload },
        affineUrl,
        [channel.port2]
      );
    });

    container.appendChild(iframe);
  });
}

// MessageChannel is a Web API available in browsers and modern Node.js workers,
// but not automatically exposed in Jest's jsdom environment.
if (typeof MessageChannel === 'undefined') {
  const { MessageChannel: NodeMessageChannel } = require('worker_threads');
  global.MessageChannel = NodeMessageChannel;
}

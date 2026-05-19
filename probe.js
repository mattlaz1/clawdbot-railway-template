// Probe: connect to OpenClaw gateway from inside the container and dump
// the scopes the server granted us. Prove that loopback connects get
// operator.* whereas external clients don't.
const WebSocket = require('/app/mission-control/node_modules/ws');
const crypto = require('crypto');

const url = process.env.OPENCLAW_WS_URL;
const token = process.env.OPENCLAW_TOKEN;
console.log('PROBE url=', url);
console.log('PROBE token set?', !!token);

const ws = new WebSocket(url);
const id = crypto.randomBytes(8).toString('hex');

ws.on('open', () => {
  console.log('PROBE open');
  ws.send(JSON.stringify({
    type: 'req',
    id,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 4,
      client: { id: 'gateway-client', version: '1.0.0', platform: 'node', mode: 'backend' },
      auth: { token },
      scopes: ['operator.read', 'operator.write'],
    },
  }));
});

ws.on('message', (data) => {
  const txt = data.toString();
  console.log('PROBE recv:', txt.slice(0, 1000));
  try {
    const msg = JSON.parse(txt);
    if (msg.id === id) {
      console.log('PROBE granted scopes:', JSON.stringify(msg.result?.scopes || msg.result));
      process.exit(0);
    }
  } catch {}
});

ws.on('error', (e) => {
  console.error('PROBE error:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('PROBE timeout');
  process.exit(2);
}, 10_000);

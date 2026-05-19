// Quick smoke test for lib/openclaw.js.
// Run with: node test-openclaw.js
// Asks CRO a quick question and prints status events + final reply.

const { getClient } = require('./lib/openclaw');

(async () => {
  const c = getClient();
  const SESSION = 'agent:cro:main';

  c.on('agent', (p) => {
    if (p.sessionKey !== SESSION) return;
    const data = typeof p.data === 'string' ? p.data.slice(0, 60) : JSON.stringify(p.data).slice(0, 60);
    console.log(`[agent] stream=${p.stream} data=${data}`);
  });

  c.on('message', (p) => {
    if (p.sessionKey !== SESSION) return;
    const role = p.message?.role;
    const text = Array.isArray(p.message?.content)
      ? p.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      : p.message?.content;
    console.log(`\n[message] role=${role} status=${p.session?.status} runtimeMs=${p.session?.runtimeMs} tokens=${p.session?.totalTokens}`);
    if (role === 'assistant' && p.session?.status === 'done') {
      console.log('\n=== ASSISTANT ===\n' + text + '\n=================\n');
      c.close();
      process.exit(0);
    }
  });

  await c.subscribe(SESSION);
  console.log('[test] subscribed to', SESSION);
  const { runId } = await c.send(SESSION, 'Quick check — reply with exactly: ACK from CRO via Mission Control client.');
  console.log('[test] sent; runId=', runId);

  setTimeout(() => {
    console.error('[test] timeout (60s)');
    process.exit(1);
  }, 60_000);
})().catch((err) => {
  console.error('[test] error:', err);
  process.exit(2);
});

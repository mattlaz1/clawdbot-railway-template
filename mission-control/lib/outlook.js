// Graph API helper for Mission Control.
// Reuses the Outlook MCP's token cache so there's no separate login flow.
// Lazy-init: don't touch the MCP .env or token cache at require time —
// on Railway those paths don't exist and would crash the server at boot.
const fs = require('fs');
const path = require('path');

const MCP_ROOT = path.resolve(__dirname, '..', '..', '..', 'mcp', 'outlook');
const TOKEN_CACHE_PATH = path.join(MCP_ROOT, '.token-cache.json');
const SCOPES = ['Mail.Read'];

let msalClient = null;

function loadMcpEnv() {
  const envPath = path.join(MCP_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Outlook MCP .env not found at ${envPath}. Outlook integration is local-only.`);
  }
  const lines = fs.readFileSync(envPath, 'utf-8').replace(/\r/g, '').split('\n');
  const env = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function getClient() {
  if (msalClient) return msalClient;
  const { PublicClientApplication } = require('@azure/msal-node');
  const mcpEnv = loadMcpEnv();
  msalClient = new PublicClientApplication({
    auth: {
      clientId: mcpEnv.AZURE_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${mcpEnv.AZURE_TENANT_ID}`,
    },
  });
  if (fs.existsSync(TOKEN_CACHE_PATH)) {
    try {
      const cache = fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8');
      msalClient.getTokenCache().deserialize(cache);
    } catch { /* will fail gracefully below */ }
  }
  return msalClient;
}

async function getAccessToken() {
  const client = getClient();
  const accounts = await client.getTokenCache().getAllAccounts();
  if (!accounts.length) {
    throw new Error('No cached Outlook token. Run the MCP auth first: cd mcp/outlook && npm run auth');
  }
  const result = await client.acquireTokenSilent({
    account: accounts[0],
    scopes: SCOPES,
  });
  return result.accessToken;
}

async function callGraph(endpoint) {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

module.exports = { callGraph };

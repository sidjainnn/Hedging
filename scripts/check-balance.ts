import { config } from '../src/config.js';
import crypto from 'crypto';

function sign(query: string): string {
  return crypto.createHmac('sha256', config.apiSecret).update(query).digest('hex');
}
async function signedGet(path: string, params: Record<string, string | number> = {}) {
  const withTime = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const query = Object.entries(withTime).map(([k, v]) => `${k}=${v}`).join('&');
  const url = `${config.futuresBase}${path}?${query}&signature=${sign(query)}`;
  const res = await fetch(url, { headers: { 'X-MBX-APIKEY': config.apiKey } });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

const balances: any = await signedGet('/fapi/v2/balance');
console.log(JSON.stringify(balances, null, 2));

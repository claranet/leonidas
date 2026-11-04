import dgram from 'node:dgram';
import { TAG, encodeTlv, encodeOctetString } from '../src/snmp/ber.js';
import { parseMessage, encodeMessage, PDU } from '../src/snmp/message.js';

export const encodeOid = (oid) => {
  const [ a, b, ...rest ] = oid.split(`.`).map(Number);
  const bytes = [];

  for (const n of [ a * 40 + b, ...rest ]) {
    const group = [ n & 0x7f ];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128))
      group.unshift((v & 0x7f) | 0x80);
    bytes.push(...group);
  }

  return encodeTlv(TAG.OID, Buffer.from(bytes));
};

export const varbind = (oid, value) =>
  encodeTlv(TAG.SEQUENCE, Buffer.concat([ encodeOid(oid), value ]));

export const nullVarbinds = (oids) =>
  Buffer.concat(oids.map((oid) => varbind(oid, Buffer.from([ TAG.NULL, 0 ]))));

export const request = ({ version = 1, community = `public`, pduType = PDU.GET, requestId = 42, errorStatus = 0, errorIndex = 0, oids }) =>
  encodeMessage({ version, community: Buffer.from(community), pduType, requestId, errorStatus, errorIndex, varbinds: nullVarbinds(oids) });

// A fake SNMP agent answering every OID with an OCTET STRING "<oid>#<n>",
// where n counts the requests it has served. GETBULK returns max-repetitions
// varbinds. Messages that are not v1/v2c are echoed back unchanged.
export const startAgent = async ({ silent = false } = {}) => {
  const socket = dgram.createSocket(`udp4`);
  const agent = { socket, requests: 0, received: [] };

  socket.on(`message`, (buf, src) => {
    agent.requests++;
    agent.received.push(buf);

    if (silent)
      return;

    let msg;
    try {
      msg = parseMessage(buf);
    } catch {
      return socket.send(buf, src.port, src.address);
    }

    const count = msg.pduType === PDU.GET_BULK ? msg.errorIndex : 1;
    const varbinds = [];
    for (const oid of msg.oids) {
      for (let i = 1; i <= count; i++) {
        const value = encodeOctetString(Buffer.from(`${oid}${count > 1 ? `.${i}` : ``}#${agent.requests}`));
        varbinds.push(varbind(`${oid}${count > 1 ? `.${i}` : ``}`, value));
      }
    }

    socket.send(encodeMessage({
      version: msg.version,
      community: msg.community,
      pduType: PDU.RESPONSE,
      requestId: msg.requestId,
      varbinds: Buffer.concat(varbinds)
    }), src.port, src.address);
  });

  await new Promise((resolve) => socket.bind(0, `127.0.0.1`, resolve));
  agent.port = socket.address().port;
  agent.close = () => new Promise((resolve) => socket.close(resolve));

  return agent;
};

// Sends one datagram and resolves with the reply (or null on timeout).
export const query = (port, buf, timeoutMs = 1000) => new Promise((resolve) => {
  const socket = dgram.createSocket(`udp4`);
  const timer = setTimeout(() => {
    socket.close();
    resolve(null);
  }, timeoutMs);

  socket.on(`message`, (msg) => {
    clearTimeout(timer);
    socket.close();
    resolve(msg);
  });

  socket.send(buf, port, `127.0.0.1`);
});

// In-memory stand-in for the node-redis client methods used by Leonidas.
export class FakeRedis {
  constructor() {
    this.data = new Map();
    this.ttl = new Map();
    this.failing = false;
  }

  check() {
    if (this.failing)
      throw new Error(`connection is closed`);
  }

  async get(key) {
    this.check();
    return this.data.get(key) ?? null;
  }

  async set(key, value, options) {
    this.check();
    this.data.set(key, value);
    this.ttl.set(key, options?.expiration?.value);
    return `OK`;
  }
}

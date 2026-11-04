/*
Minimal BER (Basic Encoding Rules) codec - just enough of ASN.1 to read and
write SNMPv1/v2c message envelopes. Varbind values are never decoded, they are
passed through as raw bytes.
 */

export const TAG = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30
};

export class BerError extends Error {}

// Reads one TLV at `offset`. Returns positions so callers can slice raw bytes.
export const readTlv = (buf, offset = 0, expectedTag) => {
  if (offset + 2 > buf.length)
    throw new BerError(`truncated TLV at offset ${offset}`);

  const tag = buf[offset];

  if (expectedTag !== undefined && tag !== expectedTag)
    throw new BerError(`expected tag 0x${expectedTag.toString(16)} at offset ${offset}, got 0x${tag.toString(16)}`);

  let length = buf[offset + 1];
  let pos = offset + 2;

  if (length & 0x80) {
    const bytes = length & 0x7f;

    if (bytes === 0 || bytes > 4)
      throw new BerError(`unsupported length encoding at offset ${offset}`);

    if (pos + bytes > buf.length)
      throw new BerError(`truncated length at offset ${offset}`);

    length = 0;
    for (let i = 0; i < bytes; i++)
      length = length * 256 + buf[pos++];
  }

  const end = pos + length;

  if (end > buf.length)
    throw new BerError(`TLV at offset ${offset} exceeds buffer`);

  return { tag, start: offset, valueStart: pos, end, value: buf.subarray(pos, end) };
};

export const decodeInteger = (value) => {
  if (value.length === 0 || value.length > 6)
    throw new BerError(`unsupported integer length ${value.length}`);

  return value.readIntBE(0, value.length);
};

export const decodeOid = (value) => {
  if (value.length === 0)
    throw new BerError(`empty OID`);

  const parts = [];
  let n = 0;

  for (let i = 0; i < value.length; i++) {
    n = n * 128 + (value[i] & 0x7f);

    if ((value[i] & 0x80) === 0) {
      if (parts.length === 0) {
        const first = Math.min(Math.floor(n / 40), 2);
        parts.push(first, n - first * 40);
      } else {
        parts.push(n);
      }
      n = 0;
    }
  }

  return parts.join(`.`);
};

export const encodeLength = (length) => {
  if (length < 0x80)
    return Buffer.from([ length ]);

  const bytes = [];
  for (let n = length; n > 0; n = Math.floor(n / 256))
    bytes.unshift(n & 0xff);

  return Buffer.from([ 0x80 | bytes.length, ...bytes ]);
};

export const encodeTlv = (tag, value) =>
  Buffer.concat([ Buffer.from([ tag ]), encodeLength(value.length), value ]);

// Minimal two's complement encoding, as required by BER.
export const encodeInteger = (n) => {
  if (!Number.isSafeInteger(n))
    throw new BerError(`cannot encode integer ${n}`);

  const bytes = [];
  let v = BigInt(n);

  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (!((v === 0n && (bytes[0] & 0x80) === 0) || (v === -1n && (bytes[0] & 0x80) !== 0)));

  return encodeTlv(TAG.INTEGER, Buffer.from(bytes));
};

export const encodeOctetString = (buf) => encodeTlv(TAG.OCTET_STRING, buf);

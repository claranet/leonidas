import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTlv, decodeInteger, decodeOid, encodeInteger, encodeLength, BerError } from '../src/snmp/ber.js';
import { parseMessage, encodeMessage, readVersion, PDU } from '../src/snmp/message.js';
import { encodeOid, request } from './helpers.js';

// Captured from: snmpget -v2c -c public <host> 1.3.6.1.2.1.1.1.0
const SNMPGET = Buffer.from(
  `302902010104067075626c6963a01c` +
  `02040b65a9b2020100020100300e300c06082b060102010101000500`, `hex`);

describe(`ber`, () => {
  it(`round-trips integers with minimal two's complement`, () => {
    const cases = { 0: `020100`, 127: `02017f`, 128: `02020080`, 255: `020200ff`, 256: `02020100`, [-1]: `0201ff`, [-128]: `020180`, [-129]: `0202ff7f`, 2147483647: `02047fffffff`, [-2147483648]: `020480000000` };

    for (const [ n, hex ] of Object.entries(cases)) {
      const encoded = encodeInteger(Number(n));
      assert.equal(encoded.toString(`hex`), hex, `encode ${n}`);
      assert.equal(decodeInteger(readTlv(encoded).value), Number(n), `decode ${n}`);
    }
  });

  it(`encodes long form lengths`, () => {
    assert.equal(encodeLength(127).toString(`hex`), `7f`);
    assert.equal(encodeLength(128).toString(`hex`), `8180`);
    assert.equal(encodeLength(300).toString(`hex`), `82012c`);
  });

  it(`reads long form lengths`, () => {
    const buf = Buffer.concat([ Buffer.from([ 0x04, 0x82, 0x01, 0x2c ]), Buffer.alloc(300) ]);
    assert.equal(readTlv(buf).value.length, 300);
  });

  it(`decodes OIDs including multi-byte sub-identifiers`, () => {
    for (const oid of [ `1.3.6.1.2.1.1.1.0`, `1.3.6.1.4.1.9.9.42.1.2.10.1.1.4294967295`, `2.999.1` ])
      assert.equal(decodeOid(readTlv(encodeOid(oid)).value), oid);
  });

  it(`rejects truncated input`, () => {
    assert.throws(() => readTlv(Buffer.from([ 0x30 ])), BerError);
    assert.throws(() => readTlv(Buffer.from([ 0x30, 0x05, 0x00 ])), BerError);
    assert.throws(() => parseMessage(SNMPGET.subarray(0, 20)), BerError);
  });
});

describe(`message`, () => {
  it(`parses a real snmpget request`, () => {
    const msg = parseMessage(SNMPGET);

    assert.equal(msg.version, 1);
    assert.equal(msg.community.toString(), `public`);
    assert.equal(msg.pduType, PDU.GET);
    assert.equal(msg.requestId, 0x0b65a9b2);
    assert.deepEqual(msg.oids, [ `1.3.6.1.2.1.1.1.0` ]);
  });

  it(`re-encodes a message byte for byte`, () => {
    assert.deepEqual(encodeMessage(parseMessage(SNMPGET)), SNMPGET);
  });

  it(`parses GETBULK parameters and multiple varbinds`, () => {
    const msg = parseMessage(request({ pduType: PDU.GET_BULK, errorStatus: 1, errorIndex: 10, oids: [ `1.3.6.1.2.1.1`, `1.3.6.1.2.1.2.2.1.2` ] }));

    assert.equal(msg.pduType, PDU.GET_BULK);
    assert.equal(msg.errorStatus, 1);
    assert.equal(msg.errorIndex, 10);
    assert.deepEqual(msg.oids, [ `1.3.6.1.2.1.1`, `1.3.6.1.2.1.2.2.1.2` ]);
  });

  it(`reads the version of an SNMPv3 message without parsing it`, () => {
    const v3 = Buffer.from(`300e020103300902020001020205dc0400`, `hex`);

    assert.equal(readVersion(v3), 3);
    assert.throws(() => parseMessage(v3));
  });
});

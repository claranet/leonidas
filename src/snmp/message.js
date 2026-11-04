/*
SNMPv1/v2c message parsing and encoding.

  Message ::= SEQUENCE { version INTEGER, community OCTET STRING, pdu PDU }
  PDU     ::= [tag] { request-id, error-status, error-index, varbind-list }

For GetBulkRequest the error-status/error-index slots carry non-repeaters and
max-repetitions (RFC 3416), so they are kept under the generic names here.
 */

import {
  TAG, BerError, readTlv, decodeInteger, decodeOid,
  encodeTlv, encodeInteger, encodeOctetString
} from './ber.js';

export const VERSION = { V1: 0, V2C: 1, V3: 3 };

export const PDU = {
  GET: 0xa0,
  GET_NEXT: 0xa1,
  RESPONSE: 0xa2,
  SET: 0xa3,
  TRAP: 0xa4,
  GET_BULK: 0xa5,
  INFORM: 0xa6,
  TRAP_V2: 0xa7,
  REPORT: 0xa8
};

export const PDU_NAMES = Object.fromEntries(Object.entries(PDU).map(([ k, v ]) => [ v, k ]));

// Peeks at the version without requiring the rest of the message to be v1/v2c.
export const readVersion = (buf) => {
  const msg = readTlv(buf, 0, TAG.SEQUENCE);

  return decodeInteger(readTlv(buf, msg.valueStart, TAG.INTEGER).value);
};

export const parseMessage = (buf) => {
  const msg = readTlv(buf, 0, TAG.SEQUENCE);
  const version = readTlv(buf, msg.valueStart, TAG.INTEGER);
  const community = readTlv(buf, version.end, TAG.OCTET_STRING);
  const pdu = readTlv(buf, community.end);

  if (pdu.tag < PDU.GET || pdu.tag > PDU.REPORT)
    throw new BerError(`unknown PDU type 0x${pdu.tag.toString(16)}`);

  if (pdu.tag === PDU.TRAP)
    throw new BerError(`SNMPv1 traps are not supported`);

  const requestId = readTlv(buf, pdu.valueStart, TAG.INTEGER);
  const errorStatus = readTlv(buf, requestId.end, TAG.INTEGER);
  const errorIndex = readTlv(buf, errorStatus.end, TAG.INTEGER);
  const varbindList = readTlv(buf, errorIndex.end, TAG.SEQUENCE);

  const oids = [];
  for (let pos = varbindList.valueStart; pos < varbindList.end;) {
    const varbind = readTlv(buf, pos, TAG.SEQUENCE);

    oids.push(decodeOid(readTlv(buf, varbind.valueStart, TAG.OID).value));
    pos = varbind.end;
  }

  return {
    version: decodeInteger(version.value),
    community: Buffer.from(community.value),
    pduType: pdu.tag,
    requestId: decodeInteger(requestId.value),
    errorStatus: decodeInteger(errorStatus.value),
    errorIndex: decodeInteger(errorIndex.value),
    varbinds: Buffer.from(varbindList.value),
    oids
  };
};

// `varbinds` is the raw content of the varbind-list SEQUENCE.
export const encodeMessage = ({ version, community, pduType, requestId, errorStatus = 0, errorIndex = 0, varbinds }) => {
  const pdu = encodeTlv(pduType, Buffer.concat([
    encodeInteger(requestId),
    encodeInteger(errorStatus),
    encodeInteger(errorIndex),
    encodeTlv(TAG.SEQUENCE, varbinds)
  ]));

  return encodeTlv(TAG.SEQUENCE, Buffer.concat([
    encodeInteger(version),
    encodeOctetString(community),
    pdu
  ]));
};

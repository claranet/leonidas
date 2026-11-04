/*
Sends a raw SNMP packet to a device and resolves with the first datagram the
device sends back. Each request uses its own ephemeral socket, so responses
can never be mixed up between concurrent requests.
 */

import dgram from 'node:dgram';
import net from 'node:net';

export class TimeoutError extends Error {}

export const request = (buf, { host, port, timeoutMs, retries }) => new Promise((resolve, reject) => {
  const socket = dgram.createSocket(net.isIPv6(host) ? `udp6` : `udp4`);
  let attempts = 0;
  let timer = null;
  let done = false;

  const finish = (err, response) => {
    if (done)
      return;

    done = true;
    clearTimeout(timer);
    socket.close();

    if (err)
      return reject(err);

    return resolve(response);
  };

  const send = () => {
    attempts++;
    socket.send(buf, port, host, (err) => {
      if (err)
        return finish(err);
    });

    timer = setTimeout(() => {
      if (attempts > retries)
        return finish(new TimeoutError(`no response from ${host}:${port} after ${attempts} attempt(s)`));

      send();
    }, timeoutMs);
  };

  socket.on(`error`, finish);
  socket.on(`message`, (msg, rinfo) => {
    if (rinfo.address === host && rinfo.port === port)
      finish(null, msg);
  });

  send();
});

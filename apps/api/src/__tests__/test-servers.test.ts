import { describe, it, expect } from 'vitest';
import type { AddressInfo, Server } from 'node:net';
import express from 'express';
import request from 'supertest';

/** See `setup.ts`: a wildcard test server can share its port with another program. */
describe('servers supertest starts', () => {
  const app = express();
  app.get('/where', (req, res) => {
    // The address the server bound, not the one this connection arrived on: a
    // wildcard server reports 127.0.0.1 traffic as ::ffff:127.0.0.1 either way.
    const server = (req.socket as unknown as { server: Server }).server;
    res.json({ bound: (server.address() as AddressInfo).address, query: req.query });
  });

  it('listen on 127.0.0.1, the address the request is sent to', async () => {
    const res = await request(app).get('/where');

    expect(res.status).toBe(200);
    expect(res.body.bound).toBe('127.0.0.1');
  });

  it('still carry the query string and the expectation callback style', async () => {
    await request(app).get('/where').query({ q: 'x' }).expect(200, { bound: '127.0.0.1', query: { q: 'x' } });
  });
});

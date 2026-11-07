import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createVisionServer} from './vision-server.mjs';

async function serve(t, reply) {
  const calls = [];
  const server = createVisionServer(
    {baseUrl: 'https://example.test/v1', model: 'glm-test', apiKey: 'test-key'},
    async (url, options) => {
      calls.push({url, body: JSON.parse(options.body)});
      return {ok: true, json: async () => ({choices: [{message: {content: reply}}]})};
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return {url: 'http://127.0.0.1:' + server.address().port + '/api/vision', calls};
}

test('vision API forwards deterministic JSON-mode requests and keeps legacy single fields', async (t) => {
  const {url, calls} = await serve(t, '{"beans":[{"name":"阿洛","weight":60}]}');
  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'image/jpeg'},
    body: Buffer.from([255, 216, 255, 1]),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.fields.remaining, '60');
  assert.equal(result.beans.length, 1);
  assert.equal(calls[0].body.temperature, 0);
  assert.deepEqual(calls[0].body.response_format, {type: 'json_object'});
  assert.match(calls[0].body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('small PNG inputs remain PNG and multiple beans reach the client', async (t) => {
  const {url, calls} = await serve(t, '[{"name":"A","weight":60},{"name":"B","capacity":"0.25kg"}]');
  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'image/png'},
    body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).beans[1].fields.weight, '250');
  assert.match(calls[0].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('MIME mismatches and unsupported formats never call the model', async (t) => {
  const {url, calls} = await serve(t, '{}');
  for (const type of ['image/jpeg', 'image/svg+xml']) {
    const response = await fetch(url, {method: 'POST', headers: {'Content-Type': type}, body: '<svg/>'});
    assert([400, 415].includes(response.status));
  }
  assert.equal(calls.length, 0);
});

test('malformed model output fails safely and empty recognition remains a valid result', async (t) => {
  const broken = await serve(t, 'not json');
  const response = await fetch(broken.url, {
    method: 'POST',
    headers: {'Content-Type': 'image/jpeg'},
    body: Buffer.from([255, 216, 255]),
  });
  assert.equal(response.status, 502);
  const empty = await serve(t, '{"beans":[]}');
  const noFields = await fetch(empty.url, {
    method: 'POST',
    headers: {'Content-Type': 'image/jpeg'},
    body: Buffer.from([255, 216, 255]),
  });
  assert.deepEqual((await noFields.json()).beans, []);
});

test('the service permits five in-flight images and rejects a sixth without calling the model', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  const server = createVisionServer(
    {baseUrl: 'https://example.test/v1', model: 'glm-test', apiKey: 'test-key'},
    async () => {
      started++;
      await gate;
      return {
        ok: true,
        json: async () => ({choices: [{message: {content: '{"name":"豆","weight":60}'}}]}),
      };
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    release();
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/vision';
  const send = () =>
    fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'image/jpeg'},
      body: Buffer.from([255, 216, 255]),
    });
  const requests = Array.from({length: 5}, send);
  for (let attempt = 0; started < 5 && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, 5);
  const sixth = await send();
  assert.equal(sixth.status, 429);
  assert.equal(started, 5);
  release();
  for (const response of await Promise.all(requests)) assert.equal(response.status, 200);
});

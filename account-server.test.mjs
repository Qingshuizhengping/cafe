import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createAccountServer} from './account-server.mjs';

const origin = 'https://cafe.example.test';
const password = 'test account password';

test('accounts isolate data, sync without overwriting newer versions, and revoke sessions', async t => {
  const server = createAccountServer({databasePath: ':memory:', origin});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/account/';
  const call = (route, {method = 'GET', session, body, headers} = {}) => fetch(base + route, {
    method,
    headers: {
      Origin: origin,
      ...(session ? {Cookie: session.cookie, 'X-Cafe-Account': session.id} : {}),
      ...(body ? {'Content-Type': 'application/json'} : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sign = async (route, name, entered = password) => {
    const response = await call(route, {method:'POST', body:{name, password:entered}});
    assert.equal(response.status, route === 'register' ? 201 : 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /; Secure; HttpOnly; SameSite=Strict/);
    const {user} = await response.json();
    return {id:user.id, cookie:cookie.split(';')[0]};
  };
  assert.equal((await call('data')).status, 401);
  assert.equal((await call('register', {method:'POST', headers:{Origin:'https://elsewhere.test'}, body:{name:'alice',password}})).status, 403);
  const alice = await sign('register','alice');
  const secondDevice = await sign('login','alice');
  const bob = await sign('register','bob');
  const write = (session, body) => call('data', {method:'PUT',session,body});
  const update = {revision:0, mutation:randomUUID(), records:[
    {id:'bean-1',values:{name:'阿洛',weight:'60',remaining:'60'},cover:'data:image/png;base64,AA=='},
  ],recipes:[]};
  assert.equal((await write(alice, update)).status, 200);
  assert.equal((await write(alice, update)).status, 200);
  assert.equal((await write(secondDevice, {...update, mutation:randomUUID(), records:[]})).status, 409);
  const read = await call('data', {session:secondDevice});
  assert.equal(read.headers.get('etag'), '"1"');
  assert.equal((await read.json()).records[0].cover, update.records[0].cover);
  assert.equal((await call('data', {session:secondDevice,headers:{'If-None-Match':'"1"'}})).status, 304);
  assert.deepEqual((await (await call('data',{session:bob})).json()).records, []);
  assert.equal((await call('data',{session:bob,headers:{'X-Cafe-Account':alice.id}})).status, 401);

  const changed = await call('password',{method:'POST',session:alice,body:{password,newPassword:'different test password'}});
  assert.equal(changed.status, 200);
  assert.equal((await call('data',{session:secondDevice})).status, 401);
  const loggedIn = await sign('login','alice','different test password');
  assert.equal((await call('logout',{method:'POST',session:loggedIn})).status, 200);
  assert.equal((await call('data',{session:loggedIn})).status, 401);
});

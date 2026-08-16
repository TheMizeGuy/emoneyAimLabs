'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { poolOptionsFor } = require('../db');
const { loadConfig } = require('../config');
const { TEST_ENV } = require('./helpers');

test('database transport trusts Railway private networking and verifies public TLS', () => {
  assert.equal(
    poolOptionsFor('postgresql://u:p@postgres.railway.internal:5432/db').ssl,
    false,
  );
  assert.equal(poolOptionsFor('postgresql://u:p@127.0.0.1:5432/db').ssl, false);
  assert.deepEqual(
    poolOptionsFor('postgresql://u:p@db.example.test:5432/db').ssl,
    { rejectUnauthorized: true },
  );

  const bounded = poolOptionsFor('postgresql://u:p@db.example.test:5432/db');
  assert.equal(bounded.connectionTimeoutMillis, 10000);
  assert.equal(bounded.statement_timeout, 10000);
  assert.equal(bounded.query_timeout, 12000);
  assert.equal(bounded.lock_timeout, 5000);
  assert.equal(bounded.idle_in_transaction_session_timeout, 15000);
});

test('connection-string SSL switches cannot override the pool policy', () => {
  for (const query of [
    'sslmode=require',
    'ssl=0',
    'host=127.0.0.1',
    'sslnegotiation=direct',
    'application_name=aimlabs',
  ]) {
    assert.throws(
      () => loadConfig({
        ...TEST_ENV,
        DATABASE_URL: `postgresql://u:p@db.example.test/db?${query}`,
      }),
      /Invalid DATABASE_URL/,
      query,
    );
  }
});

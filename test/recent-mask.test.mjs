// "Recent on this PC" never keeps a secret typed into a command (ChatGPT recon 14.11). LOGIC: critical-logic/bridge.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { target, maskSecrets } from '../src/recent.mjs';

test('recent: labeled secrets in commands are masked; paths and plain words stay', () => {
  assert.equal(target({ command: 'mysql -u root --password hunter2 db' }), 'mysql -u root --password **** db');
  assert.equal(maskSecrets('curl -H "Authorization: Bearer abc.def" https://x'), 'curl -H "Authorization: Bearer ****" https://x');
  assert.equal(maskSecrets("$env:API_KEY='sk-123'; net use x: /user:a password=Qw3rty"), "$env:API_KEY=****; net use x: /user:a password=****");
  assert.equal(maskSecrets('ConvertTo-SecureString -Password "p w" -Force'), 'ConvertTo-SecureString -Password **** -Force');
  assert.equal(target({ path: 'C:\\Users\\Иван\\passwords.txt' }), 'C:\\Users\\Иван\\passwords.txt');
});

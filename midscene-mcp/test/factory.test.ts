import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pilihKelasDevice } from '../src/devices/factory.ts';

test('target computer memilih ComputerDeviceAdapter', () => {
  assert.equal(pilihKelasDevice('computer'), 'ComputerDeviceAdapter');
});

test('target web memilih WebDeviceAdapter', () => {
  assert.equal(pilihKelasDevice('web'), 'WebDeviceAdapter');
});

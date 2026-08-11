import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const angular = JSON.parse(await readFile(new URL('../angular.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const serve = angular.projects.frontend.architect.serve;

test('Angular development server binds IPv4 loopback by default', () => {
  assert.equal(serve.options.host, '127.0.0.1');
  assert.equal(serve.defaultConfiguration, 'development');
});

test('npm start delegates to the project-level Angular serve configuration', () => {
  assert.equal(packageJson.scripts.start, 'ng serve');
});

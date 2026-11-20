/**
 * GitHub-провайдер сверки: поиск файла в дереве репозитория.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGitHubFile } from '../src/verify/github-sync.js';

test('findGitHubFile: точное имя, подкаталог, отсутствие', () => {
  const paths = ['qlik-sense/03_Load_Layer/продажи.qvs', 'docs/readme.md'];
  assert.equal(findGitHubFile(paths, 'Продажи')?.file, 'qlik-sense/03_Load_Layer/продажи.qvs');
  assert.equal(findGitHubFile(paths, 'Скрипт'), null);
  assert.equal(findGitHubFile([], 'Продажи'), null);
});

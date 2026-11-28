/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import changes from '../.github/scripts/backend-changes.cjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nightcord-deployment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { exitCode: result.status, stdout: result.stdout.trim() };
  };
  const command = args => {
    const result = git(args);
    assert.equal(result.exitCode, 0);
    return result.stdout;
  };
  command(['init', '--quiet']);
  command(['config', 'user.email', 'deployment-test@example.com']);
  command(['config', 'user.name', 'Deployment test']);
  const commit = files => {
    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);
      mkdirSync(dirname(file), { recursive: true });
      if (content === null) rmSync(file);
      else writeFileSync(file, content);
    }
    command(['add', '.']);
    command(['commit', '--quiet', '-m', 'fixture']);
    return command(['rev-parse', 'HEAD']);
  };
  const initial = commit({ 'backend/src/chat.ts': 'initial', 'backend/wrangler.jsonc': '{}', 'README.md': 'initial' });
  async function decide({ sha = initial, head = sha, passed = true, deployments = [] } = {}) {
    const outputs = {}, errors = [];
    let inspectedDeployments = false;
    const paginate = async (_method, input) => deployments.find(item => item.id === input.deployment_id).statuses.map(state => ({ state }));
    paginate.iterator = async function* () { inspectedDeployments = true; yield { data: deployments }; };
    await changes({
      context: { repo: { owner: 'test', repo: 'nightcord' }, sha, payload: {} },
      core: { setOutput: (key, value) => { outputs[key] = value; }, info() {}, setFailed: value => errors.push(value),
        summary: { addRaw() { return this; }, async write() {} } },
      github: { paginate, rest: { repos: { getBranch: async () => ({ data: { commit: { sha: head } } }),
        listDeployments() {}, listDeploymentStatuses() {} }, actions: {
        listWorkflowRuns: async input => {
          assert.equal(input.head_sha, sha);
          assert.equal(input.event, 'push');
          assert.equal(input.status, 'success');
          return { data: { workflow_runs: passed ? [{}] : [] } };
        },
      } } },
      exec: { getExecOutput: async (program, args) => { assert.equal(program, 'git'); return git(args); } },
    });
    return { outputs, errors, inspectedDeployments };
  }
  const success = sha => [{ id: 1, sha, statuses: ['inactive', 'success'] }];
  return { initial, commit, decide, success };
}

test('deployment requires successful CI for current main, including manual retries', async t => {
  const f = fixture(t);
  const obsolete = await f.decide({ head: 'newer-main' });
  assert.equal(obsolete.outputs.deploy, 'false');
  assert.equal(obsolete.inspectedDeployments, false);
  const failed = await f.decide({ passed: false });
  assert.equal(failed.outputs.deploy, 'false');
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.inspectedDeployments, false);
  assert.equal((await f.decide()).outputs.deploy, 'true', 'first successful CI establishes the baseline');
});

test('frontend, documentation and tests do not redeploy an unchanged backend', async t => {
  const f = fixture(t);
  const sha = f.commit({ 'index.html': 'page', 'README.md': 'updated', 'backend/test/chat.test.mjs': 'test' });
  assert.equal((await f.decide({ sha, deployments: f.success(f.initial) })).outputs.deploy, 'false');
});

test('failed deployments and intervening frontend pushes do not hide unpublished backend changes', async t => {
  const f = fixture(t);
  const failed = f.commit({ 'backend/src/chat.ts': 'updated' });
  const sha = f.commit({ 'index.html': 'page' });
  const deployments = [{ id: 2, sha: failed, statuses: ['failure'] }, ...f.success(f.initial)];
  assert.equal((await f.decide({ sha, deployments })).outputs.deploy, 'true');
  assert.equal((await f.decide({ sha, deployments: f.success(sha) })).outputs.deploy, 'false');
});

test('config, dependency, migration, workflow and deleted source changes trigger deployment', async t => {
  const f = fixture(t);
  let baseline = f.initial;
  for (const path of ['backend/wrangler.jsonc', 'backend/package.json', 'backend/package-lock.json',
    'backend/tsconfig.json', 'backend/migrations/0002.sql', '.github/workflows/deploy-backend.yml',
    '.github/scripts/backend-changes.cjs', 'js/services/message-policy.js',
    'js/renderer/parser.js', 'js/renderer/resources.js', 'backend/src/chat.ts']) {
    const sha = f.commit({ [path]: path.endsWith('chat.ts') ? null : 'changed' });
    assert.equal((await f.decide({ sha, deployments: f.success(baseline) })).outputs.deploy, 'true', path);
    baseline = sha;
  }
});

test('a baseline no longer in Git history triggers deployment instead of dropping changes', async t => {
  const f = fixture(t);
  assert.equal((await f.decide({ deployments: f.success('a'.repeat(40)) })).outputs.deploy, 'true');
});

/* SPDX-License-Identifier: AGPL-3.0-only */
module.exports = async ({ context, core, github, exec }) => {
  const repo = context.repo;
  const sha = context.payload.workflow_run?.head_sha || context.sha;
  core.setOutput('sha', sha);
  core.setOutput('deploy', 'false');
  const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: 'main' });
  if (branch.commit.sha !== sha) {
    core.info('A newer main commit exists; its CI run will handle deployment.');
    return;
  }
  // Manual retries must also deploy a commit that passed the complete CI.
  const { data: checks } = await github.rest.actions.listWorkflowRuns({
    ...repo, workflow_id: 'ci.yml', branch: 'main', head_sha: sha,
    event: 'push', status: 'success', per_page: 1,
  });
  if (!checks.workflow_runs.length) {
    core.setFailed('The current main commit must pass CI before deployment.');
    return;
  }
  let baseline;
  for await (const { data: deployments } of github.paginate.iterator(
    github.rest.repos.listDeployments, { ...repo, environment: 'production-backend', per_page: 100 }
  )) {
    for (const deployment of deployments) {
      const statuses = await github.paginate(github.rest.repos.listDeploymentStatuses, {
        ...repo, deployment_id: deployment.id, per_page: 100,
      });
      if (statuses.some(status => status.state === 'success')) {
        baseline = deployment.sha;
        break;
      }
    }
    if (baseline) break;
  }
  let changed = true;
  if (baseline) {
    const present = await exec.getExecOutput('git', ['cat-file', '-e', `${baseline}^{commit}`], { ignoreReturnCode: true });
    if (present.exitCode === 0) {
      const diff = await exec.getExecOutput('git', ['diff', '--quiet', baseline, sha, '--',
        'backend/src/', 'backend/migrations/', 'backend/package.json', 'backend/package-lock.json',
        'backend/wrangler.jsonc', 'backend/tsconfig.json', '.github/workflows/deploy-backend.yml',
        '.github/scripts/backend-changes.cjs', 'js/services/message-policy.js',
        'js/renderer/parser.js', 'js/renderer/resources.js',
      ], { ignoreReturnCode: true });
      if (diff.exitCode > 1) throw new Error('Unable to compare backend changes.');
      changed = diff.exitCode === 1;
    }
  }
  core.setOutput('deploy', String(changed));
  await core.summary.addRaw(changed
    ? `Backend changes detected; deploying ${sha}.`
    : `Backend matches the last successful deployment (${baseline}); skipped.`).write();
};

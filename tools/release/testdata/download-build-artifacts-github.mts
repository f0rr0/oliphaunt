import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const native = process.env.FAKE_NATIVE_ORIGIN === 'true';
const nativeCase = process.env.FAKE_NATIVE_CASE;
const nativeSourceCommit = process.env.FAKE_NATIVE_SOURCE_COMMIT || 'a'.repeat(40);
const nativeSourceTree = process.env.FAKE_NATIVE_SOURCE_TREE || 'b'.repeat(40);

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  assert.equal(url.origin, 'https://api.github.com');
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  assert.equal(options.headers.Accept, 'application/vnd.github+json');
  const endpoint = url.pathname.slice(1) + url.search;
  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(endpoint) + '\n');
  if (/actions\/workflows[?]/.test(endpoint)) {
    return Response.json({ workflows: [{ id: 9, name: 'CI' }] });
  }
  if (/actions\/workflows\/9\/runs[?]/.test(endpoint)) {
    const page = Number(url.searchParams.get('page'));
    const selected = {
      id: 77,
      head_sha: 'a'.repeat(40),
      workflow_id: 9,
      status: 'completed',
      conclusion: 'success',
    };
    const more = process.env.FAKE_CANDIDATE_MODE === 'beyond-first-page' && page === 1;
    const workflow_runs = more
      ? Array.from({ length: 100 }, (_, index) => ({
          ...selected,
          id: 100 + index,
          conclusion: 'failure',
        }))
      : [selected];
    const next = new URL(url);
    next.searchParams.set('page', '2');
    return Response.json(
      { workflow_runs },
      { headers: more ? { link: `<${next}>; rel="next", <${next}>; rel="last"` } : {} },
    );
  }
  if (/actions\/runs\/77\/artifacts/.test(endpoint)) {
    const bytes = fs.readFileSync(process.env.FAKE_ARTIFACT_ARCHIVE);
    const identity = {
      id: Number(process.env.FAKE_ARTIFACT_ID || '101'),
      name: native ? 'native-build-evidence-x86_64' : 'exact-artifact',
      size_in_bytes: bytes.length,
      expired: false,
      digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
      ...(native
        ? {
            created_at:
              nativeCase === 'stale-artifact' ? '2026-10-10T01:00:00Z' : '2026-10-11T01:01:00Z',
            workflow_run: {
              id: 77,
              head_sha: nativeCase === 'artifact-source' ? 'f'.repeat(40) : nativeSourceCommit,
            },
          }
        : {}),
    };
    if (nativeCase === 'digest') identity.digest = 'sha256:' + 'f'.repeat(64);
    if (nativeCase === 'artifact-missing') identity.name = 'other-artifact';
    if (nativeCase === 'artifact-window-missing') delete identity.created_at;
    if (nativeCase === 'artifact-head-missing') delete identity.workflow_run.head_sha;
    return Response.json({
      artifacts: [
        identity,
        {
          ...identity,
          id: 102,
          name: nativeCase === 'artifact-ambiguous' ? identity.name : 'exact-artifact-near-match',
        },
      ],
    });
  }
  if (/actions\/runs\/77\/jobs/.test(endpoint)) {
    const jobs = [
      {
        id: 501,
        name: native ? 'Linux runtime (x86_64)' : 'Qualified',
        status: 'completed',
        conclusion: nativeCase === 'job-failure' ? 'failure' : 'success',
        run_attempt: nativeCase === 'job-attempt' ? 2 : 1,
        ...(native
          ? { started_at: '2026-10-11T01:00:00Z', completed_at: '2026-10-11T01:02:00Z' }
          : {}),
      },
    ];
    if (native)
      jobs.push({
        id: 502,
        name: 'Unrelated WASIX lane',
        status: 'completed',
        conclusion: 'failure',
        run_attempt: 1,
      });
    if (nativeCase === 'job-window-missing') delete jobs[0].started_at;
    if (process.env.FAKE_DUPLICATE_JOB === 'true') jobs.push({ ...jobs[0], id: 502 });
    return Response.json({ jobs });
  }
  if (/actions\/runs\/77$/.test(endpoint)) {
    return Response.json({
      id: 77,
      head_sha:
        nativeCase === 'source' ? 'f'.repeat(40) : native ? nativeSourceCommit : 'a'.repeat(40),
      workflow_id: 9,
      run_attempt: nativeCase === 'attempt' ? 2 : 1,
      status: process.env.FAKE_RUN_STATUS || 'completed',
      conclusion: process.env.FAKE_RUN_CONCLUSION || 'success',
      ...(native
        ? {
            path:
              nativeCase === 'run-workflow'
                ? '.github/workflows/other.yml'
                : '.github/workflows/bazel.yml',
            event:
              nativeCase === 'event'
                ? 'pull_request'
                : process.env.FAKE_NATIVE_EVENT || 'workflow_dispatch',
            head_branch:
              nativeCase === 'ref' ? 'other' : process.env.FAKE_NATIVE_HEAD_BRANCH || 'main',
            pull_requests: [],
          }
        : {}),
    });
  }
  if (/actions\/workflows\/9$/.test(endpoint))
    return Response.json({
      id: 9,
      name: native ? 'Native Bazel qualification' : 'CI',
      ...(native
        ? {
            path:
              nativeCase === 'workflow'
                ? '.github/workflows/other.yml'
                : '.github/workflows/bazel.yml',
          }
        : {}),
    });
  if (/git\/commits\/[0-9a-f]{40}$/.test(endpoint))
    return Response.json({
      sha: url.pathname.split('/').at(-1),
      tree: { sha: nativeCase === 'tree' ? 'f'.repeat(40) : nativeSourceTree },
    });
  if (/actions\/artifacts\/101\/zip$/.test(endpoint)) {
    const state = process.env.FAKE_GH_STATE;
    const count = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;
    fs.writeFileSync(state, String(count + 1));
    if (process.env.FAKE_MODE === 'transient' && count === 0)
      return new Response('unavailable', { status: 503 });
    if (process.env.FAKE_MODE === 'permanent') return new Response('not found', { status: 404 });
    if (native && process.env.FAKE_NATIVE_MUTATE_LOCAL_PACKET)
      fs.writeFileSync(
        process.env.FAKE_NATIVE_MUTATE_LOCAL_PACKET,
        '{"changedAfterAuthenticatedRead":true}',
      );
    return new Response(fs.readFileSync(process.env.FAKE_ARTIFACT_ARCHIVE));
  }
  throw new Error('unexpected GitHub endpoint ' + endpoint);
};

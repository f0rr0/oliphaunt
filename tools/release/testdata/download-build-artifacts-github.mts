import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

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
      name: 'exact-artifact',
      size_in_bytes: bytes.length,
      expired: false,
      digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
    };
    return Response.json({
      artifacts: [identity, { ...identity, id: 102, name: 'exact-artifact-near-match' }],
    });
  }
  if (/actions\/runs\/77\/jobs/.test(endpoint)) {
    const jobs = [
      { id: 501, name: 'Qualified', status: 'completed', conclusion: 'success', run_attempt: 1 },
    ];
    if (process.env.FAKE_DUPLICATE_JOB === 'true') jobs.push({ ...jobs[0], id: 502 });
    return Response.json({ jobs });
  }
  if (/actions\/runs\/77$/.test(endpoint)) {
    return Response.json({
      id: 77,
      head_sha: 'a'.repeat(40),
      workflow_id: 9,
      run_attempt: 1,
      status: process.env.FAKE_RUN_STATUS || 'completed',
      conclusion: process.env.FAKE_RUN_CONCLUSION || 'success',
    });
  }
  if (/actions\/workflows\/9$/.test(endpoint)) return Response.json({ id: 9, name: 'CI' });
  if (/actions\/artifacts\/101\/zip$/.test(endpoint)) {
    const state = process.env.FAKE_GH_STATE;
    const count = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;
    fs.writeFileSync(state, String(count + 1));
    if (process.env.FAKE_MODE === 'transient' && count === 0)
      return new Response('unavailable', { status: 503 });
    if (process.env.FAKE_MODE === 'permanent') return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(process.env.FAKE_ARTIFACT_ARCHIVE));
  }
  throw new Error('unexpected GitHub endpoint ' + endpoint);
};

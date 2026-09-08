import fs from 'node:fs';

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (
    url.origin !== 'https://api.github.com' ||
    options.headers.Authorization !== 'Bearer test-token'
  )
    throw new Error('unexpected GitHub request');
  const endpoint = url.pathname.slice(1) + url.search;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(endpoint) + '\n');
  if (/actions\/runs\/77\/jobs/.test(endpoint)) {
    const jobs = [
      {
        name: process.env.FAKE_RELEASE ? 'Prepare frozen publication candidate' : 'Qualified',
        conclusion: process.env.FAKE_MODE === 'failed-candidate' ? 'failure' : 'success',
      },
    ];
    if (process.env.FAKE_MODE === 'duplicate-job') jobs.push({ ...jobs[0] });
    return Response.json({ jobs });
  }
  if (/actions\/workflows[?]/.test(endpoint)) {
    return Response.json({ workflows: [{ id: 9, name: 'CI' }] });
  }
  if (/actions\/workflows\/9\/runs[?]/.test(endpoint)) {
    const state = process.env.FAKE_STATE;
    const count = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;
    fs.writeFileSync(state, String(count + 1));
    if (process.env.FAKE_MODE === 'transient' && count === 0) {
      return new Response('unavailable', { status: 503 });
    }
    if (process.env.FAKE_MODE === 'permanent') {
      return new Response('bad credentials', { status: 401 });
    }
    const selected = {
      id: 77,
      head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'completed',
      conclusion: 'success',
      run_attempt: 3,
      html_url: 'https://example.invalid/run/77',
      event: 'push',
    };
    const page = new URL('https://api.github.com/' + endpoint).searchParams.get('page');
    const workflow_runs =
      process.env.FAKE_MODE === 'beyond-first-page'
        ? page === '1'
          ? Array.from({ length: 100 }, (_, index) => ({
              ...selected,
              id: 100 + index,
              conclusion: 'failure',
            }))
          : [selected]
        : [selected];
    const link =
      process.env.FAKE_MODE === 'beyond-first-page' && page === '1'
        ? '<https://api.github.com/repos/f0rr0/oliphaunt/actions/workflows/9/runs?head_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&page=2&per_page=100>; rel="next", <https://api.github.com/repos/f0rr0/oliphaunt/actions/workflows/9/runs?head_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&page=2&per_page=100>; rel="last"'
        : '';
    return Response.json({ workflow_runs }, { headers: link ? { link } : {} });
  }
  if (/actions\/runs\/77\/artifacts/.test(endpoint)) {
    const artifact = {
      id: 901,
      name: 'required-artifact',
      size_in_bytes: 123,
      digest: 'sha256:' + '1'.repeat(64),
      expired: false,
    };
    const gateArtifact = {
      id: 903,
      name: 'gate-artifact',
      size_in_bytes: 456,
      digest: 'sha256:' + '2'.repeat(64),
      expired: false,
    };
    const artifacts =
      process.env.FAKE_MODE === 'duplicate-artifact'
        ? [artifact, { ...artifact, id: 902 }]
        : process.env.FAKE_MODE === 'expired-artifact'
          ? [{ ...artifact, expired: true }]
          : process.env.FAKE_MODE === 'missing-gate-artifact'
            ? [artifact]
            : process.env.FAKE_MODE === 'malformed-artifact-metadata'
              ? [{ ...artifact, digest: undefined }]
              : [artifact, gateArtifact];
    return Response.json({ artifacts });
  }
  if (/actions\/runs\/77$/.test(endpoint)) {
    if (process.env.FAKE_MODE === 'metadata-auth')
      return new Response('bad credentials', { status: 401 });
    if (process.env.FAKE_MODE === 'metadata-transient')
      return new Response('unavailable', { status: 503 });
    const sha =
      process.env.FAKE_MODE === 'wrong-sha'
        ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        : process.env.FAKE_MODE === 'upper-sha'
          ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
          : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const status = process.env.FAKE_MODE === 'in-progress-run' ? 'in_progress' : 'completed';
    const conclusion =
      process.env.FAKE_MODE === 'in-progress-run'
        ? ''
        : process.env.FAKE_MODE === 'failed-run' ||
            (process.env.FAKE_RELEASE &&
              ['failed-candidate', 'duplicate-job', 'expired-artifact', 'wrong-sha'].includes(
                process.env.FAKE_MODE,
              ))
          ? 'failure'
          : 'success';
    return Response.json({
      head_sha: sha,
      workflow_id: 9,
      event: process.env.FAKE_RELEASE ? 'workflow_dispatch' : 'push',
      status,
      conclusion,
      run_attempt: 3,
    });
  }
  if (/actions\/workflows\/9$/.test(endpoint)) {
    return Response.json({ name: process.env.FAKE_RELEASE ? 'Release' : 'CI' });
  }
  throw new Error('unexpected GitHub endpoint ' + endpoint);
};

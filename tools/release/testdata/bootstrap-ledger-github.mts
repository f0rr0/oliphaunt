import crypto from 'node:crypto';
import fs from 'node:fs';

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.github.com') throw new Error('unexpected fixture origin');
  if (options.headers.Authorization !== 'Bearer test-token')
    throw new Error('missing fixture authorization');
  const endpoint = url.pathname.slice(1) + url.search;
  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(endpoint) + '\n');
  const attempt = /\/runs\/([0-9]+)\/attempts\/([0-9]+)$/.exec(endpoint);
  if (attempt) {
    return new Response(process.env.FAKE_ATTEMPT_METADATA);
  }
  const run = /\/actions\/runs\/([0-9]+)$/.exec(endpoint);
  if (run) {
    if (run[1] !== '900') throw new Error('unexpected run ' + run[1]);
    return new Response(process.env.FAKE_CURRENT_RUN);
  }
  if (/\/actions\/artifacts[?]name=/.test(endpoint)) {
    const url = new URL('https://api.github.com/' + endpoint);
    const page = Number(url.searchParams.get('page'));
    const zips = JSON.parse(process.env.FAKE_ZIPS_BY_ARTIFACT);
    const all = Object.values(JSON.parse(process.env.FAKE_ARTIFACTS_BY_RUN))
      .flat()
      .map((artifact) => {
        const archive = zips[String(artifact.id)];
        const bytes = archive ? fs.readFileSync(archive) : null;
        return {
          ...artifact,
          ...(bytes === null
            ? {}
            : {
                size_in_bytes: bytes.length,
                digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
              }),
          workflow_run: {
            head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ...artifact.workflow_run,
          },
        };
      });
    const artifacts = all.slice((page - 1) * 100, page * 100);
    let link = '';
    if (page * 100 < all.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      const last = new URL(url);
      last.searchParams.set('page', String(Math.ceil(all.length / 100)));
      link = `<${next}>; rel="next", <${last}>; rel="last"`;
    }
    return Response.json({ total_count: all.length, artifacts }, { headers: link ? { link } : {} });
  }
  const download = /\/artifacts\/([0-9]+)\/zip$/.exec(endpoint);
  if (download) {
    const archive = JSON.parse(process.env.FAKE_ZIPS_BY_ARTIFACT)[download[1]];
    if (!archive) throw new Error('missing fake artifact ZIP ' + download[1]);
    const state = process.env.FAKE_DOWNLOAD_STATE;
    const count = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;
    fs.writeFileSync(state, String(count + 1));
    if (process.env.FAKE_DOWNLOAD_MODE === 'transient' && count === 0) {
      return new Response('unavailable', { status: 503 });
    }
    const bytes = fs.readFileSync(archive);
    if (process.env.FAKE_DOWNLOAD_MODE === 'identity-mismatch') {
      const altered = Buffer.from(bytes);
      altered[Math.min(10, altered.length - 1)] ^= 0x01;
      return new Response(altered);
    } else {
      return new Response(
        process.env.FAKE_DOWNLOAD_MODE === 'truncated' ? bytes.subarray(0, 3) : bytes,
      );
    }
  }
  throw new Error('unexpected gh api endpoint ' + endpoint);
};

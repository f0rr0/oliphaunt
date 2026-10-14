/** Identity supplied by the existing Git snapshot launcher. */
export function sourceIdentity(headRef: string) {
  const snapshot = JSON.parse(process.env.OLIPHAUNT_GIT_SOURCE_JSON || '{}');
  if (
    ![snapshot.commit, snapshot.tree, snapshot.checkout].every((value) =>
      /^[0-9a-f]{40}$/u.test(value ?? ''),
    ) ||
    !(
      headRef === snapshot.ref ||
      headRef === snapshot.commit ||
      (headRef === 'HEAD' && snapshot.checkout === snapshot.commit)
    )
  ) {
    throw new Error(
      'publication-lock: source identity for ' +
        headRef +
        ' requires a matching Git snapshot from bash tools/release/with-source.sh',
    );
  }
  return { commit: snapshot.commit, tree: snapshot.tree };
}

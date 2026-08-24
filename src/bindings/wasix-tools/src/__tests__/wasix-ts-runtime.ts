export async function runWasixToolProcess(): Promise<never> {
  throw new Error('unexpected WASIX tool runtime call in validation test');
}

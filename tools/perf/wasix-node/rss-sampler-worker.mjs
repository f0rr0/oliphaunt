import { workerData } from 'node:worker_threads';

const peakRssKiB = new Int32Array(workerData);

sample();
setInterval(sample, 2);

function sample() {
  const rssKiB = Math.ceil(process.memoryUsage.rss() / 1024);
  let current = Atomics.load(peakRssKiB, 0);
  while (rssKiB > current) {
    const observed = Atomics.compareExchange(peakRssKiB, 0, current, rssKiB);
    if (observed === current) return;
    current = observed;
  }
}

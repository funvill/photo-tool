// The tagging worker answers a ping with the version of onnxruntime-node it loaded, without a model: what the
// desktop self-test (taggingWorkerLoads) asks the installed worker, to prove its native runtime loads.
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { taggingWorkerSource } from '../server/tagging/workerSource';

describe('tagging worker ping', () => {
  it('the worker answers a ping with the onnxruntime version', async () => {
    const worker = new Worker(taggingWorkerSource());
    try {
      const reply = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No pong within 30 s.')), 30_000);
        worker.once('message', (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        worker.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        worker.postMessage({ type: 'ping' });
      });
      expect(reply).toEqual({ type: 'pong', ort: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    } finally {
      await worker.terminate();
    }
  }, 35_000);
});

// Runs in a worker thread: loads the tagging models with Transformers.js (onnxruntime-node, CPU) and answers one
// request at a time. Local files only: remote models are switched off, so nothing here touches the network.
// Imports nothing of the app at run time (it runs from source as plain TypeScript in development).
import { parentPort } from 'node:worker_threads';
import { basename, dirname } from 'node:path';
import {
  env, AutoProcessor, AutoTokenizer, RawImage,
  Florence2ForConditionalGeneration, CLIPVisionModelWithProjection, CLIPTextModelWithProjection,
} from '@huggingface/transformers';

export type WorkerRequest =
  | { id: number; op: 'load'; part: 'describe' | 'keywords'; dir: string; dtype: string; threads: number; keywordThreshold: number; vocabulary: string[] }
  /** describe with `sample`: the caption is sampled (a new wording each time); objects stay greedy. */
  | { id: number; op: 'describe'; path: string; sample?: boolean }
  | { id: number; op: 'keywords'; path: string }
  /** The caption only, sampled: what Regenerate asks for (no object detection). */
  | { id: number; op: 'caption'; path: string }
  | { id: number; op: 'embedText'; text: string };
export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; load?: boolean; lost?: boolean };
/**
 * Outside the request queue, no model needed: is onnxruntime-node loaded? `ort` is its version (empty when
 * Transformers.js did not load it). The desktop self-test asks this of the installed worker (taggingWorkerLoads).
 */
export type WorkerPing = { type: 'ping' };
export type WorkerPong = { type: 'pong'; ort: string };

/** Asked to use a model this worker has not loaded (it was restarted): the caller loads it again. */
class NotLoaded extends Error {}

env.allowRemoteModels = false;
env.allowLocalModels = true;

/** CLIP's own scale for picture–text similarity before a softmax. */
const LOGIT_SCALE = 100;
const MAX_KEYWORDS = 12;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let florence: { model: Any; processor: Any; tokenizer: Any } | null = null;
let clip: { vision: Any; text: Any; processor: Any; tokenizer: Any; vocab: Float32Array[]; words: string[]; threshold: number } | null = null;

const unit = (v: Float32Array): Float32Array => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Transformers.js finds a local model at `<localModelPath><name>/`. */
const from = (dir: string) => {
  env.localModelPath = `${dirname(dir)}/`;
  return basename(dir);
};

async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const { text_embeds } = await clip!.text(clip!.tokenizer(batch, { padding: true, truncation: true }));
    const d = text_embeds.dims[1];
    for (let j = 0; j < batch.length; j++) out.push(unit(text_embeds.data.slice(j * d, (j + 1) * d)));
  }
  return out;
}

async function load(r: Extract<WorkerRequest, { op: 'load' }>) {
  const opts = { dtype: r.dtype as 'q8', device: 'cpu' as const, local_files_only: true, session_options: { intraOpNumThreads: r.threads, interOpNumThreads: 1 } };
  const name = from(r.dir);
  if (r.part === 'describe') {
    await florence?.model.dispose();
    florence = null;
    florence = {
      model: await Florence2ForConditionalGeneration.from_pretrained(name, opts),
      processor: await AutoProcessor.from_pretrained(name, { local_files_only: true }),
      tokenizer: await AutoTokenizer.from_pretrained(name, { local_files_only: true }),
    };
  } else {
    await clip?.vision.dispose();
    await clip?.text.dispose();
    clip = null;
    const loaded = {
      vision: await CLIPVisionModelWithProjection.from_pretrained(name, opts),
      text: await CLIPTextModelWithProjection.from_pretrained(name, opts),
      processor: await AutoProcessor.from_pretrained(name, { local_files_only: true }),
      tokenizer: await AutoTokenizer.from_pretrained(name, { local_files_only: true }),
      vocab: [] as Float32Array[],
      words: r.vocabulary,
      threshold: r.keywordThreshold,
    };
    clip = loaded;
    loaded.vocab = await embedTexts(r.vocabulary.map((w) => `a photo of ${w}`));
  }
  return null;
}

/**
 * Greedy decoding gives the same sentence every time; Regenerate samples instead (multinomial over the 50 likeliest
 * tokens, a little cooler than the model's own spread), so each try can word it differently.
 */
const SAMPLING = { do_sample: true, temperature: 0.7, top_k: 50 };

async function florenceTask(image: Any, task: string, maxTokens: number, sample = false) {
  const { model, processor, tokenizer } = florence!;
  const vision = await processor(image);
  const text = tokenizer(processor.construct_prompts(task));
  const ids = await model.generate({ ...text, ...vision, max_new_tokens: maxTokens, ...(sample ? SAMPLING : {}) });
  const out = tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
  return processor.post_process_generation(out, task, image.size)[task];
}

const captionOf = async (image: Any, sample: boolean) =>
  String((await florenceTask(image, '<MORE_DETAILED_CAPTION>', 100, sample)) ?? '').replace(/<[^>]*>/g, '').trim();

async function caption(path: string) {
  if (!florence) throw new NotLoaded('The descriptions model is not loaded.');
  return captionOf(await RawImage.read(path), true);
}

async function describe(path: string, sample = false) {
  if (!florence) throw new NotLoaded('The descriptions model is not loaded.');
  const image = await RawImage.read(path);
  const caption = await captionOf(image, sample);
  const od = (await florenceTask(image, '<OD>', 256)) as { labels?: string[] } | undefined;
  const counts = new Map<string, number>();
  for (const l of od?.labels ?? []) {
    const label = l.trim().toLowerCase();
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return { description: caption, objects: [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)) };
}

async function keywords(path: string) {
  if (!clip) throw new NotLoaded('The keywords model is not loaded.');
  const image = await RawImage.read(path);
  const { image_embeds } = await clip.vision(await clip.processor(image));
  const embedding = unit(image_embeds.data as Float32Array);
  const sims = clip.vocab.map((v) => dot(embedding, v));
  const max = Math.max(...sims);
  const exps = sims.map((s) => Math.exp(LOGIT_SCALE * (s - max)));
  const total = exps.reduce((a, b) => a + b, 0);
  const words = clip.words
    .map((label, i) => ({ label, score: exps[i] / total }))
    .filter((w) => w.score >= clip!.threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_KEYWORDS);
  return { keywords: words, embedding };
}

async function embedText(text: string) {
  if (!clip) throw new NotLoaded('The keywords model is not loaded.');
  return (await embedTexts([text]))[0];
}

async function handle(r: WorkerRequest): Promise<WorkerReply> {
  try {
    let result: unknown;
    if (r.op === 'load') result = await load(r);
    else if (r.op === 'embedText') result = await embedText(r.text);
    else if (r.op === 'describe') result = await describe(r.path, r.sample);
    else if (r.op === 'caption') result = await caption(r.path);
    else result = await keywords(r.path);
    return { id: r.id, ok: true, result };
  } catch (e) {
    return { id: r.id, ok: false, error: e instanceof Error ? e.message : String(e), load: r.op === 'load', lost: e instanceof NotLoaded };
  }
}

// One request at a time, in order; except a search's words (embedText), which wait only for a keywords model
// still loading, not for a photo being described (many seconds): the models' runs are async, so it fits in between.
let chain: Promise<unknown> = Promise.resolve();
let keywordsReady: Promise<unknown> = Promise.resolve();
parentPort?.on('message', (r: WorkerRequest | WorkerPing) => {
  if ('type' in r) {
    // Transformers.js loaded onnxruntime-node (its native binding) on import, before this message could arrive.
    if (r.type === 'ping') parentPort!.postMessage({ type: 'pong', ort: String((env.backends.onnx as Any)?.versions?.node ?? '') } satisfies WorkerPong);
    return;
  }
  const reply = async () => parentPort!.postMessage(await handle(r));
  if (r.op === 'embedText') {
    void keywordsReady.then(reply);
    return;
  }
  chain = chain.then(reply);
  if (r.op === 'load' && r.part === 'keywords') keywordsReady = chain;
});

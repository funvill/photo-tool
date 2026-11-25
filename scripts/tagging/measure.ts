/**
 * Measures the candidate on-device tagging models (Task 1 of the tagging plan).
 * Downloads them from Hugging Face into --cache <dir> (outside the repo), runs each on every JPEG in
 * fixtures/generated/trip and prints sizes, load time, seconds per photo and the outputs.
 *
 *   npx tsx scripts/tagging/measure.ts --cache %TEMP%\photobook-models [--only florence|clip] [--dtype q8]
 */
import { readdirSync, statSync, readdirSync as ls } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import {
  env, AutoProcessor, AutoTokenizer, RawImage,
  Florence2ForConditionalGeneration, CLIPVisionModelWithProjection, CLIPTextModelWithProjection,
} from '@huggingface/transformers';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const cache = arg('cache');
if (!cache) throw new Error('--cache <dir> is required');
const only = arg('only');
const dtype = arg('dtype', 'q8') as 'q8';
env.cacheDir = resolve(cache);
env.allowLocalModels = false;
const threads = Math.max(1, Math.floor(cpus().length / 2));
const session_options = { intraOpNumThreads: threads, interOpNumThreads: 1 };

const photosDir = resolve('fixtures/generated/trip');
const photos = readdirSync(photosDir).filter((f) => /\.jpe?g$/i.test(f)).map((f) => join(photosDir, f));

/** Draft vocabulary; the final list lives in photo-tool/server/tagging/vocabulary.ts. */
const DRAFT_VOCAB = [
  'beach', 'sea', 'harbour', 'boat', 'lake', 'river', 'mountain', 'forest', 'trail', 'garden', 'flower', 'tree',
  'sky', 'sunset', 'sunrise', 'night', 'city', 'street', 'building', 'market', 'cafe', 'restaurant', 'food',
  'lunch', 'coffee', 'cake', 'museum', 'painting', 'statue', 'church', 'bridge', 'car', 'train', 'airport',
  'plane', 'station', 'person', 'people', 'child', 'crowd', 'dog', 'cat', 'bird', 'horse', 'snow', 'rain',
  'road', 'house', 'kitchen', 'table', 'party', 'birthday', 'wedding', 'portrait', 'selfie', 'landscape',
  'panorama', 'water', 'grass', 'field', 'desert', 'park', 'playground', 'bicycle', 'shop', 'sign', 'text',
  'document', 'screenshot', 'abstract pattern', 'gradient', 'colour blocks', 'blurry photo',
];
const PHRASES = ['a harbour by the sea', 'a lake in the mountains', 'food on a table', 'a busy street', 'a cat on a sofa'];

const bytesIn = (dir: string): number => {
  let n = 0;
  for (const e of ls(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? bytesIn(p) : statSync(p).size;
  }
  return n;
};
const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`;
const repoDir = (repo: string) => join(env.cacheDir!, repo);
const time = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await f();
  return [r, (performance.now() - t) / 1000];
};
const summary = (secs: number[]) =>
  `mean ${(secs.reduce((a, b) => a + b, 0) / secs.length).toFixed(2)} s, max ${Math.max(...secs).toFixed(2)} s`;

async function florence(repo: string) {
  console.log(`\n=== ${repo} (${dtype}, ${threads} threads)`);
  const [loaded, loadSecs] = await time(async () => ({
    model: await Florence2ForConditionalGeneration.from_pretrained(repo, { dtype, device: 'cpu', session_options }),
    processor: await AutoProcessor.from_pretrained(repo),
    tokenizer: await AutoTokenizer.from_pretrained(repo),
  }));
  const { model, processor, tokenizer } = loaded as any;
  console.log(`load ${loadSecs.toFixed(1)} s, on disk ${mb(bytesIn(repoDir(repo)))}`);
  const run = async (image: RawImage, task: string, maxTokens: number) => {
    const vision = await processor(image);
    const text = tokenizer(processor.construct_prompts(task));
    const ids = await model.generate({ ...text, ...vision, max_new_tokens: maxTokens });
    const out = tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
    return processor.post_process_generation(out, task, image.size);
  };
  const secs: number[] = [];
  for (const p of photos) {
    const image = await RawImage.read(p);
    const [res, s] = await time(async () => ({
      caption: await run(image, '<MORE_DETAILED_CAPTION>', 100),
      od: await run(image, '<OD>', 256),
    }));
    secs.push(s);
    const labels = (res.od['<OD>']?.labels ?? []) as string[];
    console.log(`${p.split(/[\\/]/).pop()}  ${s.toFixed(2)} s\n  ${res.caption['<MORE_DETAILED_CAPTION>']}\n  objects: ${labels.join(', ')}`);
  }
  console.log(`seconds/photo: ${summary(secs)}`);
  await model.dispose();
}

async function clip(repo: string) {
  console.log(`\n=== ${repo} (${dtype}, ${threads} threads)`);
  const [loaded, loadSecs] = await time(async () => ({
    vision: await CLIPVisionModelWithProjection.from_pretrained(repo, { dtype, device: 'cpu', session_options }),
    text: await CLIPTextModelWithProjection.from_pretrained(repo, { dtype, device: 'cpu', session_options }),
    processor: await AutoProcessor.from_pretrained(repo),
    tokenizer: await AutoTokenizer.from_pretrained(repo),
  }));
  const { vision, text, processor, tokenizer } = loaded as any;
  console.log(`load ${loadSecs.toFixed(1)} s, on disk ${mb(bytesIn(repoDir(repo)))}`);
  const norm = (v: Float32Array) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const embedTexts = async (texts: string[]) => {
    const { text_embeds } = await text(tokenizer(texts, { padding: true, truncation: true }));
    const d = text_embeds.dims[1];
    return texts.map((_, i) => norm(text_embeds.data.slice(i * d, (i + 1) * d)));
  };
  const vocab = await embedTexts(DRAFT_VOCAB.map((w) => `a photo of ${w}`));
  const phrases = await embedTexts(PHRASES);
  const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
  const secs: number[] = [];
  for (const p of photos) {
    const image = await RawImage.read(p);
    const [emb, s] = await time(async () => {
      const { image_embeds } = await vision(await processor(image));
      return norm(image_embeds.data as Float32Array);
    });
    secs.push(s);
    const sims = vocab.map((v) => dot(emb, v));
    const exps = sims.map((x) => Math.exp(100 * x));
    const total = exps.reduce((a, b) => a + b, 0);
    const top = DRAFT_VOCAB.map((w, i) => ({ w, sim: sims[i], prob: exps[i] / total }))
      .sort((a, b) => b.sim - a.sim).slice(0, 12);
    console.log(`${p.split(/[\\/]/).pop()}  ${s.toFixed(2)} s\n  ${top.map((t) => `${t.w} ${t.sim.toFixed(3)}/${t.prob.toFixed(2)}`).join(', ')}`);
    console.log(`  phrases: ${PHRASES.map((ph, i) => `${ph}=${dot(emb, phrases[i]).toFixed(3)}`).join(', ')}`);
  }
  console.log(`seconds/photo: ${summary(secs)}`);
  await vision.dispose();
  await text.dispose();
}

console.log(`${photos.length} photos, ${cpus().length} logical CPUs (${cpus()[0].model})`);
if (only !== 'clip') {
  for (const repo of ['onnx-community/Florence-2-base-ft', 'onnx-community/Florence-2-large-ft']) {
    await florence(repo).catch((e) => console.log(`FAILED ${repo}: ${e?.stack ?? e}`));
  }
}
if (only !== 'florence') {
  for (const repo of ['Xenova/clip-vit-base-patch32', 'Xenova/clip-vit-large-patch14']) {
    await clip(repo).catch((e) => console.log(`FAILED ${repo}: ${e?.stack ?? e}`));
  }
}

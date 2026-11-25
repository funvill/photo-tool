// What runs the tagging models. The real one (workerBackend) runs Transformers.js in a worker thread; tests use a fake.
import type { ModelChoice, TagPart } from '../../../core/tagModels';

export interface DescribeResult {
  description: string;
  objects: { label: string; count: number }[];
}

export interface KeywordResult {
  keywords: { label: string; score: number }[];
  /** Unit length, in the same space as embedText's. */
  embedding: Float32Array;
}

export interface TaggerBackend {
  /** Throws ModelLoadError when the model's folder is incomplete or will not load. */
  load(part: TagPart, model: ModelChoice, dir: string): Promise<void>;
  describe(imagePath: string): Promise<DescribeResult>;
  keywords(imagePath: string): Promise<KeywordResult>;
  embedText(text: string): Promise<Float32Array>;
  close(): Promise<void>;
}

export class ModelLoadError extends Error {}

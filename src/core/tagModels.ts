// The on-device photo-tagging models the gallery can download, fixed in code (never fetched): each file is
// pinned to one Hugging Face commit and checked against its SHA-256 before use. Values measured on
// 2026-11-24 (docs/superpowers/notes/2026-11-24-tagging-measurements.md); changing them is a code change.

export type TagPart = 'describe' | 'keywords';

export interface ModelFile {
  /** Path inside the repository (and inside `<dataDir>/models/<id>/`). */
  path: string;
  bytes: number;
  sha256: string;
}

export interface ModelChoice {
  id: string;
  part: TagPart;
  size: 'smaller' | 'larger';
  label: string;
  repo: string;
  /** The commit every file is taken from. */
  revision: string;
  /** As passed to Transformers.js. */
  dtype: string;
  files: ModelFile[];
  licence: 'MIT' | 'Apache-2.0' | 'BSD-3-Clause';
  /** Typical seconds per photo on a six-core desktop processor. */
  secondsPerPhoto: number;
  /** Keywords part only: the lowest share of the vocabulary's attention a keyword needs to be kept. */
  keywordThreshold?: number;
  /** Keywords part only: the lowest picture–text similarity search by meaning shows. */
  meaningThreshold?: number;
}

const CLIP_PROCESSOR = { path: 'preprocessor_config.json', bytes: 520, sha256: '6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f' };
const CLIP_TOKENIZER_CONFIG = { path: 'tokenizer_config.json', bytes: 775, sha256: '60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967' };

export const MODEL_CATALOGUE: readonly ModelChoice[] = [
  {
    id: 'florence2-base-q8',
    part: 'describe',
    size: 'smaller',
    label: 'Florence-2 base',
    repo: 'onnx-community/Florence-2-base-ft',
    revision: 'e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f',
    dtype: 'q8',
    files: [
      { path: 'config.json', bytes: 5432, sha256: 'd90c22ed72eb55291f183fcd9b98ebd3bd3d92bfcffb6c7f6e1606085e793525' },
      { path: 'generation_config.json', bytes: 292, sha256: '7b8eb17bbd6cf8a07f619ad83ae03881eff05b6b9237bab89005b40e77783c29' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 98177697, sha256: 'f22f52f980c33df0efa15932c2f3db6d9d3595ce6387eca938b8cfe23dc4c641' },
      { path: 'onnx/embed_tokens_quantized.onnx', bytes: 39390433, sha256: '6b2258db1c8ee9b160576ccde3cd3814d83a2edaed0dd1c6ca9ff3c38fa62214' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 43651493, sha256: 'f4ad7a68f1fb875d3bcf735ea14a7021b7ba7e83baf7cf10289881b4ed6d9b85' },
      { path: 'onnx/vision_encoder_quantized.onnx', bytes: 93746540, sha256: '3b79d54f23f666f731549db23cb070c35a979ce19cbd9720e90e67a78dc9768c' },
      { path: 'preprocessor_config.json', bytes: 2673, sha256: 'c892857e34a7082284983a7717717d39c9bf7e574f1f41d80d4c918c97502efa' },
      { path: 'tokenizer.json', bytes: 2297961, sha256: 'd69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac' },
      { path: 'tokenizer_config.json', bytes: 197658, sha256: 'd8e64607233cb53b619fb46664f6cad08176c26e0e8735b2d30d888364f19600' },
    ],
    licence: 'MIT',
    secondsPerPhoto: 6,
  },
  {
    id: 'florence2-large-q8',
    part: 'describe',
    size: 'larger',
    label: 'Florence-2 large',
    repo: 'onnx-community/Florence-2-large-ft',
    revision: '04ace74913c28d7ec94af32cee5c111a10126b6f',
    dtype: 'q8',
    files: [
      { path: 'config.json', bytes: 5460, sha256: '226291bd5b65c932b01704838489cdc810f0f4949f182abc3de67d7a6ab3632a' },
      { path: 'generation_config.json', bytes: 62, sha256: '6257874d1d2fd60a5c0786253005d9dfa46f5287903fdb079ca9829ec13cf8b4' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 257619824, sha256: '167e7807fb1e5b8d693138f84bc81e1368ea11833264131c1ea96eafc9d13222' },
      { path: 'onnx/embed_tokens_quantized.onnx', bytes: 52520480, sha256: 'dab1d09ab449f1302df6e439b35ec9e93fb037134bf6bed9ffeaa93a5b35d43c' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 152985855, sha256: '9fe30b02cc8c2247631f8f0b9bc4d6613df1c33da0afe4087abff2f940bc2fe0' },
      { path: 'onnx/vision_encoder_quantized.onnx', bytes: 366371802, sha256: '0dbf2172ef1dc6fbb4da0f02498ef9e3a009bf84e8f2e0d971f39cc5b7e053ce' },
      { path: 'preprocessor_config.json', bytes: 2672, sha256: '3adbbeec44c2b8f41a1e97b3ab2197227fb24be1fc1779c9d0d925f4e77d6559' },
      { path: 'tokenizer.json', bytes: 2297961, sha256: 'd69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac' },
      { path: 'tokenizer_config.json', bytes: 197658, sha256: 'd8e64607233cb53b619fb46664f6cad08176c26e0e8735b2d30d888364f19600' },
    ],
    licence: 'MIT',
    secondsPerPhoto: 20,
  },
  {
    id: 'clip-base-q8',
    part: 'keywords',
    size: 'smaller',
    label: 'CLIP base',
    repo: 'Xenova/clip-vit-base-patch32',
    revision: '6b7c523703ae26e39be4b03774966f8571c7f523',
    dtype: 'q8',
    files: [
      { path: 'config.json', bytes: 4524, sha256: '493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495' },
      { path: 'onnx/text_model_quantized.onnx', bytes: 64504507, sha256: '73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a' },
      { path: 'onnx/vision_model_quantized.onnx', bytes: 89117001, sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299' },
      CLIP_PROCESSOR,
      { path: 'tokenizer.json', bytes: 2224119, sha256: 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd' },
      CLIP_TOKENIZER_CONFIG,
    ],
    licence: 'MIT',
    secondsPerPhoto: 0.1,
    keywordThreshold: 0.05,
    meaningThreshold: 0.27,
  },
  {
    id: 'clip-large-q8',
    part: 'keywords',
    size: 'larger',
    label: 'CLIP large',
    repo: 'Xenova/clip-vit-large-patch14',
    revision: 'c307790166907339eed5a9a53a249af534102536',
    dtype: 'q8',
    files: [
      { path: 'config.json', bytes: 694, sha256: '99d2f15ccaf4f72c1e4c656dc77ae0fa487696860617ea50626d3a14a018185d' },
      { path: 'onnx/text_model_quantized.onnx', bytes: 124987663, sha256: '6d31c7a212681c3918d78193b6b4f98c70fe540577f9a0a57fe7ba8c7439244c' },
      { path: 'onnx/vision_model_quantized.onnx', bytes: 307001500, sha256: '9a658de8944a2001719beabf6c5030cfe7b3dc80e85983f69fc648d6b4d7ec0f' },
      CLIP_PROCESSOR,
      { path: 'tokenizer.json', bytes: 2224081, sha256: '72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85' },
      CLIP_TOKENIZER_CONFIG,
    ],
    licence: 'MIT',
    secondsPerPhoto: 0.5,
    keywordThreshold: 0.05,
    meaningThreshold: 0.24,
  },
];

export const modelBytes = (m: ModelChoice): number => m.files.reduce((s, f) => s + f.bytes, 0);

export const findModel = (id: string, catalogue: readonly ModelChoice[] = MODEL_CATALOGUE): ModelChoice | undefined =>
  catalogue.find((m) => m.id === id);

export const choicesFor = (part: TagPart, catalogue: readonly ModelChoice[] = MODEL_CATALOGUE): ModelChoice[] =>
  catalogue.filter((m) => m.part === part).sort((a, b) => (a.size === b.size ? 0 : a.size === 'smaller' ? -1 : 1));

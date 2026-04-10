import { embed } from "ai";
import type { EmbeddingModel } from "ai";

let _embeddingModel: EmbeddingModel | undefined;

export function setEmbeddingModel(model: EmbeddingModel): void {
  _embeddingModel = model;
}

export function getEmbeddingModel(): EmbeddingModel | undefined {
  return _embeddingModel;
}

/**
 * Generate an embedding for text. Falls back to a bag-of-words hash
 * if no embedding model is configured (for offline/local use).
 */
export async function embedText(text: string): Promise<number[]> {
  if (_embeddingModel) {
    const { embedding } = await embed({ model: _embeddingModel, value: text });
    return embedding;
  }
  // Fallback: deterministic hash-based pseudo-embedding (64 dims).
  // Not great for real semantic search but works for exact/tag matching.
  return hashEmbed(text, 64);
}

function hashEmbed(text: string, dims: number): number[] {
  const vec = new Array(dims).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    let h = 0;
    for (let i = 0; i < word.length; i++) {
      h = ((h << 5) - h + word.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(h) % dims;
    vec[idx] += h > 0 ? 1 : -1;
  }
  // Normalize
  const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

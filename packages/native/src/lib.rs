#![deny(clippy::all)]

mod parser;

use napi_derive::napi;
use ignore::WalkBuilder;
use rayon::prelude::*;
use std::fs;
use std::collections::HashSet;

#[napi(object)]
pub struct ScannedFile {
  pub absolute_path: String,
  pub relative_path: String,
  pub size_bytes: i64,
  pub mtime_ms: i64,
}

#[napi]
pub fn scan_workspace_fast(root_path: String, allowed_extensions: Vec<String>) -> Vec<ScannedFile> {
  let ext_set: HashSet<String> = allowed_extensions.into_iter().collect();
  let root = std::path::Path::new(&root_path);

  let mut entries = Vec::new();
  let walker = WalkBuilder::new(&root_path)
    .hidden(true)
    .git_ignore(true)
    .build();

  for result in walker {
    if let Ok(entry) = result {
      if entry.file_type().map_or(false, |ft| ft.is_file()) {
        let path = entry.path();
        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
          let dot_ext = format!(".{}", ext);
          if ext_set.contains(&dot_ext) {
            entries.push(path.to_path_buf());
          }
        }
      }
    }
  }

  entries
    .par_iter()
    .filter_map(|path| {
      let metadata = fs::metadata(path).ok()?;
      let rel = path.strip_prefix(root).ok()?.to_string_lossy().to_string();

      Some(ScannedFile {
        absolute_path: path.to_string_lossy().to_string(),
        relative_path: rel.replace('\\', "/"),
        size_bytes: metadata.len() as i64,
        mtime_ms: metadata
          .modified()
          .ok()?
          .duration_since(std::time::UNIX_EPOCH)
          .ok()?
          .as_millis() as i64,
      })
    })
    .collect()
}

fn djb2_hash(s: &str) -> String {
  let mut h: u32 = 5381;
  for b in s.bytes() {
    h = h.wrapping_shl(5).wrapping_add(h).wrapping_add(b as u32);
  }
  format!("{:x}", h)
}

#[napi]
pub fn fast_hash(content: String) -> String {
  djb2_hash(&content)
}

#[napi]
pub fn fast_hash_bytes(bytes: &[u8]) -> String {
  let mut h: u32 = 5381;
  for &b in bytes {
    h = h.wrapping_shl(5).wrapping_add(h).wrapping_add(b as u32);
  }
  format!("{:x}", h)
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeChunk {
  pub content: String,
  pub token_count: i32,
  pub content_hash: String,
  pub heading: Option<String>,
}

fn count_tokens(s: &str) -> i32 {
  ((s.len() + 3) / 4) as i32
}

fn split_to_token_limit(value: &str, max_tokens: i32, overlap_tokens: i32) -> Vec<String> {
  if value.is_empty() || max_tokens <= 0 {
    return Vec::new();
  }
  let overlap = overlap_tokens.clamp(0, max_tokens - 1);
  let max_bytes = (max_tokens * 4) as usize;
  let overlap_bytes = (overlap * 4) as usize;

  if value.len() <= max_bytes {
    return vec![value.to_string()];
  }

  let mut chunks = Vec::new();
  let mut start = 0usize;
  while start < value.len() {
    let mut end = (start + max_bytes).min(value.len());
    while end < value.len() && !value.is_char_boundary(end) {
      end -= 1;
    }
    chunks.push(value[start..end].to_string());
    if end >= value.len() {
      break;
    }
    // Advance start from the adjusted `end`, not from the unadjusted window.
    // Using a fixed step would skip bytes between `end` and `start + step`
    // when `end` was moved back to a char boundary — dropping code points.
    start = end.saturating_sub(overlap_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
      start += 1;
    }
  }
  chunks
}

/// Returns indices into the original chunk list for each output chunk.
/// Each entry: (original_index, split_index, split_count) or (-1, 0, 0) for a merged chunk.
/// For merged chunks, the first original index is the start of the merge group.
#[napi(object)]
pub struct BoundPlan {
  pub content: String,
  pub token_count: i32,
  pub content_hash: String,
  pub heading: Option<String>,
  pub source_index: i32,
  pub split_index: i32,
  pub split_count: i32,
  pub merged_indices: Vec<i32>,
}

struct SplitItem {
  content: String,
  token_count: i32,
  content_hash: String,
  heading: Option<String>,
  source_index: i32,
  split_index: i32,
  split_count: i32,
}

#[napi]
pub fn bound_chunks(
  chunks: Vec<NativeChunk>,
  target_tokens: i32,
  overlap_tokens: i32,
) -> Vec<BoundPlan> {
  // Phase 1: split oversized chunks
  let mut split: Vec<SplitItem> = Vec::new();
  for (idx, chunk) in chunks.iter().enumerate() {
    let parts = split_to_token_limit(&chunk.content, target_tokens, overlap_tokens);
    if parts.len() <= 1 {
      split.push(SplitItem {
        content_hash: chunk.content_hash.clone(),
        token_count: chunk.token_count,
        content: chunk.content.clone(),
        heading: chunk.heading.clone(),
        source_index: idx as i32,
        split_index: 0,
        split_count: 1,
      });
      continue;
    }
    let part_count = parts.len() as i32;
    for (split_index, content) in parts.into_iter().enumerate() {
      split.push(SplitItem {
        content_hash: djb2_hash(&content),
        token_count: count_tokens(&content),
        content,
        heading: chunk.heading.clone(),
        source_index: idx as i32,
        split_index: split_index as i32,
        split_count: part_count,
      });
    }
  }

  // Phase 2: merge small chunks
  let merge_threshold = target_tokens * 3 / 10;
  let mut merged: Vec<BoundPlan> = Vec::new();
  let mut buffer: Vec<SplitItem> = Vec::new();
  let mut buffer_tokens = 0i32;
  let mut buffer_indices: Vec<i32> = Vec::new();

  for chunk in split {
    if chunk.token_count < merge_threshold && buffer_tokens + chunk.token_count <= target_tokens {
      buffer_tokens += chunk.token_count;
      buffer_indices.push(chunk.source_index);
      buffer.push(chunk);
    } else {
      if !buffer.is_empty() {
        merged.push(merge_split_items(&buffer, buffer_indices.clone()));
        buffer.clear();
        buffer_indices.clear();
        buffer_tokens = 0;
      }
      merged.push(BoundPlan {
        content: chunk.content,
        token_count: chunk.token_count,
        content_hash: chunk.content_hash,
        heading: chunk.heading,
        source_index: chunk.source_index,
        split_index: chunk.split_index,
        split_count: chunk.split_count,
        merged_indices: vec![chunk.source_index],
      });
    }
  }
  if !buffer.is_empty() {
    merged.push(merge_split_items(&buffer, buffer_indices.clone()));
  }

  merged
}

fn merge_split_items(chunks: &[SplitItem], indices: Vec<i32>) -> BoundPlan {
  if chunks.len() == 1 {
    let c = &chunks[0];
    return BoundPlan {
      content: c.content.clone(),
      token_count: c.token_count,
      content_hash: c.content_hash.clone(),
      heading: c.heading.clone(),
      source_index: c.source_index,
      split_index: c.split_index,
      split_count: c.split_count,
      merged_indices: indices,
    };
  }
  let content = chunks
    .iter()
    .map(|c| c.content.as_str())
    .collect::<Vec<_>>()
    .join("\n\n");
  BoundPlan {
    content_hash: djb2_hash(&content),
    token_count: count_tokens(&content),
    heading: chunks[0].heading.clone(),
    content,
    source_index: chunks[0].source_index,
    split_index: 0,
    split_count: 1,
    merged_indices: indices,
  }
}

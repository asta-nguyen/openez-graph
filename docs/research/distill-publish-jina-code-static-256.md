# Distill and publish `astanguyen/jina-code-static-256`

Status: reproducible runbook; no credentials used and nothing has been published.

## Decision

Create a 256-dimensional, float16 Model2Vec artifact from the official
`jinaai/jina-embeddings-v2-base-code` teacher, then publish it as a public,
ungated model at `astanguyen/jina-code-static-256`.

Do not advertise the model as "~25 MB" until the generated files are measured.
The comparable official CodeGraph release asset is 30,199,125 bytes compressed;
its extracted `model.safetensors` is 31,747,720 bytes and its complete runtime
folder is about 33.7 MB. See the
[CodeGraph model release](https://github.com/codegraph-ai/CodeGraph/releases/tag/model).

## Pinned inputs

| Input                     | Pin                                        | Reason                                             |
| ------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Python                    | 3.11                                       | Model2Vec 0.8.2 requires Python >=3.10             |
| Model2Vec                 | `0.8.2`                                    | Current tagged release used by this runbook        |
| Teacher                   | `jinaai/jina-embeddings-v2-base-code`      | Official code-search teacher                       |
| Teacher revision          | `516f4baf13dec4ddddda8631e019b5737c8bc250` | Pins weights, tokenizer and config                 |
| Jina remote-code revision | `3baf9e3ac750e76e8edd3019170176884695fb94` | Pins code executed by `trust_remote_code=True`     |
| Output                    | PCA 256, mean pooling, float16, SIF `1e-4` | Explicitly fixes all material distillation options |

The Jina model card identifies the teacher as Apache-2.0, 161M parameters,
English plus 30 programming languages, and intended for code search. It also
requires mean pooling and custom model code. See the
[official Jina model card](https://huggingface.co/jinaai/jina-embeddings-v2-base-code).
The current teacher and remote-code revisions can be verified through the
[teacher API](https://huggingface.co/api/models/jinaai/jina-embeddings-v2-base-code)
and [custom-code API](https://huggingface.co/api/models/jinaai/jina-bert-v2-qk-post-norm).

Model2Vec 0.8.2 requires Python >=3.10 and its distillation extra installs
Torch, `transformers<5.4.0`, scikit-learn and Skeletoken. The pinned Jina
remote code still uses Transformers 4.x APIs removed in Transformers 5, so this
runbook pins `transformers==4.46.3`. It has no distillation CLI entry point, so
use its Python API. See the
[0.8.2 package definition](https://github.com/MinishLab/model2vec/blob/v0.8.2/pyproject.toml)
and [release](https://github.com/MinishLab/model2vec/releases/tag/v0.8.2).

## 1. Create a clean build environment

Run outside the OpenEZ repository or in an ignored working directory:

```bash
mkdir -p jina-code-static-build
cd jina-code-static-build
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install "model2vec[distill]==0.8.2" "transformers==4.46.3" "huggingface_hub"
python -m pip freeze > requirements.lock.txt
```

Keep `requirements.lock.txt` with the published provenance. The top-level
Model2Vec version is pinned above; the lock records the exact Torch,
Transformers, NumPy and scikit-learn versions resolved for the actual build.

## 2. Review the remote code before executing it

Jina uses custom Transformers code. `trust_remote_code=True` executes Python
from the Hub, so inspect the pinned `configuration_bert.py` and
`modeling_bert.py` at revision
`3baf9e3ac750e76e8edd3019170176884695fb94` before continuing. Transformers
itself recommends reviewing custom code and pinning a commit revision:
[official security guidance](https://github.com/huggingface/transformers/security).

The pin is intentional; do not replace either revision with `main`.

## 3. Distill

Save this as `distill.py`:

```python
import json
from pathlib import Path

import numpy as np
from model2vec import StaticModel
from model2vec.distill import distill_from_model
from model2vec.modelcards import create_model_card
from transformers import AutoModel, AutoTokenizer

BASE = "jinaai/jina-embeddings-v2-base-code"
BASE_REVISION = "516f4baf13dec4ddddda8631e019b5737c8bc250"
CODE_REVISION = "3baf9e3ac750e76e8edd3019170176884695fb94"
OUT = Path("jina-code-static-256")

teacher = AutoModel.from_pretrained(
    BASE,
    revision=BASE_REVISION,
    code_revision=CODE_REVISION,
    trust_remote_code=True,
    use_safetensors=True,
)
tokenizer = AutoTokenizer.from_pretrained(
    BASE,
    revision=BASE_REVISION,
    trust_remote_code=True,
    use_fast=True,
)

static = distill_from_model(
    model=teacher,
    tokenizer=tokenizer,
    vocabulary=None,
    device="cpu",
    pca_dims=256,
    sif_coefficient=1e-4,
    token_remove_pattern=r"\[unused\d+\]",
    quantize_to="float16",
    vocabulary_quantization=None,
    pooling="mean",
)
static.save_pretrained(OUT)

# Model2Vec defaults generated cards to MIT. Override that metadata because
# the teacher and this redistributed derivative are Apache-2.0.
create_model_card(
    OUT,
    base_model_name=BASE,
    license="apache-2.0",
    language=["en"],
    model_name="jina-code-static-256",
)

provenance = {
    "base_model": BASE,
    "base_revision": BASE_REVISION,
    "remote_code_model": "jinaai/jina-bert-v2-qk-post-norm",
    "remote_code_revision": CODE_REVISION,
    "model2vec_version": "0.8.2",
    "dimensions": 256,
    "dtype": "float16",
    "pooling": "mean",
    "sif_coefficient": 1e-4,
    "modified": "Distilled to static token embeddings and reduced with PCA.",
}
(OUT / "PROVENANCE.json").write_text(
    json.dumps(provenance, indent=2) + "\n", encoding="utf-8"
)

# Reload from disk; do not merely test the in-memory object.
loaded = StaticModel.from_pretrained(OUT)
vectors = loaded.encode(
    [
        "find the function that validates an access token",
        "function validateToken(token) { return verify(token); }",
    ]
)
assert vectors.shape == (2, 256), vectors.shape
assert np.isfinite(vectors).all()
assert np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=1e-3)
print("local smoke test passed", vectors.shape, vectors.dtype)
```

Run it:

```bash
python distill.py
```

This follows CodeGraph's official explicit-loader approach for Jina custom code,
while additionally pinning revisions and making dtype explicit. See the
[CodeGraph distillation script](https://github.com/codegraph-ai/CodeGraph/blob/489ccf1612555510f8367e3e673181f6a1275fe4/scripts/distill_static_model.py)
and Model2Vec's
[`distill_from_model`](https://github.com/MinishLab/model2vec/blob/v0.8.2/model2vec/distill/distillation.py).

Model2Vec writes these files:

- `model.safetensors`
- `tokenizer.json`
- `config.json`
- `modules.json`
- `README.md`

The first three are the minimum Model2Vec runtime files. The exact persistence
logic is in the
[Model2Vec 0.8.2 source](https://github.com/MinishLab/model2vec/blob/v0.8.2/model2vec/persistence/persistence.py).

## 4. Complete license and provenance

The Jina repository declares `license: apache-2.0`, but its published file list
does not contain a standalone `LICENSE` or `NOTICE`. Download the canonical
Apache-2.0 license text into the derived model:

```bash
curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt \
  -o jina-code-static-256/LICENSE
cp requirements.lock.txt jina-code-static-256/requirements.lock.txt
```

Edit the generated `README.md` and add a short provenance section containing:

```markdown
## Provenance

Distilled and modified from `jinaai/jina-embeddings-v2-base-code`
at revision `516f4baf13dec4ddddda8631e019b5737c8bc250` using Model2Vec
0.8.2. Jina custom code was loaded at revision
`3baf9e3ac750e76e8edd3019170176884695fb94`. The output uses mean
pooling, SIF 1e-4, PCA 256 and float16 storage.
```

Confirm the YAML frontmatter says `license: apache-2.0`, not `mit`. This matters
because Model2Vec's generated-card default is MIT even when the teacher has a
different license; see its
[model-card implementation](https://github.com/MinishLab/model2vec/blob/v0.8.2/model2vec/modelcards/modelcards.py).

Apache-2.0 permits redistribution and derivative works, subject to providing
the license, marking modifications, retaining applicable notices, and carrying
forward a `NOTICE` file if the upstream work supplies one. See
[Apache License 2.0 section 4](https://www.apache.org/licenses/LICENSE-2.0#redistribution).
The steps above cover the observable upstream metadata, but they are not legal
advice.

## 5. Inspect and checksum before publishing

```bash
du -h jina-code-static-256/*
python - <<'PY'
import json
from pathlib import Path
from safetensors import safe_open

root = Path("jina-code-static-256")
cfg = json.loads((root / "config.json").read_text())
assert cfg["hidden_dim"] == 256
assert cfg["embedding_dtype"] == "float16"
with safe_open(root / "model.safetensors", framework="numpy") as f:
    matrix = f.get_tensor("embeddings")
assert matrix.ndim == 2 and matrix.shape[1] == 256
print("embedding matrix", matrix.shape, matrix.dtype)
PY

cd jina-code-static-256
shasum -a 256 \
  model.safetensors tokenizer.json config.json modules.json README.md \
  LICENSE PROVENANCE.json requirements.lock.txt > SHA256SUMS
cd ..
```

Before labeling this a production code-search preset, run the OpenEZ retrieval
fixture against it and compare Recall@5 and MRR with FTS-only and BGE-small.
Distillation completing successfully does not establish retrieval quality.

## 6. Authenticate as `astanguyen`

Use the official CLI browser login; do not paste a token into source code or
commit it:

```bash
hf auth login
hf auth whoami
```

Stop unless `hf auth whoami` reports `astanguyen`. Hugging Face documents both
commands in its [official CLI guide](https://huggingface.co/docs/huggingface_hub/guides/cli#hf-auth-login).

## 7. Create a public, ungated model repository and upload

```bash
hf repos create astanguyen/jina-code-static-256
hf repos settings astanguyen/jina-code-static-256 --private false --gated false
hf upload astanguyen/jina-code-static-256 jina-code-static-256 . \
  --commit-message "Publish Jina Code Model2Vec 256d artifact"
```

Model repositories are public unless created with `--private`; setting both
flags explicitly prevents ambiguity. Hugging Face documents repository creation
and visibility in its
[repository guide](https://huggingface.co/docs/huggingface_hub/guides/repository),
and documents whole-folder upload in its
[upload guide](https://huggingface.co/docs/huggingface_hub/guides/upload#upload-from-the-cli).
Gating is disabled by default, but the explicit `--gated false` check ensures
anonymous downloads remain possible; see the
[gated-model documentation](https://huggingface.co/docs/hub/models-gated).

## 8. Verify the published artifact anonymously and pin it in OpenEZ

Get the immutable Hub commit and assert public/ungated metadata without using a
token:

```bash
python - <<'PY'
from huggingface_hub import model_info

info = model_info("astanguyen/jina-code-static-256", token=False)
assert info.private is False
assert info.gated is False
print(info.sha)
PY
```

Then test an anonymous, revision-pinned download. Replace `<PUBLISHED_SHA>` with
the printed full commit hash:

```bash
python - <<'PY'
import numpy as np
from huggingface_hub import snapshot_download
from model2vec import StaticModel

revision = "<PUBLISHED_SHA>"
folder = snapshot_download(
    "astanguyen/jina-code-static-256",
    revision=revision,
    token=False,
)
model = StaticModel.from_pretrained(folder)
vectors = model.encode(["find token validation", "validateToken(token)"])
assert vectors.shape == (2, 256)
assert np.isfinite(vectors).all()
print("anonymous pinned smoke test passed", revision)
PY
```

Only after this passes should OpenEZ record:

- repo: `astanguyen/jina-code-static-256`
- revision: the full published commit SHA, never `main`
- SHA-256 values from `SHA256SUMS`
- dimensions: 256
- dtype: float16
- engine: Model2Vec/static

## Reproducibility limits

- The teacher, remote custom code, Model2Vec version and resolved dependency
  lock are pinned. This prevents silent upstream changes.
- Bit-for-bit output can still vary across CPU/BLAS/Torch platforms. Treat the
  published commit and checksums as the canonical artifact after building it.
- The `~25 MB` claim is not established. Measure this build and publish the
  actual compressed and extracted sizes.
- The artifact is distilled, not retrieval-fine-tuned. OpenEZ must benchmark it
  before making it the recommended default.

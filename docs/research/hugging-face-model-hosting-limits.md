# Hugging Face hosting limits for an OpenEZ model

Checked: 2026-08-10. Scope: a public, ungated model of about 25 MB downloaded lazily by OpenEZ CLI users.

## Conclusion

Hugging Face Hub is suitable for this distribution pattern. A public 25 MB model is far below the storage sizes that Hugging Face flags for special handling, and users can download public files anonymously. There is no promise of unlimited or uninterrupted service, so OpenEZ should treat the Hub as a remote artifact origin backed by a verified global cache, not as a runtime dependency.

## Access and limits

- Public downloads can be anonymous: Hugging Face documents an anonymous Resolver tier keyed by IP address. Authentication is optional for a public model, but a user's own `HF_TOKEN` increases the current Resolver allowance from 3,000 to 5,000 requests per five-minute window. Anonymous and Free-tier figures may change. A limit breach returns HTTP 429 with `RateLimit` and `RateLimit-Policy` headers. Resolver URLs containing `/resolve/` are the optimized, highest-limit bucket for model files. [Hub rate limits](https://huggingface.co/docs/hub/en/rate-limits)
- This means many users on independent networks do not consume one shared publisher quota; that is an inference from the documented per-IP anonymous tier and per-member organization limits. A classroom or company behind one NAT can still share one anonymous quota.
- Free public storage is "best-effort." Hugging Face asks for responsible use beyond the first few GB and uses anti-abuse mitigations; a useful 25 MB artifact is comfortably inside that guidance. The docs state no per-repository size limit for models/datasets, subject to the account storage policy. [Storage limits](https://huggingface.co/docs/hub/storage-limits)
- Hugging Face pricing says egress and CDN are included at no extra cost. This is not a contractual promise of unlimited bandwidth: paid tiers advertise higher bandwidth/rate limits, and the Terms allow Hugging Face to modify, suspend, or discontinue service and to suspend accounts at its discretion. [Pricing](https://huggingface.co/pricing), [Terms of Service](https://huggingface.co/terms-of-service)

## Delivery and caching

- Model files are delivered through storage/CDN hosts. Hugging Face documents nearest-edge downloads and separate Xet/CDN hostnames; restrictive networks must allow those hosts as well as `huggingface.co`. [Downloading models](https://huggingface.co/docs/hub/models-downloading)
- Hugging Face documents CloudFront delivery for repository files. It warns that huge files may not be cached, but gives no CDN hit-rate or retention guarantee. A 25 MB file is nowhere near its huge-file guidance. [Storage limits](https://huggingface.co/docs/hub/storage-limits)
- The official cache is revision-aware and content-addressed, and avoids downloading an unchanged file again. Its location is configurable. [Download guide](https://huggingface.co/docs/huggingface_hub/guides/download), [cache guide](https://huggingface.co/docs/huggingface_hub/guides/manage-cache)

## Public versus gated/private

Keep the OpenEZ model public and ungated. A private repository is not cloneable by other users. A gated model requires each user to log in, request access in a browser, and provide a token to scripts; authors can later revoke access. That breaks zero-config CLI download. [Repository visibility](https://huggingface.co/docs/hub/en/repositories-settings), [gated models](https://huggingface.co/docs/hub/models-gated)

## Recommended OpenEZ client behavior

1. Download only through `/resolve/<full-commit-hash>/...`; pin the model revision rather than following `main`.
2. Store one verified copy under the global OpenEZ cache, then reuse it across workspaces. Record the repo ID, revision, file size, and SHA-256 checksum.
3. Download to a temporary file, validate size/checksum, then atomically rename it. Keep the last valid cached model if a refresh fails.
4. On HTTP 429, wait for the reset described by the rate-limit headers; retry network errors and transient 5xx responses with bounded backoff. Never busy-loop or parallel-download the same artifact.
5. Use a user's own `HF_TOKEN` when present, but do not require it for the public preset and never ship a shared OpenEZ/publisher token.
6. Report firewall failures with the documented CDN/Xet hostnames, and allow an explicit offline/local-model path for CI or restricted networks.
7. If model availability becomes release-critical, add a checksum-identical mirror later. A mirror is not necessary for the initial 25 MB public release.

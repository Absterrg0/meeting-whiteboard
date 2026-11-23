# Answer key

## Accepted decisions and reasons

- Build a video transcoding pipeline that accepts the archive team's JSON manifest and camera originals, and produces HLS with three renditions. The archive can wait a few minutes, but must not need to resend a large shoot after a worker failure.
- Store sources and outputs in the existing S3 bucket under separate prefixes, with IAM access split by role. The bucket already has lifecycle rules, and a second account is unnecessary. Workers read sources from S3 and use local scratch for ffmpeg segment writes.
- Keep Postgres as the authoritative job ledger. Store the source key, requested renditions, status, attempt count, and winning output manifest key there so the UI and archive export do not need to inspect queue state.
- Use a transactional outbox: commit each new job and its outbox row in the same Postgres transaction; a publisher sends the outbox item to SQS and marks it sent. Duplicate sends are expected and safe because the message prompts the worker to inspect and claim the job rather than authorizing a second result. This was adopted implicitly as the group moved on from the outbox proposal and Jo worked through duplicate delivery.
- Use a standard SQS queue. Jobs within a shoot have no dependencies; the export page orders cameras by manifest ordinal. Workers claim work through a database lease and stable job ID.
- Have workers write each run under a unique attempt prefix. A worker validates all renditions and the master playlist before publishing. Abandoned attempt prefixes can be garbage-collected later. A failed or stale run cannot overwrite the winning output.
- A worker may publish only if a Postgres transaction confirms its lease token still matches. In that transaction it sets the winning manifest key and marks the job complete. The catalog exposes only completed rows, making that transaction the publication point.
- Reject malformed manifests at ingest. Retry a failed transcode twice after its initial attempt, using a fresh attempt prefix each time. After the third failed attempt, set terminal failure and show a short encoder error summary. The first release classifies exit codes to separate infrastructure failures from input failures.
- Keep error logs private and tagged with job ID while retention is unresolved. Do not expose a public URL for them.
- Enforce a maximum total source size of 400 GB per shoot. Provision 512 GB of local scratch per worker. Measure peak scratch use in the pilot before changing either limit.
- Publish one validated master playlist only after all three renditions pass checks. Partial rendition sets are not playable/publishable.
- Emit queue age and oldest-job age metrics from day one. Use the existing archive catalog and CloudFront path for playback: the catalog reads the winning output manifest key and issues signed URLs; the transcoder does not mint viewer credentials.
- For the first release, use H.264 because the archive player supports it. Keep the three-rendition layout.

## Rejected or superseded options and reasons

- Shared NFS for source videos: rejected because it risks a shared slow mount stalling unrelated jobs and does not fit the expected worker count. Sources are already in S3 and can be streamed or range-read. (Lines 7–8.)
- Redis Streams: rejected because the team does not operate Redis across regions and does not want archival backlog durability to depend on Redis persistence settings. SQS is already available with suitable retention and visibility controls. (Lines 11–12.)
- FIFO SQS grouped by shoot: rejected because the jobs have no dependency; the export page sorts by camera ordinal, and queue serialization would slow processing without guaranteeing completion order. (Lines 16–18.)
- Resume a transcode at a completed segment: rejected because encoder-version differences and variable-frame-rate inputs make safe splicing hard to prove. Delete/ignore the failed attempt and rerun under a fresh attempt prefix. (Lines 19–21.)
- Ten-minute worker lease: superseded by a two-minute lease because a dead worker would delay retry too long. (Lines 22–25.)
- Publishing before all renditions validate: rejected because the archive player uses a single master playlist and partial availability makes playback inconsistent. (Lines 34–35.)
- API writes job then directly sends SQS without an outbox: superseded because a crash between the database write and queue send strands a job. (Lines 13, 40–41.)
- Marking a job complete before confirming and recording its final output key: superseded because the catalog could then expose a missing playlist. Upload and validate first; atomically check lease, save manifest key, and mark complete. (Lines 40–41.)
- AV1 for the first delivery: not selected because compatibility with older conference-room players is untested. H.264 is the first-release choice; AV1 remains for later comparison. (Lines 48–49.)

## Final values

- Output format: HLS, three renditions.
- Queue: standard SQS.
- Lease: two minutes, renewed every 30 seconds.
- Retry policy: initial attempt plus two retries; the third failed attempt is terminal.
- Maximum source size: 400 GB per shoot.
- Worker scratch: 512 GB.
- First-release codec: H.264.

## Open questions

- Legal must determine how long error logs may be retained and whether they count as archive records.
- The queue-age alert threshold is deferred until the pilot provides a real week's traffic data. Queue age and oldest-job age metrics are still emitted from day one.
- Choose spot instances versus reserved GPU capacity after evaluating the pilot's job mix, interruption rate, and cost data.
- Evaluate AV1 against actual playback coverage, especially older conference-room players.
- Validate the exit-code classification and retry table in the pilot; Jo owns the first draft.

## Tentative items

- Use the two existing GPU workers for the pilot, with a separate queue and worker deployment that caps transcoder GPU and scratch use. This is explicitly “for now”; the long-term pool and capacity model depend on pilot evidence.
- Error logs remain private and tagged by job ID for now. Their retention period is undecided.

## Action items

- Ishan: implement the transactional outbox publisher, lease-token publication guard, and replay command for stuck unsent rows by Wednesday.
- Jo: write the encoder failure-code mapping and retry table by Thursday.
- Celeste: get GPU cost data from finance and bring a pilot capacity recommendation by Friday.
- Mara: ask legal about error-log retention by Friday.

## What must not appear

- NFS as the source store; Redis Streams or FIFO SQS as the selected queue.
- Segment-level resume or cross-attempt output splicing.
- Ten-minute lease, or any lease value other than two minutes with 30-second renewal.
- A three-attempt total policy; there are three total attempts (initial plus two retries).
- A 90 GB or 240 GB source-size limit, or a per-camera-file limit. The accepted limit is 400 GB per shoot.
- A 1.4-times scratch multiplier as a configured sizing rule. The accepted worker scratch allocation is 512 GB.
- Publication of partial renditions, a playlist before validation, or a job marked complete before the winning manifest key is recorded.
- A delivery service newly introduced by this design, or transcoder-issued viewer credentials. Existing catalog and CloudFront delivery remain in place.
- A chosen alert threshold, error-log retention duration, or final spot/reserved capacity choice; these remain open.
- AV1 as the first-release codec, or AV1 playback support stated as verified.

## Final architecture and connections

1. **Ingest API** receives the archive JSON manifest and camera originals, validates the manifest and the 400 GB per-shoot limit, and stores source objects in the existing S3 bucket under the source prefix.
2. **Postgres job ledger + outbox**: the ingest API creates the authoritative job row and matching outbox row atomically. The job row records source key, requested renditions, status, attempt count, and (once published) winning output manifest key.
3. **Outbox publisher** reads unsent outbox rows, sends job IDs to the **standard SQS queue**, and marks rows sent. It can safely resend after a crash.
4. **GPU worker deployment** polls SQS, claims the job in Postgres with a renewable lease, and uses its lease token as the authority to publish. It reads source video from S3, transcodes H.264 HLS into three renditions using 512 GB local scratch, and writes each run under a unique attempt prefix in the output prefix.
5. The worker validates all renditions and the master playlist. It then writes/chooses the output manifest key and marks the job complete in one Postgres transaction after verifying the current lease token. Stale or failed attempts are never exposed as winners.
6. **Attempt-prefix garbage collector** can remove abandoned attempt outputs later.
7. **Archive catalog service** reads only completed job rows and the winning output manifest key, then issues signed URLs. **CloudFront** serves the output objects to viewers.
8. **Metrics/alerting** receives queue age and oldest-job age measurements; the alert threshold is TBD until after the pilot.

Connection summary: Archive ingest → Ingest API → source S3 and atomic Postgres job/outbox write → Outbox publisher → standard SQS → GPU workers ↔ Postgres lease/job state; workers read source S3 and write validated attempt outputs to output S3 → Postgres completion transaction → Archive catalog → signed URLs → CloudFront → viewers. Metrics flow from queue/worker observations to metrics and alerting. Garbage collection removes abandoned output attempt prefixes.

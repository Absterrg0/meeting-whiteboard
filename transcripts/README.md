# Held-out meeting traps

These notes are for people maintaining the evaluation set. The meeting scribe sees only each transcript.

## `adv-asr-messy`

A rough speech-to-text style conversation with fillers, clipped clauses, a false start, and brief crosstalk. “Lower one” is corrected to LoRaWAN; Lambda is initially miscalled a cloud function and corrected. Mara is interrupted while starting to say the retention period and Pavel supplies the agreed 90-day value. The final 60-second stale threshold replaces 30 seconds, the Kafka path keeps kiln ID as its key, and a proposed alarm rules database is rejected because Safety owns the thresholds. Camera ingestion stays out of scope. Encryption remains open pending Ivo’s security follow-up.

## `adv-flipflop`

The metadata store goes from Postgres (A) to temporarily accepted DynamoDB (B) and back to Postgres (A), with the relational eviction-query reason. DynamoDB belongs in history only. Retention and capacity values change over the meeting; the final values are 90 days and 16 TB. The cap is doubled from 8 TB. Omar declines the invalidation write-up, which Lena takes over; Priya keeps the latency benchmark and Omar’s attestation follow-up is only an inventory. CDN and rollout canary are not architecture decisions.

## `adv-hypotheticals`

The Netflix/global-data-lake comparison and graph database are explicitly examples, not proposals. The Rust rewrite is sarcasm. The synchronous API question is answered immediately, so it is not open. Kafka is conditionally tentative on a passing load test, then Mina objects because platform cannot support it; event transport stays open. The raw-payload archive tier is also open, while the seven-year audit retention and 15-second worklist polling are decided.

## `adv-interleaved`

Tenancy, PDF exports, deployment, and backups are revisited out of order. “The second option” and “that one” refer to shared tables plus RLS, which is later rejected in favor of per-organization schemas. Export jobs use RabbitMQ and workers; identity-provider migration is deferred to another meeting. Signed export links still require an authenticated download. Queue fairness instrumentation is declined, and the export load test changes owner to Sana.

## `long-60`

A one-hour cold-chain telemetry review with long status and test-environment stretches between decisions. Kafka and the consumer are initially accepted, then reversed late in favor of a durable batch writer into TimescaleDB. Twelve partitions become 24 after doubling; the earlier value is history only. Redis is considered but not selected. Fleet enrollment is removed late in favor of the existing device registry. Calibration payload format remains open, with metrology and replay follow-ups assigned.

## `long-120`

A two-hour geospatial tile-generation review with extended operational updates and tangents. The Kafka design is reversed around minute 100 in favor of batch reads from the existing Postgres change journal. The shard count is cut from 16 to 8 and prior-bundle retention falls from 30 to 14 days. Edge cache and bundle-diff service are removed late. Partial-region downloads and autoscaling remain open; autoscaling’s proposed benchmark is declined. Three follow-ups have explicit owners and due dates.

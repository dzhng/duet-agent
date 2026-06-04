# Fernweb Overview

Fernweb is a hypothetical edge-deployed feed reader. It serves personalized
article feeds from regional edge workers and keeps each reader's state in a
small per-user shard so reads stay fast even when the origin store is
unreachable.

Key invariant: a Fernweb edge worker must never write directly to the
origin store. All writes go through the central ingest pipeline, and edge
workers only read from their local shard. Violating this invariant breaks
multi-region consistency and is the single most common cause of phantom
unread counts.

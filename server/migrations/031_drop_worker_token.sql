-- The worker_token table is gone: the driver authenticates with the deployment's shared
-- JOB_BOARD_TOKEN secret, compared in constant time against the board's own environment value.
-- No row, no hash, no CLI mint — and no org binding to store, because the org a worker call
-- operates on comes from the job (or task_reclaim) row its URL names, and a claim is offered
-- every organization's queue.
drop table if exists worker_token;

-- Generation-provider comparison audit. Does not modify or recreate existing tables.
CREATE TABLE igk_provider_audit (
    user_id Utf8 NOT NULL,
    job_id Utf8 NOT NULL,
    provider Utf8 NOT NULL,
    status Utf8 NOT NULL,
    task_id Utf8,
    model Utf8,
    usage_json Utf8,
    seconds Int64,
    note Utf8,
    updated_at Utf8 NOT NULL,
    PRIMARY KEY (user_id, job_id)
);

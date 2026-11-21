-- Separate tables: existing photo-restorer tables remain untouched.
-- Money: integer kopeks; all timestamps: UTC ISO8601.
CREATE TABLE igk_wallets (
    user_id Utf8 NOT NULL,
    available Int64 NOT NULL,
    held Int64 NOT NULL,
    created_at Utf8 NOT NULL,
    PRIMARY KEY (user_id)
);
CREATE TABLE igk_bonus_awards (
    user_id Utf8 NOT NULL,
    bonus_id Utf8 NOT NULL,
    created_at Utf8 NOT NULL,
    PRIMARY KEY (user_id, bonus_id)
);
CREATE TABLE igk_movements (
    user_id Utf8 NOT NULL,
    created_at Utf8 NOT NULL,
    movement_id Utf8 NOT NULL,
    kind Utf8 NOT NULL,
    amount Int64 NOT NULL,
    note Utf8,
    reference Utf8,
    PRIMARY KEY (user_id, created_at, movement_id)
);
CREATE TABLE igk_jobs (
    user_id Utf8 NOT NULL,
    job_id Utf8 NOT NULL,
    request_id Utf8 NOT NULL,
    created_at Utf8 NOT NULL,
    status Utf8 NOT NULL,
    kind Utf8 NOT NULL,
    prompt Utf8 NOT NULL,
    aspect Utf8 NOT NULL,
    price Int64 NOT NULL,
    source_key Utf8,
    output_key Utf8,
    error Utf8,
    INDEX idx_user_date GLOBAL ON (user_id, created_at),
    PRIMARY KEY (user_id, job_id)
);
CREATE TABLE igk_idempotency (
    user_id Utf8 NOT NULL,
    request_id Utf8 NOT NULL,
    job_id Utf8 NOT NULL,
    PRIMARY KEY (user_id, request_id)
);
CREATE TABLE igk_topups (
    order_id Utf8 NOT NULL,
    user_id Utf8 NOT NULL,
    created_at Utf8 NOT NULL,
    amount Int64 NOT NULL,
    status Utf8 NOT NULL,
    proof_key Utf8,
    bank_reference Utf8,
    receipt Utf8,
    confirmed_at Utf8,
    INDEX idx_user_date GLOBAL ON (user_id, created_at),
    INDEX idx_status_date GLOBAL ON (status, created_at),
    PRIMARY KEY (order_id)
);
CREATE TABLE igk_bank_refs (
    reference Utf8 NOT NULL,
    order_id Utf8 NOT NULL,
    created_at Utf8 NOT NULL,
    PRIMARY KEY (reference)
);

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

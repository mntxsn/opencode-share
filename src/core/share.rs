use crate::models::Share;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use thiserror::Error;

/// Default key used when client doesn't provide a `_key` field.
/// Uses a UUID to ensure each item is treated as unique (append-only).
const DEFAULT_KEY_PREFIX: &str = "auto";

/// Share IDs come from client-chosen session IDs, so restrict them to a safe charset.
const MAX_SHARE_ID_LEN: usize = 128;

/// Upper bounds per share so a client cannot grow a share without limit.
const MAX_ITEMS_PER_SHARE: usize = 100_000;
const MAX_SHARE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum ShareError {
    #[error("Invalid share id")]
    InvalidId,
    #[error("Share already exists: {0}")]
    AlreadyExists(String),
    #[error("Share not found: {0}")]
    NotFound(String),
    #[error("Share secret invalid: {0}")]
    InvalidSecret(String),
    #[error("Share data too large: {0}")]
    TooLarge(String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, ShareError>;

pub struct ShareService {
    pool: PgPool,
}

impl ShareService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create(&self, session_id: String) -> Result<Share> {
        if !is_valid_share_id(&session_id) {
            return Err(ShareError::InvalidId);
        }

        let id = session_id.clone();
        let secret = uuid::Uuid::new_v4().to_string();

        // Create new share with empty data array; ON CONFLICT avoids a check-then-insert race
        let share = sqlx::query_as::<_, Share>(
            r#"
            INSERT INTO shares (id, secret, session_id, data, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (id) DO NOTHING
            RETURNING id, secret, session_id, data, created_at, updated_at
            "#
        )
        .bind(&id)
        .bind(&secret)
        .bind(&session_id)
        .bind(json!([])) // Empty data array
        .bind(Utc::now())
        .bind(Utc::now())
        .fetch_optional(&self.pool)
        .await?;

        share.ok_or(ShareError::AlreadyExists(id))
    }

    pub async fn get(&self, id: &str) -> Result<Option<Share>> {
        let share = sqlx::query_as::<_, Share>(
            "SELECT id, secret, session_id, data, created_at, updated_at FROM shares WHERE id = $1"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(share)
    }

    pub async fn remove(&self, id: &str, secret: &str) -> Result<()> {
        let share = self.get(id).await?;
        let share = share.ok_or_else(|| ShareError::NotFound(id.to_string()))?;

        if !secrets_match(&share.secret, secret) {
            return Err(ShareError::InvalidSecret(id.to_string()));
        }

        // Delete share (single table operation)
        sqlx::query("DELETE FROM shares WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    pub async fn sync(&self, share_id: &str, secret: &str, incoming_data: Vec<Value>) -> Result<()> {
        // Lock the row so concurrent syncs don't overwrite each other's changes
        let mut tx = self.pool.begin().await?;

        let share = sqlx::query_as::<_, Share>(
            "SELECT id, secret, session_id, data, created_at, updated_at FROM shares WHERE id = $1 FOR UPDATE"
        )
        .bind(share_id)
        .fetch_optional(&mut *tx)
        .await?;
        let share = share.ok_or_else(|| ShareError::NotFound(share_id.to_string()))?;

        if !secrets_match(&share.secret, secret) {
            return Err(ShareError::InvalidSecret(share_id.to_string()));
        }

        // Get current data
        let mut current_data: Vec<Value> = match share.data {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        };

        // Merge incoming data with current data: same key replaces, new key appends
        let mut index: HashMap<String, usize> = current_data
            .iter()
            .enumerate()
            .map(|(i, item)| (self.get_data_key(item), i))
            .collect();

        for item in incoming_data {
            let key = self.get_data_key(&item);
            match index.get(&key) {
                Some(&i) => current_data[i] = item,
                None => {
                    index.insert(key, current_data.len());
                    current_data.push(item);
                }
            }
        }

        if current_data.len() > MAX_ITEMS_PER_SHARE
            || serde_json::to_vec(&current_data)?.len() > MAX_SHARE_BYTES
        {
            return Err(ShareError::TooLarge(share_id.to_string()));
        }

        sqlx::query(
            r#"
            UPDATE shares
            SET data = $2,
                updated_at = $3
            WHERE id = $1
            "#
        )
        .bind(share_id)
        .bind(Value::Array(current_data))
        .bind(Utc::now())
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        Ok(())
    }

    pub async fn get_data(&self, share_id: &str) -> Result<Vec<Value>> {
        let share = self.get(share_id).await?;
        let share = share.ok_or_else(|| ShareError::NotFound(share_id.to_string()))?;

        // Simply return the stored data
        if let Some(data_value) = share.data {
            if let Some(data_array) = data_value.as_array() {
                return Ok(data_array.clone());
            }
        }

        Ok(vec![])
    }

    /// Extract the merge key from a data item.
    /// Uses `_key` field if provided by client, otherwise generates a unique key.
    fn get_data_key(&self, data: &Value) -> String {
        if let Some(key) = data.get("_key").and_then(|v| v.as_str()) {
            key.to_string()
        } else {
            // Generate a unique key for items without _key (treat as append-only)
            format!("{}/{}", DEFAULT_KEY_PREFIX, uuid::Uuid::new_v4())
        }
    }
}

fn is_valid_share_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SHARE_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Compare secrets in constant time to avoid leaking matching prefixes through timing.
fn secrets_match(expected: &str, provided: &str) -> bool {
    let (a, b) = (expected.as_bytes(), provided.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

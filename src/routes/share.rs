use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Html,
    routing::get,
    Router,
};
use chrono::Duration;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use tracing::{error, info, warn};

use crate::core::share::ShareService;
use crate::models::Share;
use crate::AppState;

pub fn share_routes() -> Router<AppState> {
    Router::new().route("/:share_id", get(share_page))
}

pub async fn share_page(
    State(state): State<AppState>,
    Path(share_id): Path<String>,
    headers: HeaderMap,
) -> Result<Html<String>, StatusCode> {
    // Removed client IP extraction
    let user_agent = headers
        .get("user-agent")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("Unknown");
    
    info!(
        "🌐 Share page request - ID: {}",
        share_id
    );
    
    let share_service = ShareService::new(state.db.clone());
    
    // Verify share exists
    match share_service.get(&share_id).await {
        Ok(Some(share)) => {
            info!(
                "✅ Share page rendered successfully - ID: {}",
                share_id
            );
            
            // Return HTML page using template
            let html = generate_share_page(&share, &state)?;
            Ok(Html(html))
        }
        Ok(None) => {
            warn!(
                "⚠️ Share not found - ID: {} - User-Agent: {}",
                share_id, user_agent
            );
            Err(StatusCode::NOT_FOUND)
        }
        Err(e) => {
            error!(
                 "❌ Error checking share - ID: {} - Error: {}",
                 share_id, e
            );
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

fn generate_share_page(share: &Share, state: &AppState) -> Result<String, StatusCode> {
    let template_path = PathBuf::from("templates/share.html");

    // Read HTML template file
    let template_content = fs::read_to_string(template_path)
        .map_err(|e| {
            error!("Failed to read HTML template: {}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    // Display settings for share.js; inline scripts are blocked by the CSP, so pass them as an attribute
    let retention_days = state.config.retention_days;
    let expires_at = (retention_days > 0).then(|| share.updated_at + Duration::days(retention_days.into()));
    let mut page_config = serde_json::to_value(&state.config.display).map_err(|e| {
        error!("Failed to serialize page config: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    page_config["expiresAt"] = json!(expires_at);

    let html = template_content
        .replace("{{config}}", &escape_html(&page_config.to_string()))
        .replace("{{share_id}}", &escape_html(&share.id))
        .replace("{{asset_version}}", &state.asset_version);

    Ok(html)
}

/// Escape for both text and attribute contexts to prevent XSS
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

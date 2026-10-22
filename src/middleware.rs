use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
};
use std::time::Instant;
use tracing::{info, warn};

use crate::AppState;

/// 记录HTTP请求访问日志的中间件
pub async fn access_log_middleware(
    State(_state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let start_time = Instant::now();
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers = request.headers().clone();
    
    // 提取客户端IP
    let client_ip = get_client_ip(&headers);
    
    // 提取User-Agent
    let user_agent = headers
        .get("user-agent")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("Unknown");
    
    // 记录请求开始
    info!(
        "📥 {} {} - IP: {} - User-Agent: {}",
        method,
        uri,
        client_ip,
        user_agent
    );
    
    // 执行请求
    let response = next.run(request).await;
    
    // 计算处理时间
    let duration = start_time.elapsed();
    let status = response.status();
    let status_code = status.as_u16();
    
    // 根据状态码选择日志级别和图标
    let (log_icon, log_level) = match status_code {
        200..=299 => ("✅", "info"),
        300..=399 => ("🔄", "info"),
        400..=499 => ("⚠️", "warn"),
        500..=599 => ("❌", "error"),
        _ => ("❓", "info"),
    };
    
    // 记录请求完成
    match log_level {
        "info" => info!(
            "{} {} {} - IP: {} - Duration: {:?} - Status: {}",
            log_icon,
            method,
            uri,
            client_ip,
            duration,
            status_code
        ),
        "warn" => warn!(
            "{} {} {} - IP: {} - Duration: {:?} - Status: {}",
            log_icon,
            method,
            uri,
            client_ip,
            duration,
            status_code
        ),
        "error" => tracing::error!(
            "{} {} {} - IP: {} - Duration: {:?} - Status: {}",
            log_icon,
            method,
            uri,
            client_ip,
            duration,
            status_code
        ),
        _ => {}
    }
    
    Ok(response)
}

/// Content-Security-Policy for all responses. The share page renders untrusted
/// session content, so scripts may only come from this origin.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; \
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Adds browser security headers to every response
pub async fn security_headers_middleware(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

/// 从请求头中提取客户端IP地址
fn get_client_ip(headers: &HeaderMap) -> String {
    // 尝试从各种头部获取真实IP
    headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|h| h.to_str().ok())
        })
        .or_else(|| {
            headers
                .get("cf-connecting-ip") // Cloudflare
                .and_then(|h| h.to_str().ok())
        })
        .or_else(|| {
            headers
                .get("x-client-ip")
                .and_then(|h| h.to_str().ok())
        })
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Unknown".to_string())
}
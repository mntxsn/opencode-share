// Integration tests for API endpoints

use axum::{
    body::Body,
    http::{header, method, Request, StatusCode},
    Router,
};
use opencode_share::AppState;
use serde_json::json;
use sqlx::PgPool;
use std::env;
use tower::ServiceExt;

async fn get_test_app() -> Router {
    let database_url = env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres@localhost/opencode_share_test".to_string());

    let pool = PgPool::connect(&database_url)
        .await
        .expect("Failed to connect to test database");

    // Clean up test database
    sqlx::query("DELETE FROM shares")
        .execute(&pool)
        .await
        .expect("Failed to clean test database");

    let app_state = AppState { db: pool };

    // Create a test router
    opencode_share::routes::api_routes().with_state(app_state)
}

#[tokio::test]
async fn test_create_share_endpoint() {
    let app = get_test_app().await;

    let request_body = json!({
        "sessionID": "test-session-api-create"
    });

    let request = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .header("host", "localhost:3006")
        .body(Body::from(serde_json::to_string(&request_body).unwrap()))
        .unwrap();

    let response = app
        .oneshot(request)
        .await
        .expect("Failed to get response");

    assert_eq!(response.status(), StatusCode::OK);

    let body = hyper::body::to_bytes(response.into_body())
        .await
        .expect("Failed to read body");
    let response_json: serde_json::Value = serde_json::from_slice(&body)
        .expect("Failed to parse JSON");

    assert!(response_json["id"].is_string());
    assert!(response_json["secret"].is_string());
    assert!(response_json["url"].is_string());
    assert_eq!(response_json["id"], "test-session-api-create");
    assert!(response_json["url"].as_str().unwrap().contains("/share/test-session-api-create"));
}

#[tokio::test]
async fn test_create_share_with_custom_host() {
    let app = get_test_app().await;

    let request_body = json!({
        "sessionID": "test-session-custom-host"
    });

    let request = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .header("host", "example.com:8080")
        .body(Body::from(serde_json::to_string(&request_body).unwrap()))
        .unwrap();

    let response = app
        .oneshot(request)
        .await
        .expect("Failed to get response");

    assert_eq!(response.status(), StatusCode::OK);

    let body = hyper::body::to_bytes(response.into_body())
        .await
        .expect("Failed to read body");
    let response_json: serde_json::Value = serde_json::from_slice(&body)
        .expect("Failed to parse JSON");

    let url = response_json["url"].as_str().unwrap();
    assert!(url.contains("example.com:8080"));
}

#[tokio::test]
async fn test_create_share_duplicate() {
    let app = get_test_app().await;

    let request_body = json!({
        "sessionID": "test-session-duplicate-api"
    });

    // Create first share
    let request1 = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .header("host", "localhost:3006")
        .body(Body::from(serde_json::to_string(&request_body).unwrap()))
        .unwrap();

    let response1 = app
        .clone()
        .oneshot(request1)
        .await
        .expect("Failed to get response");
    assert_eq!(response1.status(), StatusCode::OK);

    // Try to create duplicate
    let request2 = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .header("host", "localhost:3006")
        .body(Body::from(serde_json::to_string(&request_body).unwrap()))
        .unwrap();

    let response2 = app
        .oneshot(request2)
        .await
        .expect("Failed to get response");

    // Should return conflict for duplicate
    assert_eq!(response2.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn test_sync_share_endpoint() {
    let app = get_test_app().await;

    // First, create a share
    let create_body = json!({
        "sessionID": "test-session-api-sync"
    });

    let create_request = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .header("host", "localhost:3006")
        .body(Body::from(serde_json::to_string(&create_body).unwrap()))
        .unwrap();

    let create_response = app
        .clone()
        .oneshot(create_request)
        .await
        .expect("Failed to get response");

    assert_eq!(create_response.status(), StatusCode::OK);

    let create_body_bytes = hyper::body::to_bytes(create_response.into_body())
        .await
        .expect("Failed to read body");
    let create_json: serde_json::Value = serde_json::from_slice(&create_body_bytes)
        .expect("Failed to parse JSON");

    let share_id = create_json["id"].as_str().unwrap();
    let secret = create_json["secret"].as_str().unwrap();

    // Now sync data to the share (using arbitrary JSON with _key field)
    let sync_data = json!({
        "secret": secret,
        "data": [
            {
                "_key": "session",
                "model": "gpt-4",
                "messages": []
            },
            {
                "_key": "message/msg-1",
                "id": "msg-1",
                "role": "user",
                "content": "Hello"
            }
        ]
    });

    let sync_request = Request::builder()
        .method(method::POST)
        .uri(&format!("/api/share/{}/sync", share_id))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&sync_data).unwrap()))
        .unwrap();

    let sync_response = app
        .oneshot(sync_request)
        .await
        .expect("Failed to get response");

    assert_eq!(sync_response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_sync_share_with_invalid_secret() {
    let app = get_test_app().await;

    // First, create a share
    let create_body = json!({
        "sessionID": "test-session-invalid-secret"
    });

    let create_request = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .header("host", "localhost:3006")
        .body(Body::from(serde_json::to_string(&create_body).unwrap()))
        .unwrap();

    let create_response = app
        .clone()
        .oneshot(create_request)
        .await
        .expect("Failed to get response");

    assert_eq!(create_response.status(), StatusCode::OK);

    let create_body_bytes = hyper::body::to_bytes(create_response.into_body())
        .await
        .expect("Failed to read body");
    let create_json: serde_json::Value = serde_json::from_slice(&create_body_bytes)
        .expect("Failed to parse JSON");

    let share_id = create_json["id"].as_str().unwrap();

    // Try to sync with invalid secret (using arbitrary JSON with _key field)
    let sync_data = json!({
        "secret": "invalid-secret",
        "data": [
            {
                "_key": "session",
                "model": "gpt-4"
            }
        ]
    });

    let sync_request = Request::builder()
        .method(method::POST)
        .uri(&format!("/api/share/{}/sync", share_id))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&sync_data).unwrap()))
        .unwrap();

    let sync_response = app
        .oneshot(sync_request)
        .await
        .expect("Failed to get response");

    assert_eq!(sync_response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_get_share_data_endpoint() {
    let app = get_test_app().await;

    // First, create a share
    let create_body = json!({
        "sessionID": "test-session-api-get"
    });

    let create_request = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .header("host", "localhost:3006")
        .body(Body::from(serde_json::to_string(&create_body).unwrap()))
        .unwrap();

    let create_response = app
        .clone()
        .oneshot(create_request)
        .await
        .expect("Failed to get response");

    assert_eq!(create_response.status(), StatusCode::OK);

    let create_body_bytes = hyper::body::to_bytes(create_response.into_body())
        .await
        .expect("Failed to read body");
    let create_json: serde_json::Value = serde_json::from_slice(&create_body_bytes)
        .expect("Failed to parse JSON");

    let share_id = create_json["id"].as_str().unwrap();
    let secret = create_json["secret"].as_str().unwrap();

    // Sync some data (using arbitrary JSON with _key field)
    let sync_data = json!({
        "secret": secret,
        "data": [
            {
                "_key": "session",
                "model": "gpt-4",
                "messages": []
            }
        ]
    });

    let sync_request = Request::builder()
        .method(method::POST)
        .uri(&format!("/api/share/{}/sync", share_id))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&sync_data).unwrap()))
        .unwrap();

    let sync_response = app
        .clone()
        .oneshot(sync_request)
        .await
        .expect("Failed to get response");

    assert_eq!(sync_response.status(), StatusCode::OK);

    // Now get the share data
    let get_request = Request::builder()
        .method(method::GET)
        .uri(&format!("/api/share/{}/data", share_id))
        .body(Body::empty())
        .unwrap();

    let get_response = app
        .oneshot(get_request)
        .await
        .expect("Failed to get response");

    assert_eq!(get_response.status(), StatusCode::OK);

    let body = hyper::body::to_bytes(get_response.into_body())
        .await
        .expect("Failed to read body");
    let response_json: serde_json::Value = serde_json::from_slice(&body)
        .expect("Failed to parse JSON");

    // Response is now a direct array of ShareData items
    assert!(response_json.is_array());
    let data_array = response_json.as_array().unwrap();
    assert_eq!(data_array.len(), 1);
    // Verify the data contains the _key field we set
    assert_eq!(data_array[0]["_key"], "session");
}

#[tokio::test]
async fn test_get_nonexistent_share_data() {
    let app = get_test_app().await;

    let get_request = Request::builder()
        .method(method::GET)
        .uri("/api/share/nonexistent-id/data")
        .body(Body::empty())
        .unwrap();

    let get_response = app
        .oneshot(get_request)
        .await
        .expect("Failed to get response");

    // Should return internal server error for non-existent share
    assert_eq!(get_response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn test_remove_share_endpoint() {
    let app = get_test_app().await;

    // First, create a share
    let create_body = json!({
        "sessionID": "test-session-api-remove"
    });

    let create_request = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .header("host", "localhost:3006")
        .body(Body::from(serde_json::to_string(&create_body).unwrap()))
        .unwrap();

    let create_response = app
        .clone()
        .oneshot(create_request)
        .await
        .expect("Failed to get response");

    assert_eq!(create_response.status(), StatusCode::OK);

    let create_body_bytes = hyper::body::to_bytes(create_response.into_body())
        .await
        .expect("Failed to read body");
    let create_json: serde_json::Value = serde_json::from_slice(&create_body_bytes)
        .expect("Failed to parse JSON");

    let share_id = create_json["id"].as_str().unwrap();
    let secret = create_json["secret"].as_str().unwrap();

    // Remove the share
    let remove_body = json!({
        "secret": secret
    });

    let remove_request = Request::builder()
        .method(method::DELETE)
        .uri(&format!("/api/share/{}", share_id))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&remove_body).unwrap()))
        .unwrap();

    let remove_response = app
        .oneshot(remove_request)
        .await
        .expect("Failed to get response");

    assert_eq!(remove_response.status(), StatusCode::OK);

    // Verify share is removed by trying to get it
    let get_request = Request::builder()
        .method(method::GET)
        .uri(&format!("/api/share/{}/data", share_id))
        .body(Body::empty())
        .unwrap();

    let get_response = app
        .oneshot(get_request)
        .await
        .expect("Failed to get response");

    assert_eq!(get_response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn test_remove_share_with_invalid_secret() {
    let app = get_test_app().await;

    // First, create a share
    let create_body = json!({
        "sessionID": "test-session-api-invalid-remove"
    });

    let create_request = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .header("host", "localhost:3006")
        .body(Body::from(serde_json::to_string(&create_body).unwrap()))
        .unwrap();

    let create_response = app
        .clone()
        .oneshot(create_request)
        .await
        .expect("Failed to get response");

    assert_eq!(create_response.status(), StatusCode::OK);

    let create_body_bytes = hyper::body::to_bytes(create_response.into_body())
        .await
        .expect("Failed to read body");
    let create_json: serde_json::Value = serde_json::from_slice(&create_body_bytes)
        .expect("Failed to parse JSON");

    let share_id = create_json["id"].as_str().unwrap();

    // Try to remove with invalid secret
    let remove_body = json!({
        "secret": "invalid-secret"
    });

    let remove_request = Request::builder()
        .method(method::DELETE)
        .uri(&format!("/api/share/{}", share_id))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&remove_body).unwrap()))
        .unwrap();

    let remove_response = app
        .oneshot(remove_request)
        .await
        .expect("Failed to get response");

    assert_eq!(remove_response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn test_invalid_json_request() {
    let app = get_test_app().await;

    let request = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{invalid json}"))
        .unwrap();

    let response = app
        .oneshot(request)
        .await
        .expect("Failed to get response");

    // Should return internal server error for invalid JSON
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn test_missing_required_field() {
    let app = get_test_app().await;

    let request_body = json!({
        "invalidField": "some-value"
    });

    let request = Request::builder()
        .method(method::POST)
        .uri("/api/share")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&request_body).unwrap()))
        .unwrap();

    let response = app
        .oneshot(request)
        .await
        .expect("Failed to get response");

    // Should return internal server error for missing required field
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

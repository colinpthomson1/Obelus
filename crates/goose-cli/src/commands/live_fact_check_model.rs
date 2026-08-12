use anyhow::Result;
use goose::live_fact_check_model::{
    chatgpt_subscription_support, run_claim_detection_with_chatgpt_subscription,
    run_with_chatgpt_subscription, valid_worker_request_id, validate_worker_request,
    LiveFactCheckModelError, LiveFactCheckWorkerOperation, LiveFactCheckWorkerRequest,
    LiveFactCheckWorkerResponse, MAX_LIVE_FACT_CHECK_WORKER_INPUT_BYTES,
};
use std::io::{Read, Write};

pub async fn handle_live_fact_check_model() -> Result<()> {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    run_worker(&mut stdin, &mut stdout).await
}

pub async fn run_worker(reader: &mut dyn Read, writer: &mut dyn Write) -> Result<()> {
    let mut input = Vec::new();
    reader
        .take((MAX_LIVE_FACT_CHECK_WORKER_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)?;
    if input.len() > MAX_LIVE_FACT_CHECK_WORKER_INPUT_BYTES {
        return write_response(
            writer,
            &LiveFactCheckWorkerResponse::failure(
                String::new(),
                LiveFactCheckModelError::InvalidRequest("worker input is too large").worker_error(),
            ),
        );
    }

    let request = match serde_json::from_slice::<LiveFactCheckWorkerRequest>(&input) {
        Ok(request) => request,
        Err(_) => {
            return write_response(
                writer,
                &LiveFactCheckWorkerResponse::failure(
                    String::new(),
                    LiveFactCheckModelError::InvalidRequest("worker input is not valid JSON")
                        .worker_error(),
                ),
            );
        }
    };
    let response_request_id = if valid_worker_request_id(&request.request_id) {
        request.request_id.clone()
    } else {
        String::new()
    };
    if let Err(error) = validate_worker_request(&request) {
        return write_response(
            writer,
            &LiveFactCheckWorkerResponse::failure(response_request_id, error.worker_error()),
        );
    }

    let response = match request.operation {
        LiveFactCheckWorkerOperation::Support => LiveFactCheckWorkerResponse::support(
            response_request_id,
            chatgpt_subscription_support().await,
        ),
        LiveFactCheckWorkerOperation::Synthesize { request } => {
            match run_with_chatgpt_subscription(request).await {
                Ok(result) => LiveFactCheckWorkerResponse::success(response_request_id, result),
                Err(error) => {
                    LiveFactCheckWorkerResponse::failure(response_request_id, error.worker_error())
                }
            }
        }
        LiveFactCheckWorkerOperation::DetectClaims { request } => {
            match run_claim_detection_with_chatgpt_subscription(request).await {
                Ok(result) => {
                    LiveFactCheckWorkerResponse::claim_detection(response_request_id, result)
                }
                Err(error) => {
                    LiveFactCheckWorkerResponse::failure(response_request_id, error.worker_error())
                }
            }
        }
    };
    write_response(writer, &response)
}

fn write_response(writer: &mut dyn Write, response: &LiveFactCheckWorkerResponse) -> Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn malformed_input_returns_a_bounded_sanitized_error() {
        let mut input = b"not json".as_slice();
        let mut output = Vec::new();

        run_worker(&mut input, &mut output).await.unwrap();

        let response: LiveFactCheckWorkerResponse = serde_json::from_slice(&output).unwrap();
        assert!(!response.ok);
        assert_eq!(response.request_id, "");
        assert_eq!(response.error.unwrap().code, "invalid_request");
        assert!(output.len() < 1_024);
    }

    #[tokio::test]
    async fn oversized_input_is_rejected_without_echoing_it() {
        let oversized = vec![b'x'; MAX_LIVE_FACT_CHECK_WORKER_INPUT_BYTES + 1];
        let mut input = oversized.as_slice();
        let mut output = Vec::new();

        run_worker(&mut input, &mut output).await.unwrap();

        let response: LiveFactCheckWorkerResponse = serde_json::from_slice(&output).unwrap();
        assert_eq!(response.error.unwrap().code, "invalid_request");
        assert!(output.len() < 1_024);
    }

    #[tokio::test]
    async fn support_probe_awaits_cached_session_validation_without_a_model_call() {
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path().to_string_lossy().to_string();
        let _guard = env_lock::lock_env([
            ("GOOSE_PATH_ROOT", Some(root_path.as_str())),
            ("GOOSE_DISABLE_KEYRING", Some("1")),
        ]);
        let request = serde_json::json!({
            "protocolVersion": 1,
            "requestId": "support-1",
            "operation": "support"
        });
        let bytes = serde_json::to_vec(&request).unwrap();
        let mut input = bytes.as_slice();
        let mut output = Vec::new();

        run_worker(&mut input, &mut output).await.unwrap();

        let response: LiveFactCheckWorkerResponse = serde_json::from_slice(&output).unwrap();
        assert!(response.ok);
        assert_eq!(response.request_id, "support-1");
        let support = response.support.unwrap();
        assert!(!support.available);
        assert_eq!(support.provider, "chatgpt_codex");
        assert_eq!(support.model, "gpt-5.6-sol");
        assert!(response.result.is_none());
        assert!(response.error.is_none());
    }
}

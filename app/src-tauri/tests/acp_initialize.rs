use app_lib::acp::InitializeResponseExt;
use std::path::Path;

#[tokio::test]
async fn initialize_mengembalikan_info_agen_dan_kapabilitas() {
    let spec = app_lib::agents::find_agent("claude").expect("agen claude harus ada");
    let (handle, init) = app_lib::acp::connect(spec, Path::new("."))
        .await
        .expect("connect harus berhasil");

    assert!(
        init.agent_info_name().contains("claude-agent-acp"),
        "agentInfo.name tak terduga: {}",
        init.agent_info_name()
    );
    assert!(init.supports_image_prompt(), "agen harus mendukung prompt gambar");

    handle.shutdown().await;
}

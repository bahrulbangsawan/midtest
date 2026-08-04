use std::path::PathBuf;

fn akar_repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

#[test]
fn konfigurasi_sidecar_tidak_menyertakan_field_type() {
    let cfg = app_lib::sidecar::midscene_server(&akar_repo());
    let json = serde_json::to_value(&cfg).unwrap();
    assert!(
        json.get("type").is_none(),
        "entri stdio harus tanpa field type, dapat: {json}"
    );
    assert_eq!(json["name"], "midscene");
    let args = json["args"].as_array().expect("args harus array");
    assert!(
        args.iter()
            .any(|a| a.as_str().unwrap_or("").contains("--env-file"))
    );
    assert!(
        args.iter()
            .any(|a| a.as_str().unwrap_or("").ends_with("midscene-mcp/src/index.ts"))
    );
}

#[tokio::test]
async fn sesi_baru_membuat_id_sesi() {
    let spec = app_lib::agents::find_agent("claude").unwrap();
    let akar = akar_repo();
    let (handle, _init) = app_lib::acp::connect(spec, &akar).await.unwrap();
    let servers = vec![app_lib::sidecar::midscene_server(&akar)];
    let sid = app_lib::acp::new_session(&handle, &akar, servers)
        .await
        .unwrap();
    assert!(!sid.to_string().is_empty(), "sessionId tidak boleh kosong");
    handle.shutdown().await;
}

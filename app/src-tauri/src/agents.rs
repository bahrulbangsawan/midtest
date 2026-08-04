use std::path::PathBuf;

/// One ACP agent adapter this app can drive.
/// Neither Codex nor Claude ships a native ACP mode; both are separate
/// adapter binaries that translate ACP to the vendor's own CLI protocol.
pub struct AgentSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub bin: &'static str,
    /// npm package that installs `bin` globally. Named here — not duplicated
    /// in `commands.rs` or the frontend — so the install instructions shown
    /// to the user can never drift from the binary name they're paired with.
    pub npm_package: &'static str,
}

pub const AGENTS: [AgentSpec; 2] = [
    AgentSpec {
        id: "claude",
        label: "Claude",
        bin: "claude-agent-acp",
        npm_package: "@agentclientprotocol/claude-agent-acp",
    },
    AgentSpec {
        id: "codex",
        label: "Codex",
        bin: "codex-acp",
        npm_package: "@agentclientprotocol/codex-acp",
    },
];

pub fn find_agent(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// Whether the adapter binary is resolvable. The lookup is injected so this
/// stays testable without depending on the machine's PATH.
pub fn probe(bin: &str, path_lookup: &dyn Fn(&str) -> Option<PathBuf>) -> bool {
    path_lookup(bin).is_some()
}

/// Indonesian message shown when `probe` finds `spec.bin` unresolvable.
///
/// Built here, from the one registry entry that owns `bin` and
/// `npm_package`, so callers never carry their own copy of either name.
/// `commands.rs` must call this instead of composing its own sentence — see
/// the module doc on why `probe` existing but never being called was the
/// defect this closes.
#[must_use]
pub fn missing_binary_message(spec: &AgentSpec) -> String {
    format!(
        "Biner adapter \"{}\" untuk agen {} tidak ditemukan di PATH. \
         Pasang lebih dulu dengan `npm install -g {}`, lalu coba sambungkan lagi.",
        spec.bin, spec.label, spec.npm_package
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn registry_memuat_kedua_agen() {
        let id: Vec<&str> = AGENTS.iter().map(|a| a.id).collect();
        assert!(id.contains(&"claude"));
        assert!(id.contains(&"codex"));
    }

    #[test]
    fn find_agent_mengembalikan_spec_yang_cocok() {
        let a = find_agent("claude").expect("claude harus ada");
        assert_eq!(a.bin, "claude-agent-acp");
        assert!(find_agent("tidak-ada").is_none());
    }

    #[test]
    fn probe_benar_bila_biner_ditemukan() {
        let ada = |_: &str| Some(PathBuf::from("/usr/local/bin/x"));
        assert!(probe("claude-agent-acp", &ada));
    }

    #[test]
    fn probe_salah_bila_biner_tidak_ditemukan() {
        let kosong = |_: &str| None;
        assert!(!probe("claude-agent-acp", &kosong));
    }

    /// Pesan biner hilang wajib menyebut nama biner dan paket npm-nya —
    /// bukan hanya salah satu — supaya pengguna tahu persis apa yang harus
    /// dipasang dan lewat perintah apa.
    #[test]
    fn missing_binary_message_menyebut_biner_dan_paket_npm() {
        let spec = find_agent("claude").expect("claude harus ada");
        let pesan = missing_binary_message(spec);

        assert!(pesan.contains("claude-agent-acp"), "dapat: {pesan}");
        assert!(
            pesan.contains("@agentclientprotocol/claude-agent-acp"),
            "dapat: {pesan}"
        );
        assert!(pesan.contains("npm install"), "dapat: {pesan}");
    }

    /// Dua agen berbeda wajib menghasilkan kalimat berbeda: bila keduanya
    /// sama, pengguna tidak bisa tahu biner mana yang sesungguhnya hilang.
    #[test]
    fn missing_binary_message_berbeda_untuk_setiap_agen() {
        let claude = missing_binary_message(find_agent("claude").expect("claude harus ada"));
        let codex = missing_binary_message(find_agent("codex").expect("codex harus ada"));
        assert_ne!(claude, codex);
    }
}

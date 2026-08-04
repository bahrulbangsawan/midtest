use std::path::PathBuf;

/// One ACP agent adapter this app can drive.
/// Neither Codex nor Claude ships a native ACP mode; both are separate
/// adapter binaries that translate ACP to the vendor's own CLI protocol.
pub struct AgentSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub bin: &'static str,
}

pub const AGENTS: [AgentSpec; 2] = [
    AgentSpec { id: "claude", label: "Claude", bin: "claude-agent-acp" },
    AgentSpec { id: "codex", label: "Codex", bin: "codex-acp" },
];

pub fn find_agent(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// Whether the adapter binary is resolvable. The lookup is injected so this
/// stays testable without depending on the machine's PATH.
pub fn probe(bin: &str, path_lookup: &dyn Fn(&str) -> Option<PathBuf>) -> bool {
    path_lookup(bin).is_some()
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
}

// Script Workbench owns its terminal UI. Never open a separate Windows console,
// including for debug builds used by local self-tests.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    script_workbench_lib::run()
}

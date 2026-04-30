use tauri::{command, AppHandle, Emitter, State};
use tokio::net::TcpStream;
use tokio::net::tcp::OwnedWriteHalf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone, Serialize)]
struct TcpEvent {
    message: String,
    format: String,
    timestamp: String,
}

struct AppState {
    writer: Arc<Mutex<Option<OwnedWriteHalf>>>,
}

#[command]
async fn connect_to_server(
    app: AppHandle,
    state: State<'_, AppState>,
    ip: String,
    port: String,
    protocol: String,
) -> Result<String, String> {
    let _ = protocol; // UDP not yet implemented natively; accept the arg from the frontend.
    let addr = format!("{}:{}", ip, port);

    // Drop any previous writer so the old read task ends (its peer will see EOF).
    {
        let mut writer_lock = state.writer.lock().await;
        *writer_lock = None;
    }

    let connect_fut = TcpStream::connect(&addr);
    let stream = match tokio::time::timeout(std::time::Duration::from_secs(3), connect_fut).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("TCP Connection failed: {}", e)),
        Err(_) => return Err("TCP Connection timed out (Device unreachable)".to_string()),
    };

    // ONE connection, split into read + write halves. The read half drives the
    // background reader; the write half goes into shared state so send_*
    // commands write on the same socket the peer is replying on.
    let (mut read_half, write_half) = stream.into_split();

    {
        let mut writer_lock = state.writer.lock().await;
        *writer_lock = Some(write_half);
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buffer = [0u8; 1024];
        loop {
            match read_half.read(&mut buffer).await {
                Ok(0) => {
                    let _ = app_clone.emit("tcp-status", "Disconnected");
                    break;
                }
                Ok(n) => {
                    let hex: String = buffer[..n].iter().map(|b| format!("{:02x}", b)).collect();
                    let _ = app_clone.emit("tcp-data", TcpEvent {
                        message: hex,
                        format: "hex".to_string(),
                        timestamp: chrono::Local::now().to_rfc3339(),
                    });
                }
                Err(_) => {
                    let _ = app_clone.emit("tcp-status", "Disconnected");
                    break;
                }
            }
        }
    });

    Ok(format!("Connected to {} via TCP", addr))
}

#[command]
async fn send_to_server(state: State<'_, AppState>, message: String) -> Result<(), String> {
    let mut writer_lock = state.writer.lock().await;
    if let Some(ref mut writer) = *writer_lock {
        writer.write_all(message.as_bytes()).await.map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Not connected".to_string())
    }
}

#[command]
async fn send_bytes_to_server(state: State<'_, AppState>, data: Vec<u8>) -> Result<(), String> {
    let mut writer_lock = state.writer.lock().await;
    if let Some(ref mut writer) = *writer_lock {
        writer.write_all(&data).await.map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Not connected".to_string())
    }
}

#[command]
fn get_system_stats() -> String {
    "Live Socket System Active".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(AppState {
        writer: Arc::new(Mutex::new(None)),
    })
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![
        get_system_stats,
        connect_to_server,
        send_to_server,
        send_bytes_to_server
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

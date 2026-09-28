//! What an email says: the notification about a finished job and the test email.

use super::JobReport;
use crate::settings::EmailSettings;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::Message;
use std::io::SeekFrom;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// A log bigger than this is cut to its last this-many bytes before it is attached: mail servers
/// commonly refuse messages over 10-25 MB, and base64 makes an attachment a third bigger.
pub const ATTACH_LIMIT: u64 = 5 * 1024 * 1024;

/// The From mailbox and every To mailbox, checked. The errors are the sentences the UI shows.
pub fn mailboxes(settings: &EmailSettings) -> Result<(Mailbox, Vec<Mailbox>), String> {
    let from_text = settings.from_address.trim();
    if from_text.is_empty() {
        return Err("Enter the address the emails come from.".into());
    }
    let from: Mailbox = from_text
        .parse()
        .map_err(|_| format!("The From address “{from_text}” is not a valid email address."))?;
    let mut to = Vec::new();
    for entry in &settings.to_addresses {
        let text = entry.trim();
        if text.is_empty() {
            continue;
        }
        let mailbox: Mailbox = text
            .parse()
            .map_err(|_| format!("The To address “{text}” is not a valid email address."))?;
        to.push(mailbox);
    }
    if to.is_empty() {
        return Err("Add at least one address to send the emails to.".into());
    }
    Ok((from, to))
}

/// How the job ended, as the end of the subject line ("“Photos” failed") and as the first sentence
/// of the body.
fn outcome(report: &JobReport) -> (&'static str, String) {
    let noun = match report.kind.as_str() {
        "" => "transfer",
        kind => kind,
    };
    let is_check = report.kind == "check";
    match report.status.as_str() {
        "success" if is_check => ("found no differences", "The check found no differences.".into()),
        "success" => ("finished", format!("The {noun} finished successfully.")),
        // rclone's check fails with "N differences found" when it did its job and the two sides differ,
        // which reads better as what it found than as a failure. Any other check error is a failure.
        "error" if is_check && report.error.as_deref().unwrap_or("").contains("differences found") => (
            "found differences",
            "The check found differences between the source and the destination.".into(),
        ),
        "error" => ("failed", format!("The {noun} failed.")),
        "stopped" => ("was stopped", format!("The {noun} was stopped before it finished.")),
        _ => (
            "ended with an unknown result",
            format!(
                "Arcus lost track of the {noun}, so how it ended is not known. That happens when Arcus or \
                 rclone quit while it was running."
            ),
        ),
    }
}

pub fn report_subject(report: &JobReport) -> String {
    format!("Arcus: “{}” {}", report.title, outcome(report).0)
}

/// What becomes of the log file in the email.
enum LogAttachment {
    /// Not asked for, or the job did not fail.
    NotWanted,
    Missing,
    Unreadable(String),
    Whole(Vec<u8>),
    /// The last `ATTACH_LIMIT` bytes (from the start of a line) of a file of `total` bytes.
    Tail { bytes: Vec<u8>, total: u64 },
}

async fn read_log(path: &Path) -> LogAttachment {
    let total = match tokio::fs::metadata(path).await {
        Ok(meta) => meta.len(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return LogAttachment::Missing,
        Err(err) => return LogAttachment::Unreadable(err.to_string()),
    };
    let read = async {
        let mut file = tokio::fs::File::open(path).await?;
        if total <= ATTACH_LIMIT {
            let mut bytes = Vec::with_capacity(total as usize);
            file.read_to_end(&mut bytes).await?;
            return Ok::<_, std::io::Error>(LogAttachment::Whole(bytes));
        }
        file.seek(SeekFrom::End(-(ATTACH_LIMIT as i64))).await?;
        let mut bytes = Vec::with_capacity(ATTACH_LIMIT as usize);
        file.take(ATTACH_LIMIT).read_to_end(&mut bytes).await?;
        // Start at a whole line (and a whole UTF-8 character) rather than in the middle of one.
        if let Some(newline) = bytes.iter().take(64 * 1024).position(|b| *b == b'\n') {
            bytes.drain(..=newline);
        }
        Ok(LogAttachment::Tail { bytes, total })
    };
    match read.await {
        Ok(attachment) => attachment,
        Err(err) => LogAttachment::Unreadable(err.to_string()),
    }
}

/// The email about a finished job, with the log attached when the settings and the outcome ask for it.
pub async fn report_message(settings: &EmailSettings, report: &JobReport) -> Result<Message, String> {
    let (from, to) = mailboxes(settings)?;
    let failed = matches!(report.status.as_str(), "error" | "lost");
    let log = match report.log_path.as_deref() {
        Some(path) if settings.attach_log_on_failure && failed => read_log(Path::new(path)).await,
        _ => LogAttachment::NotWanted,
    };

    let (_, headline) = outcome(report);
    let mut body = String::new();
    body.push_str(&headline);
    body.push_str("\n\n");
    let mut row = |label: &str, value: &str| {
        body.push_str(&format!("{:<13}{}\n", format!("{label}:"), value));
    };
    row("Transfer", &report.title);
    row("Started by", &report.origin);
    if !report.kind.is_empty() {
        row("Action", &report.kind);
    }
    if !report.source.is_empty() {
        row("Source", &report.source);
    }
    if !report.destination.is_empty() {
        row("Destination", &report.destination);
    }
    if report.started_at_unix > 0 {
        row("Started", &human_time(report.started_at_unix));
    }
    if report.finished_at_unix > 0 {
        let mut finished = human_time(report.finished_at_unix);
        if report.started_at_unix > 0 && report.finished_at_unix >= report.started_at_unix {
            finished.push_str(&format!(
                " (took {})",
                human_duration(report.finished_at_unix - report.started_at_unix)
            ));
        }
        row("Finished", &finished);
    }
    if let Some(error) = report.error.as_deref().filter(|e| !e.trim().is_empty()) {
        row("Error", error.trim());
    }
    if !report.summary.trim().is_empty() {
        body.push_str("\nSummary\n-------\n");
        body.push_str(report.summary.trim_end());
        body.push('\n');
    }
    if let Some(path) = report.log_path.as_deref() {
        body.push_str(&format!("\nLog file: {path}\n"));
        match &log {
            LogAttachment::NotWanted | LogAttachment::Whole(_) => {}
            LogAttachment::Missing => body.push_str("The log file no longer exists, so it is not attached.\n"),
            LogAttachment::Unreadable(err) => {
                body.push_str(&format!("The log file could not be read ({err}), so it is not attached.\n"))
            }
            LogAttachment::Tail { total, .. } => body.push_str(&format!(
                "The log is {}, so only its last {} is attached.\n",
                human_bytes(*total),
                human_bytes(ATTACH_LIMIT)
            )),
        }
    }
    body.push_str("\n-- \nSent by Arcus. Change what Arcus emails you about in Settings → Email notifications");
    body.push_str(if report.origin.starts_with("Watch folder") {
        " or in the watch folder's settings.\n"
    } else {
        ".\n"
    });

    let text = SinglePart::plain(body);
    let builder = base_builder(&from, &to).subject(report_subject(report));
    let attachment = match log {
        LogAttachment::Whole(bytes) | LogAttachment::Tail { bytes, .. } => Some(bytes),
        _ => None,
    };
    let message = match attachment {
        Some(bytes) => {
            let name = report
                .log_path
                .as_deref()
                .and_then(|p| Path::new(p).file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "transfer.log".into());
            // As text, not bytes: lettre turns a String's bare LF line ends into CRLF, and servers that
            // guard against SMTP smuggling refuse mail with bare LFs. rclone writes its logs in UTF-8.
            let log_text = String::from_utf8_lossy(&bytes).into_owned();
            let part = Attachment::new(name).body(log_text, ContentType::parse("text/plain; charset=utf-8").unwrap());
            builder.multipart(MultiPart::mixed().singlepart(text).singlepart(part))
        }
        None => builder.singlepart(text),
    };
    message.map_err(|err| format!("Could not put the email together: {err}"))
}

/// The email "Send test email" sends.
pub fn test_message(settings: &EmailSettings) -> Result<Message, String> {
    let (from, to) = mailboxes(settings)?;
    let security = match settings.security.as_str() {
        "tls" => "SSL/TLS",
        "none" => "no encryption",
        _ => "STARTTLS",
    };
    let body = format!(
        "This is a test email from Arcus.\n\n\
         It came through {}:{} ({security}), so Arcus can email you when transfers and watch folders end.\n\n\
         -- \nSent by Arcus from Settings → Email notifications.\n",
        settings.host.trim(),
        settings.port
    );
    base_builder(&from, &to)
        .subject("Arcus: test email")
        .singlepart(SinglePart::plain(body))
        .map_err(|err| format!("Could not put the email together: {err}"))
}

fn base_builder(from: &Mailbox, to: &[Mailbox]) -> lettre::message::MessageBuilder {
    // A Message-ID in the sender's own domain: some servers mark mail whose ID names another
    // host (lettre's fallback is "localhost" without its `hostname` feature) as more likely spam.
    let domain = from.email.domain().to_string();
    let mut builder = Message::builder()
        .from(from.clone())
        .message_id(Some(format!("<{}@{domain}>", uuid::Uuid::new_v4().simple())))
        .user_agent(format!("Arcus {}", env!("CARGO_PKG_VERSION")));
    for mailbox in to {
        builder = builder.to(mailbox.clone());
    }
    builder
}

/// "Monday 28 September 2026, 14:03:05 UTC" without a date library: the civil-from-days conversion
/// `transfers::compact_timestamp` also uses (Howard Hinnant's algorithm).
pub fn human_time(unix: u64) -> String {
    const WEEKDAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS: [&str; 12] = [
        "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
        "November", "December",
    ];
    let days = (unix / 86_400) as i64;
    let secs = unix % 86_400;
    // 1 January 1970 was a Thursday.
    let weekday = WEEKDAYS[((days + 4) % 7) as usize];
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{weekday} {d} {} {y}, {:02}:{:02}:{:02} UTC",
        MONTHS[(m - 1) as usize],
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// "45 s", "2 min 5 s", "3 h 4 min".
pub fn human_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{secs} s")
    } else if secs < 3600 {
        format!("{} min {} s", secs / 60, secs % 60)
    } else {
        format!("{} h {} min", secs / 3600, (secs % 3600) / 60)
    }
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

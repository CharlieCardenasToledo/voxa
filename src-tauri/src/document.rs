use std::io::{Cursor, Read};

#[derive(Debug, serde::Serialize)]
pub struct DocumentContext {
    pub text: String,
    pub vocabulary: Vec<String>,
    pub kind: String,
}

pub fn extract(file_name: &str, bytes: &[u8]) -> Result<DocumentContext, String> {
    let extension = file_name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (text, kind) = match extension.as_str() {
        "pdf" => extract_pdf(bytes).map(|text| (text, "PDF".to_string()))?,
        "pptx" => extract_pptx(bytes).map(|text| (text, "PPTX".to_string()))?,
        _ => return Err("Only PDF and PPTX files are supported".into()),
    };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("The selected document contains no readable text".into());
    }
    Ok(DocumentContext {
        vocabulary: vocabulary(&text),
        text,
        kind,
    })
}

fn extract_pdf(bytes: &[u8]) -> Result<String, String> {
    let document =
        lopdf::Document::load_mem(bytes).map_err(|error| format!("Could not read PDF: {error}"))?;
    let pages = document.get_pages().keys().copied().collect::<Vec<_>>();
    document
        .extract_text(&pages)
        .map_err(|error| format!("Could not extract PDF text: {error}"))
}

fn extract_pptx(bytes: &[u8]) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Could not read PPTX: {error}"))?;
    let mut slide_names = (1..=archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|file| file.name().to_string())
        })
        .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
        .collect::<Vec<_>>();
    slide_names.sort();
    let mut output = String::new();
    for name in slide_names {
        let mut file = archive.by_name(&name).map_err(|error| error.to_string())?;
        let mut xml = String::new();
        file.read_to_string(&mut xml)
            .map_err(|error| format!("Could not read slide XML: {error}"))?;
        let mut reader = quick_xml::Reader::from_str(&xml);
        let mut buffer = Vec::new();
        loop {
            match reader.read_event_into(&mut buffer) {
                Ok(quick_xml::events::Event::Text(text)) => {
                    let decoded = text.decode().map_err(|error| error.to_string())?;
                    output.push_str(
                        &quick_xml::escape::unescape(&decoded)
                            .map_err(|error| error.to_string())?,
                    );
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Ok(_) => {}
                Err(error) => return Err(format!("Could not parse slide XML: {error}")),
            }
            buffer.clear();
        }
        output.push('\n');
    }
    Ok(output)
}

fn vocabulary(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for token in text.split(|character: char| {
        !character.is_alphanumeric() && character != '-' && character != '_'
    }) {
        if token.len() < 2
            || terms
                .iter()
                .any(|term: &String| term.eq_ignore_ascii_case(token))
        {
            continue;
        }
        let technical = token.chars().any(|character| character.is_uppercase())
            || token.chars().any(|character| character.is_ascii_digit())
            || token.contains('-')
            || token.contains('_');
        if technical {
            terms.push(token.to_string());
        }
        if terms.len() == 100 {
            break;
        }
    }
    terms
}

#[cfg(test)]
mod tests {
    use super::vocabulary;

    #[test]
    fn extracts_technical_terms() {
        let terms = vocabulary("Kubernetes PostgreSQL api v2 OpenTelemetry");
        assert!(terms.iter().any(|term| term == "Kubernetes"));
        assert!(terms.iter().any(|term| term == "v2"));
    }
}
